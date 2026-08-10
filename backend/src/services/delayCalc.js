// 注意: 以前はここで「scheduled_timeがNULLならstatusを強制的に'通過'にする」
// 処理を行っていたが、これが原因で「その便がまだ実際に到達していないだけの
// 先のバス停（終点より先で、まだ運行終了と確定していない区間）」まで
// 問答無用で「通過」に書き換えられ、本来出すべき予想到着時刻の代わりに
// 「通過」と表示され続けるバグを引き起こしていた。
// バス停のstatus('通過'／''／'到着済')の判定は割り当て作成時（tripAssignment.js の
// openAssignment）が（本来の経由・非停車駅か、単に終点より先で未確定なだけか）を
// 区別した上で既に確定させているため、delayCalcはそれを尊重し、ここでの上書きは行わない。
//
// 便起点方式では、処理単位は車両ではなく便への割り当て(assignment)。
// 候補車両も担当車両と同じように遅延計算を行う（仕様書 9）。
const pool = require('../config/db');
const { computeDelayMinutes } = require('../utils/time');

async function delayCalc() {
  const client = await pool.connect();
  let updatedAssignments = 0;
  try {
    const assignments = await client.query(
      `SELECT a.id AS assignment_id, v.car_id, d.start_time
       FROM trip_vehicle_assignments a
       JOIN daily_trips d ON d.id = a.daily_trip_id
       JOIN vehicles v ON v.id = a.vehicle_id
       WHERE a.state = 'active'
       ORDER BY a.id ASC`
    );

    for (const a of assignments.rows) {
      const rows = await client.query(
        `SELECT stop_id, seq_order, scheduled_time, status, actual_time, delay_minutes
         FROM trip_stop_progress
         WHERE assignment_id = $1
         ORDER BY seq_order ASC`,
        [a.assignment_id]
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
          `UPDATE trip_stop_progress SET delay_minutes = $1 WHERE assignment_id = $2 AND stop_id = $3`,
          [result, a.assignment_id, r.stop_id]
        );
        latestDelay = result;
        changed = true;
      }

      if (latestDelay !== null) {
        await client.query(`UPDATE trip_vehicle_assignments SET delay_minutes = $1 WHERE id = $2`, [
          latestDelay,
          a.assignment_id
        ]);
      }
      if (changed) updatedAssignments++;
    }
  } finally {
    client.release();
  }
  return { updatedAssignments };
}

module.exports = { delayCalc };
