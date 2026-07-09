const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

function readTsv(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)
    .map((l) => l.split('\t'));
}

async function seedStops(client) {
  const rows = readTsv(path.join(__dirname, '..', '..', 'data', 'stops.tsv'));
  for (let i = 0; i < rows.length; i++) {
    const [name, lat, lon] = rows[i];
    await client.query(
      `INSERT INTO stops (seq_order, name, lat, lon)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (seq_order) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon`,
      [i, name, parseFloat(lat), parseFloat(lon)]
    );
  }
  console.log(`[seed] 停留所 ${rows.length} 件を登録しました。`);
  return rows.length;
}

async function seedTimetable(client) {
  const rows = readTsv(path.join(__dirname, '..', '..', 'data', 'timetable.tsv'));
  if (rows.length === 0) return;

  const tripCount = rows[0].length - 1;

  // 便（列）を作成。始発停留所（1行目）の時刻をキャッシュしておく。
  const tripIds = [];
  for (let t = 0; t < tripCount; t++) {
    const firstStopTime = rows[0][t + 1] === '↓' ? null : rows[0][t + 1];
    const res = await client.query(
      `INSERT INTO schedule_trips (trip_index, first_stop_time)
       VALUES ($1, $2)
       ON CONFLICT (trip_index) DO UPDATE SET first_stop_time = EXCLUDED.first_stop_time
       RETURNING id`,
      [t, firstStopTime]
    );
    tripIds.push(res.rows[0].id);
  }

  for (let r = 0; r < rows.length; r++) {
    const stopName = rows[r][0];
    const stopRes = await client.query('SELECT id FROM stops WHERE name = $1', [stopName]);
    if (stopRes.rows.length === 0) {
      console.warn(`[seed] 警告: 時刻表の停留所「${stopName}」が停留所マスタに存在しません。スキップします。`);
      continue;
    }
    const stopId = stopRes.rows[0].id;

    for (let t = 0; t < tripCount; t++) {
      const raw = rows[r][t + 1];
      const isThrough = raw === '↓' || raw === undefined || raw === '';
      const scheduledTime = isThrough ? null : raw;
      await client.query(
        `INSERT INTO schedule_stop_times (trip_id, stop_id, scheduled_time, is_through)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (trip_id, stop_id) DO UPDATE
           SET scheduled_time = EXCLUDED.scheduled_time, is_through = EXCLUDED.is_through`,
        [tripIds[t], stopId, scheduledTime, isThrough]
      );
    }
  }
  console.log(`[seed] 時刻表 ${tripCount} 便 × ${rows.length} 停留所を登録しました。`);
}

async function seedSettings(client) {
  const defaults = [
    ['notice1', ''],
    ['notice2', ''],
    ['important_notice', ''],
    ['route_name', '横田信大循環線'],
    ['operator_name', 'ぐるっと松本バス（アルピコ交通）']
  ];
  for (const [key, value] of defaults) {
    await client.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
  console.log('[seed] システム設定の初期値を登録しました。');
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedStops(client);
    await seedTimetable(client);
    await seedSettings(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seed()
    .then(() => {
      console.log('[seed] 完了しました。');
      return pool.end();
    })
    .catch((err) => {
      console.error('[seed] エラー:', err);
      process.exit(1);
    });
}

module.exports = seed;
