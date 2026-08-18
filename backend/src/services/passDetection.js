// GPS走行ログとバス停マスタを突き合わせ、バス停通過を検知する。
//
// 便起点方式では処理単位が「車両」ではなく「便への割り当て(assignment)」になる。
// 担当車両・候補車両を区別せず、有効な割り当てすべてに対して同じ処理を行う（仕様書 9）。
// 判定アルゴリズム本体（循環線対策・巻き戻り防止・重複解消・欠落補完）は
// 従来のまま変更していない（仕様書 14）。
//   ① 直近の到着済バス停インデックスから4つ先までしか探索しない
//   ② 始発時刻から一定時間以内は、便全体の後半80%のバス停を候補から除外する。
//      除外時間は固定値ではなく、その便の時刻表上の所要時間（終着予定時刻－始発予定時刻）の
//      50%を便ごとに動的に算出する（例: 所要20分の便なら10分、40分の便なら20分）。
//      所要時間が算出できない場合のみ、従来の固定値20分にフォールバックする。
//   ③ ETAによる時間制約（ETA-7分 〜 ETA+20分）を満たすバス停だけを候補とする
//      （循環線対策の追加強化。①②の既存仕様はそのまま維持し、削除・弱体化しない）
//
// ③で使うETAは、trip_arrival_predictionsに保存されている値をpass()の開始時点で
// 読み取ったものを使う。パイプラインは 6:pass() → 7:delayCalc() → 8:computeAndStoreAllArrivals()
// の順で直列実行される（jobs/pipeline.js）ため、pass()実行時点でDBにあるETAは
// 必ず「前回のパイプライン実行」で計算されたものであり、今回のpass()の結果を
// 使って今回のETAが計算されるのはこの後（⑧）になる。したがって、ここでETAを
// 読むだけで到着判定とETA計算の循環依存は発生しない。
const pool = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');
const { timeStrToMinutes, minutesToTimeStr } = require('../utils/time');

// ETA時間制約のマージン（分）。早着側は7分、遅着側は20分と非対称にしている。
// 循環線で先のバス停を誤って拾うことを厳しく防ぎつつ、渋滞等による実際の遅延は
// ある程度許容するため。
const ETA_EARLY_MARGIN_MIN = 7;
const ETA_LATE_MARGIN_MIN = 20;

// 【循環線対策②】始発直後の除外時間は、便の時刻表上の所要時間の何%を使うか。
const EARLY_EXCLUSION_RATIO = 0.5;
// 所要時間（始発予定時刻・終着予定時刻）が算出できない便向けのフォールバック（旧・固定値）。
const EARLY_EXCLUSION_FALLBACK_MIN = 20;

/**
 * 2つの"H:mm"由来の分数の差（a - b）を、日跨ぎを考慮して正規化する。
 * computeDelayMinutes（utils/time.js）と同じ「半日(720分)を超える差分だけ
 * 日跨ぎとみなす」考え方を踏襲する。この路線は日付を跨がない運行のため、
 * 720分を超える差は「前日/翌日を跨いだ見かけ上の差」とみなして補正する。
 */
function diffMinutesSigned(aMin, bMin) {
  let diff = aMin - bMin;
  if (diff < -720) diff += 24 * 60;
  else if (diff > 720) diff -= 24 * 60;
  return diff;
}

/**
 * 処理対象の割り当て一覧。担当・候補の両方が対象。
 */
async function getActiveAssignments(client) {
  const res = await client.query(
    `SELECT a.id AS assignment_id, a.vehicle_id, a.role,
            d.id AS daily_trip_id, d.route_id, d.start_time, d.start_at,
            v.car_id
     FROM trip_vehicle_assignments a
     JOIN daily_trips d ON d.id = a.daily_trip_id
     JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.state = 'active'
     ORDER BY a.id ASC`
  );
  return res.rows;
}

/**
 * その便の停留所と現在の進捗。便の停車パターンだけが対象になるため、
 * 路線に属していてもその便が通らないバス停は最初から含まれない。
 */
async function getStopMaster(client, assignmentId) {
  const res = await client.query(
    `SELECT p.stop_id, p.seq_order, p.status, p.scheduled_time, s.name, s.lat, s.lon, s.notice
     FROM trip_stop_progress p
     JOIN stops s ON s.id = p.stop_id
     WHERE p.assignment_id = $1
     ORDER BY p.seq_order ASC`,
    [assignmentId]
  );
  return res.rows;
}

/**
 * その割り当てについて、直前のパイプライン実行で計算され、
 * trip_arrival_predictionsに保存されているETA（predicted_time）を
 * stop_idごとに取得する。今回のpass()実行より後（⑧）に計算される
 * 新しいETAは使わない。
 */
async function getEtaMap(client, assignmentId) {
  const res = await client.query(
    `SELECT stop_id, predicted_time FROM trip_arrival_predictions WHERE assignment_id = $1`,
    [assignmentId]
  );
  const map = new Map();
  for (const row of res.rows) {
    if (row.predicted_time) map.set(row.stop_id, row.predicted_time);
  }
  return map;
}

/**
 * 【循環線対策②】始発直後に後半80%のバス停を除外する時間（分）を、
 * その便の時刻表上の所要時間（終着予定時刻－始発予定時刻）の50%として算出する。
 * 終着予定時刻は、末尾から探して最初に見つかった有効な scheduled_time
 * （通過扱いでNULLのバス停はスキップ）を使う。所要時間を算出できない場合は
 * 従来の固定値にフォールバックする。
 */
function computeEarlyExclusionMin(assignment, stopMaster) {
  const startSchedMin = timeStrToMinutes(assignment.start_time);
  let endSchedMin = NaN;
  for (let i = stopMaster.length - 1; i >= 0; i--) {
    const m = timeStrToMinutes(stopMaster[i].scheduled_time);
    if (!Number.isNaN(m)) {
      endSchedMin = m;
      break;
    }
  }
  if (Number.isNaN(startSchedMin) || Number.isNaN(endSchedMin)) return EARLY_EXCLUSION_FALLBACK_MIN;

  let durationMin = endSchedMin - startSchedMin;
  if (durationMin < 0) durationMin += 24 * 60; // 日跨ぎ対策（念のため）
  if (durationMin <= 0) return EARLY_EXCLUSION_FALLBACK_MIN;

  return durationMin * EARLY_EXCLUSION_RATIO;
}

function passStep1And3(assignment, stopMaster, gpsRows, radiusMeters, etaByStopId) {
  const totalStops = stopMaster.length;
  // 旧実装の「出発時刻からの経過分」に相当する基準。便起点方式では便の始発時刻を使う。
  const startMin = timeStrToMinutes(assignment.start_time);
  // 【循環線対策②】この便の所要時間から動的に算出した除外時間（分）
  const earlyExclusionMin = computeEarlyExclusionMin(assignment, stopMaster);

  // DB上で確定している「最後に到着したバス停」のインデックスを取得
  // 【循環線対策】このバッチ処理中は、この基準値を書き換えない（固定する）
  let lastArrivedIdx = -1;
  for (let i = stopMaster.length - 1; i >= 0; i--) {
    if (stopMaster[i].status === '到着済') {
      lastArrivedIdx = stopMaster[i].seq_order;
      break;
    }
  }

  // 【巻き戻り防止用】バッチ内での進行状況を記録する変数（初期値はDBの直近バス停）
  let currentMaxIdx = lastArrivedIdx;

  const arrivedSet = new Set(stopMaster.filter((s) => s.status === '到着済').map((s) => s.seq_order));
  const tentativeMatches = [];

  for (const gps of gpsRows) {
    const gpsMin = timeStrToMinutes(gps.gps_time);
    const minSinceStart = !Number.isNaN(startMin) && !Number.isNaN(gpsMin) ? gpsMin - startMin : NaN;

    let best = null;
    for (const stop of stopMaster) {
      if (arrivedSet.has(stop.seq_order)) continue;

      // 【巻き戻り防止】すでに通過した（またはこのバッチ内で通過判定が出た）バス停は除外
      if (stop.seq_order <= currentMaxIdx) continue;

      // 【循環線対策①】探索範囲の制限（確定している直近バス停の4つ先まで）
      if (lastArrivedIdx !== -1 && stop.seq_order > lastArrivedIdx + 4) continue;

      // 【循環線対策②】初期の誤判定防止（始発からearlyExclusionMin分以内は後半80%を除外）
      if (!Number.isNaN(minSinceStart) && minSinceStart < earlyExclusionMin && stop.seq_order / totalStops > 0.8) continue;

      // 【距離制約】STOP_RADIUS_METERS以内のバス停だけを候補とする
      const dist = haversineDistanceMeters(gps.lat, gps.lon, stop.lat, stop.lon);
      if (dist > radiusMeters) continue;

      // 【時間制約(ETA)】ETA-7分 <= 現在時刻 <= ETA+20分を満たさない候補は除外する。
      // 対象バス停にETAが存在しない場合は、この制約を適用せず既存の挙動のまま
      // （距離・順番制約のみ）で候補として扱う。ETA未計算を理由に到着判定を
      // 止めないため。
      const etaStr = etaByStopId && etaByStopId.get(stop.stop_id);
      if (etaStr) {
        const etaMin = timeStrToMinutes(etaStr);
        if (!Number.isNaN(etaMin) && !Number.isNaN(gpsMin)) {
          const diff = diffMinutesSigned(gpsMin, etaMin);
          if (diff < -ETA_EARLY_MARGIN_MIN || diff > ETA_LATE_MARGIN_MIN) continue;
        }
      }

      if (!best || dist < best.dist) {
        best = { stopId: stop.stop_id, seqOrder: stop.seq_order, stopName: stop.name, dist };
      }
    }

    if (best) {
      tentativeMatches.push({
        gpsRowId: gps.id,
        gpsTime: gps.gps_time,
        lat: gps.lat,
        lon: gps.lon,
        ...best
      });

      // 【巻き戻り防止】マッチしたバス停を記録し、次のGPSログからはこれより前を探索させない
      currentMaxIdx = Math.max(currentMaxIdx, best.seqOrder);
    }
  }

  return tentativeMatches;
}

function passStep2Dedup(matches, stopMaster) {
  const coordByStop = new Map(stopMaster.map((s) => [s.stop_id, { lat: s.lat, lon: s.lon }]));
  const byStop = new Map();
  for (const m of matches) {
    if (!byStop.has(m.stopId)) byStop.set(m.stopId, []);
    byStop.get(m.stopId).push(m);
  }
  const kept = [];
  for (const [stopId, arr] of byStop.entries()) {
    if (arr.length === 1) {
      kept.push(arr[0]);
      continue;
    }
    const coord = coordByStop.get(stopId);
    arr.sort((a, b) => {
      const da = haversineDistanceMeters(a.lat, a.lon, coord.lat, coord.lon);
      const db = haversineDistanceMeters(b.lat, b.lon, coord.lat, coord.lon);
      return da - db;
    });
    kept.push(arr[0]);
  }
  return kept;
}

async function passInterpolate(client, assignmentId) {
  const rows = await client.query(
    `SELECT stop_id, seq_order, status, actual_time FROM trip_stop_progress
     WHERE assignment_id = $1 ORDER BY seq_order ASC`,
    [assignmentId]
  );

  const arrivedList = [];
  for (const r of rows.rows) {
    if (r.status !== '到着済' || !r.actual_time) continue;
    const mins = timeStrToMinutes(r.actual_time);
    if (Number.isNaN(mins)) continue;
    arrivedList.push({ seqOrder: r.seq_order, mins });
  }
  if (arrivedList.length < 2) return 0;

  const firstArrivedSeq = arrivedList[0].seqOrder;
  const statusBySeq = new Map(rows.rows.map((r) => [r.seq_order, r]));
  let filled = 0;

  for (let a = 0; a < arrivedList.length - 1; a++) {
    const prev = arrivedList[a];
    const next = arrivedList[a + 1];
    const segments = next.seqOrder - prev.seqOrder;
    if (segments <= 1) continue;

    for (let j = 1; j < segments; j++) {
      const targetSeq = prev.seqOrder + j;
      if (targetSeq < firstArrivedSeq) continue;
      const target = statusBySeq.get(targetSeq);
      if (!target || target.status === '到着済') continue;

      const interpolatedMins = Math.round(prev.mins + ((next.mins - prev.mins) * j) / segments);
      if (Number.isNaN(interpolatedMins) || interpolatedMins < 0 || interpolatedMins > 1439) continue;

      const timeStr = minutesToTimeStr(interpolatedMins);
      await client.query(
        `UPDATE trip_stop_progress
         SET status = '到着済', actual_time = $1, interpolated = TRUE
         WHERE assignment_id = $2 AND stop_id = $3`,
        [timeStr, assignmentId, target.stop_id]
      );
      filled++;
    }
  }
  return filled;
}

async function pass() {
  const client = await pool.connect();
  const radiusMeters = parseFloat(process.env.STOP_RADIUS_METERS || '120');
  const freshnessMin = parseInt(process.env.GPS_FRESHNESS_MIN || '15', 10);
  const gpsWindowMin = parseFloat(process.env.ASSIGN_GPS_WINDOW_MIN || '3');
  let totalPassed = 0;
  let totalInterpolated = 0;

  try {
    const assignments = await getActiveAssignments(client);

    for (const assignment of assignments) {
      const stopMaster = await getStopMaster(client, assignment.assignment_id);
      if (stopMaster.length === 0) continue;

      // この割り当てでまだ消費していないGPSログ。
      // 「どのGPSを処理済みか」は車両ではなく割り当てごとに管理する必要がある
      // （1台の車両が複数便の候補になり得るため）。
      const windowStart = new Date(new Date(assignment.start_at).getTime() - gpsWindowMin * 60 * 1000);
      const gpsRes = await client.query(
        `SELECT g.id, g.gps_time, g.gps_time_ts, g.lat, g.lon
         FROM vehicle_gps_log g
         WHERE g.vehicle_id = $1
           AND g.gps_time_ts >= $2
           AND g.gps_time_ts >= now() - ($3::int * INTERVAL '1 minute')
           AND NOT EXISTS (
             SELECT 1 FROM trip_gps_matches m
             WHERE m.assignment_id = $4 AND m.gps_log_id = g.id
           )
         ORDER BY g.gps_time_ts ASC`,
        [assignment.vehicle_id, windowStart, freshnessMin, assignment.assignment_id]
      );

      if (gpsRes.rows.length === 0) {
        await passInterpolate(client, assignment.assignment_id);
        continue;
      }

      // 【時間制約(ETA)】DBに保存済みのETA（前回のパイプライン実行分）を読み取る。
      // ここで読むのは必ず「今回のpass()より前」に確定した値であり、今回のpass()の
      // 結果を使って計算される今回のETA（パイプライン⑧）とは循環依存しない。
      const etaByStopId = await getEtaMap(client, assignment.assignment_id);

      const tentative = passStep1And3(assignment, stopMaster, gpsRes.rows, radiusMeters, etaByStopId);
      const kept = passStep2Dedup(tentative, stopMaster);

      for (const m of kept) {
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO trip_gps_matches (assignment_id, gps_log_id, stop_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (assignment_id, gps_log_id) DO NOTHING`,
            [assignment.assignment_id, m.gpsRowId, m.stopId]
          );
          await client.query(
            `UPDATE trip_stop_progress
             SET status = '到着済', actual_time = $1
             WHERE assignment_id = $2 AND stop_id = $3 AND status != '到着済'`,
            [m.gpsTime, assignment.assignment_id, m.stopId]
          );
          await client.query(
            `UPDATE trip_vehicle_assignments
             SET last_arrived_seq = GREATEST(last_arrived_seq, $1)
             WHERE id = $2`,
            [m.seqOrder, assignment.assignment_id]
          );
          await client.query('COMMIT');
          totalPassed++;
          console.log(
            `[pass] 通過判定: 便=${assignment.start_time}発 carId=${assignment.car_id} ` +
            `バス停=${m.stopName} 時刻=${m.gpsTime}`
          );
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[pass] エラー carId=${assignment.car_id}:`, err.message);
        }
      }

      // 重複除去で外れたGPSログは trip_gps_matches に記録しないため、
      // 次回のバッチで自動的に再評価される（旧実装の matched_label 戻し処理に相当）。

      const filled = await passInterpolate(client, assignment.assignment_id);
      totalInterpolated += filled;
      if (filled > 0) {
        console.log(`[pass] 欠落補完: 便=${assignment.start_time}発 carId=${assignment.car_id} 件数=${filled}`);
      }
    }
  } finally {
    client.release();
  }

  return { totalPassed, totalInterpolated };
}

module.exports = { pass };
