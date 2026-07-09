// GASの SortCarID() に相当。
// vehicle_positions_raw の未処理行を、車両ごとの走行ログ(vehicle_gps_log)へ転記する。
// 車両IDシートが存在しなければ新規作成する、というGASの挙動は
// vehiclesテーブルへのレコード新規作成として再現する。
const pool = require('../config/db');

async function getOrCreateVehicle(client, carId, nowLabel) {
  const existing = await client.query('SELECT id FROM vehicles WHERE car_id = $1 AND status = $2', [
    carId,
    'active'
  ]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await client.query(
    `INSERT INTO vehicles (car_id, created_at) VALUES ($1, now()) RETURNING id`,
    [carId]
  );
  const vehicleId = inserted.rows[0].id;

  // バス停マスタは時刻表照合(trip_id)とは独立して位置判定に使うため、
  // 車両作成と同時に全バス停分の進捗行を用意しておく（GASの車両IDシートK列相当）。
  await client.query(
    `INSERT INTO vehicle_stop_status (vehicle_id, stop_id, seq_order, status)
     SELECT $1, id, seq_order, '' FROM stops`,
    [vehicleId]
  );

  console.log(`[vehicleAssigner] 新規車両を作成しました: ${carId} (作成時刻表示用=${nowLabel})`);
  return vehicleId;
}

async function sortCarId() {
  const client = await pool.connect();
  let transferred = 0;
  try {
    const pending = await client.query(
      `SELECT id, car_id, received_time, gps_time, gps_time_ts, lat, lon
       FROM vehicle_positions_raw
       WHERE processed = FALSE
       ORDER BY id ASC
       LIMIT 500`
    );

    if (pending.rows.length === 0) {
      return { transferred: 0 };
    }

    for (const row of pending.rows) {
      await client.query('BEGIN');
      try {
        const vehicleId = await getOrCreateVehicle(client, row.car_id, row.received_time);
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

module.exports = { sortCarId };
