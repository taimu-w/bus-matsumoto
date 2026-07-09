// GASの planmaking() に相当。
// 出発時刻をもとに時刻表から最も近い便を照合し、各バス停の定刻を
// vehicle_stop_status へ展開する。合致する便がなければ「臨時便」と判定する。
const pool = require('../config/db');
const { timeStrToMinutes, computeDelayMinutes } = require('../utils/time');

async function planMaking() {
  const client = await pool.connect();
  const rangeBefore = parseInt(process.env.SCHEDULE_MATCH_BEFORE_MIN || '10', 10);
  const rangeAfter = parseInt(process.env.SCHEDULE_MATCH_AFTER_MIN || '10', 10);
  let matched = 0;
  let markedExtra = 0;
  try {
    const vehicles = await client.query(
      `SELECT id, car_id, departure_time, business_start_time FROM vehicles
       WHERE status = 'active'
         AND business_start_time IS NOT NULL
         AND departure_time IS NOT NULL
         AND trip_id IS NULL
         AND trip_type != '臨時便'`
    );

    if (vehicles.rows.length === 0) return { matched: 0, markedExtra: 0 };

    // 全便の始発時刻一覧を取得
    const trips = await client.query(
      `SELECT id, trip_index, first_stop_time FROM schedule_trips ORDER BY trip_index ASC`
    );

    for (const v of vehicles.rows) {
      const depMin = timeStrToMinutes(v.departure_time);
      if (Number.isNaN(depMin)) continue;

      let bestTrip = null;
      let bestDiff = Infinity;
      for (const trip of trips.rows) {
        const tMin = timeStrToMinutes(trip.first_stop_time);
        if (Number.isNaN(tMin)) continue;
        const diff = tMin - depMin;
        if (diff >= -rangeBefore && diff <= rangeAfter) {
          const absDiff = Math.abs(diff);
          if (absDiff < bestDiff) {
            bestDiff = absDiff;
            bestTrip = trip;
          }
        }
      }

      if (!bestTrip) {
        await client.query(`UPDATE vehicles SET trip_type = '臨時便' WHERE id = $1`, [v.id]);
        console.log(`[planMaking] 臨時便判定（時刻表なし）: carId=${v.car_id}`);
        markedExtra++;
        continue;
      }

      const stopTimes = await client.query(
        `SELECT st.stop_id, s.seq_order, st.scheduled_time, st.is_through
         FROM schedule_stop_times st
         JOIN stops s ON s.id = st.stop_id
         WHERE st.trip_id = $1
         ORDER BY s.seq_order ASC`,
        [bestTrip.id]
      );

      if (stopTimes.rows.length === 0) {
        await client.query(`UPDATE vehicles SET trip_type = '臨時便' WHERE id = $1`, [v.id]);
        console.log(`[planMaking] 臨時便判定（列データなし）: carId=${v.car_id}`);
        markedExtra++;
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(`UPDATE vehicles SET trip_id = $1 WHERE id = $2`, [bestTrip.id, v.id]);

        // この便が実際に定刻を持つ最後のバス停（＝この便の実質的な終点）を求める。
        // is_through=true(↓)には2種類の意味が混在している:
        //   (a) 経由するが停車しない「本来の通過駅」（前後を実stop に挟まれている）
        //   (b) この便がそもそもそこまで行かない（終点より先）だけの「対象外」
        // (b) を最初から「通過」で確定させてしまうと、GPSでまだ検知していない
        // だけの未到達バス停まで「通過」表示になり、予想到着時刻が出せなくなる。
        // そのため (a) だけを「通過」とし、(b) はステータスを空('')のままにして
        // 高度な予測ロジック側で扱う。
        let lastValidSeq = -1;
        for (const st of stopTimes.rows) {
          if (!st.is_through) lastValidSeq = st.seq_order;
        }

        for (const st of stopTimes.rows) {
          const isOrigin = st.seq_order === 0;
          const isGenuineThroughStop = st.is_through && st.seq_order < lastValidSeq;

          // 始発バス停(seq_order=0)は、GPSによる通過判定（半径内マッチング）に
          // 頼ると出発直後の座標が既にbusinessStart/departureのログ側で
          // 消費されてしまい検知漏れが起きやすい。そのため、ここで
          // 出発検知時刻(departure_time)を最良の推定出発時刻として直ちに
          // 「到着済」（＝出発済み）を確定させる。departure_timeが万一取れない
          // 場合でも、営業開始検知時刻(business_start_time)を次善の推定値として使う。
          // これにより、始発バス停が未到着状態のまま「通過」表示になることはない。
          let status = isGenuineThroughStop ? '通過' : '';
          let actualTime = null;
          let delayMinutes = null;

          if (isOrigin) {
            status = '到着済';
            actualTime = v.departure_time || v.business_start_time || null;
            delayMinutes = actualTime ? computeDelayMinutes(st.scheduled_time, actualTime) : 0;
          }

          await client.query(
            `INSERT INTO vehicle_stop_status (vehicle_id, stop_id, seq_order, scheduled_time, status, actual_time, delay_minutes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (vehicle_id, stop_id) DO UPDATE
               SET scheduled_time = EXCLUDED.scheduled_time,
                   status = CASE
                     WHEN vehicle_stop_status.status = '到着済' THEN vehicle_stop_status.status
                     WHEN EXCLUDED.status = '通過' THEN '通過'
                     WHEN EXCLUDED.status = '到着済' THEN '到着済'
                     ELSE vehicle_stop_status.status
                   END,
                   actual_time = CASE
                     WHEN vehicle_stop_status.status = '到着済' THEN vehicle_stop_status.actual_time
                     ELSE EXCLUDED.actual_time
                   END,
                   delay_minutes = CASE
                     WHEN vehicle_stop_status.status = '到着済' THEN vehicle_stop_status.delay_minutes
                     ELSE EXCLUDED.delay_minutes
                   END`,
            [v.id, st.stop_id, st.seq_order, st.scheduled_time, status, actualTime, delayMinutes]
          );
        }
        await client.query('COMMIT');
        matched++;
        console.log(
          `[planMaking] 運行予定転記完了: carId=${v.car_id} 便=${bestTrip.trip_index} 件数=${stopTimes.rows.length}`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[planMaking] エラー carId=${v.car_id}:`, err.message);
      }
    }
  } finally {
    client.release();
  }
  return { matched, markedExtra };
}

module.exports = { planMaking };