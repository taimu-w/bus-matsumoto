// 仕様書 第9項「予想到着時刻の高度化」に対応するモジュール。
//
// 旧ロジック（単純加算方式）: 現在の遅延時間をそのまま残り全区間へ加算するだけだった。
//
// 新ロジック: 過去に蓄積された「同一曜日区分×同一時間帯×同一区間」の走行時間統計
// (segment_travel_stats) を参照しつつ、当該便の直近の実績ペース（liveFactor）で
// 補正した所要時間を積み上げて残り各バス停の到着時刻を予測する。
// 統計データが不足する区間・便については、時刻表上の所要時間 or 単純遅延加算に
// 段階的にフォールバックし、常に何らかの予測値を返せるようにしている。
const pool = require('../config/db');
const { timeStrToMinutes, minutesToTimeStr, getDayType, computeDelayMinutes } = require('../utils/time');
const { loadHolidaySet } = require('./holidayCalendar');

const MIN_SAMPLES_FOR_TRUST = 3;
const BLEND_WEIGHT = parseFloat(process.env.ETA_BLEND_WEIGHT || '0.55'); // 過去統計への信頼度(0-1)
const LIVE_SEGMENTS_FOR_PACE = 3; // 直近何区間の実績からペースを算出するか

// 遅延予測の暴走防止（仕様③、docs参照なし・口頭仕様）: 統計・ペース補正だけに
// 任せると、データが薄い区間で誤差が連鎖的に積み上がり、起点ではわずか1分の
// 遅れだったものが終点では1時間超という非現実的な予測に育ってしまうことが
// あった。これを防ぐため、現在の遅れ(currentDelay。起点＝直近到着済みバス停
// での実績遅延)を基準に、以降の各バス停で許容する予測遅延の上限を段階的に
// 定める。上限は「現在の遅れが小さいほど、その後の伸び幅を厳しく制限する」
// 設計にしてあり、結果として遅れが解消される方向の予測が相対的に選ばれ
// やすくなる。DELAY_RECOVERY_BOOSTは、生の予測(rawDelay)がcurrentDelayを
// 下回る場合（＝アルゴリズム自体が既に遅れ解消を見込んでいる場合）に、その
// 解消幅を上乗せして現行仕様よりやや多めに遅れが解消されるようにするための
// 係数。極端にならない範囲で1.15倍にとどめている。
const DELAY_RECOVERY_BOOST = 1.15;

/**
 * scheduled_time が実際の時刻情報として使える値かどうかを判定する。
 * NULL・空文字・「↓」「通過」などの非時刻データはすべて無効(false)。
 * （timeStrToMinutesはこれらに対して既にNaNを返す実装になっているため、それを利用する）
 */
function isValidTime(t) {
  return !Number.isNaN(timeStrToMinutes(t));
}

/**
 * 現在の遅れ(currentDelay)に応じて、以降のバス停で許容する予測遅延の上限(分)を返す。
 * 30分を超える場合は、これ以上遅れが増えるとは見込まず currentDelay 自体を上限にする
 * （＝単純加算方式と同じ結果になる。短縮方向の予測は capPredictedDelay 側で別途扱う）。
 */
function resolveDelayCeiling(currentDelay) {
  if (currentDelay <= 0) return 2;
  if (currentDelay <= 1) return 5;
  if (currentDelay <= 2) return 7;
  if (currentDelay <= 3) return 9;
  if (currentDelay <= 15) return currentDelay * 2;
  if (currentDelay <= 30) return 40;
  return currentDelay;
}

/**
 * 区間計算で得た生の予測遅延(rawDelay)を、現在の遅れ(currentDelay)を基準に補正する。
 * - rawDelay が currentDelay を下回る（＝遅れ解消方向の予測）場合は、その解消幅を
 *   DELAY_RECOVERY_BOOST倍だけ多めに見込む（0分未満にはならないよう下限0でクランプ）。
 * - それ以外（横ばい・悪化方向）は resolveDelayCeiling() の上限でクランプする。
 */
function capPredictedDelay(rawDelay, currentDelay) {
  if (rawDelay < currentDelay) {
    const recovered = (currentDelay - rawDelay) * DELAY_RECOVERY_BOOST;
    return Math.max(0, Math.round(currentDelay - recovered));
  }
  return Math.round(Math.min(rawDelay, resolveDelayCeiling(currentDelay)));
}

/**
 * completed_trips のうち未集計のものを segment_travel_stats へインクリメンタル反映する。
 */
async function updateSegmentStats(client) {
  // is_official = TRUE（＝その便の実績として正とみなす、最後に担当車両だった記録）だけを
  // 集計する。候補車両止まりの記録を混ぜると、別経路をたまたま走っていた車両の所要時間で
  // 区間統計が汚染される。また担当が切り替わった便で同じ区間を二重計上することも防げる。
  const pending = await client.query(
    `SELECT id, day_of_week, day_type FROM completed_trips
     WHERE aggregated = FALSE AND is_official = TRUE
     ORDER BY id ASC LIMIT 200`
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
    // day_type は祝日カレンダー反映済み（finishService.jsのarchiveAssignment()参照）。
    // 祝日カレンダー導入前にアーカイブされ day_type が未設定の行のみ、
    // 従来ロジック（日曜のみholiday扱い）にフォールバックする。
    const dayType = trip.day_type || (trip.day_of_week === 0 ? 'holiday' : trip.day_of_week === 6 ? 'saturday' : 'weekday');

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
 * 指定した便への割り当て（assignment）の、残り各バス停に対する予測到着時刻を算出する。
 * 便起点方式では進捗が (便 × 車両) 単位になったため、車両IDではなく割り当てIDを受け取る。
 * 予測アルゴリズムそのものは従来から一切変更していない。
 * 戻り値: [{ stopId, seqOrder, predictedTime, predictedDelayMinutes, source, stopsBefore }]
 *   source: 'historical'（統計採用） | 'schedule_paced'（時刻表所要時間×ペース補正）
 *         | 'naive_anchored'（通過区間を基準駅からの定刻差分で算出） | 'through_skip'（通過駅本体・時間を進めない）
 *         | 'naive'（統計・基準駅とも不明な異常系の最終フォールバック）
 *   stopsBefore: 予測時点で対象停留所の何停留所手前に居たか（cursorSeqとの差。
 *     予測精度監視で「何停留所前に出した予測か」の軸に使う。算出アルゴリズムの
 *     判定には一切使わない、付随メタデータ）
 *
 * 仕様書 第9項 追加修正:
 *   ①通過バス停を跨ぐ区間は、データ汚染防止のため統計/ペース補正を使わない。
 *     ただし通過駅の scheduled_time はNULLや「↓」など非時刻データのため、
 *     単純に前駅との差分を取ると5分固定フォールバックが連鎖し予測が大暴走する。
 *     そのため「最後に有効な時刻表を持っていた通常停車駅(lastValidStop)」を
 *     基準に、有効な定刻同士の差分のみで絶対時刻を算出する。
 *   ②通常停車バス停（有効な時刻表を持つ駅）で予測が定刻を下回る場合は、
 *     早発防止のため定刻まで床打ちする。通過駅は対象外。
 *   ③現在の遅れ(currentDelay)を基準に、以降の予測遅延に上限を設ける
 *     （resolveDelayCeiling）。統計・ペース補正だけでは誤差が連鎖的に積み
 *     上がり、起点はわずかな遅れでも終点では非現実的な大遅延になってしまう
 *     ことがあったための対策。遅れ解消方向の予測はさらにやや強調する
 *     （capPredictedDelay／DELAY_RECOVERY_BOOST）。通過駅は対象外。
 */
async function predictArrivals(client, assignmentId) {
  const rows = await client.query(
    `SELECT p.stop_id, p.seq_order, p.scheduled_time, p.status, p.actual_time, s.name
     FROM trip_stop_progress p
     JOIN stops s ON s.id = p.stop_id
     WHERE p.assignment_id = $1
     ORDER BY p.seq_order ASC`,
    [assignmentId]
  );
  const stops = rows.rows;
  if (stops.length === 0) return [];

  const holidaySet = await loadHolidaySet(client);
  const dayType = getDayType(new Date(), holidaySet);

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
      source: 'schedule',
      stopsBefore: s.seq_order - cursorSeq // cursorSeq=-1（まだどこにも到着していない）
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
        source: 'actual',
        stopsBefore: s.seq_order - cursorSeq // 実績確定行（0以下）。予測精度分析では参照しない
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
    const schedMin = sHasValidScheduledTime ? timeStrToMinutes(s.scheduled_time) : null;
    if (sHasValidScheduledTime && cursorMinutes < schedMin) {
      cursorMinutes = schedMin;
    }

    let predictedTime = minutesToTimeStr(Math.round(cursorMinutes));
    let predictedDelay = sHasValidScheduledTime
      ? (computeDelayMinutes(s.scheduled_time, predictedTime) ?? currentDelay)
      : currentDelay;

    // 【仕様③】遅延予測の上限キャップ／短縮強調。通過駅(scheduled_timeが無効)は
    // currentDelayをそのまま使っているだけなので対象外（上限を跨ぐことはない）。
    if (sHasValidScheduledTime) {
      const cappedDelay = capPredictedDelay(predictedDelay, currentDelay);
      if (cappedDelay !== predictedDelay) {
        predictedDelay = cappedDelay;
        cursorMinutes = ((schedMin + predictedDelay) % (24 * 60) + 24 * 60) % (24 * 60);
        predictedTime = minutesToTimeStr(Math.round(cursorMinutes));
      }
    }

    results.push({
      stopId: s.stop_id,
      seqOrder: s.seq_order,
      predictedTime,
      predictedDelayMinutes: predictedDelay,
      source,
      // 予測時点で、対象の停留所の何停留所手前に居たか（cursorSeqは実績到着済みの最後尾で
      // ループ中は変化しない）。予測精度監視で「何停留所前に出した予測か」の軸に使う。
      stopsBefore: s.seq_order - cursorSeq
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

/**
 * 予測値の履歴ログ(trip_arrival_prediction_log)への追記。
 * 「予測はいつの時点のものかで常に変動する」ため、予測精度の監視には最新値の
 * UPSERTだけでは足りず、時系列の履歴が要る。直前に記録した値（predicted_time・
 * source）から変化があった停留所だけを1行追記することで書き込み量を抑える。
 * 到着済み区間は source='actual'・predicted_time=実績時刻として記録されるため、
 * 「その停留所への予測がどう変遷し、実際いつ着いたか」がこのテーブル単体で揃う。
 * 呼び出し側(computeAndStoreAllArrivals)で個別にtry/catchし、失敗してもETA本体の
 * 計算・保存には一切影響させない。
 */
async function logPredictionChanges(client, assignmentId, dailyTripId, routeId, arrivals) {
  if (arrivals.length === 0) return;

  const lastRes = await client.query(
    `SELECT DISTINCT ON (stop_id) stop_id, predicted_time, source, stops_before
     FROM trip_arrival_prediction_log
     WHERE assignment_id = $1
     ORDER BY stop_id, computed_at DESC`,
    [assignmentId]
  );
  const lastByStop = new Map(lastRes.rows.map((r) => [r.stop_id, r]));

  const toInsert = arrivals.filter((a) => {
    const prev = lastByStop.get(a.stopId);
    return !prev || prev.predicted_time !== a.predictedTime || prev.source !== a.source || prev.stops_before !== a.stopsBefore;
  });
  if (toInsert.length === 0) return;

  await client.query(
    `INSERT INTO trip_arrival_prediction_log
       (assignment_id, daily_trip_id, route_id, stop_id, seq_order, predicted_time, predicted_delay_minutes, source, stops_before, computed_at)
     SELECT $1, $2, $3, t.stop_id, t.seq_order, t.predicted_time, t.predicted_delay_minutes, t.source, t.stops_before, now()
     FROM unnest($4::int[], $5::int[], $6::text[], $7::int[], $8::text[], $9::int[])
       AS t(stop_id, seq_order, predicted_time, predicted_delay_minutes, source, stops_before)`,
    [
      assignmentId,
      dailyTripId,
      routeId,
      toInsert.map((a) => a.stopId),
      toInsert.map((a) => a.seqOrder),
      toInsert.map((a) => a.predictedTime),
      toInsert.map((a) => a.predictedDelayMinutes),
      toInsert.map((a) => a.source),
      toInsert.map((a) => a.stopsBefore)
    ]
  );
}

/**
 * 全 active な割り当て（担当・候補とも）に対する ETA を一括計算し、
 * trip_arrival_predictions へ UPSERT する。パイプライン内から delayCalc() の
 * 直後に呼ばれる（設計書 docs/design-eta-precompute.md）。
 * predictArrivals() 自体はここでもオンデマンド計算時と同じものを使う。
 * アルゴリズムを重複実装しないため。
 * @returns {Promise<{computed: number, stored: number, deleted: number}>}
 */
async function computeAndStoreAllArrivals() {
  const client = await pool.connect();
  const startedAt = Date.now();
  let computed = 0;
  let stored = 0;
  try {
    const assignments = await client.query(
      `SELECT a.id, a.daily_trip_id, d.route_id
       FROM trip_vehicle_assignments a
       JOIN daily_trips d ON d.id = a.daily_trip_id
       WHERE a.state = 'active' ORDER BY a.id ASC`
    );

    for (const assignment of assignments.rows) {
      try {
        const arrivals = await predictArrivals(client, assignment.id);
        if (arrivals.length === 0) {
          computed++;
          continue;
        }

        await client.query(
          `INSERT INTO trip_arrival_predictions
             (assignment_id, stop_id, seq_order, predicted_time, predicted_delay_minutes, source, computed_at, updated_at)
           SELECT $1, t.stop_id, t.seq_order, t.predicted_time, t.predicted_delay_minutes, t.source, now(), now()
           FROM unnest($2::int[], $3::int[], $4::text[], $5::int[], $6::text[])
             AS t(stop_id, seq_order, predicted_time, predicted_delay_minutes, source)
           ON CONFLICT (assignment_id, stop_id) DO UPDATE SET
             seq_order = EXCLUDED.seq_order,
             predicted_time = EXCLUDED.predicted_time,
             predicted_delay_minutes = EXCLUDED.predicted_delay_minutes,
             source = EXCLUDED.source,
             computed_at = EXCLUDED.computed_at,
             updated_at = now()`,
          [
            assignment.id,
            arrivals.map((a) => a.stopId),
            arrivals.map((a) => a.seqOrder),
            arrivals.map((a) => a.predictedTime),
            arrivals.map((a) => a.predictedDelayMinutes),
            arrivals.map((a) => a.source)
          ]
        );
        stored += arrivals.length;
        computed++;

        // 予測精度監視用の履歴ログ追記。失敗してもプリコンピュート本体は成功済みなので、
        // ここだけ個別にcatchして握りつぶす（ETA配信を止めない）。
        try {
          await logPredictionChanges(client, assignment.id, assignment.daily_trip_id, assignment.route_id, arrivals);
        } catch (logErr) {
          console.error(`[etaPredictor] assignment=${assignment.id} の予測履歴ログ書き込みエラー（本体には影響なし）:`, logErr.message);
        }
      } catch (err) {
        console.error(`[etaPredictor] assignment=${assignment.id} の ETA 計算エラー:`, err.message);
      }
    }

    // 48時間以上前の予測は掃除する（便がclosedになった場合のトリップCASCADE削除の
    // 補完。カスケード対象外の孤児レコードが残る経路は無いはずだが保険）
    const deleted = await client.query(
      `DELETE FROM trip_arrival_predictions WHERE computed_at < now() - interval '48 hours'`
    );

    console.log(
      `[etaPredictor] ETA プリコンピュート完了: ${computed} 割り当て / ${stored} レコード保存 ` +
        `/ ${deleted.rowCount} 古いレコード削除 (${Date.now() - startedAt}ms)`
    );

    return { computed, stored, deleted: deleted.rowCount };
  } finally {
    client.release();
  }
}

/**
 * 指定した割り当ての到着予測を trip_arrival_predictions から読み出す（DB読み出しのみ）。
 * predictArrivals() とは異なり計算は一切行わない。
 * @param {Client} client - PostgreSQL クライアント
 * @param {number} assignmentId - 割り当て ID
 * @returns {Promise<Array>} [{stopId, seqOrder, predictedTime, predictedDelayMinutes, source}]
 */
async function getArrivalsForAssignment(client, assignmentId) {
  const res = await client.query(
    `SELECT stop_id, seq_order, predicted_time, predicted_delay_minutes, source
     FROM trip_arrival_predictions
     WHERE assignment_id = $1
     ORDER BY seq_order ASC`,
    [assignmentId]
  );

  return res.rows.map((row) => ({
    stopId: row.stop_id,
    seqOrder: row.seq_order,
    predictedTime: row.predicted_time,
    predictedDelayMinutes: row.predicted_delay_minutes,
    source: row.source
  }));
}

// 予測根拠(source)の管理画面向け日本語説明。値の一覧はpredictArrivals()のJSDoc参照。
// category は「時刻表 / 過去統計 / 直近走行ペース」のどれを根拠にしたかの大分類
// （管理画面の根拠表示で使う。仕様: ETA予測の根拠表示）。
const SOURCE_INFO = {
  schedule: { category: 'schedule', label: '時刻表（始発前・実績なし）' },
  historical: { category: 'historical', label: '過去統計＋直近走行ペース補正' },
  schedule_paced: { category: 'pace', label: '時刻表所要時間×直近走行ペース補正' },
  naive_anchored: { category: 'schedule', label: '時刻表（通過区間・基準駅からの差分）' },
  through_skip: { category: 'schedule', label: '通過駅（時刻表上非停車）' },
  naive: { category: 'fallback', label: 'フォールバック（統計・時刻表とも参照不可）' },
  actual: { category: 'actual', label: '実績到着' }
};

function describeSource(source) {
  return SOURCE_INFO[source] || { category: 'unknown', label: source || '不明' };
}

module.exports = {
  updateSegmentStats,
  predictArrivals,
  computeAndStoreAllArrivals,
  getArrivalsForAssignment,
  describeSource,
  SOURCE_INFO
};