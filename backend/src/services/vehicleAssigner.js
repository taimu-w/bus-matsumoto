// vehicle_positions_raw の未処理行を、車両ごとの走行ログ(vehicle_gps_log)へ転記する。
//
// 便起点方式では vehicles テーブルは「観測されている物理車両」を表すだけになり、
// 便との紐付けは一切持たない（それは trip_vehicle_assignments の役割）。
// 1台の車両が複数便の候補になり得るため、運行終了しても行は削除せず
// status = 'inactive' にして再利用する。
const pool = require('../config/db');
const { getRuntimeSetting } = require('./runtimeSettings');

// 1回のクエリで取得する未処理行の上限（既存の挙動と同じ値）。
const BATCH_LIMIT = 500;
// 1周期（sortCarId 1回の呼び出し）でこのバッチを繰り返す最大回数。
// 滞留（BATCH_LIMIT超の未処理行）があるときに次のポーリングを待たず同一周期内で
// 追いつくための上限で、DB接続を1周期分専有し続けないための歯止めでもある（既知 M-8）。
const MAX_BATCHES_PER_CYCLE = 5;

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

/**
 * 未処理行を1バッチ（最大BATCH_LIMIT件）だけ転記する。従来どおり行ごとに
 * BEGIN/COMMITする（1行の失敗が他行を巻き込まないようにするため）。
 * @returns {Promise<{fetched: number, transferred: number, duplicateSkipped: number}>}
 */
async function processBatch(client) {
  const pending = await client.query(
    `SELECT id, route_id, direction_id, direction_raw, car_id, received_time, gps_time, gps_time_ts, lat, lon
     FROM vehicle_positions_raw
     WHERE processed = FALSE
     ORDER BY id ASC
     LIMIT ${BATCH_LIMIT}`
  );

  let transferred = 0;
  let duplicateSkipped = 0;

  for (const row of pending.rows) {
    if (!row.route_id) {
      // 路線を解決できなかった行は便に紐づけようがないため、処理済みにして捨てる
      await client.query('UPDATE vehicle_positions_raw SET processed = TRUE WHERE id = $1', [row.id]);
      continue;
    }

    await client.query('BEGIN');
    try {
      const vehicleId = await getOrCreateVehicle(client, row);
      // 同一車両・同一GPS時刻の測位はvehicle_gps_logへ重複挿入しない
      // （フィード更新間隔がポーリング間隔より長いと同じ測位が繰り返し届くため。既知 M-7）。
      // 一意制約（ux_vehicle_gps_log_vehicle_time）に任せてDO NOTHINGで無視する。
      const insertRes = await client.query(
        `INSERT INTO vehicle_gps_log (vehicle_id, received_time, gps_time, gps_time_ts, lat, lon)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vehicle_id, gps_time_ts) DO NOTHING`,
        [vehicleId, row.received_time, row.gps_time, row.gps_time_ts, row.lat, row.lon]
      );
      await client.query('UPDATE vehicle_positions_raw SET processed = TRUE WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      if (insertRes.rowCount > 0) {
        transferred++;
      } else {
        duplicateSkipped++;
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[vehicleAssigner] 転記エラー carId=${row.car_id}:`, err.message);
    }
  }

  return { fetched: pending.rows.length, transferred, duplicateSkipped };
}

async function sortCarId() {
  const client = await pool.connect();
  let transferred = 0;
  let duplicateSkipped = 0;
  let batches = 0;
  let backlogRemains = false;
  try {
    for (;;) {
      const batch = await processBatch(client);
      transferred += batch.transferred;
      duplicateSkipped += batch.duplicateSkipped;
      batches++;

      if (batch.fetched < BATCH_LIMIT) {
        // 取得件数がLIMIT未満 = 未処理行を出し切った
        backlogRemains = false;
        break;
      }
      if (batches >= MAX_BATCHES_PER_CYCLE) {
        // まだ残っている可能性があるが、1周期での専有時間に歯止めをかけて次回へ回す
        backlogRemains = true;
        break;
      }
    }
  } finally {
    client.release();
  }
  if (transferred > 0) console.log(`[vehicleAssigner] ${transferred} 件を車両別ログへ転記しました。`);
  if (backlogRemains) {
    console.warn(
      `[vehicleAssigner] 未処理ログの滞留が残っています（1周期の上限 ${MAX_BATCHES_PER_CYCLE * BATCH_LIMIT} 件に到達）。次回のポーリングで継続します。`
    );
  }
  return { transferred, duplicateSkipped, batches, backlogRemains };
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
