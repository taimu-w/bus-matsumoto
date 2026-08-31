// 時刻表検索（GTFS識別子ベース）とリアルタイム運行状況（DBの daily_trips ベース）を
// 便詳細ページのために橋渡しする、小さな専用モジュール。
//
// 2つの機能のデータ経路は独立を保つ設計（README/CLAUDE.md参照）だが、
// 便詳細ページのURL（/timetable/trips/{gtfs_id}/{route_id}/{trip_id}/{departure_time}）に
// 現れるGTFS識別子から「その便が今日DB側で運行中か」を引けないと、
// リアルタイム表示への切り替えボタンが作れない。ここでの突き合わせだけに用途を限定し、
// 他のコードから gtfsTimetable 側のインメモリインデックスへ依存させることはしない。
const pool = require('../config/db');
const { qualifyRouteId } = require('./gtfsFeedManager');
const { timeStrToMinutes, getServiceDateString } = require('../utils/time');
const { getArrivalsForAssignment, describeSource } = require('./etaPredictor');
const { describeArrivalMethod } = require('./passDetection');
const { getRuntimeSetting } = require('./runtimeSettings');
const { isRealtimeSuspended } = require('./realtimeSuspension');

/**
 * daily_trips.start_time（"H:mm"）を便詳細URLの departure_time 表記（"0805"）に変換する。
 * gtfsTimetable.js の formatHhmm と同じ0埋め2桁×2の表記に合わせる（24時超えはそのまま）。
 */
function startTimeToUrlHhmm(startTime) {
  const minutes = timeStrToMinutes(startTime);
  if (Number.isNaN(minutes)) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

/** 便詳細URLの departure_time（"0805"のような4桁、または"H:mm"）を分単位に変換する。 */
function urlDepartureTimeToMinutes(value) {
  const s = String(value || '').trim();
  if (!s) return NaN;
  if (s.includes(':')) return timeStrToMinutes(s);
  if (!/^\d{3,4}$/.test(s)) return NaN;
  const padded = s.padStart(4, '0');
  return Number.parseInt(padded.slice(0, 2), 10) * 60 + Number.parseInt(padded.slice(2), 10);
}

/**
 * 便詳細ページのURLパラメータから、当日DB上でその便を担当している
 * 割り当て（trip_vehicle_assignments, role='assigned' state='active'）を探す。
 * 見つからなければ null（＝現在リアルタイム運行していない）。
 *
 * 注意: frequencies.txt由来の仮想便で、始発時刻が24時を跨ぐ場合
 * （dailyTripBuilder.js の minutesToTimeStr が 24時で折り返す）は
 * URL側（折り返さない表記）とマッチしないことがある。この路線の運行時間帯
 * （早朝〜23時台）では実質発生しないため、対応を割愛している。
 */
async function findLiveAssignment(feedId, routeId, tripId, departureTime) {
  const qualifiedRouteId = qualifyRouteId(routeId, feedId);

  // 管理画面「リアルタイム休止」でこの路線のリアルタイム表示が止められている場合は、
  // 実際には担当車両が居ても「現在リアルタイム運行なし（null）」として返す。
  // この関数の外部呼び出し元（経路検索の重ね合わせ・便詳細のリアルタイム切替・
  // バス停の接近中バス）はいずれも null を soft-fail して定刻表示へ落ちるため、
  // ここ1か所のガードで公開面のリアルタイム表示をまとめて止められる。
  // 管理画面の運行監視は assignment_id 直引きの別経路（getAssignmentDetailForAdmin 等）で
  // このガードを通らないため、従来どおり全路線を監視できる（docs/realtime-suspension.md）。
  if (await isRealtimeSuspended(qualifiedRouteId)) return null;

  const targetMinutes = urlDepartureTimeToMinutes(departureTime);
  if (Number.isNaN(targetMinutes)) return null;

  const serviceDate = getServiceDateString();
  const result = await pool.query(
    `SELECT d.id AS daily_trip_id, d.start_time, d.headsign,
            a.id AS assignment_id, a.delay_minutes,
            v.id AS vehicle_id, v.car_id
     FROM daily_trips d
     JOIN schedule_trips st ON st.id = d.schedule_trip_id
     JOIN trip_vehicle_assignments a
       ON a.daily_trip_id = d.id AND a.role = 'assigned' AND a.state = 'active'
     JOIN vehicles v ON v.id = a.vehicle_id
     WHERE d.route_id = $1
       AND st.gtfs_trip_id = $2
       AND d.service_date = $3
       AND d.closed_at IS NULL`,
    [qualifiedRouteId, tripId, serviceDate]
  );

  return result.rows.find((row) => timeStrToMinutes(row.start_time) === targetMinutes) || null;
}

/**
 * 1便分のリアルタイム詳細（停車進捗・遅延・到着予測・車両位置）を組み立てる。
 * /api/buses の1件分と同じ形。findLiveAssignment() の結果行を渡す。
 */
async function buildBusEntry(t, routeId, routeName) {
  const stopRows = await pool.query(
    `SELECT p.stop_id,
            p.seq_order,
            p.scheduled_time,
            p.status,
            p.actual_time,
            p.delay_minutes,
            p.interpolated,
            s.name,
            s.lat,
            s.lon,
            s.notice,
            s.timetable_link
     FROM trip_stop_progress p
     JOIN stops s ON s.id = p.stop_id
     WHERE p.assignment_id = $1
     ORDER BY p.seq_order ASC`,
    [t.assignment_id]
  );

  const latestGpsResult = await pool.query(
    `SELECT lat, lon FROM vehicle_gps_log
     WHERE vehicle_id = $1
     ORDER BY gps_time_ts DESC, id DESC LIMIT 1`,
    [t.vehicle_id]
  );
  const latestGps = latestGpsResult.rows[0] || null;

  const predictions = await getArrivalsForAssignment(pool, t.assignment_id);
  const predictionBySeq = new Map(predictions.map((p) => [p.seqOrder, p]));

  const stops = stopRows.rows.map((r) => {
    const pred = predictionBySeq.get(r.seq_order);
    return {
      stopId: r.stop_id,
      seqOrder: r.seq_order,
      name: r.name,
      lat: r.lat,
      lng: r.lon,
      notice: r.notice,
      timetableLink: r.timetable_link,
      scheduledTime: r.scheduled_time,
      status: r.status,
      actualTime: r.actual_time,
      delayMinutes: r.delay_minutes,
      interpolated: r.interpolated,
      predictedTime: pred ? pred.predictedTime : r.scheduled_time,
      predictedDelayMinutes: pred ? pred.predictedDelayMinutes : 0
    };
  });

  return {
    id: t.car_id,
    tripId: t.daily_trip_id,
    startTime: t.start_time,
    routeId,
    routeName,
    headsign: t.headsign || null,
    isRealtime: true,
    delayMinutes: t.delay_minutes,
    lat: latestGps ? latestGps.lat : null,
    lng: latestGps ? latestGps.lon : null,
    stops
  };
}

/**
 * 管理画面「運行ダッシュボード」の地図：バスアイコンをタップしたときの詳細取得。
 * findLiveAssignment()がGTFS識別子(feedId/routeId/tripId/departureTime)からの橋渡しなのに対し、
 * こちらは既に判明している assignment_id（/api/buses-for-map のレスポンスに含まれる）から
 * 直接1件を引く。stops[]の組み立てはbuildBusEntry()をそのまま再利用し、ロジックを重複させない。
 * 見つからなければnull。
 */
async function getAssignmentDetailForAdmin(assignmentId) {
  const result = await pool.query(
    `SELECT a.id AS assignment_id, a.delay_minutes, a.became_assigned_at,
            d.id AS daily_trip_id, d.route_id, d.start_time, d.headsign,
            v.id AS vehicle_id, v.car_id,
            vl.name AS car_name, vl.memo AS car_memo,
            r.name AS route_name, r.color AS route_color, r.text_color AS route_text_color
     FROM trip_vehicle_assignments a
     JOIN daily_trips d ON d.id = a.daily_trip_id
     JOIN vehicles v ON v.id = a.vehicle_id
     LEFT JOIN vehicle_labels vl ON vl.car_id = v.car_id
     LEFT JOIN routes r ON r.id = d.route_id
     WHERE a.id = $1`,
    [assignmentId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const bus = await buildBusEntry(row, row.route_id, row.route_name || '不明な路線');

  // 「その車両がこの便を担当してから」記録された位置情報＝became_assigned_at以降のGPSログ。
  // 各点がバス停通過判定に使われていれば（trip_gps_matches）、そのバス停名・定刻も併せて返す
  // （地図上の位置履歴ホバー用）。48時間ログ削除の掃除ジョブは変更しない。
  const historyRes = await pool.query(
    `SELECT g.id, g.lat, g.lon, g.gps_time, g.gps_time_ts,
            tgm.stop_id AS matched_stop_id, s.name AS matched_stop_name,
            dts.scheduled_time AS matched_scheduled_time
     FROM vehicle_gps_log g
     LEFT JOIN trip_gps_matches tgm ON tgm.gps_log_id = g.id AND tgm.assignment_id = $1
     LEFT JOIN stops s ON s.id = tgm.stop_id
     LEFT JOIN daily_trip_stop_times dts ON dts.daily_trip_id = $2 AND dts.stop_id = tgm.stop_id
     WHERE g.vehicle_id = $3 AND g.gps_time_ts >= $4
     ORDER BY g.gps_time_ts ASC`,
    [assignmentId, row.daily_trip_id, row.vehicle_id, row.became_assigned_at]
  );

  const positionHistory = historyRes.rows.map((r) => ({
    id: r.id,
    lat: r.lat,
    lng: r.lon,
    gpsTime: r.gps_time,
    gpsTimeTs: r.gps_time_ts,
    matchedStopId: r.matched_stop_id,
    matchedStopName: r.matched_stop_name,
    matchedScheduledTime: r.matched_scheduled_time
  }));

  return {
    assignmentId: row.assignment_id,
    vehicleId: row.vehicle_id,
    carId: row.car_id,
    carName: row.car_name || null,
    carMemo: row.car_memo || null,
    routeId: row.route_id,
    routeName: row.route_name || '不明な路線',
    routeColor: row.route_color || null,
    routeTextColor: row.route_text_color || null,
    headsign: bus.headsign,
    startTime: bus.startTime,
    delayMinutes: bus.delayMinutes,
    becameAssignedAt: row.became_assigned_at,
    lat: bus.lat,
    lng: bus.lng,
    stops: bus.stops,
    positionHistory
  };
}

/**
 * 管理画面「運行ダッシュボード」のバス停別詳細モーダル用。1つの割り当て×1つのバス停について、
 *  - 到着済なら：到着判定方法（付近経由／ベクトル判定／手動 等）と根拠（内積・線分距離・前後GPS点
 *    ／最接近距離・観測GPS時刻 等）、遅れ分数
 *  - 未到着なら：現在のETA予測とその根拠（source＋ペース補正の内訳）
 * に加え、常にETA予測の推移（trip_arrival_prediction_log。実績確定時は source='actual' の行が付く）
 * を返す。見つからなければ null。
 */
async function getStopArrivalDetailForAdmin(assignmentId, stopId) {
  const stopRes = await pool.query(
    `SELECT p.stop_id, p.seq_order, p.scheduled_time, p.status, p.actual_time,
            p.delay_minutes, p.interpolated, p.arrival_method, p.arrival_evidence,
            p.nearby_min_distance_meters, p.nearby_min_distance_gps_time,
            s.name
     FROM trip_stop_progress p
     JOIN stops s ON s.id = p.stop_id
     WHERE p.assignment_id = $1 AND p.stop_id = $2`,
    [assignmentId, stopId]
  );
  const row = stopRes.rows[0];
  if (!row) return null;

  // --- 到着判定の根拠（到着済のときのみ組み立てる） ---
  let arrival = null;
  if (row.status === '到着済') {
    // arrival_method が未記録（本機能導入前の行）でも、interpolated フラグから線形補間だけは判別できる。
    const method = row.arrival_method || (row.interpolated ? 'interpolated' : 'unknown');
    const ev = row.arrival_evidence || {}; // node-pg が jsonb をJSオブジェクトへパース済み
    const info = describeArrivalMethod(row.arrival_method || (row.interpolated ? 'interpolated' : null));

    let vector = null;
    if (method === 'vector' && row.arrival_evidence) {
      vector = {
        stepDist: ev.stepDist,
        distP1Stop: ev.distP1Stop,
        distP2Stop: ev.distP2Stop,
        segDist: ev.segDist,
        dot: ev.dot,
        t: ev.t,
        p1: ev.p1 ? { lat: ev.p1.lat, lng: ev.p1.lon, gpsTime: ev.p1.gpsTime } : null,
        p2: ev.p2 ? { lat: ev.p2.lat, lng: ev.p2.lon, gpsTime: ev.p2.gpsTime } : null
      };
    }

    let nearby = null;
    if (method === 'nearby' || method === 'promoted' || method === 'finish') {
      const minDist = ev.minDistanceMeters ?? row.nearby_min_distance_meters ?? null;
      const gpsTime = ev.gpsTime ?? row.nearby_min_distance_gps_time ?? null;
      if (minDist !== null || gpsTime !== null || ev.marginMeters != null) {
        nearby = { minDistanceMeters: minDist, gpsTime, marginMeters: ev.marginMeters ?? null };
      }
    }

    arrival = {
      method,
      methodLabel: info.label,
      methodDescription: info.description,
      vector,
      nearby,
      note: ev.trigger || ev.note || null
    };
  }

  // --- 現在のETA予測（スナップショット）と根拠内訳 ---
  const predRes = await pool.query(
    `SELECT predicted_time, predicted_delay_minutes, source, computed_at,
            live_factor, today_previous_trip_factor, today_previous_trip_samples,
            nearby_factor, nearby_factor_samples, nearby_weight_mass, combined_pace_factor
     FROM trip_arrival_predictions
     WHERE assignment_id = $1 AND stop_id = $2`,
    [assignmentId, stopId]
  );
  let currentPrediction = null;
  const pr = predRes.rows[0];
  if (pr) {
    const si = describeSource(pr.source);
    currentPrediction = {
      predictedTime: pr.predicted_time,
      predictedDelayMinutes: pr.predicted_delay_minutes,
      source: pr.source,
      sourceLabel: si.label,
      sourceCategory: si.category,
      computedAt: pr.computed_at,
      // /admin/eta-basis と同じ整形（combined_pace_factor が非nullのときだけ内訳を返す）。
      paceBreakdown: pr.combined_pace_factor === null ? null : {
        liveFactor: pr.live_factor,
        todayPreviousTripFactor: pr.today_previous_trip_factor,
        todayPreviousTripSamples: pr.today_previous_trip_samples,
        nearbyFactor: pr.nearby_factor,
        nearbyFactorSamples: pr.nearby_factor_samples,
        nearbyWeightMass: pr.nearby_weight_mass,
        combinedPaceFactor: pr.combined_pace_factor
      }
    };
  }

  // --- ETA予測の推移（予測が変わるたび1行追記されている。到着済なら末尾が source='actual'） ---
  // ログは predicted_time / source / stops_before のいずれかが変われば追記されるため、
  // 到着後は predicted_time・source が同じまま stops_before だけが動いて同じ値が並ぶ。
  // 「推移」として見せたいのは (predicted_time, source) が変わった瞬間だけなので、
  // 連続する同値をまとめ、その値に最初になった時点（computed_at・stops_before）を代表にする。
  const histRes = await pool.query(
    `SELECT computed_at, predicted_time, predicted_delay_minutes, source, stops_before
     FROM trip_arrival_prediction_log
     WHERE assignment_id = $1 AND stop_id = $2
     ORDER BY computed_at ASC`,
    [assignmentId, stopId]
  );
  const predictionHistory = [];
  for (const h of histRes.rows) {
    const prev = predictionHistory[predictionHistory.length - 1];
    if (prev && prev.predictedTime === h.predicted_time && prev.source === h.source) continue;
    predictionHistory.push({
      computedAt: h.computed_at,
      predictedTime: h.predicted_time,
      predictedDelayMinutes: h.predicted_delay_minutes,
      source: h.source,
      sourceLabel: describeSource(h.source).label,
      stopsBefore: h.stops_before
    });
  }

  return {
    stopId: row.stop_id,
    seqOrder: row.seq_order,
    name: row.name,
    scheduledTime: row.scheduled_time,
    status: row.status,
    actualTime: row.actual_time,
    delayMinutes: row.delay_minutes,
    interpolated: row.interpolated,
    arrival,
    currentPrediction,
    predictionHistory
  };
}

/**
 * 位置履歴（gps_time_ts 昇順）から「GPS途絶（＝連続する2点の時間差が thresholdMinutes 以上）」を
 * 抽出する純関数。管理画面「異常アラート」のGPS途絶を地図で検証する機能から使う。
 *
 * - 途中の途絶（トンネル等で一時的に測位不良になり、その後復旧したもの）は
 *   { lost: 途絶直前の点, recovered: 復旧後の最初の点, ongoing:false } で返す。
 * - 末尾の途絶（最後の点以降ずっとGPSが来ておらず、割り当てがGPS途絶で打ち切られているもの）は
 *   endedForGpsLoss=true のときだけ { lost: 最後の点, recovered: null, ongoing:true } で返す。
 * - どの outage が「便を打ち切った途絶」か（primary）は、配列の並びが時系列昇順なので常に末尾。
 *
 * @param {Array<{lat:number,lng:number,gpsTime:string,gpsTimeTs:string}>} history
 * @param {number} thresholdMinutes 途絶とみなす連続点間の分数
 * @param {number} nowMs 現在時刻（ミリ秒。テスト用に注入可能）
 * @param {boolean} endedForGpsLoss 割り当てが end_reason='GPS更新停止' で終了しているか
 */
function detectGpsOutages(history, thresholdMinutes, nowMs, endedForGpsLoss) {
  const outages = [];
  const thresholdMs = thresholdMinutes * 60000;
  const ts = (p) => new Date(p.gpsTimeTs).getTime();

  for (let i = 0; i + 1 < history.length; i++) {
    const gapMs = ts(history[i + 1]) - ts(history[i]);
    if (gapMs >= thresholdMs) {
      outages.push({
        lost: history[i],
        recovered: history[i + 1],
        durationMinutes: Math.round(gapMs / 60000),
        ongoing: false
      });
    }
  }

  const last = history[history.length - 1];
  if (last && endedForGpsLoss) {
    const sinceMs = nowMs - ts(last);
    if (sinceMs >= thresholdMs) {
      outages.push({
        lost: last,
        recovered: null,
        durationMinutes: Math.round(sinceMs / 60000),
        ongoing: true
      });
    }
  }
  return outages;
}

/**
 * 管理画面「異常アラート」のGPS途絶（type='gpsLostTrip'）を地図で検証するための詳細。
 * getAssignmentDetailForAdmin() の結果（停車バス停・位置履歴・リアルタイム時刻表）に加えて、
 *   - 途絶の一覧（途絶時刻・地点、復旧時刻・地点、継続分数、途絶中かどうか）
 *   - 「便を打ち切った途絶」の時点で時刻表のどこまで進んでいたか（直近到着済バス停・次のバス停）
 * を返す。位置履歴は became_assigned_at 以降のこの車両の全GPSログなので、便打ち切り後に
 * 復旧して走り続けた場合の復旧地点もそのまま含まれる（GPS_LOG_RETENTION_HOURS＝既定48時間で
 * 消えるため、それを過ぎると走行経路は空になる）。見つからなければ null。
 */
async function getGpsOutageDetailForAdmin(assignmentId) {
  const base = await getAssignmentDetailForAdmin(assignmentId);
  if (!base) return null;

  const metaRes = await pool.query(
    `SELECT end_reason, ended_at, state FROM trip_vehicle_assignments WHERE id = $1`,
    [assignmentId]
  );
  const meta = metaRes.rows[0] || {};
  // 末尾（最後のGPS点以降ずっと途絶）を「継続中の途絶」として扱う条件：
  //   - まだ稼働中の割り当て（staleGpsアラートから開いたケース。打ち切り前）、または
  //   - GPS途絶で打ち切られた割り当て（gpsLostTripアラートから開いたケース）
  // 終点到着で正常終了した割り当てはGPSが自然に止まるだけなので対象外。
  const treatTrailingGapAsOutage = meta.state === 'active'
    || (meta.state === 'ended' && meta.end_reason === 'GPS更新停止');

  const thresholdMinutes = getRuntimeSetting('GPS_STALE_TIMEOUT_MIN');
  const retentionHours = getRuntimeSetting('GPS_LOG_RETENTION_HOURS');
  const outages = detectGpsOutages(base.positionHistory, thresholdMinutes, Date.now(), treatTrailingGapAsOutage);
  const primary = outages.length > 0 ? outages[outages.length - 1] : null;

  // 「便を打ち切った途絶」の時点でどこまで進んでいたか。
  // 途絶時刻（primary.lost.gpsTime, "H:mm"）以前に到着済になっているバス停のうち最も先のものを
  // 直近到着済とみなす。位置履歴が保持期間切れで空のときは、時刻での絞り込みをせず
  // 「最後に到着済になっているバス停」を使う（途絶後は新たな到着判定が起きないため近似が成り立つ）。
  const lostMinuteOfDay = primary ? timeStrToMinutes(primary.lost.gpsTime) : NaN;
  const arrived = base.stops.filter((s) => s.status === '到着済' && s.actualTime);
  const lastArrived = arrived
    .filter((s) => Number.isNaN(lostMinuteOfDay) || timeStrToMinutes(s.actualTime) <= lostMinuteOfDay)
    .reduce((acc, s) => (!acc || s.seqOrder > acc.seqOrder ? s : acc), null);
  const afterSeq = lastArrived ? lastArrived.seqOrder : -1;
  const nextStop = base.stops.find((s) => s.seqOrder > afterSeq && s.status !== '通過') || null;

  const toOutage = (o) => ({
    lostAt: o.lost.gpsTimeTs,
    lostGpsTime: o.lost.gpsTime,
    lostLat: o.lost.lat,
    lostLng: o.lost.lng,
    recoveredAt: o.recovered ? o.recovered.gpsTimeTs : null,
    recoveredGpsTime: o.recovered ? o.recovered.gpsTime : null,
    recoveredLat: o.recovered ? o.recovered.lat : null,
    recoveredLng: o.recovered ? o.recovered.lng : null,
    durationMinutes: o.durationMinutes,
    ongoing: o.ongoing
  });

  return {
    ...base,
    endReason: meta.end_reason || null,
    endedAt: meta.ended_at || null,
    assignmentState: meta.state || null,
    thresholdMinutes,
    retentionHours,
    historyRetentionExpired: base.positionHistory.length === 0,
    outages: outages.map(toOutage),
    primaryOutage: primary ? toOutage(primary) : null,
    progressAtLoss: {
      totalStops: base.stops.length,
      arrivedCount: base.stops.filter((s) => s.status === '到着済').length,
      lastArrivedStop: lastArrived
        ? {
            stopId: lastArrived.stopId,
            seqOrder: lastArrived.seqOrder,
            name: lastArrived.name,
            scheduledTime: lastArrived.scheduledTime,
            actualTime: lastArrived.actualTime,
            delayMinutes: lastArrived.delayMinutes
          }
        : null,
      nextStop: nextStop
        ? {
            stopId: nextStop.stopId,
            seqOrder: nextStop.seqOrder,
            name: nextStop.name,
            scheduledTime: nextStop.scheduledTime,
            predictedTime: nextStop.predictedTime,
            predictedDelayMinutes: nextStop.predictedDelayMinutes
          }
        : null
    }
  };
}

module.exports = {
  findLiveAssignment,
  buildBusEntry,
  getAssignmentDetailForAdmin,
  getStopArrivalDetailForAdmin,
  getGpsOutageDetailForAdmin,
  detectGpsOutages,
  urlDepartureTimeToMinutes,
  startTimeToUrlHhmm
};
