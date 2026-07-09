// GASの departure() に相当。
// 営業開始地点から一定距離(DEPARTURE_OFFSET_METERS)以上離れたことを検知して出発時刻(F3相当)を記録する。
// 通信欠落等で「出発検知前に次のバス停到着が先に記録される」ケースに備え、
// 既にバス停名が記録されているログが見つかった場合は、その一つ前のログ時刻を出発時刻とみなす
// （元GASのフォールバックロジックを踏襲）。
const pool = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');

async function getStartStop(client) {
  const res = await client.query('SELECT id, lat, lon FROM stops WHERE seq_order = 0');
  return res.rows[0];
}

async function departure() {
  const client = await pool.connect();
  const offsetMeters = parseFloat(process.env.DEPARTURE_OFFSET_METERS || '200');
  let detected = 0;
  try {
    const startStop = await getStartStop(client);
    if (!startStop) return { detected: 0 };

    const vehicles = await client.query(
      `SELECT id, car_id FROM vehicles
       WHERE status = 'active' AND business_start_time IS NOT NULL AND departure_time IS NULL`
    );

    for (const v of vehicles.rows) {
      const logs = await client.query(
        `SELECT id, gps_time, gps_time_ts, lat, lon, matched_label
         FROM vehicle_gps_log
         WHERE vehicle_id = $1
         ORDER BY gps_time_ts ASC`,
        [v.id]
      );

      // 「営業開始」ログの直後から走査する
      const startIdx = logs.rows.findIndex((r) => r.matched_label === '営業開始');
      if (startIdx < 0) continue;

      for (let i = startIdx + 1; i < logs.rows.length; i++) {
        const cur = logs.rows[i];
        const dist = haversineDistanceMeters(cur.lat, cur.lon, startStop.lat, startStop.lon);

        // フォールバック: 既にバス停名が記録されている（出発検知より先に通過判定が付いた）
        const isNamedStop = cur.matched_label && !['営業開始', '出発済'].includes(cur.matched_label);
        if (isNamedStop) {
          const prev = logs.rows[i - 1];
          await client.query('UPDATE vehicles SET departure_time = $1 WHERE id = $2', [
            prev.gps_time,
            v.id
          ]);
          await client.query(`UPDATE vehicle_gps_log SET matched_label = '出発済' WHERE id = $1`, [
            prev.id
          ]);
          console.log(`[departure] 出発済(バス停到着から逆算): carId=${v.car_id} 時刻=${prev.gps_time}`);
          detected++;
          break;
        }

        if (dist > offsetMeters) {
          await client.query('UPDATE vehicles SET departure_time = $1 WHERE id = $2', [
            cur.gps_time,
            v.id
          ]);
          await client.query(`UPDATE vehicle_gps_log SET matched_label = '出発済' WHERE id = $1`, [
            cur.id
          ]);
          console.log(`[departure] 出発済: carId=${v.car_id} 時刻=${cur.gps_time}`);
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

module.exports = { departure };
