// vehicle_positions_raw の未処理行を、車両ごとの走行ログ(vehicle_gps_log)へ転記する。
//
// 便起点方式では vehicles テーブルは「観測されている物理車両」を表すだけになり、
// 便との紐付けは一切持たない（それは trip_vehicle_assignments の役割）。
// 1台の車両が複数便の候補になり得るため、運行終了しても行は削除せず
// status = 'inactive' にして再利用する。
const pool = require('../config/db');
const { getRuntimeSetting } = require('./runtimeSettings');

async function getOrCreateVehicle(client, row) {
  const existing = await client.query(
    'SELECT id FROM vehicles WHERE route_id = $1 AND car_id = $2',
    [row.route_id, row.car_id]
  );

  if (existing.rows.length > 0) {
    const vehicleId = existing.rows[0].id;
    // GPSが届いている＝稼働中に戻す。方向は毎回の観測値で更新する。
    await client.query(
      `UPDATE vehicles
       SET status = 'active',
           direction_id = $2,
           direction_raw = $3,
           last_gps_at = GREATEST(COALESCE(last_gps_at, $4::timestamptz), $4::timestamptz)
       WHERE id = $1`,
      [vehicleId, row.direction_id, row.direction_raw, row.gps_time_ts]
    );
    return vehicleId;
  }

  const inserted = await client.query(
    `INSERT INTO vehicles (route_id, car_id, direction_id, direction_raw, last_gps_at, created_at, status)
     VALUES ($1, $2, $3, $4, $5, now(), 'active')
     RETURNING id`,
    [row.route_id, row.car_id, row.direction_id, row.direction_raw, row.gps_time_ts]
  );

  console.log(`[vehicleAssigner] 新規車両を作成しました: ${row.car_id} (route=${row.route_id})`);
  return inserted.rows[0].id;
}

async function sortCarId() {
  const client = await pool.connect();
  let transferred = 0;
  try {
    const pending = await client.query(
      `SELECT id, route_id, direction_id, direction_raw, car_id, received_time, gps_time, gps_time_ts, lat, lon
       FROM vehicle_positions_raw
       WHERE processed = FALSE
       ORDER BY id ASC
       LIMIT 500`
    );

    if (pending.rows.length === 0) {
      return { transferred: 0 };
    }

    for (const row of pending.rows) {
      if (!row.route_id) {
        // 路線を解決できなかった行は便に紐づけようがないため、処理済みにして捨てる
        await client.query('UPDATE vehicle_positions_raw SET processed = TRUE WHERE id = $1', [row.id]);
        continue;
      }

      await client.query('BEGIN');
      try {
        const vehicleId = await getOrCreateVehicle(client, row);
        await client.query(
          `INSERT INTO vehicle_gps_log (vehicle_id, received_time, gps_time, gps_time_ts, lat, lon)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [vehicleId, row.received_time, row.gps_time, row.gps_time_ts, row.lat, row.lon]
        );
        await client.query('UPDATE vehicle_positions_raw SET processed = TRUE WHERE id = $1', [row.id]);
        await client.query('COMMIT');
        transferred++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[vehicleAssigner] 転記エラー carId=${row.car_id}:`, err.message);
      }
    }
  } finally {
    client.release();
  }
  if (transferred > 0) console.log(`[vehicleAssigner] ${transferred} 件を車両別ログへ転記しました。`);
  return { transferred };
}

/**
 * 古いGPSログを掃除する。車両行を削除しなくなったため、明示的な保持期間が必要。
 */
async function purgeOldGpsLogs(retentionHours = getRuntimeSetting('GPS_LOG_RETENTION_HOURS')) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `DELETE FROM vehicle_gps_log
       WHERE gps_time_ts < now() - ($1::int * INTERVAL '1 hour')`,
      [retentionHours]
    );
    if (res.rowCount > 0) {
      console.log(`[vehicleAssigner] 保持期間を過ぎたGPSログ ${res.rowCount} 件を削除しました。`);
    }
    const rawRes = await client.query(
      `DELETE FROM vehicle_positions_raw
       WHERE processed = TRUE AND gps_time_ts < now() - ($1::int * INTERVAL '1 hour')`,
      [retentionHours]
    );
    return { deleted: res.rowCount, deletedRaw: rawRes.rowCount };
  } finally {
    client.release();
  }
}

module.exports = { sortCarId, purgeOldGpsLogs };
