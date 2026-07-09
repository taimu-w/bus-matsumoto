// GASの StartBusiness() に相当。
// 始発バス停（seq_order = 0）付近にバスが入ったことを検知し、営業開始時刻(F2相当)を記録する。
// 元GASは緯度経度の矩形範囲(P2:P3, R2:R3)で判定していたが、本実装では
// 「始発バス停座標からSTART_AREA_RADIUS_METERS以内」という円形判定に置き換えている
// （矩形か円形かは仕様書13項により改善が許容されている構成上の裁量）。
const pool = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');

async function getStartStop(client) {
  const res = await client.query('SELECT id, lat, lon FROM stops WHERE seq_order = 0');
  return res.rows[0];
}

async function startBusiness() {
  const client = await pool.connect();
  const radius = parseFloat(process.env.START_AREA_RADIUS_METERS || '150');
  let detected = 0;
  try {
    const startStop = await getStartStop(client);
    if (!startStop) {
      console.error('[businessStart] 始発バス停(seq_order=0)が見つかりません。');
      return { detected: 0 };
    }

    const vehicles = await client.query(
      `SELECT id, car_id FROM vehicles WHERE status = 'active' AND business_start_time IS NULL`
    );

    for (const v of vehicles.rows) {
      const logs = await client.query(
        `SELECT id, gps_time, gps_time_ts, lat, lon
         FROM vehicle_gps_log
         WHERE vehicle_id = $1
         ORDER BY gps_time_ts ASC`,
        [v.id]
      );

      for (const log of logs.rows) {
        const dist = haversineDistanceMeters(log.lat, log.lon, startStop.lat, startStop.lon);
        if (dist <= radius) {
          await client.query('UPDATE vehicles SET business_start_time = $1 WHERE id = $2', [
            log.gps_time,
            v.id
          ]);
          await client.query(
            `UPDATE vehicle_gps_log SET matched_stop_id = $1, matched_label = '営業開始' WHERE id = $2`,
            [startStop.id, log.id]
          );
          console.log(`[businessStart] 営業開始検知: carId=${v.car_id} 時刻=${log.gps_time}`);
          detected++;
          break;
        }
      }
    }
  } finally {
    client.release();
  }
  return { detected };
}

module.exports = { startBusiness };
