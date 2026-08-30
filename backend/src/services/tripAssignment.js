// 便への車両割り当て（仕様書 4〜8・10）。
//
// 便を先に決め、始発時刻になった時点で車両を後から割り当てる。
//   1. 始発時刻直前（始発時刻の3分前〜始発時刻の閉区間）の最新GPSを車両ごとに取る
//   2. 路線一致・direction条件・始発バス停から100m以内、を満たす車両を候補にする
//   3. 最も近い車両を担当車両、それ以外も候補車両として記録する
//   4. 候補車両にも担当車両と同じ運行処理（通過判定・遅延計算）を行う（仕様書 9）
//
// 担当車両が運行終了したら、始発時刻時点の候補の中から再割り当てする（仕様書 10）。
// 候補車両は自分自身の進捗を最初から便に紐づけて記録しているため、
// 担当への昇格は「どの割り当てを正とみなすか」の切り替えだけで済み、
// 実績のコピーやマージは発生しない（仕様書 11・11.1）。
const pool = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');
const { computeDelayMinutes, getServiceDateString } = require('../utils/time');
const { isDirectionIgnored } = require('./directionRules');
const { getRuntimeSetting } = require('./runtimeSettings');

function assignRadiusMeters() {
  return getRuntimeSetting('ASSIGN_RADIUS_METERS');
}
function gpsWindowMinutes() {
  return getRuntimeSetting('ASSIGN_GPS_WINDOW_MIN');
}
function assignDelaySeconds() {
  return getRuntimeSetting('ASSIGN_DELAY_SEC');
}
// 「同時刻帯」＝始発時刻の差がこの分数以内（仕様書 8.1）。
// この範囲の便どうしでは同じ車両を担当車両として重複させない。
// 逆に言うと、8:00便の担当車両を 8:11便の担当にすることは許される。
function samePeriodMinutes() {
  return getRuntimeSetting('ASSIGN_SAME_PERIOD_MIN');
}

/**
 * 現在「担当車両」として有効な割り当てを、車両ID→担当便の始発時刻(ms)一覧の形で読み込む。
 * 同時刻帯の重複判定に使う。
 */
async function loadAssignedStartTimes(client) {
  const res = await client.query(
    `SELECT a.vehicle_id, d.start_at
     FROM trip_vehicle_assignments a
     JOIN daily_trips d ON d.id = a.daily_trip_id
     WHERE a.role = 'assigned' AND a.state = 'active'`
  );
  const map = new Map();
  for (const row of res.rows) {
    const list = map.get(row.vehicle_id) || [];
    list.push(new Date(row.start_at).getTime());
    map.set(row.vehicle_id, list);
  }
  return map;
}

/**
 * その車両を、この便の担当車両にすると同時刻帯の重複になるか（仕様書 8.1）。
 */
function hasSamePeriodConflict(assignedMap, vehicleId, startAtMs) {
  const list = assignedMap.get(vehicleId);
  if (!list || list.length === 0) return false;
  const windowMs = samePeriodMinutes() * 60 * 1000;
  return list.some((otherStartMs) => Math.abs(otherStartMs - startAtMs) <= windowMs);
}

function rememberAssigned(assignedMap, vehicleId, startAtMs) {
  const list = assignedMap.get(vehicleId) || [];
  list.push(startAtMs);
  assignedMap.set(vehicleId, list);
}

/**
 * 便の始発バス停の座標を取得する。
 */
async function getStartStop(client, trip) {
  const res = await client.query(`SELECT id, name, lat, lon FROM stops WHERE id = $1`, [
    trip.start_stop_id
  ]);
  return res.rows[0] || null;
}

/**
 * 候補車両を抽出する（仕様書 5）。
 *
 * GPSは「始発時刻の3分前から始発時刻まで（閉区間）」に限り、
 * その範囲内で車両ごとに最新の1点を使う（仕様書 4.2）。
 * 「GPS取得時刻が始発時刻の3分以内」という条件はこのウィンドウと同義のため、
 * 追加の判定は行わない。
 */
async function findCandidates(client, trip, startStop) {
  const startAt = new Date(trip.start_at);
  const windowStart = new Date(startAt.getTime() - gpsWindowMinutes() * 60 * 1000);

  const res = await client.query(
    `SELECT DISTINCT ON (v.id)
            v.id AS vehicle_id, v.car_id, v.direction_id,
            g.id AS gps_log_id, g.lat, g.lon, g.gps_time, g.gps_time_ts
     FROM vehicles v
     JOIN vehicle_gps_log g ON g.vehicle_id = v.id
     WHERE v.route_id = $1
       AND g.gps_time_ts >= $2
       AND g.gps_time_ts <= $3
     ORDER BY v.id, g.gps_time_ts DESC`,
    [trip.route_id, windowStart, startAt]
  );

  const radius = assignRadiusMeters();
  const ignoreDirection = isDirectionIgnored(trip.route_id);
  const candidates = [];

  for (const row of res.rows) {
    // direction条件（route_direction_rules。管理画面「方向マッピング」で編集）。
    // 方向を使わない設定の路線（既定）、または車両側の方向が不明（位置情報CSVに
    // 方向列が無い等）の場合は方向で絞り込まない。
    if (!ignoreDirection && row.direction_id !== null && row.direction_id !== undefined) {
      if (row.direction_id !== trip.direction_id) continue;
    }

    const distance = haversineDistanceMeters(row.lat, row.lon, startStop.lat, startStop.lon);
    if (distance > radius) continue;

    candidates.push({
      vehicleId: row.vehicle_id,
      carId: row.car_id,
      distance,
      gpsTime: row.gps_time,
      gpsTimeTs: row.gps_time_ts
    });
  }

  // 始発バス停からの距離が近い順（仕様書 7）
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates;
}

/**
 * 割り当てを1件作成し、その便の停車予定を進捗テーブルへ展開する。
 *
 * 停車予定の展開ルールは旧 planMaking.js からの移植だったが、2026年8月にGTFSの
 * データ構造に合わせて設計し直した（docs/pass-detection.md参照）。
 *
 * 旧ルールは「経由・非停車(is_through)のバス停を通過扱いにするのは、その便で
 * 実際に定刻を持つ最後のバス停(lastValidSeq)より手前にある場合だけ」という
 * 位置ベースの判定だった。これは、当時のis_through判定がpickup_type/drop_off_type
 * のどちらか一方が1なら通過とみなしscheduled_timeをNULLにしていたため、「真の通過」
 * と「単に終点より先でまだ実績が確定していないだけの停車（scheduled_timeはあるのに
 * 見た目上NULLになっていた）」を区別する必要があったことによる代償的な措置だった。
 * 今はis_through自体がGTFS本来の意味（pickup_type=1 かつ drop_off_type=1の場合のみ
 * 真の通過）に修正され、scheduled_timeも常に実時刻が入るため、この位置による
 * 区別は不要になった。is_throughをそのままstatus='通過'に対応させれば足りる。
 *
 * 【2段階到着判定】ON CONFLICTのCASE式は、既存行が'到着済'だけでなく'付近'（GTFS再取得
 * によるGTFS更新・reseed時に進行中の追跡状態を巻き戻さないため）の場合も上書きしない。
 * nearby_min_distance_* 列はSET句に含めていないため、reseedでも常に保持される。
 */
async function openAssignment(client, trip, candidate, role) {
  const inserted = await client.query(
    `INSERT INTO trip_vehicle_assignments
       (daily_trip_id, vehicle_id, role, state, distance_meters, eval_gps_time, eval_gps_time_ts, became_assigned_at)
     VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)
     ON CONFLICT (daily_trip_id, vehicle_id) DO UPDATE
       SET role = EXCLUDED.role,
           state = 'active',
           distance_meters = EXCLUDED.distance_meters,
           eval_gps_time = EXCLUDED.eval_gps_time,
           eval_gps_time_ts = EXCLUDED.eval_gps_time_ts,
           became_assigned_at = EXCLUDED.became_assigned_at
     RETURNING id`,
    [
      trip.id,
      candidate.vehicleId,
      role,
      candidate.distance,
      candidate.gpsTime,
      candidate.gpsTimeTs,
      role === 'assigned' ? new Date() : null
    ]
  );
  const assignmentId = inserted.rows[0].id;

  const stopTimes = await client.query(
    `SELECT stop_id, seq_order, scheduled_time, is_through
     FROM daily_trip_stop_times
     WHERE daily_trip_id = $1
     ORDER BY seq_order ASC`,
    [trip.id]
  );
  if (stopTimes.rows.length === 0) return assignmentId;

  const originSeq = stopTimes.rows[0].seq_order;

  for (const st of stopTimes.rows) {
    const isOrigin = st.seq_order === originSeq;

    let status = st.is_through ? '通過' : '';
    let actualTime = null;
    let delayMinutes = null;
    let arrivalMethod = null;
    let arrivalEvidence = null;

    if (isOrigin) {
      // 始発時刻の時点で始発バス停から100m以内にいたという確定した観測事実を実績にする。
      // （旧方式の「出発時刻」に相当。営業開始・出発判定は廃止した＝仕様書 13）
      status = '到着済';
      actualTime = candidate.gpsTime;
      delayMinutes = computeDelayMinutes(st.scheduled_time, actualTime);
      arrivalMethod = 'start';
      arrivalEvidence = { distanceMeters: candidate.distance, gpsTime: candidate.gpsTime };
    }

    // arrival_method / arrival_evidence は nearby_min_distance_* と同じく ON CONFLICT の
    // SET句に含めない（GTFS再取得のreseedで進行中の判定結果・根拠を巻き戻さないため）。
    await client.query(
      `INSERT INTO trip_stop_progress
         (assignment_id, stop_id, seq_order, scheduled_time, status, actual_time, delay_minutes, arrival_method, arrival_evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (assignment_id, stop_id) DO UPDATE
         SET scheduled_time = EXCLUDED.scheduled_time,
             status = CASE
               WHEN trip_stop_progress.status IN ('到着済', '付近') THEN trip_stop_progress.status
               ELSE EXCLUDED.status
             END,
             actual_time = CASE
               WHEN trip_stop_progress.status IN ('到着済', '付近') THEN trip_stop_progress.actual_time
               ELSE EXCLUDED.actual_time
             END,
             delay_minutes = CASE
               WHEN trip_stop_progress.status IN ('到着済', '付近') THEN trip_stop_progress.delay_minutes
               ELSE EXCLUDED.delay_minutes
             END`,
      [assignmentId, st.stop_id, st.seq_order, st.scheduled_time, status, actualTime, delayMinutes, arrivalMethod, arrivalEvidence]
    );
  }

  return assignmentId;
}

/**
 * 始発時刻が到来した便に、担当車両・候補車両を割り当てる（仕様書 4・7・8）。
 * 便は始発時刻の早い順に1件ずつ確定させるため、直前の便で担当になった車両は
 * 次の便の判定時点で自動的に考慮される（仕様書 8.2）。
 */
async function assignPendingTrips() {
  const client = await pool.connect();
  const serviceDate = getServiceDateString();
  // 位置情報フィードの配信遅れを吸収するため、始発時刻から少し待ってから判定する。
  // 判定に使うGPSの時間窓（始発時刻の3分前〜始発時刻）は変わらない。
  const evaluateBefore = new Date(Date.now() - assignDelaySeconds() * 1000);

  let assigned = 0;
  let unassigned = 0;
  let candidatesTotal = 0;

  try {
    const targets = await client.query(
      `SELECT id, route_id, direction_id, start_stop_id, start_time, start_at, headsign
       FROM daily_trips
       WHERE service_date = $1
         AND assignment_state = 'pending'
         AND start_at <= $2
       ORDER BY start_at ASC, id ASC`,
      [serviceDate, evaluateBefore]
    );
    if (targets.rows.length === 0) return { assigned: 0, unassigned: 0, candidates: 0 };

    const assignedMap = await loadAssignedStartTimes(client);

    for (const trip of targets.rows) {
      const startStop = await getStartStop(client, trip);
      if (!startStop) {
        console.error(`[tripAssignment] 始発バス停が見つかりません: daily_trip_id=${trip.id}`);
        await client.query(
          `UPDATE daily_trips SET assignment_state = 'unassigned' WHERE id = $1`,
          [trip.id]
        );
        unassigned++;
        continue;
      }

      const candidates = await findCandidates(client, trip, startStop);

      if (candidates.length === 0) {
        // 候補がいなければ、その便はリアルタイム運行情報を取得できない扱いにする。
        // 時刻表上のデータとしては存在し続ける（仕様書 10.4・12）。
        await client.query(
          `UPDATE daily_trips SET assignment_state = 'unassigned' WHERE id = $1`,
          [trip.id]
        );
        unassigned++;
        continue;
      }

      const startAtMs = new Date(trip.start_at).getTime();
      // 最も近い車両を担当にする。ただし同時刻帯の別便で既に担当になっている車両は飛ばす。
      const assignedCandidate = candidates.find(
        (c) => !hasSamePeriodConflict(assignedMap, c.vehicleId, startAtMs)
      );

      await client.query('BEGIN');
      try {
        for (const candidate of candidates) {
          const role = assignedCandidate && candidate.vehicleId === assignedCandidate.vehicleId
            ? 'assigned'
            : 'candidate';
          await openAssignment(client, trip, candidate, role);
        }

        if (assignedCandidate) {
          await client.query(
            `UPDATE daily_trips
             SET assignment_state = 'assigned', assigned_vehicle_id = $2, assigned_at = now()
             WHERE id = $1`,
            [trip.id, assignedCandidate.vehicleId]
          );
        } else {
          // 候補は居るが全員が同時刻帯の別便の担当だった場合。
          // 候補としての記録は残すため、再割り当て時に担当へ昇格し得る。
          await client.query(
            `UPDATE daily_trips SET assignment_state = 'unassigned' WHERE id = $1`,
            [trip.id]
          );
        }
        await client.query('COMMIT');

        candidatesTotal += candidates.length;
        if (assignedCandidate) {
          rememberAssigned(assignedMap, assignedCandidate.vehicleId, startAtMs);
          assigned++;
          console.log(
            `[tripAssignment] 担当車両を決定: 便=${trip.start_time}発 route=${trip.route_id} ` +
            `carId=${assignedCandidate.carId} 距離=${Math.round(assignedCandidate.distance)}m 候補=${candidates.length}台`
          );
        } else {
          unassigned++;
          console.log(
            `[tripAssignment] 担当車両なし（候補は全員が同時刻帯の別便の担当）: 便=${trip.start_time}発 route=${trip.route_id}`
          );
        }
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[tripAssignment] 割り当てエラー daily_trip_id=${trip.id}:`, err.message);
      }
    }
  } finally {
    client.release();
  }

  return { assigned, unassigned, candidates: candidatesTotal };
}

/**
 * 担当車両が運行終了した便について、始発時刻時点の候補から再割り当てする（仕様書 10）。
 *
 * 再割り当て候補は「始発時刻時点で候補になっていた車両」だけで、
 * 始発時刻後に近づいてきた車両を追加することはしない（仕様書 10.2）。
 */
async function reassignOrphanTrips() {
  const { closeDailyTrip, SUCCESS_END_REASONS } = require('./finishService');
  const client = await pool.connect();
  let reassigned = 0;
  let closed = 0;

  try {
    // 担当車両が有効でなくなった、まだクローズしていない便。
    // assignment_state='unassigned' でも、生きている候補車両が残っていれば昇格対象にする
    // （割り当て時点では同時刻帯の重複で担当を立てられなかったが、その後解消した場合）。
    const orphans = await client.query(
      `SELECT d.id, d.route_id, d.start_time, d.start_at, d.assignment_state
       FROM daily_trips d
       WHERE d.closed_at IS NULL
         AND d.assignment_state IN ('assigned', 'unassigned')
         AND NOT EXISTS (
           SELECT 1 FROM trip_vehicle_assignments a
           WHERE a.daily_trip_id = d.id AND a.role = 'assigned' AND a.state = 'active'
         )
         AND EXISTS (
           SELECT 1 FROM trip_vehicle_assignments a WHERE a.daily_trip_id = d.id
         )
       ORDER BY d.start_at ASC`
    );

    if (orphans.rows.length === 0) return { reassigned: 0, closed: 0 };

    const assignedMap = await loadAssignedStartTimes(client);

    for (const trip of orphans.rows) {
      // 終点まで走り切って終了した便は、再割り当てせずそのまま完了とする。
      // GPS途絶時の終点到着救済判定で終点到達が確認できたケースも同様に扱う。
      // （時間経過・終点未到達でのGPS途絶ロストで落ちた場合だけが再割り当ての対象）
      const lastAssigned = await client.query(
        `SELECT end_reason FROM trip_vehicle_assignments
         WHERE daily_trip_id = $1 AND role = 'assigned'
         ORDER BY became_assigned_at DESC NULLS LAST, id DESC
         LIMIT 1`,
        [trip.id]
      );
      const endReason = lastAssigned.rows[0]?.end_reason || '';
      if (SUCCESS_END_REASONS.has(endReason)) {
        await closeDailyTrip(client, trip.id, endReason);
        closed++;
        continue;
      }

      // 再割り当て候補：始発時刻時点の候補のうち、まだ生きていて、
      // 同時刻帯の別便の担当になっていないもの（仕様書 10.3）
      const candidatePool = await client.query(
        `SELECT a.id AS assignment_id, a.vehicle_id, a.distance_meters, v.car_id
         FROM trip_vehicle_assignments a
         JOIN vehicles v ON v.id = a.vehicle_id
         WHERE a.daily_trip_id = $1
           AND a.role = 'candidate'
           AND a.state = 'active'
         ORDER BY a.distance_meters ASC`,
        [trip.id]
      );

      const startAtMs = new Date(trip.start_at).getTime();
      const next = candidatePool.rows.find(
        (row) => !hasSamePeriodConflict(assignedMap, row.vehicle_id, startAtMs)
      );

      if (!next) {
        if (trip.assignment_state === 'unassigned') {
          // 一度も担当が立っていない便。候補が同時刻帯の重複で塞がっているだけなので、
          // クローズせず次回以降に再挑戦する（アーカイブすべき実績も無い）。
          continue;
        }
        // 再割り当てできる車両がない。便は時刻表上のデータとして存続し、
        // リアルタイム運行情報の対象からは外れる（仕様書 10.4・10.5）。
        await closeDailyTrip(client, trip.id, '担当車両不在');
        closed++;
        console.log(`[tripAssignment] 再割り当て候補なし: 便=${trip.start_time}発 route=${trip.route_id}`);
        continue;
      }

      await client.query('BEGIN');
      try {
        // 距離が最も近い候補を新しい担当にする。進行度は判断材料にしない（仕様書 11.1）。
        await client.query(
          `UPDATE trip_vehicle_assignments
           SET role = 'assigned', became_assigned_at = now()
           WHERE id = $1`,
          [next.assignment_id]
        );
        await client.query(
          `UPDATE daily_trips
           SET assignment_state = 'assigned', assigned_vehicle_id = $2, assigned_at = now()
           WHERE id = $1`,
          [trip.id, next.vehicle_id]
        );
        await client.query('COMMIT');

        rememberAssigned(assignedMap, next.vehicle_id, startAtMs);
        reassigned++;
        console.log(
          `[tripAssignment] 担当車両を再割り当て: 便=${trip.start_time}発 route=${trip.route_id} ` +
          `carId=${next.car_id} 距離=${Math.round(next.distance_meters)}m`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[tripAssignment] 再割り当てエラー daily_trip_id=${trip.id}:`, err.message);
      }
    }

    // 便がクローズされた＝新しい実績が確定したので、区間統計を育てる
    if (closed > 0) {
      const { updateSegmentStats } = require('./etaPredictor');
      await updateSegmentStats(client);
    }
  } finally {
    client.release();
  }

  return { reassigned, closed };
}

module.exports = {
  assignPendingTrips,
  reassignOrphanTrips,
  findCandidates,
  openAssignment,
  hasSamePeriodConflict,
  loadAssignedStartTimes
};
