// ETA予測精度の監視用集計サービス（読み取り専用）。
//
// trip_arrival_prediction_log（etaPredictor.jsが追記するETA予測の時系列履歴。
// source='actual'の行がその停留所への実績到着時刻）を元に、「予測がいつの時点・
// 何停留所手前で出されたものか（リードタイム／stopsBefore）」と「実績」との誤差を、
// 路線・停留所・時間帯・曜日区分別に集計する。誤差の許容分数(thresholdMinutes)や、
// リードタイム／停留所数での絞り込みは呼び出し側（管理画面）が指定できる。
//
// 既存のETA計算（predictArrivals/computeAndStoreAllArrivals）やパイプラインには
// 一切書き込みを行わない、完全に独立した参照系モジュール。
const pool = require('../config/db');
const { timeStrToMinutes, getDayType } = require('../utils/time');
const { loadHolidaySet } = require('./holidayCalendar');
const { describeSource } = require('./etaPredictor');

const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;
const MAX_ROWS = 20000; // 小規模システム前提だが、クエリ暴走を避けるための上限
const DEFAULT_THRESHOLD_MIN = 3;
const MAX_THRESHOLD_MIN = 30;
const SAMPLE_LIMIT = 100;
const WORST_STOPS_LIMIT = 30;

function diffMinutesSigned(fromStr, toStr) {
  const a = timeStrToMinutes(fromStr);
  const b = timeStrToMinutes(toStr);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  let diff = b - a;
  // utils/time.jsのcomputeDelayMinutesと同じ流儀（半日を超える差だけ日跨ぎ補正）。
  // 誤差は正負の符号を残す（早着/遅着の傾向＝バイアスを見るため0でクランプしない）。
  if (diff < -720) diff += 24 * 60;
  else if (diff > 720) diff -= 24 * 60;
  return Math.round(diff * 10) / 10;
}

function hourBucketOf(timeStr) {
  const m = timeStrToMinutes(timeStr);
  if (Number.isNaN(m)) return null;
  return Math.floor(m / 60) % 24;
}

const LEAD_ORDER = ['5分未満', '5〜15分前', '15〜30分前', '30分以上前'];
function leadBucketOf(leadMinutes) {
  if (leadMinutes < 5) return LEAD_ORDER[0];
  if (leadMinutes < 15) return LEAD_ORDER[1];
  if (leadMinutes < 30) return LEAD_ORDER[2];
  return LEAD_ORDER[3];
}

const STOPS_BEFORE_ORDER = ['1停留所前', '2停留所前', '3停留所前', '4〜6停留所前', '7停留所以上前'];
function stopsBeforeBucketOf(n) {
  if (n === null || n === undefined || n <= 0) return null;
  if (n === 1) return STOPS_BEFORE_ORDER[0];
  if (n === 2) return STOPS_BEFORE_ORDER[1];
  if (n === 3) return STOPS_BEFORE_ORDER[2];
  if (n <= 6) return STOPS_BEFORE_ORDER[3];
  return STOPS_BEFORE_ORDER[4];
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function emptyAgg() {
  return { count: 0, sumAbsError: 0, sumError: 0, withinThreshold: 0 };
}

function addSample(agg, errorMinutes, thresholdMinutes) {
  agg.count++;
  agg.sumAbsError += Math.abs(errorMinutes);
  agg.sumError += errorMinutes;
  if (Math.abs(errorMinutes) <= thresholdMinutes) agg.withinThreshold++;
}

function finalizeAgg(agg) {
  if (agg.count === 0) {
    return { sampleCount: 0, meanAbsErrorMinutes: null, meanErrorMinutes: null, withinThresholdRate: null };
  }
  return {
    sampleCount: agg.count,
    meanAbsErrorMinutes: round1(agg.sumAbsError / agg.count),
    meanErrorMinutes: round1(agg.sumError / agg.count),
    withinThresholdRate: round1((agg.withinThreshold / agg.count) * 100)
  };
}

const HOUR_ORDER = Array.from({ length: 24 }, (_, i) => i);
const DAY_TYPE_ORDER = ['weekday', 'saturday', 'holiday'];

/**
 * 予測精度レポートを生成する。
 * 「実績（source='actual'）が確定した停留所」ごとに、それ以前に記録された
 * 予測（source<>'actual'）の全履歴と突き合わせ、1予測=1サンプルとして誤差を集計する。
 * 同じ停留所でも予測は時間とともに何度も更新されるため、履歴全体を使うことで
 * 「早い段階の予測ほど誤差が大きい」といった傾向も見える。
 *
 * @param {object} opts
 * @param {number} [opts.days=7] 何日前までのデータを対象にするか（1〜31）
 * @param {string} [opts.routeId] 路線で絞り込み
 * @param {number} [opts.thresholdMinutes=3] 「誤差◯分以内」の◯分（1〜30。UIから変更可能）
 * @param {string} [opts.leadBucket] リードタイム区分で絞り込み（byLeadTimeの値のいずれか）
 * @param {string} [opts.stopsBeforeBucket] 停留所数区分で絞り込み（byStopsBeforeの値のいずれか）
 */
async function getAccuracyReport({
  days = DEFAULT_DAYS,
  routeId = null,
  thresholdMinutes = DEFAULT_THRESHOLD_MIN,
  leadBucket = null,
  stopsBeforeBucket = null
} = {}) {
  const client = await pool.connect();
  try {
    const clampedDays = Math.min(Math.max(parseInt(days, 10) || DEFAULT_DAYS, 1), MAX_DAYS);
    const clampedThreshold = Math.min(Math.max(parseFloat(thresholdMinutes) || DEFAULT_THRESHOLD_MIN, 0.5), MAX_THRESHOLD_MIN);
    const params = [clampedDays];
    let routeFilter = '';
    if (routeId) {
      params.push(routeId);
      routeFilter = `AND act.route_id = $${params.length}`;
    }

    const res = await client.query(
      `SELECT act.route_id, r.name AS route_name, act.stop_id, act.daily_trip_id, act.predicted_time AS actual_time,
              act.computed_at AS actual_logged_at, d.start_time, d.service_date::text AS service_date,
              s.name AS stop_name,
              pred.predicted_time, pred.source, pred.computed_at AS predicted_at, pred.stops_before
       FROM trip_arrival_prediction_log act
       JOIN trip_arrival_prediction_log pred
         ON pred.assignment_id = act.assignment_id
        AND pred.stop_id = act.stop_id
        AND pred.source <> 'actual'
        AND pred.computed_at < act.computed_at
       JOIN routes r ON r.id = act.route_id
       JOIN stops s ON s.id = act.stop_id
       JOIN daily_trips d ON d.id = act.daily_trip_id
       WHERE act.source = 'actual'
         AND act.computed_at >= now() - ($1 || ' days')::interval
         ${routeFilter}
       ORDER BY act.computed_at DESC
       LIMIT ${MAX_ROWS}`,
      params
    );

    const holidaySet = await loadHolidaySet(client);
    const dayTypeCache = new Map();

    // 生データを1回だけ整形する（誤差・リードタイム・停留所区分・曜日区分を付与）
    const allRows = [];
    for (const row of res.rows) {
      const errorMinutes = diffMinutesSigned(row.predicted_time, row.actual_time);
      if (errorMinutes === null) continue;
      const leadMinutesRaw = (new Date(row.actual_logged_at).getTime() - new Date(row.predicted_at).getTime()) / 60000;
      if (!Number.isFinite(leadMinutesRaw) || leadMinutesRaw < 0) continue; // 異常値除外
      const leadMinutes = round1(leadMinutesRaw);

      let dayType = dayTypeCache.get(row.service_date);
      if (!dayType) {
        dayType = getDayType(new Date(`${row.service_date}T12:00:00+09:00`), holidaySet);
        dayTypeCache.set(row.service_date, dayType);
      }

      allRows.push({
        routeId: row.route_id,
        routeName: row.route_name,
        stopName: row.stop_name,
        startTime: row.start_time,
        source: row.source,
        predictedTime: row.predicted_time,
        actualTime: row.actual_time,
        predictedAt: row.predicted_at,
        actualLoggedAt: row.actual_logged_at,
        errorMinutes,
        leadMinutes,
        leadBucket: leadBucketOf(leadMinutes),
        stopsBefore: row.stops_before,
        stopsBeforeBucket: stopsBeforeBucketOf(row.stops_before),
        hour: hourBucketOf(row.actual_time),
        dayType
      });
    }

    // byLeadTime・byStopsBefore は「選択肢の全体像」を見せるため、ドリルダウン
    // フィルタ（leadBucket/stopsBeforeBucket）を適用する前の全件から集計する。
    const byLead = new Map();
    const byStopsBefore = new Map();
    for (const r of allRows) {
      if (!byLead.has(r.leadBucket)) byLead.set(r.leadBucket, emptyAgg());
      addSample(byLead.get(r.leadBucket), r.errorMinutes, clampedThreshold);

      if (r.stopsBeforeBucket) {
        if (!byStopsBefore.has(r.stopsBeforeBucket)) byStopsBefore.set(r.stopsBeforeBucket, emptyAgg());
        addSample(byStopsBefore.get(r.stopsBeforeBucket), r.errorMinutes, clampedThreshold);
      }
    }

    // ここから先はドリルダウンフィルタを適用した集合で集計する
    const filteredRows = allRows.filter((r) => {
      if (leadBucket && r.leadBucket !== leadBucket) return false;
      if (stopsBeforeBucket && r.stopsBeforeBucket !== stopsBeforeBucket) return false;
      return true;
    });

    const overall = emptyAgg();
    const byRoute = new Map();
    const byHour = new Map();
    const byDayType = new Map();
    const byStop = new Map();

    for (const r of filteredRows) {
      addSample(overall, r.errorMinutes, clampedThreshold);

      if (!byRoute.has(r.routeId)) byRoute.set(r.routeId, { routeName: r.routeName, agg: emptyAgg() });
      addSample(byRoute.get(r.routeId).agg, r.errorMinutes, clampedThreshold);

      if (r.hour !== null) {
        if (!byHour.has(r.hour)) byHour.set(r.hour, emptyAgg());
        addSample(byHour.get(r.hour), r.errorMinutes, clampedThreshold);
      }

      if (!byDayType.has(r.dayType)) byDayType.set(r.dayType, emptyAgg());
      addSample(byDayType.get(r.dayType), r.errorMinutes, clampedThreshold);

      const stopKey = `${r.routeId}:${r.stopName}`;
      if (!byStop.has(stopKey)) byStop.set(stopKey, { routeId: r.routeId, routeName: r.routeName, stopName: r.stopName, agg: emptyAgg() });
      addSample(byStop.get(stopKey).agg, r.errorMinutes, clampedThreshold);
    }

    const worstStops = Array.from(byStop.values())
      .map((v) => ({ routeId: v.routeId, routeName: v.routeName, stopName: v.stopName, ...finalizeAgg(v.agg) }))
      .filter((v) => v.sampleCount > 0)
      .sort((a, b) => b.meanAbsErrorMinutes - a.meanAbsErrorMinutes)
      .slice(0, WORST_STOPS_LIMIT);

    const samples = filteredRows.slice(0, SAMPLE_LIMIT).map((r) => ({
      routeId: r.routeId,
      routeName: r.routeName,
      stopName: r.stopName,
      startTime: r.startTime,
      source: r.source,
      basisLabel: describeSource(r.source).label,
      predictedTime: r.predictedTime,
      actualTime: r.actualTime,
      errorMinutes: r.errorMinutes,
      leadMinutes: r.leadMinutes,
      stopsBefore: r.stopsBefore
    }));

    return {
      days: clampedDays,
      routeId: routeId || null,
      thresholdMinutes: clampedThreshold,
      leadBucket: leadBucket || null,
      stopsBeforeBucket: stopsBeforeBucket || null,
      sampleCount: filteredRows.length,
      overall: finalizeAgg(overall),
      byRoute: Array.from(byRoute.entries()).map(([id, v]) => ({ routeId: id, routeName: v.routeName, ...finalizeAgg(v.agg) })),
      byHour: HOUR_ORDER.filter((h) => byHour.has(h)).map((h) => ({ hour: h, ...finalizeAgg(byHour.get(h)) })),
      byDayType: DAY_TYPE_ORDER.filter((t) => byDayType.has(t)).map((t) => ({ dayType: t, ...finalizeAgg(byDayType.get(t)) })),
      byLeadTime: LEAD_ORDER.filter((l) => byLead.has(l)).map((l) => ({ leadBucket: l, ...finalizeAgg(byLead.get(l)) })),
      byStopsBefore: STOPS_BEFORE_ORDER.filter((l) => byStopsBefore.has(l)).map((l) => ({ stopsBeforeBucket: l, ...finalizeAgg(byStopsBefore.get(l)) })),
      worstStops,
      samples
    };
  } finally {
    client.release();
  }
}

module.exports = { getAccuracyReport, LEAD_ORDER, STOPS_BEFORE_ORDER };
