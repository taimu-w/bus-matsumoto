// 運行終了判定とアーカイブ。
//
// 便起点方式では、終了判定の単位は「車両」ではなく「便への割り当て(assignment)」になる。
// 1台の車両が複数便の候補になり得るため、車両単位で終了させると他便の処理まで巻き添えになる。
// 判定条件そのもの（終点到着・終了エリア・経過時間・GPS途絶）と閾値は従来どおり。
//
// 担当車両の割り当てが終了しても、便が終了したとは扱わない（仕様書 10.5）。
// 便のクローズ（＝実績の確定とアーカイブ）は closeDailyTrip() で行い、
// 再割り当てできる候補が居なくなった時点、または終点まで走り切った時点で呼ばれる。
const pool = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');
const { getDayOfWeek, timeStrToMinutes } = require('../utils/time');
const { updateSegmentStats } = require('./etaPredictor');

/**
 * 車両ごとの直近GPSを一括で読み込む。
 */
async function loadLatestGpsByVehicle(client, vehicleIds) {
  if (vehicleIds.length === 0) return new Map();
  const res = await client.query(
    `SELECT DISTINCT ON (vehicle_id) vehicle_id, lat, lon, gps_time_ts
     FROM vehicle_gps_log
     WHERE vehicle_id = ANY($1::int[])
     ORDER BY vehicle_id, gps_time_ts DESC, id DESC`,
    [vehicleIds]
  );
  return new Map(res.rows.map((row) => [row.vehicle_id, row]));
}

/**
 * その割り当ての終点バス停（＝その便の最終停留所）の情報を取得する。
 * 路線の終点ではなく便ごとの終点を見るため、途中止まりの便も正しく終了できる。
 */
async function getAssignmentTerminal(client, assignmentId) {
  const res = await client.query(
    `SELECT p.stop_id, p.seq_order, p.status, s.lat, s.lon
     FROM trip_stop_progress p
     JOIN stops s ON s.id = p.stop_id
     WHERE p.assignment_id = $1
     ORDER BY p.seq_order DESC
     LIMIT 1`,
    [assignmentId]
  );
  return res.rows[0] || null;
}

async function endAssignment(client, assignmentId, reason) {
  await client.query(
    `UPDATE trip_vehicle_assignments
     SET state = 'ended', ended_at = now(), end_reason = $2
     WHERE id = $1 AND state = 'active'`,
    [assignmentId, reason]
  );
}

/**
 * 1つの割り当ての実績を completed_trips へ保存する。
 * @param {boolean} isOfficial 便の実績として正とみなすか（区間統計の集計対象になる）
 */
async function archiveAssignment(client, assignment, reason, isOfficial) {
  const progressRows = await client.query(
    `SELECT stop_id, seq_order, scheduled_time, actual_time, delay_minutes
     FROM trip_stop_progress WHERE assignment_id = $1 ORDER BY seq_order ASC`,
    [assignment.assignment_id]
  );

  const serviceDateRef = new Date(`${assignment.service_date_str}T12:00:00+09:00`);

  const tripRes = await client.query(
    `INSERT INTO completed_trips
       (route_id, car_id, trip_id, daily_trip_id, assignment_id, start_time, is_official,
        trip_type, day_of_week, business_start_time, departure_time, finish_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, NULL, NULL, $9)
     RETURNING id`,
    [
      assignment.route_id,
      assignment.car_id,
      assignment.schedule_trip_id,
      assignment.daily_trip_id,
      assignment.assignment_id,
      assignment.start_time,
      isOfficial,
      getDayOfWeek(serviceDateRef),
      reason
    ]
  );
  const completedTripId = tripRes.rows[0].id;

  for (const r of progressRows.rows) {
    const actualMinutes = r.actual_time ? timeStrToMinutes(r.actual_time) : null;
    await client.query(
      `INSERT INTO completed_trip_stop_times
         (completed_trip_id, stop_id, seq_order, scheduled_time, actual_time, actual_minutes, delay_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (completed_trip_id, stop_id) DO NOTHING`,
      [
        completedTripId,
        r.stop_id,
        r.seq_order,
        r.scheduled_time,
        r.actual_time,
        Number.isNaN(actualMinutes) ? null : actualMinutes,
        r.delay_minutes
      ]
    );
  }

  return completedTripId;
}

/**
 * 便をクローズして実績を確定させる。
 *
 * 便の実績として採用するのは「最後に担当車両だった割り当て」1件だけ（is_official = TRUE）。
 * 候補車両は始発時刻から便に紐づけて進捗を記録しているため、担当へ昇格した車両の記録は
 * 便の全区間をそのまま持っている。進行度によるマージは行わない（仕様書 11・11.1）。
 *
 * 一度も担当にならなかった候補は、別経路をたまたま走っていた可能性があるため
 * アーカイブせず、区間統計(segment_travel_stats)にも一切反映しない（仕様書 18.3）。
 */
async function closeDailyTrip(client, dailyTripId, reason) {
  const assignments = await client.query(
    `SELECT a.id AS assignment_id, a.vehicle_id, a.role, a.state, a.became_assigned_at,
            a.end_reason, d.id AS daily_trip_id, d.route_id, d.schedule_trip_id,
            d.start_time, d.service_date::text AS service_date_str, v.car_id
     FROM trip_vehicle_assignments a
     JOIN daily_trips d ON d.id = a.daily_trip_id
     JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.daily_trip_id = $1
     ORDER BY a.became_assigned_at DESC NULLS LAST, a.id DESC`,
    [dailyTripId]
  );

  // 最後に担当車両だった割り当て（= 便の実績として正とみなす記録）
  const official = assignments.rows.find((a) => a.became_assigned_at !== null);

  await client.query('BEGIN');
  try {
    for (const a of assignments.rows) {
      if (a.state === 'active') {
        await endAssignment(client, a.assignment_id, reason);
      }
    }

    let archived = 0;
    if (official) {
      await archiveAssignment(client, official, official.end_reason || reason, true);
      archived++;
      // 担当を経験した他の車両（再割り当て前の旧担当など）は監査用に残す
      for (const a of assignments.rows) {
        if (a.became_assigned_at === null) continue;
        if (a.assignment_id === official.assignment_id) continue;
        await archiveAssignment(client, a, a.end_reason || reason, false);
        archived++;
      }
    }

    // クローズしても便自体は時刻表上のデータとして残り、ルート検索にも出る（仕様書 10.5）。
    // closed_at はリアルタイム運行情報の対象から外れたことを表す。
    await client.query(
      `UPDATE daily_trips
       SET closed_at = now(),
           assignment_state = CASE WHEN $2 = '担当車両不在' THEN 'unassigned' ELSE assignment_state END,
           assigned_vehicle_id = CASE WHEN $2 = '担当車両不在' THEN NULL ELSE assigned_vehicle_id END
       WHERE id = $1 AND closed_at IS NULL`,
      [dailyTripId, reason]
    );
    await client.query('COMMIT');
    return { archived };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[finish] 便のクローズに失敗しました daily_trip_id=${dailyTripId}:`, err.message);
    return { archived: 0 };
  }
}

/**
 * 運行終了条件を満たした割り当てを終了させる。
 * 便のクローズ・再割り当ては tripAssignment.reassignOrphanTrips() が引き取る。
 */
async function finishTrips() {
  const client = await pool.connect();
  const endRadius = parseFloat(process.env.END_AREA_RADIUS_METERS || '150');
  const maxAgeMin = parseInt(process.env.VEHICLE_MAX_AGE_MIN || '120', 10);
  // 割り当て直後の終了誤判定をブロックする保護期間
  const protectionMin = parseInt(process.env.FINISH_PROTECTION_MIN || '10', 10);

  let finished = 0;

  try {
    const assignments = await client.query(
      `SELECT a.id AS assignment_id, a.vehicle_id, a.role, a.created_at,
              d.id AS daily_trip_id, d.route_id, d.start_time,
              v.car_id
       FROM trip_vehicle_assignments a
       JOIN daily_trips d ON d.id = a.daily_trip_id
       JOIN vehicles v ON v.id = a.vehicle_id
       WHERE a.state = 'active'
       ORDER BY a.id ASC`
    );

    if (assignments.rows.length > 0) {
      const vehicleIds = [...new Set(assignments.rows.map((a) => a.vehicle_id))];
      const latestGpsByVehicle = await loadLatestGpsByVehicle(client, vehicleIds);

      // 条件④: GPSが3分以上更新されていない車両は、その車両の全割り当てを終了させる
      const staleVehicles = new Set();
      for (const vehicleId of vehicleIds) {
        const gps = latestGpsByVehicle.get(vehicleId);
        if (!gps) continue;
        const elapsedGpsMin = (Date.now() - new Date(gps.gps_time_ts).getTime()) / 60000;
        if (elapsedGpsMin >= 3) staleVehicles.add(vehicleId);
      }
      if (staleVehicles.size > 0) {
        await client.query(
          `UPDATE vehicles SET status = 'inactive' WHERE id = ANY($1::int[])`,
          [[...staleVehicles]]
        );
      }

      for (const a of assignments.rows) {
        let reason = '';
        const elapsedMin = (Date.now() - new Date(a.created_at).getTime()) / 60000;

        // 保護期間を過ぎている場合のみ、条件①②④を評価する
        if (elapsedMin >= protectionMin) {
          const terminal = await getAssignmentTerminal(client, a.assignment_id);

          // 条件①: この便の最終バス停が到着済か
          if (terminal && terminal.status === '到着済') {
            reason = '最終バス停到着済';
          }

          const gps = latestGpsByVehicle.get(a.vehicle_id);
          if (!reason && terminal && gps) {
            // 条件②: 直近GPSが終了エリア内か
            const dist = haversineDistanceMeters(gps.lat, gps.lon, terminal.lat, terminal.lon);
            if (dist <= endRadius) {
              reason = '終了エリア到達';
            }
          }

          // 条件④: GPS更新停止
          if (!reason && staleVehicles.has(a.vehicle_id)) {
            reason = 'GPS更新停止';
          }
        }

        // 条件③: 割り当てから一定時間経過（保護期間外でも判定し、強制終了させる）
        if (!reason && elapsedMin >= maxAgeMin) {
          reason = `割り当てから${maxAgeMin}分経過`;
        }

        if (reason) {
          await endAssignment(client, a.assignment_id, reason);
          finished++;
          console.log(
            `[finish] 割り当て終了: 便=${a.start_time}発 route=${a.route_id} carId=${a.car_id} ` +
            `役割=${a.role === 'assigned' ? '担当' : '候補'} 理由=${reason}`
          );
        }
      }
    }

    // 運行日が過ぎてもクローズされていない便を掃除する（仕様書 10.5：
    // 便の終了は既存のGTFS運行日の扱いに準ずる）
    const staleTrips = await client.query(
      `SELECT id FROM daily_trips
       WHERE closed_at IS NULL AND service_date < CURRENT_DATE
       ORDER BY id ASC
       LIMIT 200`
    );
    for (const row of staleTrips.rows) {
      await closeDailyTrip(client, row.id, '運行日終了');
    }

    if (finished > 0 || staleTrips.rows.length > 0) {
      await updateSegmentStats(client);
    }
  } finally {
    client.release();
  }

  return { finished };
}

module.exports = { finishTrips, closeDailyTrip };
