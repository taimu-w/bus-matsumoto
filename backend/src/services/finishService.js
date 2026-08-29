// 運行終了判定とアーカイブ。
//
// 便起点方式では、終了判定の単位は「車両」ではなく「便への割り当て(assignment)」になる。
// 1台の車両が複数便の候補になり得るため、車両単位で終了させると他便の処理まで巻き添えになる。
// 判定条件そのもの（終点到着・経過時間・GPS途絶）は従来どおり。
// 各閾値（半径・経過時間）は既定値こそ従来どおりだが、2026-08-21以降は
// services/runtimeSettings.js 経由で管理画面（運用パラメータ設定）から編集できる。
//
// 担当車両の割り当てが終了しても、便が終了したとは扱わない（仕様書 10.5）。
// 便のクローズ（＝実績の確定とアーカイブ）は closeDailyTrip() で行い、
// 再割り当てできる候補が居なくなった時点、または終点まで走り切った時点で呼ばれる。
const pool = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');
const { getDayOfWeek, getDayType, timeStrToMinutes } = require('../utils/time');
const { updateSegmentStats } = require('./etaPredictor');
const { loadHolidaySet } = require('./holidayCalendar');
const { refreshRuntimeSettingsCache, getRuntimeSetting } = require('./runtimeSettings');

// 「終点まで到達して正常に終了した」とみなす end_reason。
// - reassignOrphanTrips() はこれらを再割り当てせずそのままクローズする。
// - 便の割り当て監視（/api/admin/assignment-monitor）では正常終了（緑）扱いにする。
// GPS途絶時の終点到着救済判定（条件④）で終点到達が確認できたケースも、通常の終点到着と
// 同じ正常終了として扱い、GPS途絶（ロスト）には含めない。
const SUCCESS_END_REASONS = new Set([
  '最終バス停到着済',
  '終点到着（GPS途絶時判定）',
  '終点到着（GPS途絶時判定・付近経由）'
]);

/**
 * 車両ごとの直近GPSを一括で読み込む。
 */
async function loadLatestGpsByVehicle(client, vehicleIds) {
  if (vehicleIds.length === 0) return new Map();
  const res = await client.query(
    `SELECT DISTINCT ON (vehicle_id) vehicle_id, lat, lon, gps_time, gps_time_ts
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
    `SELECT p.stop_id, p.seq_order, p.status, p.nearby_min_distance_gps_time, s.lat, s.lon
     FROM trip_stop_progress p
     JOIN stops s ON s.id = p.stop_id
     WHERE p.assignment_id = $1
     ORDER BY p.seq_order DESC
     LIMIT 1`,
    [assignmentId]
  );
  return res.rows[0] || null;
}

/**
 * まだ到着済/通過になっていない（＝未到達の）バス停一覧を返す。
 * GPS途絶時の「終点到着」救済判定（残り未到達バス停が終点のみか）に使う。
 */
async function getUnreachedStops(client, assignmentId) {
  const res = await client.query(
    `SELECT stop_id FROM trip_stop_progress WHERE assignment_id = $1 AND status = ''`,
    [assignmentId]
  );
  return res.rows;
}

/**
 * 【2段階到着判定・付近スタックの強制昇格】終点をはじめ、バス停は「付近」のまま
 * 離脱（＝到着確定のトリガー）が起きずに割り当てが終了することがある（典型例は
 * 終点：バスが到着後そのまま停車し続け、マージン距離だけ離れることが無い）。
 * 割り当て終了時に「付近」のまま残っているバス停は、記録済みの最小距離の観測時刻を
 * 使って強制的に「到着済」へ昇格させる（実観測データに基づくためinterpolated=FALSE）。
 */
async function promoteStuckNearbyOnEnd(client, assignmentId) {
  const promoted = await client.query(
    `UPDATE trip_stop_progress
     SET status = '到着済', actual_time = nearby_min_distance_gps_time, interpolated = FALSE,
         arrival_method = 'finish',
         arrival_evidence = jsonb_build_object(
           'minDistanceMeters', nearby_min_distance_meters,
           'gpsTime', nearby_min_distance_gps_time,
           'trigger', '割り当て終了時に付近状態のまま残っていたため強制昇格'
         )
     WHERE assignment_id = $1 AND status = '付近' AND nearby_min_distance_gps_time IS NOT NULL
     RETURNING seq_order`,
    [assignmentId]
  );
  if (promoted.rows.length > 0) {
    const maxSeq = Math.max(...promoted.rows.map((r) => r.seq_order));
    await client.query(
      `UPDATE trip_vehicle_assignments SET last_arrived_seq = GREATEST(last_arrived_seq, $1) WHERE id = $2`,
      [maxSeq, assignmentId]
    );
  }
}

async function endAssignment(client, assignmentId, reason) {
  await promoteStuckNearbyOnEnd(client, assignmentId);
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
  const holidaySet = await loadHolidaySet(client);

  const tripRes = await client.query(
    `INSERT INTO completed_trips
       (route_id, car_id, trip_id, daily_trip_id, assignment_id, start_time, is_official,
        day_of_week, day_type, finish_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      getDayType(serviceDateRef, holidaySet),
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
  await client.query('BEGIN');
  try {
    // 便クローズの二重実行防止。
    // finishTrips()の運行日終了掃除と、パイプラインのreassignOrphanTrips()は、
    // それぞれ別タイマー・別DB接続から同じ便を同時にクローズしようとすることがある。
    // 行ロックを取り、既にクローズ済み（closed_at IS NOT NULL）なら即座に抜ける。
    // 後発側はFOR UPDATEで先発のCOMMITまでブロックされたあとにこの判定へ来るため、
    // 「両方が実績を二重アーカイブする」事態を防げる。
    const lock = await client.query(
      `SELECT id FROM daily_trips WHERE id = $1 AND closed_at IS NULL FOR UPDATE`,
      [dailyTripId]
    );
    if (lock.rows.length === 0) {
      await client.query('COMMIT');
      return { archived: 0 };
    }

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
  // 管理画面から編集可能な運用設定（判定半径・タイムアウト等）を最新化する。
  await refreshRuntimeSettingsCache();

  const client = await pool.connect();
  // GPS途絶時、未到達バス停が終点のみの場合に「終点到着」とみなす救済判定の半径。
  // 途絶中は測位精度が落ちている前提のため広めにとる。
  const gpsTimeoutTerminalRadius = getRuntimeSetting('GPS_TIMEOUT_TERMINAL_RADIUS_METERS');
  const maxAgeMin = getRuntimeSetting('VEHICLE_MAX_AGE_MIN');
  // 割り当て直後の終了誤判定をブロックする保護期間
  const protectionMin = getRuntimeSetting('FINISH_PROTECTION_MIN');
  // GPSがこの時間以上更新されていない車両を「途絶」とみなす（旧・直書きの3分。
  // 管理画面（運用パラメータ設定）から編集可能。既定値は従来どおり3分）
  const staleTimeoutMin = getRuntimeSetting('GPS_STALE_TIMEOUT_MIN');

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

      // 条件④: GPSがstaleTimeoutMin以上更新されていない車両は、その車両の全割り当てを終了させる
      const staleVehicles = new Set();
      for (const vehicleId of vehicleIds) {
        const gps = latestGpsByVehicle.get(vehicleId);
        if (!gps) continue;
        const elapsedGpsMin = (Date.now() - new Date(gps.gps_time_ts).getTime()) / 60000;
        if (elapsedGpsMin >= staleTimeoutMin) staleVehicles.add(vehicleId);
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

        // 保護期間を過ぎている場合のみ、条件①④を評価する
        if (elapsedMin >= protectionMin) {
          const terminal = await getAssignmentTerminal(client, a.assignment_id);

          // 条件①: この便の最終バス停が到着済か
          if (terminal && terminal.status === '到着済') {
            reason = '最終バス停到着済';
          }

          const gps = latestGpsByVehicle.get(a.vehicle_id);

          // 条件④: GPS更新停止（途絶）
          if (!reason && staleVehicles.has(a.vehicle_id)) {
            // 途絶時は即ロスト扱いにせず、未到達バス停が「終点のみ」残っている場合に限り
            // 最終GPSが終点付近（gpsTimeoutTerminalRadius）かどうかで終点到着への救済判定を行う。
            // 未到達バス停が2個以上残っている場合はこれまでどおり通信障害/ロストとして扱う。
            if (terminal && terminal.status !== '到着済') {
              if (terminal.status === '付近' && terminal.nearby_min_distance_gps_time) {
                // 終点が既に「付近」まで来ている場合、実際に観測された最小距離の
                // GPS時刻の方が、途絶直前の生のGPS点より確度が高い（測位精度が
                // 落ちている前提の途絶時判定より強い根拠になる）ため、
                // distToTerminalの再チェックなしでそのまま昇格させる。
                await client.query(
                  `UPDATE trip_stop_progress
                   SET status = '到着済', actual_time = $1, interpolated = FALSE,
                       arrival_method = 'finish',
                       arrival_evidence = jsonb_build_object(
                         'minDistanceMeters', nearby_min_distance_meters,
                         'gpsTime', $1::text,
                         'trigger', 'GPS途絶時の終点到着救済判定（終点が付近まで到達済み）'
                       )
                   WHERE assignment_id = $2 AND stop_id = $3`,
                  [terminal.nearby_min_distance_gps_time, a.assignment_id, terminal.stop_id]
                );
                reason = '終点到着（GPS途絶時判定・付近経由）';
              } else {
                const unreached = await getUnreachedStops(client, a.assignment_id);
                const onlyTerminalUnreached =
                  unreached.length === 1 && unreached[0].stop_id === terminal.stop_id;

                if (onlyTerminalUnreached && gps) {
                  const distToTerminal = haversineDistanceMeters(gps.lat, gps.lon, terminal.lat, terminal.lon);
                  if (distToTerminal <= gpsTimeoutTerminalRadius) {
                    await client.query(
                      `UPDATE trip_stop_progress
                       SET status = '到着済', actual_time = $1, interpolated = TRUE,
                           arrival_method = 'finish',
                           arrival_evidence = jsonb_build_object(
                             'distanceMeters', $4::double precision,
                             'gpsTime', $1::text,
                             'trigger', 'GPS途絶時の終点到着救済判定（未到達は終点のみ・最終GPSが終点付近）'
                           )
                       WHERE assignment_id = $2 AND stop_id = $3`,
                      [gps.gps_time, a.assignment_id, terminal.stop_id, distToTerminal]
                    );
                    reason = '終点到着（GPS途絶時判定）';
                  }
                }
              }
            }

            if (!reason) {
              reason = 'GPS更新停止';
            }
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

/**
 * 保持期間を過ぎた運行実績アーカイブ(completed_trips / completed_trip_stop_times)を掃除する。
 *
 * 区間別の平均統計(segment_travel_stats)は便のクローズ直後に updateSegmentStats() が
 * インクリメンタルに反映済みで、生データ(completed_trips)を消しても平均は変化しない。
 *
 * 安全のため、削除するのは次のいずれかを満たす行だけに限定する：
 *   - aggregated = TRUE                 … 既に区間統計へ反映済み
 *   - is_official = FALSE               … 候補車両止まりの参考記録。updateSegmentStats() は
 *                                          is_official = TRUE しか集計しないため永久に
 *                                          aggregated = FALSE のまま残る（この条件が無いと
 *                                          参考記録だけが掃除されず溜まり続ける）
 * これにより「まだ区間統計へ反映されていない正実績」を取りこぼすことはない
 * （集計が遅れている行は保持期間を過ぎていても次回以降まで残る）。
 * completed_trip_stop_times は ON DELETE CASCADE で追従する。
 */
async function purgeOldCompletedTrips(retentionDays = getRuntimeSetting('COMPLETED_TRIP_RETENTION_DAYS')) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `DELETE FROM completed_trips
        WHERE finished_at < now() - ($1::int * interval '1 day')
          AND (aggregated = TRUE OR is_official = FALSE)`,
      [retentionDays]
    );
    if (res.rowCount > 0) {
      console.log(`[finish] 保持期間を過ぎた運行実績アーカイブ ${res.rowCount} 件を削除しました。`);
    }
    return { deleted: res.rowCount };
  } finally {
    client.release();
  }
}

module.exports = { finishTrips, closeDailyTrip, endAssignment, purgeOldCompletedTrips, SUCCESS_END_REASONS };
