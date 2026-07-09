// GASの delay() に相当。
// 定刻(scheduled_time)と実績(actual_time)の差分から遅延分数を算出する。
//
// 注意: 以前はここで「scheduled_timeがNULLならstatusを強制的に'通過'にする」
// 処理を行っていたが、これが原因で「その便がまだ実際に到達していないだけの
// 先のバス停（終点より先で、まだ運行終了と確定していない区間）」まで
// 問答無用で「通過」に書き換えられ、本来出すべき予想到着時刻の代わりに
// 「通過」と表示され続けるバグを引き起こしていた。
// バス停のstatus('通過'／''／'到着済')の判定は planMaking.js が
// （本来の経由・非停車駅か、単に終点より先で未確定なだけか）を区別した上で
// 既に確定させているため、delayCalcはそれを尊重し、ここでの上書きは行わない。
const pool = require('../config/db');
const { computeDelayMinutes } = require('../utils/time');

async function delayCalc() {
  const client = await pool.connect();
  let updatedVehicles = 0;
  try {
    const vehicles = await client.query(`SELECT id, car_id FROM vehicles WHERE status = 'active'`);

    for (const v of vehicles.rows) {
      const rows = await client.query(
        `SELECT stop_id, seq_order, scheduled_time, status, actual_time, delay_minutes
         FROM vehicle_stop_status
         WHERE vehicle_id = $1
         ORDER BY seq_order ASC`,
        [v.id]
      );

      let latestDelay = null;
      let changed = false;

      for (const r of rows.rows) {
        if (r.delay_minutes !== null && r.delay_minutes !== undefined) {
          latestDelay = r.delay_minutes;
          continue;
        }

        if (r.status !== '到着済' || !r.actual_time || !r.scheduled_time) continue;

        const result = computeDelayMinutes(r.scheduled_time, r.actual_time);
        if (result === null) continue;

        await client.query(
          `UPDATE vehicle_stop_status SET delay_minutes = $1 WHERE vehicle_id = $2 AND stop_id = $3`,
          [result, v.id, r.stop_id]
        );
        latestDelay = result;
        changed = true;
      }

      if (latestDelay !== null) {
        await client.query(`UPDATE vehicles SET delay_minutes = $1 WHERE id = $2`, [latestDelay, v.id]);
      }
      if (changed) updatedVehicles++;
    }
  } finally {
    client.release();
  }
  return { updatedVehicles };
}

module.exports = { delayCalc };