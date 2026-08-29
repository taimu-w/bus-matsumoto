// 仕様書 第9項「予想到着時刻の高度化」に対応するモジュール。
//
// 旧ロジック（単純加算方式）: 現在の遅延時間をそのまま残り全区間へ加算するだけだった。
//
// 新ロジック: 過去に蓄積された「同一曜日区分×同一時間帯×同一区間」の走行時間統計
// (segment_travel_stats) を参照しつつ、当該便の直近の実績ペース（liveFactor）で
// 補正した所要時間を積み上げて残り各バス停の到着時刻を予測する。
// 統計データが不足する区間・便については、時刻表上の所要時間 or 単純遅延加算に
// 段階的にフォールバックし、常に何らかの予測値を返せるようにしている。
//
// 【今日の前便実績・周辺道路実績によるペース補正の強化】
// 上記のliveFactor（当該便自身の直近3区間）に加え、
//   ①今日の前便実績: 同一路線・同方向の当日直前便が実際にどのペースで走ったか
//   ②周辺道路実績: 対象区間の周辺500m以内を走った他の便（他路線含む）の直近実績を
//     距離・方位・新しさで重み付けしたもの
// を「使えるデータがある場合だけ」動的な重みで加える（getTodayPreviousTripFactor /
// getNearbyCandidateSegments・computeNearbyFactor / combinePaceFactor）。
// どちらも欠損時はliveFactor単独にそのまま帰着するため、データが薄い状況でも
// 既存の挙動から後退しない設計にしてある。詳細はdocs/eta-prediction-algorithm.md参照。
const pool = require('../config/db');
const { timeStrToMinutes, minutesToTimeStr, getDayType, computeDelayMinutes, nowInTokyo } = require('../utils/time');
const { haversineDistanceMeters, bearingDegrees, angleDiffDegrees } = require('../utils/geo');
const { loadHolidaySet } = require('./holidayCalendar');
const { getRuntimeSetting } = require('./runtimeSettings');

const MIN_SAMPLES_FOR_TRUST = 3;
const LIVE_SEGMENTS_FOR_PACE = 3; // 直近何区間の実績からペースを算出するか

// ペース比率（実績÷基準）のクランプ範囲。従来liveFactor専用だったクランプを、
// 今日の前便実績・周辺道路実績にも同じ範囲で適用する。事故・運行乱れ等で単一区間が
// 極端な値になっても、その比率をそのままETA全体へ伝播させないための歯止め。
const PACE_RATIO_MIN = 0.5;
const PACE_RATIO_MAX = 2.5;

function clampPaceRatio(ratio) {
  return Math.max(PACE_RATIO_MIN, Math.min(PACE_RATIO_MAX, ratio));
}

// 新シグナル（今日の前便実績・周辺道路実績）を採用する最低サンプル数。
// 過去統計の信頼しきい値(MIN_SAMPLES_FOR_TRUST=3件)より緩い2件にしてある
// （仕様指示：サンプル数は最低2であれば利用してよい）。これを下回る場合は
// 「データが存在しない」のと同じ扱いにして無視し、他のシグナルへ重みを譲る。
const NEW_SIGNAL_MIN_SAMPLES = 2;

// 各新シグナルの基礎重み。liveFactor（当該便自身・直近3区間の一次情報）を常に
// 基礎重み1.0で固定し、今日の前便実績・周辺道路実績はどれだけ確信度が満点でも
// この基礎重みまでしか寄与できないようにする（寄与率の上限）。他便・周辺の
// 実績はliveFactorより一段階間接的な情報のため、liveFactorを上回って支配しない
// ようにする設計。
const LIVE_FACTOR_BASE_WEIGHT = 1.0;
const PREV_TRIP_BASE_WEIGHT = 0.6;
const NEARBY_BASE_WEIGHT = 0.5;

// 各新シグナルが「確信度満点」に達するまでのサンプル量。
// 前便実績はマッチした隣接区間数、周辺実績は距離×方位×新しさの重みの合計値
// （個々のマッチが弱い重みでも、マッチ数が多ければ確信度が積み上がる）で測る。
const PREV_TRIP_FULL_CONFIDENCE_SAMPLES = 6;
const NEARBY_FULL_CONFIDENCE_WEIGHT_MASS = 4;

// 周辺道路実績の探索半径(m)・探索対象とする実績の新しさ(分)。
const NEARBY_RADIUS_METERS = 500;
const NEARBY_RECENCY_MINUTES = 60;

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
 * GTFSのstop_times.txtに載る行には必ず実時刻が入るため、通常のデータでは
 * 常にtrueになる。NULL・空文字などになるのは、元GTFSフィード側の時刻欠損・
 * 不正値といった、こちらでは制御できない入力不備のときだけ（＝システムの
 * 境界にある外部データの保険的なチェックであり、「通過バス停」を判定する
 * ためのものではない）。
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
  // finishTrips()の運行日終了掃除と、パイプラインのreassignOrphanTrips()の両方から
  // 呼ばれるため、2つの独立したDB接続が同時にこの関数を実行しうる。
  // 対策として、この関数全体を1トランザクションにまとめ、対象行の取得を
  // FOR UPDATE SKIP LOCKEDにする。これにより「もう一方が処理中の行」を
  // 互いに読み飛ばすため、同じ completed_trips 行を二重集計することがなくなる。
  await client.query('BEGIN');
  try {
    // is_official = TRUE（＝その便の実績として正とみなす、最後に担当車両だった記録）だけを
    // 集計する。候補車両止まりの記録を混ぜると、別経路をたまたま走っていた車両の所要時間で
    // 区間統計が汚染される。また担当が切り替わった便で同じ区間を二重計上することも防げる。
    const pending = await client.query(
      `SELECT id, day_of_week, day_type FROM completed_trips
       WHERE aggregated = FALSE AND is_official = TRUE
       ORDER BY id ASC LIMIT 200
       FOR UPDATE SKIP LOCKED`
    );
    if (pending.rows.length === 0) {
      await client.query('COMMIT');
      return { aggregated: 0 };
    }

    // 1区間・1バケットあたりの実効サンプル数上限。これを超えると累積平均から
    // 指数移動平均へ切り替え、古いサンプルを徐々に忘れる（生の走行データは
    // COMPLETED_TRIP_RETENTION_DAYS で消えるため、平均側で新陳代謝させる）。
    const maxSamples = getRuntimeSetting('SEGMENT_STATS_MAX_SAMPLES');

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

        // 読み取り→加算→書き込みをJS側で行うと、異なる便の区間が同じキーに
        // 集約されるときにロストアップデートが起きる（FOR UPDATE SKIP LOCKEDは
        // completed_trips行の奪い合いは防ぐが、segment_travel_stats側の行までは
        // 保護しない）。ON CONFLICT DO UPDATEで加算そのものをSQL側の1文に
        // 閉じ込め、行ロックで直列化する。
        // 実効重み k = LEAST(現sample_count, $6 - 1) を使い
        //   新平均 = (旧平均 * k + 今回値) / (k + 1)
        // とする。sample_count が上限($6)未満なら従来どおりの累積平均、
        // 上限以降は直近 $6 件相当の指数移動平均になり、古い実績の重みが下がる。
        await client.query(
          `INSERT INTO segment_travel_stats (from_stop_id, to_stop_id, day_type, hour_bucket, sample_count, avg_seconds, updated_at)
           VALUES ($1, $2, $3, $4, 1, $5, now())
           ON CONFLICT (from_stop_id, to_stop_id, day_type, hour_bucket) DO UPDATE SET
             avg_seconds = (segment_travel_stats.avg_seconds * LEAST(segment_travel_stats.sample_count, $6 - 1) + EXCLUDED.avg_seconds)
                            / (LEAST(segment_travel_stats.sample_count, $6 - 1) + 1),
             sample_count = LEAST(segment_travel_stats.sample_count + 1, $6),
             updated_at = now()`,
          [from.stop_id, to.stop_id, dayType, hourBucket, seconds, maxSamples]
        );
      }

      await client.query(`UPDATE completed_trips SET aggregated = TRUE WHERE id = $1`, [trip.id]);
    }

    await client.query('COMMIT');
    return { aggregated: pending.rows.length };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[etaPredictor] updateSegmentStats に失敗しました:', err.message);
    return { aggregated: 0 };
  }
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
 * 【追加要素①: 今日の前便実績】
 * 同一路線・同方向・当日の直前便（直前に始発時刻を迎えた便）が実際にどのくらいの
 * ペースで走ったかを算出する。過去統計(segment_travel_stats)にも当日分のサンプルは
 * 混ざっているが、曜日区分×時間帯の平均に薄められてしまうため、「今日この路線で
 * 何が起きているか」を強く反映する独立シグナルとしてあえて別枠で扱う。
 *
 * 直前便が既に運行終了しclosed済み（completed_trips）ならその正実績を、まだ運行中
 * （担当車両が付いてtrip_stop_progressが積み上がっている途中）であってもその時点までの
 * 実績を使う。走行中の便の「ここまでの遅れ」も今日の状況を示す有効な手掛かりのため。
 * 直前便が存在しない（当日この路線の最初の便）、車両が一度も割り当たらなかった、
 * 隣接区間の実績が2件未満、のいずれかに該当する場合はnullを返し、呼び出し側
 * （combinePaceFactor）が自然に他のシグナルへ重みを再配分する。
 *
 * @returns {Promise<{factor: number, sampleCount: number} | null>}
 */
async function getTodayPreviousTripFactor(client, tripContext, currentAssignmentId) {
  const prevTripRes = await client.query(
    `SELECT id FROM daily_trips
      WHERE route_id = $1 AND direction_id = $2 AND service_date = $3 AND start_at < $4
      ORDER BY start_at DESC, id DESC LIMIT 1`,
    [tripContext.routeId, tripContext.directionId, tripContext.serviceDate, tripContext.startAt]
  );
  if (prevTripRes.rows.length === 0) return null;
  const prevDailyTripId = prevTripRes.rows[0].id;

  // 優先: 運行終了済みの正実績(completed_trips.is_official)
  let stopRows = (
    await client.query(
      `SELECT cts.seq_order, cts.scheduled_time, cts.actual_time
         FROM completed_trips ct
         JOIN completed_trip_stop_times cts ON cts.completed_trip_id = ct.id
        WHERE ct.daily_trip_id = $1 AND ct.is_official = TRUE
        ORDER BY cts.seq_order ASC`,
      [prevDailyTripId]
    )
  ).rows;

  // フォールバック: まだ運行終了していない場合は、担当車両の現時点までの進捗を使う
  // （is_officialと同じ「正実績」の考え方でrole='assigned'のみ対象にする）。
  if (stopRows.length === 0) {
    stopRows = (
      await client.query(
        `SELECT p.seq_order, p.scheduled_time, p.actual_time
           FROM trip_vehicle_assignments a
           JOIN trip_stop_progress p ON p.assignment_id = a.id
          WHERE a.daily_trip_id = $1 AND a.role = 'assigned' AND a.id != $2
            AND p.status = '到着済' AND p.actual_time IS NOT NULL
          ORDER BY p.seq_order ASC`,
        [prevDailyTripId, currentAssignmentId]
      )
    ).rows;
  }

  const ratios = [];
  for (let i = 0; i < stopRows.length - 1; i++) {
    const from = stopRows[i];
    const to = stopRows[i + 1];
    if (to.seq_order - from.seq_order !== 1) continue; // 隣接区間のみ対象
    if (!isValidTime(from.scheduled_time) || !isValidTime(to.scheduled_time)) continue;
    if (!isValidTime(from.actual_time) || !isValidTime(to.actual_time)) continue;

    let scheduledDiff = timeStrToMinutes(to.scheduled_time) - timeStrToMinutes(from.scheduled_time);
    if (scheduledDiff < 0) scheduledDiff += 24 * 60;
    let actualDiff = timeStrToMinutes(to.actual_time) - timeStrToMinutes(from.actual_time);
    if (actualDiff < 0) actualDiff += 24 * 60;
    // updateSegmentStats()と同じ基準（1区間60分超は測定誤りとみなす）で異常値を除外
    if (scheduledDiff <= 0 || actualDiff <= 0 || actualDiff > 60) continue;

    ratios.push(clampPaceRatio(actualDiff / scheduledDiff));
  }

  if (ratios.length < NEW_SIGNAL_MIN_SAMPLES) return null;
  const factor = clampPaceRatio(ratios.reduce((a, b) => a + b, 0) / ratios.length);
  return { factor, sampleCount: ratios.length };
}

// 周辺道路実績の距離重み。「同一区間」（候補区間のfrom/to停留所が対象区間と完全一致。
// 同一路線・同方向の別便が今まさにこの区間を走った場合に起きる）は、呼び出し側
// (computeNearbyFactor)で別格の1.0として扱うため、ここでは純粋な距離帯だけを見る。
function nearbyDistanceWeight(meters) {
  if (meters <= 100) return 0.8;
  if (meters <= 300) return 0.5;
  if (meters <= NEARBY_RADIUS_METERS) return 0.2;
  return 0;
}

// 周辺道路実績の方位重み。対象区間の進行方向と候補区間の進行方向がどれだけ
// 近いかを見る。方位差45度超は「別方向の道路」とみなして除外する。
function nearbyBearingWeight(angleDiffDeg) {
  if (angleDiffDeg <= 20) return 1.0;
  if (angleDiffDeg <= 45) return 0.5;
  return 0;
}

// 周辺道路実績の新しさ重み。「今この瞬間の道路状況」を知りたいので、
// NEARBY_RECENCY_MINUTES(60分)より古い実績は使わない。
function nearbyRecencyWeight(minutesAgo) {
  if (minutesAgo <= 5) return 1.0;
  if (minutesAgo <= 15) return 0.7;
  if (minutesAgo <= 30) return 0.4;
  if (minutesAgo <= NEARBY_RECENCY_MINUTES) return 0.1;
  return 0;
}

// 運行終了直後の割り当てを「周辺道路実績・メッシュ集計」の候補プールへ含める猶予時間(分)。
// NEARBY_RECENCY_MINUTES(60分)より個々の区間の重みは後段(JS側)でさらに絞られるため、
// ここではSQL側の粗いプレフィルタとして少し余裕を持たせてある。
const RECENTLY_ENDED_MINUTES = 90;

/**
 * 【追加要素②の土台: 直近の区間実績（システム全体）】
 * 現在アクティブな全割り当て、および運行終了直後（RECENTLY_ENDED_MINUTES以内）の
 * 割り当て（担当・候補いずれも実在の車両のGPS実績であり、路面状況を知る手掛かりとしては
 * 同格に扱う）のtrip_stop_progressから、隣接区間（seq_order差1）で実績が揃っている
 * ものを抽出する。運行終了直後も含めるのは、便が終わった瞬間にその区間の実績が
 * 「周辺道路実績」から消えてしまう（数分前の新しい実績なのに使われない）のを防ぐため。
 *
 * predictArrivals()の周辺道路補正（computeNearbyFactor）と、管理画面「当日の状況」の
 * メッシュ可視化（services/delayMesh.js）の共通データソース。前者は対象の割り当て自身を
 * 除外する（excludeAssignmentId）が、後者はシステム全体を俯瞰するため除外対象を持たない。
 *
 * @returns {Promise<Array<{fromStopId, toStopId, midLat, midLon, bearing, toMinutes, ratio}>>}
 */
async function getRecentSegmentPerformance(client, { excludeAssignmentId = null } = {}) {
  const res = await client.query(
    `SELECT p.assignment_id, p.stop_id, p.seq_order, p.scheduled_time, p.actual_time, s.lat, s.lon
       FROM trip_stop_progress p
       JOIN stops s ON s.id = p.stop_id
       JOIN trip_vehicle_assignments a ON a.id = p.assignment_id
      WHERE (a.state = 'active' OR (a.state = 'ended' AND a.ended_at > now() - make_interval(mins => $2)))
        AND ($1::bigint IS NULL OR a.id != $1)
        AND p.status = '到着済' AND p.actual_time IS NOT NULL AND p.scheduled_time IS NOT NULL
      ORDER BY p.assignment_id ASC, p.seq_order ASC`,
    [excludeAssignmentId, RECENTLY_ENDED_MINUTES]
  );

  const byAssignment = new Map();
  for (const row of res.rows) {
    if (!byAssignment.has(row.assignment_id)) byAssignment.set(row.assignment_id, []);
    byAssignment.get(row.assignment_id).push(row);
  }

  const segments = [];
  for (const stopRows of byAssignment.values()) {
    for (let i = 0; i < stopRows.length - 1; i++) {
      const from = stopRows[i];
      const to = stopRows[i + 1];
      if (to.seq_order - from.seq_order !== 1) continue;
      if (!isValidTime(from.scheduled_time) || !isValidTime(to.scheduled_time)) continue;
      if (!isValidTime(from.actual_time) || !isValidTime(to.actual_time)) continue;

      let scheduledDiff = timeStrToMinutes(to.scheduled_time) - timeStrToMinutes(from.scheduled_time);
      if (scheduledDiff < 0) scheduledDiff += 24 * 60;
      let actualDiff = timeStrToMinutes(to.actual_time) - timeStrToMinutes(from.actual_time);
      if (actualDiff < 0) actualDiff += 24 * 60;
      if (scheduledDiff <= 0 || actualDiff <= 0 || actualDiff > 60) continue;

      segments.push({
        fromStopId: from.stop_id,
        toStopId: to.stop_id,
        midLat: (from.lat + to.lat) / 2,
        midLon: (from.lon + to.lon) / 2,
        bearing: bearingDegrees(from.lat, from.lon, to.lat, to.lon),
        toMinutes: timeStrToMinutes(to.actual_time),
        ratio: clampPaceRatio(actualDiff / scheduledDiff)
      });
    }
  }
  return segments;
}

/**
 * 対象区間（fromStop→toStop）について、getNearbyCandidateSegments()で取得済みの
 * 候補群から距離×方位×新しさで重み付けした補正係数を算出する。
 * 距離重みだけは「同一区間」（候補区間のfrom/to停留所IDが対象区間と完全一致）を
 * 別格の1.0として扱う。物理的に同じ2停留所間＝同一路線・同方向の他便が今まさに
 * この区間を走った、という最も直接的な手掛かりのため。
 *
 * @returns {{factor: number, sampleCount: number, weightMass: number} | null}
 */
function computeNearbyFactor(candidateSegments, fromStop, toStop, nowMinutes) {
  let weightedSum = 0;
  let weightTotal = 0;
  let matchCount = 0;
  const targetMidLat = (fromStop.lat + toStop.lat) / 2;
  const targetMidLon = (fromStop.lon + toStop.lon) / 2;
  const targetBearing = bearingDegrees(fromStop.lat, fromStop.lon, toStop.lat, toStop.lon);

  for (const seg of candidateSegments) {
    const sameSegment = seg.fromStopId === fromStop.stop_id && seg.toStopId === toStop.stop_id;
    const distanceWeight = sameSegment
      ? 1.0
      : nearbyDistanceWeight(haversineDistanceMeters(targetMidLat, targetMidLon, seg.midLat, seg.midLon));
    if (distanceWeight === 0) continue;

    const bearingWeight = nearbyBearingWeight(angleDiffDegrees(targetBearing, seg.bearing));
    if (bearingWeight === 0) continue;

    let minutesAgo = nowMinutes - seg.toMinutes;
    if (minutesAgo < -700) minutesAgo += 24 * 60; // 日跨ぎ（例: 23:58の実績を0:03に参照）の補正
    if (minutesAgo < 0) minutesAgo = 0;
    const recencyWeight = nearbyRecencyWeight(minutesAgo);
    if (recencyWeight === 0) continue;

    const weight = distanceWeight * bearingWeight * recencyWeight;
    weightedSum += weight * seg.ratio;
    weightTotal += weight;
    matchCount++;
  }

  if (matchCount < NEW_SIGNAL_MIN_SAMPLES || weightTotal === 0) return null;
  return {
    factor: clampPaceRatio(weightedSum / weightTotal),
    sampleCount: matchCount,
    weightMass: weightTotal
  };
}

/**
 * liveFactor（当該便自身・直近3区間の一次情報）を軸に、今日の前便実績・周辺道路実績を
 * 「使える場合だけ」動的な重みで加えてブレンドする。
 *
 * 各シグナルの重み = 基礎重み(*_BASE_WEIGHT) × 確信度(0〜1、サンプル量に応じて頭打ち)。
 * 新シグナルが両方とも欠損（null）の場合、weightTotalはLIVE_FACTOR_BASE_WEIGHTのみと
 * なり結果はliveFactorそのものに一致する＝新シグナル追加によって既存の挙動が
 * 後退することは原理的に起きない。また各シグナルの基礎重みはliveFactorの1.0以下に
 * 抑えてあるため、新シグナルがどれだけ確信度満点でもliveFactorを上回って結果を
 * 支配することはない（異常値1件が全体を暴走させないための寄与率の上限）。
 */
function combinePaceFactor(liveFactor, prevTripSignal, nearbySignal) {
  let weightedSum = liveFactor * LIVE_FACTOR_BASE_WEIGHT;
  let weightTotal = LIVE_FACTOR_BASE_WEIGHT;

  if (prevTripSignal) {
    const confidence = Math.min(1, prevTripSignal.sampleCount / PREV_TRIP_FULL_CONFIDENCE_SAMPLES);
    const weight = PREV_TRIP_BASE_WEIGHT * confidence;
    weightedSum += prevTripSignal.factor * weight;
    weightTotal += weight;
  }

  if (nearbySignal) {
    const confidence = Math.min(1, nearbySignal.weightMass / NEARBY_FULL_CONFIDENCE_WEIGHT_MASS);
    const weight = NEARBY_BASE_WEIGHT * confidence;
    weightedSum += nearbySignal.factor * weight;
    weightTotal += weight;
  }

  return clampPaceRatio(weightedSum / weightTotal);
}

/**
 * 指定した便への割り当て（assignment）の、残り各バス停に対する予測到着時刻を算出する。
 * 便起点方式では進捗が (便 × 車両) 単位になったため、車両IDではなく割り当てIDを受け取る。
 * 戻り値: [{ stopId, seqOrder, predictedTime, predictedDelayMinutes, source, stopsBefore }]
 *   source: 'historical'（統計採用） | 'schedule_paced'（時刻表所要時間×ペース補正）
 *         | 'naive_anchored'（scheduled_time欠損区間を基準駅からの定刻差分で算出）
 *         | 'through_skip'（scheduled_time欠損駅本体・時間を進めない）
 *         | 'naive'（統計・基準駅とも不明な異常系の最終フォールバック）
 *   stopsBefore: 予測時点で対象停留所の何停留所手前に居たか（cursorSeqとの差。
 *     予測精度監視で「何停留所前に出した予測か」の軸に使う。算出アルゴリズムの
 *     判定には一切使わない、付随メタデータ）
 *
 * 【2026年8月・GTFSデータ構造の見直しに伴う位置づけの変更】
 * naive_anchored/through_skipは、元は「通過バス停（旧GASの『↓』相当）」を処理する
 * ためのロジックだった。当時はis_through（経由・非停車）のバス停はscheduled_timeが
 * NULLになる設計だったため、通過区間をまたぐたびにこのロジックが起動していた。
 * その後、is_through判定をGTFS本来の意味（pickup_type=1 かつ drop_off_type=1の
 * 場合のみ真の通過）に修正し、scheduled_timeは常に実際のGTFS時刻を保持するように
 * なった（GTFSのstop_times.txtには元々「時刻を持たない行」は存在しないため）。
 * そのため、このロジックが実際に起動するのは「元GTFSフィード側の時刻データが
 * 欠損・不正である」という、こちらでは制御できない外部データ不備のときだけになった
 * （現行の実データでは一度も発生しない）。削除も検討したが、外部フィードの不備で
 * scheduled_timeがNULLになる区間が連続した場合に「5分固定を連鎖加算して予測が
 * 大暴走する」という過去に実際に発生した不具合を再発させないための保険として、
 * あえて残している。
 *
 * 仕様書 第9項 追加修正:
 *   ①scheduled_timeが欠損している区間は、データ汚染防止のため統計/ペース補正を
 *     使わない。単純に前駅との差分を取ると5分固定フォールバックが連鎖し予測が
 *     大暴走するため、「最後に有効な時刻表を持っていた通常停車駅(lastValidStop)」
 *     を基準に、有効な定刻同士の差分のみで絶対時刻を算出する。
 *   ②通常停車バス停（有効な時刻表を持つ駅）で予測が定刻を下回る場合は、
 *     早発防止のため定刻まで床打ちする。scheduled_time欠損駅は対象外。
 *   ③現在の遅れ(currentDelay)を基準に、以降の予測遅延に上限を設ける
 *     （resolveDelayCeiling）。統計・ペース補正だけでは誤差が連鎖的に積み
 *     上がり、起点はわずかな遅れでも終点では非現実的な大遅延になってしまう
 *     ことがあったための対策。遅れ解消方向の予測はさらにやや強調する
 *     （capPredictedDelay／DELAY_RECOVERY_BOOST）。scheduled_time欠損駅は対象外。
 *   ④今日の前便実績（getTodayPreviousTripFactor）と⑤周辺道路の最近実績
 *     （getNearbyCandidateSegments／computeNearbyFactor）を、liveFactorと
 *     動的な重みでブレンドしたcombinedPaceFactorを算出し、'historical'/
 *     'schedule_paced'の両分岐で従来liveFactor単体だった箇所に用いる
 *     （combinePaceFactor）。データが無い新シグナルは重み0として自然に除外され、
 *     両方欠損時はliveFactor単体の従来挙動に一致する。isThroughSegment分岐
 *     （通常発生しない外部データ不備向けの保険）は対象外のまま変更しない。
 */
// predictArrivals()の結果行に含めるETA根拠の内訳（管理画面「ETA予測根拠」「当日の状況」向け）。
// combinedPaceFactorが実際に使われた('historical'/'schedule_paced')行だけ実値を持ち、
// それ以外（'actual'/'schedule'/'naive'/'through_skip'/'naive_anchored'）は全項目null。
const EMPTY_PACE_INFO = {
  liveFactor: null,
  todayPreviousTripFactor: null,
  todayPreviousTripSamples: null,
  nearbyFactor: null,
  nearbyFactorSamples: null,
  nearbyWeightMass: null,
  combinedPaceFactor: null
};

async function predictArrivals(client, assignmentId) {
  const rows = await client.query(
    `SELECT p.stop_id, p.seq_order, p.scheduled_time, p.status, p.actual_time,
            s.name, s.lat, s.lon,
            a.daily_trip_id, d.route_id, d.direction_id, d.service_date, d.start_at
     FROM trip_stop_progress p
     JOIN stops s ON s.id = p.stop_id
     JOIN trip_vehicle_assignments a ON a.id = p.assignment_id
     JOIN daily_trips d ON d.id = a.daily_trip_id
     WHERE p.assignment_id = $1
     ORDER BY p.seq_order ASC`,
    [assignmentId]
  );
  const stops = rows.rows;
  if (stops.length === 0) return [];

  // 今日の前便実績(①)の検索キー。全行が同じ便に属するため先頭行から取れば十分。
  const tripContext = {
    routeId: stops[0].route_id,
    directionId: stops[0].direction_id,
    serviceDate: stops[0].service_date,
    startAt: stops[0].start_at
  };

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
      liveFactor = clampPaceRatio(liveFactor); // 異常なペース補正を抑制
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
      stopsBefore: s.seq_order - cursorSeq, // cursorSeq=-1（まだどこにも到着していない）
      ...EMPTY_PACE_INFO
    }));
  }

  // 【追加要素①②】今日の前便実績・周辺道路実績は、便全体を通して1回だけ取得し
  // 以降の区間ループで使い回す（区間ごとにSQLを投げ直さない）。始発前（上のreturn）
  // では不要なため、ここまで到達した＝実際に残り区間の計算が必要な便だけが取得する。
  const todayPreviousTripFactor = await getTodayPreviousTripFactor(client, tripContext, assignmentId);
  const nearbyCandidateSegments = await getRecentSegmentPerformance(client, { excludeAssignmentId: assignmentId });
  const nowTokyo = nowInTokyo();
  const nowMinutes = nowTokyo.hour * 60 + nowTokyo.minute;

  const results = [];
  let prevStop = lastArrived;
  // 「最後に有効な時刻表を持っていた通常停車駅」を基準駅として保持する。
  // scheduled_time欠損区間を跨ぐ際は、直前駅(prevStop)ではなく必ずこの基準駅からの
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
        stopsBefore: s.seq_order - cursorSeq, // 実績確定行（0以下）。予測精度分析では参照しない
        ...EMPTY_PACE_INFO
      });
      continue;
    }

    // 【仕様①】scheduled_timeが欠損している区間を跨ぐ場合の一括フォールバック
    // 予測対象(s)または直前(prevStop)のいずれかの scheduled_time が無効
    // （NULL等）な場合、その区間は統計データが歪んでいたり存在しなかったり
    // するため、過去統計(historical)やペース補正(schedule_paced)を一切使わない。
    // GTFSのstop_times.txtに載る行には本来必ず実時刻が入るため、通常のデータでは
    // このisThroughSegmentがtrueになることはない。ここに入るのは元GTFSフィード側の
    // 時刻欠損・不正値など、外部データの不備によるものだけ（＝もう「通過バス停」の
    // 処理ではなく、外部データ不備に対する保険的なフォールバック）。
    // 「最後に有効な時刻表を持っていた通常停車駅(lastValidStop)」を基準に、
    // 有効な定刻同士の差分だけで絶対時刻を算出し直すことで、5分固定フォールバックの
    // 連鎖による予測の大暴走を防ぐ。前後とも有効な時刻表を持つ駅に戻った時点で、
    // 自動的に本来の高度な予測（historical/schedule_paced）へ復帰する。
    const isThroughSegment = !isValidTime(s.scheduled_time) || !isValidTime(prevStop.scheduled_time);

    let segmentMinutes;
    let source;
    // combinedPaceFactorが実際に使われた場合だけ埋める（ETA根拠表示用）。
    // isThroughSegment分岐、および同じelse分岐内でもnaiveフォールバックに落ちた場合は
    // combinedPaceFactorを計算はするが最終的な所要時間には使っていないため、
    // 結果に出さない（使っていないのに使ったかのように見せない）。
    let paceInfo = null;

    if (isThroughSegment) {
      const sHasValidTime = isValidTime(s.scheduled_time);
      const anchorHasValidTime = lastValidStop && isValidTime(lastValidStop.scheduled_time);

      if (!sHasValidTime) {
        // 計算対象の駅自体が有効な時刻表を持たない（元GTFSフィードの時刻欠損）
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

      // 【追加要素①②の適用】liveFactorに、今日の前便実績・周辺道路実績を
      // 動的な重みでブレンドした補正係数。両方欠損時はliveFactorそのものに一致する。
      const nearbyFactorResult = computeNearbyFactor(nearbyCandidateSegments, prevStop, s, nowMinutes);
      const combinedPace = combinePaceFactor(liveFactor, todayPreviousTripFactor, nearbyFactorResult);

      if (stat && stat.sample_count >= MIN_SAMPLES_FOR_TRUST) {
        const historicalMinutes = stat.avg_seconds / 60;
        const blendWeight = getRuntimeSetting('ETA_BLEND_WEIGHT');
        segmentMinutes = historicalMinutes * (blendWeight + (1 - blendWeight) * combinedPace);
        source = 'historical';
      } else if (prevStop.scheduled_time && s.scheduled_time) {
        const s1 = timeStrToMinutes(prevStop.scheduled_time);
        const s2 = timeStrToMinutes(s.scheduled_time);
        let scheduledDiff = !Number.isNaN(s1) && !Number.isNaN(s2) ? s2 - s1 : NaN;
        if (!Number.isNaN(scheduledDiff)) {
          if (scheduledDiff < 0) scheduledDiff += 24 * 60;
          segmentMinutes = scheduledDiff * combinedPace;
          source = 'schedule_paced';
        }
      }

      if (segmentMinutes === undefined || Number.isNaN(segmentMinutes)) {
        // 最終フォールバック: 元の単純方式（時刻表上の所要時間をそのまま加算）
        segmentMinutes = s.scheduled_time && prevStop.scheduled_time
          ? Math.max(0, timeStrToMinutes(s.scheduled_time) - timeStrToMinutes(prevStop.scheduled_time))
          : 5;
        source = 'naive';
      } else {
        // combinedPaceFactorが実際にsegmentMinutesへ反映された（historical/schedule_paced）
        // 場合だけ、その内訳をETA根拠表示用に記録する。
        paceInfo = {
          liveFactor,
          todayPreviousTripFactor: todayPreviousTripFactor ? todayPreviousTripFactor.factor : null,
          todayPreviousTripSamples: todayPreviousTripFactor ? todayPreviousTripFactor.sampleCount : null,
          nearbyFactor: nearbyFactorResult ? nearbyFactorResult.factor : null,
          nearbyFactorSamples: nearbyFactorResult ? nearbyFactorResult.sampleCount : null,
          nearbyWeightMass: nearbyFactorResult ? nearbyFactorResult.weightMass : null,
          combinedPaceFactor: combinedPace
        };
      }
    }

    cursorMinutes = ((cursorMinutes + segmentMinutes) % (24 * 60) + 24 * 60) % (24 * 60);

    // 【仕様②】早発防止ロジック
    // 有効な時刻表(isValidTime)を持つ通常停車バス停に限り、予測時刻が定刻を
    // 下回った場合は、バス停での時間調整（定刻までの待機）をシミュレートし、
    // 定刻まで床打ちする。scheduled_timeが欠損している駅（isValidTimeがfalse。
    // 通常発生しない）はそもそも定刻が存在しないため対象外とする。補正後の時刻は
    // 次区間の出発基準時刻としてそのまま引き継がれる。
    const sHasValidScheduledTime = isValidTime(s.scheduled_time);
    const schedMin = sHasValidScheduledTime ? timeStrToMinutes(s.scheduled_time) : null;
    if (sHasValidScheduledTime && cursorMinutes < schedMin) {
      cursorMinutes = schedMin;
    }

    let predictedTime = minutesToTimeStr(Math.round(cursorMinutes));
    let predictedDelay = sHasValidScheduledTime
      ? (computeDelayMinutes(s.scheduled_time, predictedTime) ?? currentDelay)
      : currentDelay;

    // 【仕様③】遅延予測の上限キャップ／短縮強調。scheduled_timeが欠損している駅は
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
      stopsBefore: s.seq_order - cursorSeq,
      ...(paceInfo || EMPTY_PACE_INFO)
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
 * 直後に呼ばれる（詳細は docs/eta-prediction-algorithm.md）。
 * 計算本体は predictArrivals() をそのまま使い、アルゴリズムを重複実装しない。
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
             (assignment_id, stop_id, seq_order, predicted_time, predicted_delay_minutes, source,
              live_factor, today_previous_trip_factor, today_previous_trip_samples,
              nearby_factor, nearby_factor_samples, nearby_weight_mass, combined_pace_factor,
              computed_at, updated_at)
           SELECT $1, t.stop_id, t.seq_order, t.predicted_time, t.predicted_delay_minutes, t.source,
                  t.live_factor, t.today_previous_trip_factor, t.today_previous_trip_samples,
                  t.nearby_factor, t.nearby_factor_samples, t.nearby_weight_mass, t.combined_pace_factor,
                  now(), now()
           FROM unnest(
                  $2::int[], $3::int[], $4::text[], $5::int[], $6::text[],
                  $7::float8[], $8::float8[], $9::int[], $10::float8[], $11::int[], $12::float8[], $13::float8[]
                )
             AS t(stop_id, seq_order, predicted_time, predicted_delay_minutes, source,
                  live_factor, today_previous_trip_factor, today_previous_trip_samples,
                  nearby_factor, nearby_factor_samples, nearby_weight_mass, combined_pace_factor)
           ON CONFLICT (assignment_id, stop_id) DO UPDATE SET
             seq_order = EXCLUDED.seq_order,
             predicted_time = EXCLUDED.predicted_time,
             predicted_delay_minutes = EXCLUDED.predicted_delay_minutes,
             source = EXCLUDED.source,
             live_factor = EXCLUDED.live_factor,
             today_previous_trip_factor = EXCLUDED.today_previous_trip_factor,
             today_previous_trip_samples = EXCLUDED.today_previous_trip_samples,
             nearby_factor = EXCLUDED.nearby_factor,
             nearby_factor_samples = EXCLUDED.nearby_factor_samples,
             nearby_weight_mass = EXCLUDED.nearby_weight_mass,
             combined_pace_factor = EXCLUDED.combined_pace_factor,
             computed_at = EXCLUDED.computed_at,
             updated_at = now()`,
          [
            assignment.id,
            arrivals.map((a) => a.stopId),
            arrivals.map((a) => a.seqOrder),
            arrivals.map((a) => a.predictedTime),
            arrivals.map((a) => a.predictedDelayMinutes),
            arrivals.map((a) => a.source),
            arrivals.map((a) => a.liveFactor),
            arrivals.map((a) => a.todayPreviousTripFactor),
            arrivals.map((a) => a.todayPreviousTripSamples),
            arrivals.map((a) => a.nearbyFactor),
            arrivals.map((a) => a.nearbyFactorSamples),
            arrivals.map((a) => a.nearbyWeightMass),
            arrivals.map((a) => a.combinedPaceFactor)
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
// naive_anchored/through_skipは、元GTFSフィードの時刻欠損という外部データ不備が
// あったときだけ現れる（通常のデータでは発生しない）。過去に記録された
// trip_arrival_prediction_log の古い行にラベルを付けるためだけに残してある。
const SOURCE_INFO = {
  schedule: { category: 'schedule', label: '時刻表（始発前・実績なし）' },
  historical: { category: 'historical', label: '過去統計＋直近走行ペース補正' },
  schedule_paced: { category: 'pace', label: '時刻表所要時間×直近走行ペース補正' },
  naive_anchored: { category: 'schedule', label: '時刻表（元データ時刻欠損・基準駅からの差分）' },
  through_skip: { category: 'schedule', label: '元データ時刻欠損（時間を進めず据え置き）' },
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
  SOURCE_INFO,
  // 管理画面「当日の状況」のメッシュ可視化(services/delayMesh.js)向けに公開。
  // 周辺道路実績（追加要素②）の下位データソースを、対象区間に限定せず取得できる。
  getRecentSegmentPerformance,
  nearbyRecencyWeight
};