// 運行ダッシュボード（地図）からの手動での車両⇔便の紐づけ・解除。
//
// 通常は tripAssignment.js が始発時刻到来時にGPSの位置関係だけで自動的に車両を割り当てるが、
// GPS精度の問題等で自動割り当てに失敗した場合の救済として、管理者が手動で紐づけ・解除できる
// ようにする。紐づけ・解除そのものの後始末（進捗記録の作成、割り当て終了時の後処理）は
// 既存の自動割り当てパイプラインと同じ関数（passDetection.processAssignmentPass /
// finishService.endAssignment）をそのまま再利用し、ロジックを重複させない。
//
// 【途中区間からの手動紐づけ】vehicle_gps_log は割り当ての有無に関わらず車両単位で
// 記録され続けている（sortCarId()が全アクティブ車両を対象に書き込む）ため、便の運行が
// 始まってから途中で手動紐づけしても、紐づけ直後に processAssignmentPass を
// freshnessMin=null（直近◯分以内という絞り込みなし）で1回だけ走らせれば、既に
// 記録済みのGPS履歴から「その便の始発時刻から現在まで」の区間を一括でキャッチアップし、
// 通過済みバス停の実績時刻を即座に埋められる。バスアイコンの表示は /api/buses-for-map が
// 割り当ての有無だけを見て決めるため、紐づけが完了した時点で次回のポーリングから
// 自動的に地図へ現れる（追加の作業は不要）。
const pool = require('../config/db');
const { formatNowNoFormat } = require('../utils/time');
const { getRuntimeSetting } = require('./runtimeSettings');
const { processAssignmentPass } = require('./passDetection');
const { endAssignment } = require('./finishService');

/**
 * 指定路線・日付の、手動紐づけの選択肢にする当日便一覧。
 * まだクローズしていない（closed_at IS NULL）便を始発時刻順に返す。
 * 既に担当車両がいる便も一覧には含める（表示側で「担当あり」と分かるようにするため）。
 */
async function listLinkableTrips(routeId, serviceDate) {
  const res = await pool.query(
    `SELECT d.id, d.start_time, d.headsign, d.assignment_state,
            v.car_id AS assigned_car_id
     FROM daily_trips d
     LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id
     WHERE d.route_id = $1 AND d.service_date = $2 AND d.closed_at IS NULL
     ORDER BY d.start_at ASC`,
    [routeId, serviceDate]
  );
  return res.rows.map((row) => ({
    dailyTripId: row.id,
    startTime: row.start_time,
    headsign: row.headsign,
    assignmentState: row.assignment_state,
    assignedCarId: row.assigned_car_id
  }));
}

/**
 * 割り当て本体(trip_vehicle_assignments)と進捗テーブル(trip_stop_progress)の行を作る。
 * tripAssignment.openAssignment() と異なり、GPS候補判定の結果（distance/gpsTime）を
 * 持たないため、始発バス停をあらかじめ「到着済」に確定させることはしない
 * （このあとのキャッチアップ判定に、始発バス停も含めて他のバス停と同列に委ねる）。
 */
async function createManualAssignmentRows(client, dailyTripId, vehicleId) {
  const nowHHmm = formatNowNoFormat();
  const inserted = await client.query(
    `INSERT INTO trip_vehicle_assignments
       (daily_trip_id, vehicle_id, role, state, distance_meters, eval_gps_time, eval_gps_time_ts, became_assigned_at)
     VALUES ($1, $2, 'assigned', 'active', 0, $3, now(), now())
     ON CONFLICT (daily_trip_id, vehicle_id) DO UPDATE
       SET role = 'assigned', state = 'active', became_assigned_at = now(),
           ended_at = NULL, end_reason = NULL
     RETURNING id`,
    [dailyTripId, vehicleId, nowHHmm]
  );
  const assignmentId = inserted.rows[0].id;

  const stopTimes = await client.query(
    `SELECT stop_id, seq_order, scheduled_time, is_through
     FROM daily_trip_stop_times
     WHERE daily_trip_id = $1
     ORDER BY seq_order ASC`,
    [dailyTripId]
  );
  for (const st of stopTimes.rows) {
    const status = st.is_through ? '通過' : '';
    await client.query(
      `INSERT INTO trip_stop_progress (assignment_id, stop_id, seq_order, scheduled_time, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (assignment_id, stop_id) DO NOTHING`,
      [assignmentId, st.stop_id, st.seq_order, st.scheduled_time, status]
    );
  }

  return assignmentId;
}

/**
 * 車両を便に手動で紐づける。戻り値 { ok:true, assignmentId } または { ok:false, status, error }。
 */
async function linkVehicleToTrip(vehicleId, dailyTripId) {
  const client = await pool.connect();
  try {
    const tripRes = await client.query(
      `SELECT id, route_id, start_time, start_at, closed_at FROM daily_trips WHERE id = $1`,
      [dailyTripId]
    );
    const trip = tripRes.rows[0];
    if (!trip) return { ok: false, status: 404, error: '指定の便が見つかりませんでした。' };
    if (trip.closed_at) return { ok: false, status: 400, error: 'この便は既に運行終了しています。' };

    const activeAssigned = await client.query(
      `SELECT id FROM trip_vehicle_assignments WHERE daily_trip_id = $1 AND role = 'assigned' AND state = 'active'`,
      [dailyTripId]
    );
    if (activeAssigned.rows.length > 0) {
      return { ok: false, status: 400, error: 'この便には既に担当車両が割り当てられています。先に解除してから紐づけてください。' };
    }

    const vehicleRes = await client.query(`SELECT id FROM vehicles WHERE id = $1`, [vehicleId]);
    if (!vehicleRes.rows[0]) return { ok: false, status: 404, error: '指定の車両が見つかりませんでした。' };

    let assignmentId;
    await client.query('BEGIN');
    try {
      assignmentId = await createManualAssignmentRows(client, dailyTripId, vehicleId);
      await client.query(
        `UPDATE daily_trips SET assignment_state = 'assigned', assigned_vehicle_id = $2, assigned_at = now() WHERE id = $1`,
        [dailyTripId, vehicleId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    // 【途中区間からの手動紐づけ】紐づけ直後に1回だけキャッチアップ判定を行う。
    const assignmentRow = await client.query(
      `SELECT a.id AS assignment_id, a.vehicle_id, d.start_time, d.start_at, v.car_id
       FROM trip_vehicle_assignments a
       JOIN daily_trips d ON d.id = a.daily_trip_id
       JOIN vehicles v ON v.id = a.vehicle_id
       WHERE a.id = $1`,
      [assignmentId]
    );
    await processAssignmentPass(client, assignmentRow.rows[0], {
      radiusMeters: getRuntimeSetting('STOP_RADIUS_METERS'),
      marginMeters: getRuntimeSetting('DEPARTURE_MARGIN_METERS'),
      gpsWindowMin: getRuntimeSetting('ASSIGN_GPS_WINDOW_MIN'),
      freshnessMin: null
    });

    return { ok: true, assignmentId };
  } finally {
    client.release();
  }
}

/**
 * 手動での紐づけ解除。割り当てを終了させるだけで、便のクローズ・再割り当ては
 * 既存の自動パイプライン（tripAssignment.reassignOrphanTrips、60秒間隔）に委ねる
 * （endAssignment自体はfinishService.jsの自動終了処理と全く同じ関数）。
 */
async function unlinkAssignment(assignmentId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT id, state FROM trip_vehicle_assignments WHERE id = $1`,
      [assignmentId]
    );
    const assignment = res.rows[0];
    if (!assignment) return { ok: false, status: 404, error: '指定の割り当てが見つかりませんでした。' };
    if (assignment.state !== 'active') {
      return { ok: false, status: 400, error: 'この割り当ては既に終了しています。' };
    }

    await endAssignment(client, assignmentId, '手動解除');
    return { ok: true };
  } finally {
    client.release();
  }
}

module.exports = { listLinkableTrips, linkVehicleToTrip, unlinkAssignment };
