// 仕様書 第9項「予想到着時刻の高度化」に対応するモジュール。
//
// 旧ロジック（単純加算方式）: 現在の遅延時間をそのまま残り全区間へ加算するだけだった。
//
// 新ロジック: 過去に蓄積された「同一曜日区分×同一時間帯×同一区間」の走行時間統計
// (segment_travel_stats) を参照しつつ、当該便の直近の実績ペース（liveFactor）で
// 補正した所要時間を積み上げて残り各バス停の到着時刻を予測する。
// 統計データが不足する区間・便については、時刻表上の所要時間 or 単純遅延加算に
// 段階的にフォールバックし、常に何らかの予測値を返せるようにしている。
const { timeStrToMinutes, minutesToTimeStr, getDayType, computeDelayMinutes } = require('../utils/time');

const MIN_SAMPLES_FOR_TRUST = 3;
const BLEND_WEIGHT = parseFloat(process.env.ETA_BLEND_WEIGHT || '0.55'); // 過去統計への信頼度(0-1)
const LIVE_SEGMENTS_FOR_PACE = 3; // 直近何区間の実績からペースを算出するか

/**
 * scheduled_time が実際の時刻情報として使える値かどうかを判定する。
 * NULL・空文字・「↓」「通過」などの非時刻データはすべて無効(false)。
 * （timeStrToMinutesはこれらに対して既にNaNを返す実装になっているため、それを利用する）
 */
function isValidTime(t) {
  return !Number.isNaN(timeStrToMinutes(t));
}

/**
 * completed_trips のうち未集計のものを segment_travel_stats へインクリメンタル反映する。
 */
async function updateSegmentStats(client) {
  const pending = await client.query(
    `SELECT id, day_of_week FROM completed_trips WHERE aggregated = FALSE ORDER BY id ASC LIMIT 200`
  );
  if (pending.rows.length === 0) return { aggregated: 0 };

  for (const trip of pending.rows) {
    const stopTimes = await client.query(
      `SELECT stop_id, seq_order, actual_minutes FROM completed_trip_stop_times
       WHERE completed_trip_id = $1 AND actual_minutes IS NOT NULL
       ORDER BY seq_order ASC`,
      [trip.id]
    );
    const rows = stopTimes.rows;
    const dayType = trip.day_of_week === 0 ? 'holiday' : trip.day_of_week === 6 ? 'saturday' : 'weekday';

    for (let i = 0; i < rows.length - 1; i++) {
      const from = rows[i];
      const to = rows[i + 1];
      if (to.seq_order - from.seq_order !== 1) continue; // 隣接区間のみ統計対象にする

      let diffMin = to.actual_minutes - from.actual_minutes;
      if (diffMin < 0) diffMin += 24 * 60;
      if (diffMin <= 0 || diffMin > 60) continue; // 異常値除外（1区間60分超は測定誤りとみなす）

      const seconds = diffMin * 60;
      const hourBucket = Math.floor(to.actual_minutes / 60) % 24;

      const existing = await client.query(
        `SELECT sample_count, avg_seconds FROM segment_travel_stats
         WHERE from_stop_id = $1 AND to_stop_id = $2 AND day_type = $3 AND hour_bucket = $4`,
        [from.stop_id, to.stop_id, dayType, hourBucket]
      );

      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO segment_travel_stats (from_stop_id, to_stop_id, day_type, hour_bucket, sample_count, avg_seconds, updated_at)
           VALUES ($1, $2, $3, $4, 1, $5, now())`,
          [from.stop_id, to.stop_id, dayType, hourBucket, seconds]
        );
      } else {
        const { sample_count: n, avg_seconds: avg } = existing.rows[0];
        const newCount = n + 1;
        const newAvg = (avg * n + seconds) / newCount;
        await client.query(
          `UPDATE segment_travel_stats
           SET sample_count = $1, avg_seconds = $2, updated_at = now()
           WHERE from_stop_id = $3 AND to_stop_id = $4 AND day_type = $5 AND hour_bucket = $6`,
          [newCount, newAvg, from.stop_id, to.stop_id, dayType, hourBucket]
        );
      }
    }

    await client.query(`UPDATE completed_trips SET aggregated = TRUE WHERE id = $1`, [trip.id]);
  }

  return { aggregated: pending.rows.length };
}

async function getSegmentStat(client, fromStopId, toStopId, dayType, hourBucket) {
  const res = await client.query(
    `SELECT sample_count, avg_seconds FROM segment_travel_stats
     WHERE from_stop_id = $1 AND to_stop_id = $2 AND day_type = $3 AND hour_bucket = $4`,
    [fromStopId, toStopId, dayType, hourBucket]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

/**
 * 指定車両の残り各バス停に対する予測到着時刻を算出する。
 * 戻り値: [{ stopId, seqOrder, predictedTime, predictedDelayMinutes, source }]
 *   source: 'historical'（統計採用） | 'schedule_paced'（時刻表所要時間×ペース補正）
 *         | 'naive_anchored'（通過区間を基準駅からの定刻差分で算出） | 'through_skip'（通過駅本体・時間を進めない）
 *         | 'naive'（統計・基準駅とも不明な異常系の最終フォールバック）
 *
 * 仕様書 第9項 追加修正:
 *   ①通過バス停を跨ぐ区間は、データ汚染防止のため統計/ペース補正を使わない。
 *     ただし通過駅の scheduled_time はNULLや「↓」など非時刻データのため、
 *     単純に前駅との差分を取ると5分固定フォールバックが連鎖し予測が大暴走する。
 *     そのため「最後に有効な時刻表を持っていた通常停車駅(lastValidStop)」を
 *     基準に、有効な定刻同士の差分のみで絶対時刻を算出する。
 *   ②通常停車バス停（有効な時刻表を持つ駅）で予測が定刻を下回る場合は、
 *     早発防止のため定刻まで床打ちする。通過駅は対象外。
 */
async function predictArrivals(client, vehicleId) {
  const rows = await client.query(
    `SELECT vss.stop_id, vss.seq_order, vss.scheduled_time, vss.status, vss.actual_time, s.name
     FROM vehicle_stop_status vss
     JOIN stops s ON s.id = vss.stop_id
     WHERE vss.vehicle_id = $1
     ORDER BY vss.seq_order ASC`,
    [vehicleId]
  );
  const stops = rows.rows;
  if (stops.length === 0) return [];

  const dayType = getDayType();

  // 直近の実績区間からペース係数(liveFactor)を算出する
  const arrived = stops.filter((s) => s.status === '到着済' && s.actual_time);
  let liveFactor = 1;
  if (arrived.length >= 2) {
    const recentPairs = [];
    for (let i = Math.max(0, arrived.length - 1 - LIVE_SEGMENTS_FOR_PACE); i < arrived.length - 1; i++) {
      const from = arrived[i];
      const to = arrived[i + 1];
      if (to.seq_order - from.seq_order !== 1) continue;
      const fromMin = timeStrToMinutes(from.actual_time);
      const toMin = timeStrToMinutes(to.actual_time);
      if (Number.isNaN(fromMin) || Number.isNaN(toMin)) continue;
      let actualDiff = toMin - fromMin;
      if (actualDiff < 0) actualDiff += 24 * 60;

      const hourBucket = Math.floor(toMin / 60) % 24;
      const stat = await getSegmentStat(client, from.stop_id, to.stop_id, dayType, hourBucket);
      let baseline = null;
      if (stat && stat.sample_count >= MIN_SAMPLES_FOR_TRUST) {
        baseline = stat.avg_seconds / 60;
      } else if (from.scheduled_time && to.scheduled_time) {
        const s1 = timeStrToMinutes(from.scheduled_time);
        const s2 = timeStrToMinutes(to.scheduled_time);
        if (!Number.isNaN(s1) && !Number.isNaN(s2)) {
          let d = s2 - s1;
          if (d < 0) d += 24 * 60;
          if (d > 0) baseline = d;
        }
      }
      if (baseline && baseline > 0) {
        recentPairs.push(actualDiff / baseline);
      }
    }
    if (recentPairs.length > 0) {
      liveFactor = recentPairs.reduce((a, b) => a + b, 0) / recentPairs.length;
      liveFactor = Math.max(0.5, Math.min(2.5, liveFactor)); // 異常なペース補正を抑制
    }
  }

  const lastArrived = arrived.length > 0 ? arrived[arrived.length - 1] : null;
  let cursorMinutes = lastArrived ? timeStrToMinutes(lastArrived.actual_time) : null;
  let cursorSeq = lastArrived ? lastArrived.seq_order : -1;

  // 現在の単純遅延（フォールバック用）
  const currentDelay =
    lastArrived && lastArrived.scheduled_time
      ? computeDelayMinutes(lastArrived.scheduled_time, lastArrived.actual_time) || 0
      : 0;

  if (cursorMinutes === null) {
    // まだどこにも到着していない（始発前）場合は時刻表どおりを返す
    return stops.map((s) => ({
      stopId: s.stop_id,
      seqOrder: s.seq_order,
      predictedTime: s.scheduled_time,
      predictedDelayMinutes: 0,
      source: 'schedule'
    }));
  }

  const results = [];
  let prevStop = lastArrived;
  // 「最後に有効な時刻表を持っていた通常停車駅」を基準駅として保持する。
  // 通過区間(↓)を跨ぐ際は、直前駅(prevStop)ではなく必ずこの基準駅からの
  // 定刻差分で絶対時刻を算出することで、5分固定フォールバックの連鎖（大暴走）を防ぐ。
  let lastValidStop = prevStop;

  for (const s of stops) {
    if (s.seq_order <= cursorSeq) {
      results.push({
        stopId: s.stop_id,
        seqOrder: s.seq_order,
        predictedTime: s.actual_time,
        predictedDelayMinutes: s.status === '到着済' && s.scheduled_time
          ? (computeDelayMinutes(s.scheduled_time, s.actual_time) || 0)
          : 0,
        source: 'actual'
      });
      continue;
    }

    // 【仕様①】通過（＝定刻が不明な）区間を跨ぐ場合の一括フォールバック
    // 予測対象(s)または直前(prevStop)のいずれかの scheduled_time が無効
    // （NULL・「↓」など）な場合、その区間は統計データが歪んでいたり
    // 存在しなかったりするため、過去統計(historical)やペース補正
    // (schedule_paced)を一切使わない。
    // 判定はステータス('通過')ではなく scheduled_time の有効性(isValidTime)で
    // 行う。これは、"本来の経由・非停車駅（通過）"だけでなく、"その便の終点より
    // 先でまだ運行終了と確定していないだけのバス停（status=''のまま）"も
    // 同じく scheduled_time が無いため、どちらも同じ安全な計算に乗せる必要が
    // あるため（statusだけで判定すると後者が5分固定フォールバックの連鎖で
    // 予測時刻が大暴走してしまう）。
    // 「最後に有効な時刻表を持っていた通常停車駅(lastValidStop)」を基準に、
    // 有効な定刻同士の差分だけで絶対時刻を算出し直すことで、これを防ぐ。
    // 前後とも有効な時刻表を持つ駅に戻った時点で、自動的に本来の高度な予測
    // （historical/schedule_paced）へ復帰する。
    const isThroughSegment = !isValidTime(s.scheduled_time) || !isValidTime(prevStop.scheduled_time);

    let segmentMinutes;
    let source;

    if (isThroughSegment) {
      const sHasValidTime = isValidTime(s.scheduled_time);
      const anchorHasValidTime = lastValidStop && isValidTime(lastValidStop.scheduled_time);

      if (!sHasValidTime) {
        // 計算対象の駅自体が「↓」等で有効な時刻表を持たない（通過駅本体）
        // → 時間は進めずスキップ処理する。
        segmentMinutes = 0;
        source = 'through_skip';
      } else if (anchorHasValidTime) {
        // 基準駅の予測(実績)時刻 ＋ 基準駅⇔対象駅の定刻差分 － 現在のcursorMinutes
        // という絶対時刻ベースの計算により、5分固定値を連鎖加算しない。
        const anchorSchedMin = timeStrToMinutes(lastValidStop.scheduled_time);
        const anchorResolvedMin = timeStrToMinutes(lastValidStop.actual_time);
        let diff = timeStrToMinutes(s.scheduled_time) - anchorSchedMin;
        if (diff < 0) diff += 24 * 60; // 安全策（日跨ぎ）
        const targetMinutes = anchorResolvedMin + diff;
        segmentMinutes = targetMinutes - cursorMinutes;
        source = 'naive_anchored';
      } else {
        // 基準駅すら有効な時刻表を持たない異常系のみ、最終手段として5分を使う
        segmentMinutes = 5;
        source = 'naive';
      }
    } else {
      const hourBucket = Math.floor(cursorMinutes / 60) % 24;
      const stat = await getSegmentStat(client, prevStop.stop_id, s.stop_id, dayType, hourBucket);

      if (stat && stat.sample_count >= MIN_SAMPLES_FOR_TRUST) {
        const historicalMinutes = stat.avg_seconds / 60;
        segmentMinutes = historicalMinutes * (BLEND_WEIGHT + (1 - BLEND_WEIGHT) * liveFactor);
        source = 'historical';
      } else if (prevStop.scheduled_time && s.scheduled_time) {
        const s1 = timeStrToMinutes(prevStop.scheduled_time);
        const s2 = timeStrToMinutes(s.scheduled_time);
        let scheduledDiff = !Number.isNaN(s1) && !Number.isNaN(s2) ? s2 - s1 : NaN;
        if (!Number.isNaN(scheduledDiff)) {
          if (scheduledDiff < 0) scheduledDiff += 24 * 60;
          segmentMinutes = scheduledDiff * liveFactor;
          source = 'schedule_paced';
        }
      }

      if (segmentMinutes === undefined || Number.isNaN(segmentMinutes)) {
        // 最終フォールバック: 元の単純方式（時刻表上の所要時間をそのまま加算）
        segmentMinutes = s.scheduled_time && prevStop.scheduled_time
          ? Math.max(0, timeStrToMinutes(s.scheduled_time) - timeStrToMinutes(prevStop.scheduled_time))
          : 5;
        source = 'naive';
      }
    }

    cursorMinutes = ((cursorMinutes + segmentMinutes) % (24 * 60) + 24 * 60) % (24 * 60);

    // 【仕様②】早発防止ロジック
    // 有効な時刻表(isValidTime)を持つ通常停車バス停に限り、予測時刻が定刻を
    // 下回った場合は、バス停での時間調整（定刻までの待機）をシミュレートし、
    // 定刻まで床打ちする。通過駅（isValidTimeがfalse）はそもそも定刻が
    // 存在しないため対象外とする。補正後の時刻は次区間の出発基準時刻として
    // そのまま引き継がれる。
    const sHasValidScheduledTime = isValidTime(s.scheduled_time);
    if (sHasValidScheduledTime) {
      const schedMin = timeStrToMinutes(s.scheduled_time);
      if (cursorMinutes < schedMin) {
        cursorMinutes = schedMin;
      }
    }

    const predictedTime = minutesToTimeStr(Math.round(cursorMinutes));
    const predictedDelay = sHasValidScheduledTime
      ? (computeDelayMinutes(s.scheduled_time, predictedTime) ?? currentDelay)
      : currentDelay;

    results.push({
      stopId: s.stop_id,
      seqOrder: s.seq_order,
      predictedTime,
      predictedDelayMinutes: predictedDelay,
      source
    });

    prevStop = { ...s, actual_time: predictedTime };

    // 基準駅（lastValidStop）の更新: 処理中の駅が有効な時刻表を持っている
    // 場合のみ、直近で確定した prevStop を新たな基準駅とする。
    if (sHasValidScheduledTime) {
      lastValidStop = prevStop;
    }
  }

  return results;
}

module.exports = { updateSegmentStats, predictArrivals };