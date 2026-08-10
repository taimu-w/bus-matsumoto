const fs = require('fs');
const path = require('path');

// マイグレーション: service_id対応 + 複数事業者対応（feeds / feed_mappings）
async function migrate() {
  const pool = require('../config/db');
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 0. スキーマ（CREATE TABLE）を適用（冪等: IF NOT EXISTS）
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schemaSql);
    console.log('[migrate] スキーマ作成完了');
    
    // 1. schedule_trips テーブルに service_id を追加
    await client.query(`
      ALTER TABLE schedule_trips 
      ADD COLUMN IF NOT EXISTS service_id TEXT NOT NULL DEFAULT ''
    `);
    
    // 2. schedule_trips のユニーク制約を変更 (route_id, direction_id, trip_index) -> (route_id, direction_id, service_id, trip_index)
    await client.query(`
      ALTER TABLE schedule_trips 
      DROP CONSTRAINT IF EXISTS schedule_trips_route_direction_trip_key
    `);
    
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'schedule_trips_route_direction_service_trip_key'
        ) THEN
          ALTER TABLE schedule_trips 
          ADD CONSTRAINT schedule_trips_route_direction_service_trip_key 
          UNIQUE (route_id, direction_id, service_id, trip_index);
        END IF;
      END $$;
    `);
    
    // 3. stops テーブルに direction_id を追加
    await client.query(`
      ALTER TABLE stops 
      ADD COLUMN IF NOT EXISTS direction_id INTEGER DEFAULT 0
    `);
    
    // 4. stops のユニーク制約を変更 (route_id, seq_order) -> (route_id, direction_id, seq_order)
    //    まず古い制約を削除
    await client.query(`
      ALTER TABLE stops 
      DROP CONSTRAINT IF EXISTS stops_route_id_seq_order_key
    `);
    
    //    新しい制約を追加（既に存在する場合はスキップ）
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'stops_route_direction_seq_key'
        ) THEN
          ALTER TABLE stops 
          ADD CONSTRAINT stops_route_direction_seq_key 
          UNIQUE (route_id, direction_id, seq_order);
        END IF;
      END $$;
    `);
    
    // 5. stops にインデックス追加
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stops_route_direction 
      ON stops(route_id, direction_id, seq_order)
    `);
    
    // 6. vehicles テーブルに direction_id を追加
    await client.query(`
      ALTER TABLE vehicles 
      ADD COLUMN IF NOT EXISTS direction_id INTEGER DEFAULT 0
    `);
    
    // 7. vehicle_positions_raw テーブルに direction_id を追加
    await client.query(`
      ALTER TABLE vehicle_positions_raw 
      ADD COLUMN IF NOT EXISTS direction_id INTEGER DEFAULT 0
    `);
    
    // 7.5. vehicle_positions_raw に feed_id を追加（取得元フィード追跡用）
    await client.query(`
      ALTER TABLE vehicle_positions_raw 
      ADD COLUMN IF NOT EXISTS feed_id TEXT
    `);
    
    // 8. route_external_ids に direction_mapping を追加（CSVの方向列とdirection_idの対応を保存）
    await client.query(`
      ALTER TABLE route_external_ids 
      ADD COLUMN IF NOT EXISTS direction_mapping JSONB DEFAULT '{"csvValue0":1,"csvValueOther":0}'::jsonb
    `);

    // 8.5. route_external_ids に feed_id を追加（どのGTFSフィード由来かを追跡）
    await client.query(`
      ALTER TABLE route_external_ids 
      ADD COLUMN IF NOT EXISTS feed_id TEXT
    `);

    // 9. schedule_trips に headsign を追加（GTFS trip_headsign。行先表示のハードコード解消のため）
    await client.query(`
      ALTER TABLE schedule_trips 
      ADD COLUMN IF NOT EXISTS headsign TEXT
    `);
    
    // 10. routes テーブルに feed_id を追加（どのGTFSフィード由来かを追跡）
    await client.query(`
      ALTER TABLE routes 
      ADD COLUMN IF NOT EXISTS feed_id TEXT
    `);

    // 11. feeds テーブルの作成（既にスキーマで作成済み。ここでは既存DB向けに保証）
    await client.query(`
      CREATE TABLE IF NOT EXISTS feeds (
        id            TEXT PRIMARY KEY,
        feed_type     TEXT NOT NULL CHECK (feed_type IN ('gtfs', 'location')),
        name          TEXT NOT NULL,
        url           TEXT NOT NULL,
        enabled       BOOLEAN NOT NULL DEFAULT TRUE,
        last_fetched_at TIMESTAMPTZ,
        last_status   TEXT,
        last_error    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // 12. feed_mappings テーブルの作成（位置情報CSV⇔GTFSの対応関係を動的管理）
    await client.query(`
      CREATE TABLE IF NOT EXISTS feed_mappings (
        location_feed_id TEXT NOT NULL REFERENCES feeds(id),
        gtfs_feed_id     TEXT NOT NULL REFERENCES feeds(id),
        confidence       REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (location_feed_id, gtfs_feed_id)
      )
    `);
    
    // ==========================================================
    // 13. 便起点の車両割り当て方式への移行
    //     （GTFS便を先に生成し、始発時刻に車両を割り当てる）
    // ==========================================================

    // 13.1 schedule_trips に gtfs_trip_id を追加。
    //      frequencies.txt の trip_id と DB上の便を突き合わせるために必須。
    await client.query(`
      ALTER TABLE schedule_trips ADD COLUMN IF NOT EXISTS gtfs_trip_id TEXT
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_schedule_trips_gtfs_trip_id ON schedule_trips(gtfs_trip_id)
    `);

    // 13.2 vehicles を「物理車両」として扱うための列
    await client.query(`
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS direction_raw TEXT
    `);
    await client.query(`
      ALTER TABLE vehicle_positions_raw ADD COLUMN IF NOT EXISTS direction_raw TEXT
    `);
    // 位置情報CSVに方向列が無い場合を NULL（方向不明）で表せるようにする
    await client.query(`
      ALTER TABLE vehicle_positions_raw ALTER COLUMN direction_id DROP NOT NULL
    `);
    await client.query(`
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS last_gps_at TIMESTAMPTZ
    `);
    // direction_id は「方向不明／方向を使わない路線」をNULLで表せるようにする
    // （既に NULL 許容の場合も no-op として成功する）
    await client.query(`
      ALTER TABLE vehicles ALTER COLUMN direction_id DROP NOT NULL
    `);

    // 13.3 completed_trips に便単位アーカイブ用の列を追加
    await client.query(`
      ALTER TABLE completed_trips ADD COLUMN IF NOT EXISTS daily_trip_id BIGINT
    `);
    await client.query(`
      ALTER TABLE completed_trips ADD COLUMN IF NOT EXISTS assignment_id BIGINT
    `);
    await client.query(`
      ALTER TABLE completed_trips ADD COLUMN IF NOT EXISTS start_time TEXT
    `);
    // 区間統計(segment_travel_stats)は is_official = TRUE の記録だけを集計する。
    // 候補車両止まりの記録を混ぜると、別経路を走っていた車両で統計が汚染されるため。
    await client.query(`
      ALTER TABLE completed_trips ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT TRUE
    `);

    // 14. schedule_stop_times / daily_trip_stop_times に stop_headsign を追加
    //     枝分かれ路線でバス停ごとに変わる行先表示を、バスマップのバス停単位表示に使う。
    await client.query(`
      ALTER TABLE schedule_stop_times ADD COLUMN IF NOT EXISTS stop_headsign TEXT
    `);
    await client.query(`
      ALTER TABLE daily_trip_stop_times ADD COLUMN IF NOT EXISTS stop_headsign TEXT
    `);

    await client.query('COMMIT');
    console.log('[migrate] 複数事業者対応・便起点割り当てマイグレーション完了');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] エラー:', err);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => {
    console.log('[migrate] 完了');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[migrate] 失敗:', err);
    process.exit(1);
  });

module.exports = { migrate };