// GASの finish() に相当（独立トリガー、10分おき実行を想定）。
// 3条件（終点到着済／終了エリアGPS到達／作成から120分経過）のいずれかで運行終了とみなし、
// 統計学習用に completed_trips へアーカイブしたうえで車両レコードを削除する。
const pool = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');
const { getDayOfWeek, timeStrToMinutes } = require('../utils/time');
const { updateSegmentStats } = require('./etaPredictor');

async function getTerminalStop(client) {
  const res = await client.query('SELECT id, lat, lon, seq_order FROM stops ORDER BY seq_order DESC LIMIT 1');
  return res.rows[0];
}

async function archiveVehicle(client, vehicle, reason) {
  const stopStatusRows = await client.query(
    `SELECT stop_id, seq_order, scheduled_time, actual_time, delay_minutes
     FROM vehicle_stop_status WHERE vehicle_id = $1 ORDER BY seq_order ASC`,
    [vehicle.id]
  );

  const tripRes = await client.query(
    `INSERT INTO completed_trips (car_id, trip_id, trip_type, day_of_week, business_start_time, departure_time, finish_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      vehicle.car_id,
      vehicle.trip_id,
      vehicle.trip_type,
      getDayOfWeek(),
      vehicle.business_start_time,
      vehicle.departure_time,
      reason
    ]
  );
  const completedTripId = tripRes.rows[0].id;

  for (const r of stopStatusRows.rows) {
    const actualMinutes = r.actual_time ? timeStrToMinutes(r.actual_time) : null;
    await client.query(
      `INSERT INTO completed_trip_stop_times
         (completed_trip_id, stop_id, seq_order, scheduled_time, actual_time, actual_minutes, delay_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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

async function finishTrips() {
  const client = await pool.connect();
  const endRadius = parseFloat(process.env.END_AREA_RADIUS_METERS || '150');
  const maxAgeMin = parseInt(process.env.VEHICLE_MAX_AGE_MIN || '120', 10);
  
  // 出発直後の終了判定をブロックする保護期間（デフォルト20分）
  const protectionMin = parseInt(process.env.FINISH_PROTECTION_MIN || '10', 10);
  
  let finished = 0;

  try {
    const terminal = await getTerminalStop(client);
    if (!terminal) {
      console.error('[finish] 終点バス停が見つかりません。');
      return { finished: 0 };
    }

    const vehicles = await client.query(
      `SELECT id, car_id, trip_id, trip_type, business_start_time, departure_time, created_at
       FROM vehicles WHERE status = 'active'`
    );

    for (const v of vehicles.rows) {
      let shouldFinish = false;
      let reason = '';
      
      const elapsedMin = (Date.now() - new Date(v.created_at).getTime()) / 60000;

      // 保護期間を過ぎている場合のみ、条件①と②を評価する（循環線・出発直後の誤爆対策）
      if (elapsedMin >= protectionMin) {
        
        // 条件①: 終点バス停が到着済か確認
        const terminalStatus = await client.query(
          `SELECT status FROM vehicle_stop_status WHERE vehicle_id = $1 AND stop_id = $2`,
          [v.id, terminal.id]
        );
        if (terminalStatus.rows.length > 0 && terminalStatus.rows[0].status === '到着済') {
          shouldFinish = true;
          reason = '最終バス停到着済';
        }

        // 条件②: 直近GPSが終了エリア内か確認
// 条件④: GPSが3分以上更新されていない
if (!shouldFinish) {
  const lastGps = await client.query(
    `SELECT lat, lon, gps_time_ts
     FROM vehicle_gps_log
     WHERE vehicle_id = $1
     ORDER BY gps_time_ts DESC
     LIMIT 1`,
    [v.id]
  );

  if (lastGps.rows.length > 0) {
    const gps = lastGps.rows[0];

    // 終了エリア判定
    const dist = haversineDistanceMeters(
      gps.lat,
      gps.lon,
      terminal.lat,
      terminal.lon
    );

    if (dist <= endRadius) {
      shouldFinish = true;
      reason = '終了エリア到達';
    }

    // GPS更新停止判定（3分）
    if (!shouldFinish) {
      const elapsedGpsMin =
        (Date.now() - new Date(gps.gps_time_ts).getTime()) / 60000;

      if (elapsedGpsMin >= 3) {
        shouldFinish = true;
        reason = 'GPS更新停止';
      }
    }
  }
}
      }

      // 条件③: 作成から一定時間経過（タイムアウト・これは保護期間外でも判定し、強制終了させる）
      if (!shouldFinish && elapsedMin >= maxAgeMin) {
        shouldFinish = true;
        reason = `作成から${maxAgeMin}分経過`;
      }

      // 終了条件を満たした場合、アーカイブして削除
      if (shouldFinish) {
        await client.query('BEGIN');
        try {
          await archiveVehicle(client, v, reason);
          await client.query('DELETE FROM vehicles WHERE id = $1', [v.id]);
          await client.query('COMMIT');
          finished++;
          console.log(`[finish] 運行終了処理: carId=${v.car_id} 理由=${reason}`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[finish] エラー carId=${v.car_id}:`, err.message);
        }
      }
    }

    if (finished > 0) {
      await updateSegmentStats(client);
    }
  } finally {
    client.release();
  }

  return { finished };
}

module.exports = { finishTrips };