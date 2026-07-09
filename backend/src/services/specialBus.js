// GASの specialbus() に相当。
// 営業開始が検知されないまま既に3つ以上のバス停へ到着している車両は、
// 通常の始発エリアを経由しない「臨時便」とみなす。
const pool = require('../config/db');

async function specialBus() {
  const client = await pool.connect();
  let markedExtra = 0;
  try {
    const candidates = await client.query(
      `SELECT id, car_id FROM vehicles
       WHERE status = 'active' AND business_start_time IS NULL AND trip_type != '臨時便'`
    );

    for (const v of candidates.rows) {
      const arrivedCount = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM vehicle_stop_status WHERE vehicle_id = $1 AND status = '到着済'`,
        [v.id]
      );
      if (arrivedCount.rows[0].cnt >= 3) {
        await client.query(`UPDATE vehicles SET trip_type = '臨時便' WHERE id = $1`, [v.id]);
        console.log(`[specialBus] 臨時便判定（条件①）: carId=${v.car_id}`);
        markedExtra++;
      }
    }
  } finally {
    client.release();
  }
  return { markedExtra };
}

module.exports = { specialBus };
