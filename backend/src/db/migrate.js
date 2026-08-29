const fs = require('fs');
const path = require('path');

// 既存DBを現行スキーマへ揃えるためのマイグレーション。
// 冒頭で schema.sql（CREATE TABLE IF NOT EXISTS）を流したうえで、
// 既存DBに足りない列・制約・データ移行を冪等に適用する。
// フィード構成はコード（config/feeds.js）で管理し、feeds テーブルは稼働状態のみを持つ。
// 外部ID⇔route_idの対応（route_external_ids）はDB管理・管理画面編集（詳細は docs/feed-config.md）。
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
    
    // 8. 使われていない feed_mappings テーブルの削除。
    //    位置情報フィード⇔GTFSフィードの対応は config/feeds.js（コード）が持つ。
    //    ⚠️ feeds は DROP しない（稼働状態の記録先）。route_external_ids も DROP しない
    //    （外部ID⇔route_idの対応はDB管理・管理画面編集。docs/feed-config.md）。
    await client.query(`DROP TABLE IF EXISTS feed_mappings`);

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
    //     構成はコード（config/feeds.js）が正で、この表が持つのは稼働状態だけである。
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

    // ==========================================================
    // 15. 祝日カレンダー対応（ETA統計の曜日区分を祝日対応させる）
    // ==========================================================

    // 15.1 holidays テーブルの作成（既にスキーマで作成済み。既存DB向けに保証）
    await client.query(`
      CREATE TABLE IF NOT EXISTS holidays (
        holiday_date  DATE PRIMARY KEY,
        name          TEXT
      )
    `);

    // 15.2 completed_trips に day_type を追加。
    //      segment_travel_stats の集計キーを、従来の day_of_week（日曜=祝日固定）
    //      から祝日カレンダー反映済みの区分へ切り替えるための列。
    await client.query(`
      ALTER TABLE completed_trips ADD COLUMN IF NOT EXISTS day_type TEXT
    `);

    // 15.3 既存行のバックフィル。祝日カレンダー導入前のアーカイブ分は holidays
    //      テーブルと突き合わせできないため、旧ロジック（日曜のみholiday扱い）を
    //      そのまま踏襲する。以後のアーカイブは finishService.js が祝日カレンダー
    //      反映済みの day_type を直接書き込む。
    await client.query(`
      UPDATE completed_trips
      SET day_type = CASE day_of_week WHEN 0 THEN 'holiday' WHEN 6 THEN 'saturday' ELSE 'weekday' END
      WHERE day_type IS NULL
    `);

    // 16. trip_arrival_prediction_log に stops_before を追加（予測精度監視で
    //     「何停留所前に出した予測か」の軸を追加するため。既にテーブルを作成済みの
    //     環境向けにALTERで保証する。新規環境ではschema.sqlのCREATE TABLEに
    //     既に含まれているため実質no-op）。
    await client.query(`
      ALTER TABLE trip_arrival_prediction_log ADD COLUMN IF NOT EXISTS stops_before INTEGER
    `);

    // ==========================================================
    // 17. 観光スポット情報機能（観光スポット情報_仕様書）
    //     GTFS由来データ（stops/schedule_*）とは完全独立の新規テーブル。
    //     バス停との関連付けは保存時ではなく参照時の近接検索で解決するため外部キーは持たない。
    //     新規環境ではschema.sqlのCREATE TABLEに既に含まれているため実質no-op。
    // ==========================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS tourist_spots (
        id              SERIAL PRIMARY KEY,
        name            TEXT NOT NULL,
        kana            TEXT,
        romaji          TEXT,
        lat             DOUBLE PRECISION NOT NULL,
        lng             DOUBLE PRECISION NOT NULL,
        url             TEXT,
        hours           TEXT,
        stay_duration   TEXT,
        description     TEXT,
        photo_url       TEXT,
        enabled         BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS tourist_spots_name_key ON tourist_spots (name)
    `);

    // ==========================================================
    // 18. 予測精度監視の集計をSQL側へ移したことに伴う部分インデックス
    //     （services/predictionAccuracy.js）。
    //     集計は「実績（source='actual'）の行を期間で絞る」ところから始まるため、
    //     source='actual' だけを含む部分インデックスで走査量を落とす。
    //     新規環境ではschema.sqlに含まれているため実質no-op。
    // ==========================================================
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prediction_log_actual_time
      ON trip_arrival_prediction_log(computed_at DESC) WHERE source = 'actual'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prediction_log_actual_route_time
      ON trip_arrival_prediction_log(route_id, computed_at DESC) WHERE source = 'actual'
    `);

    // ==========================================================
    // 19. stops.seq_order を「路線×方向で共有される単一の直線順序」として
    //     便の実際の停車順や物理バス停の一意キーに使っていた設計をやめる
    //     （停車パターンの異なる便で順序が壊れ、service_idグループ間で
    //     stops行が別バス停に上書きされる欠陥があった）。
    //
    //     - stops は物理バス停(gtfs_stop_id) + 通過回数(occurrence) で一意化する
    //       （UNIQUE制約に service_id を含まないと、停車パターンの異なる
    //       service_idグループが同じseq_orderの行を別の物理バス停のデータで
    //       上書きしてしまう）。
    //     - 便ごとの実際の停車順は schedule_stop_times.stop_sequence
    //       （便内0始まりの連番）に持たせる。stops.seq_order は表示順専用に格下げする。
    //
    //     stops.id の意味が変わるため、依存する統計・履歴・進捗データは
    //     作り直す方針とし、いったん空にしてseed()で正しい構造として再構築する
    //     （既存のsegment_travel_stats等を引き継ぐ必要はないと判断）。
    //
    //     ⚠️ migrate.js はコンテナ起動のたびに実行される（docker-entrypoint.sh）。
    //     このステップはTRUNCATE/DELETEを伴う一度きりの移行なので、他のステップと
    //     違って「ALTER自体がIF NOT EXISTSで冪等」なだけでは不十分で、ブロック全体を
    //     「stops.gtfs_stop_id列がまだ無い（＝このマイグレーション未実施）」で
    //     ガードし、2回目以降の起動では丸ごとスキップする。これを怠ると
    //     再起動のたびに当日便・進捗・統計が消し飛ぶ。
    // ==========================================================
    const stopsGtfsStopIdColumn = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'stops' AND column_name = 'gtfs_stop_id'
    `);

    if (stopsGtfsStopIdColumn.rows.length === 0) {
      // 19.1 stops.id / schedule_trips.id を参照している列のうち、便の実行に
      //      無関係で現行コードから読み書きされていない列（vehicles.trip_id、
      //      vehicle_gps_log.matched_stop_id）を先にクリアする。
      //      これらの列自体はステップ30で削除する。
      //      ⚠️ TRUNCATEはFK制約の"存在"だけでも拒否される（対象行が無くても、
      //      その制約自体を持つ他テーブルを道連れにする必要がある）ため、
      //      19.2は素のDELETEを使う。DELETEは実データの参照有無で判定されるため、
      //      ここで先にNULL化しておけばvehicles/vehicle_gps_log本体は
      //      道連れにせずに済む。
      await client.query(`UPDATE vehicles SET trip_id = NULL WHERE trip_id IS NOT NULL`);
      await client.query(`UPDATE vehicle_gps_log SET matched_stop_id = NULL WHERE matched_stop_id IS NOT NULL`);

      // 19.2 stops.id の意味が変わるため、GTFSマスタ・当日便・進捗・実績・統計・
      //      ETA予測を一括で空にする。次回起動時の seed()／パイプラインが
      //      正しいキーで再構築する。FK依存の子→親の順でDELETEする。
      await client.query(`DELETE FROM trip_arrival_prediction_log`);
      await client.query(`DELETE FROM trip_arrival_predictions`);
      await client.query(`DELETE FROM trip_gps_matches`);
      await client.query(`DELETE FROM trip_stop_progress`);
      await client.query(`DELETE FROM completed_trip_stop_times`);
      await client.query(`DELETE FROM completed_trips`);
      await client.query(`DELETE FROM segment_travel_stats`);
      await client.query(`DELETE FROM daily_trip_stop_times`);
      await client.query(`DELETE FROM trip_vehicle_assignments`);
      await client.query(`DELETE FROM daily_trips`);
      await client.query(`DELETE FROM schedule_stop_times`);
      await client.query(`DELETE FROM schedule_trip_frequencies`);
      await client.query(`DELETE FROM schedule_trips`);
      await client.query(`DELETE FROM vehicle_stop_status`);
      await client.query(`DELETE FROM stops`);

      // 19.3 stops: 物理バス停(gtfs_stop_id) + 通過回数(occurrence) で一意化する
      await client.query(`ALTER TABLE stops DROP CONSTRAINT IF EXISTS stops_route_id_seq_order_key`);
      await client.query(`ALTER TABLE stops DROP CONSTRAINT IF EXISTS stops_route_direction_seq_key`);
      await client.query(`ALTER TABLE stops DROP CONSTRAINT IF EXISTS stops_route_id_direction_id_seq_order_key`);
      await client.query(`ALTER TABLE stops ADD COLUMN IF NOT EXISTS gtfs_stop_id TEXT`);
      await client.query(`ALTER TABLE stops ADD COLUMN IF NOT EXISTS occurrence INTEGER NOT NULL DEFAULT 0`);
      // 直前の19.2でstopsは空になっているため、NOT NULL化してもデータ違反は起きない
      await client.query(`ALTER TABLE stops ALTER COLUMN gtfs_stop_id SET NOT NULL`);
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'stops_route_direction_gtfsstop_occurrence_key'
          ) THEN
            ALTER TABLE stops
            ADD CONSTRAINT stops_route_direction_gtfsstop_occurrence_key
            UNIQUE (route_id, direction_id, gtfs_stop_id, occurrence);
          END IF;
        END $$;
      `);

      // 19.4 schedule_stop_times: 便自身の中での停車順（0始まりの連番）を持つ列を追加する
      await client.query(`ALTER TABLE schedule_stop_times ADD COLUMN IF NOT EXISTS stop_sequence INTEGER`);
      // 直前の19.2でschedule_stop_timesは空になっているため、NOT NULL化してもデータ違反は起きない
      await client.query(`ALTER TABLE schedule_stop_times ALTER COLUMN stop_sequence SET NOT NULL`);

      console.log('[migrate] ステップ19完了: stops/schedule_stop_timesを物理バス停単位の一意キーへ移行し、依存データを再構築対象としてクリアしました。');
    }

    // 19.5 ステップ4が作った stops_route_direction_seq_key（UNIQUE (route_id, direction_id,
    //      seq_order)）は、seq_orderが表示順専用に格下げされた今では意味を持たない
    //      過去の制約なので、19.1-19.4のガード対象かどうかによらず常に削除しておく
    //      （新規DBではschema.sqlの旧CREATE TABLEを経由せず作られないが、ステップ4は
    //      無条件に毎回このUNIQUE制約を再作成するため、ここで打ち消す必要がある）。
    //      IF EXISTSなので存在しない場合は無害。
    await client.query(`ALTER TABLE stops DROP CONSTRAINT IF EXISTS stops_route_direction_seq_key`);

    // ==========================================================
    // 20. 便クローズの二重実行に対する安全網。
    //
    //     finishTrips()の運行日終了掃除とパイプラインのreassignOrphanTrips()は
    //     独立したタイマー・DB接続から同じ便を同時にcloseDailyTrip()しうる。
    //     コード側の一次対策（closeDailyTripの行ロック、updateSegmentStatsの
    //     FOR UPDATE SKIP LOCKED化）に加え、completed_trips に
    //     UNIQUE (daily_trip_id, assignment_id) を張って二重挿入を防ぐ。
    //
    //     制約を張る前に、既存の重複行（daily_trip_id/assignment_idの組ごとに
    //     最小idだけ残す）を削除し、二重集計された可能性のある
    //     segment_travel_stats をTRUNCATE・completed_trips.aggregated を全行FALSEへ
    //     戻して updateSegmentStats() に作り直させる。
    //
    //     ⚠️ このクリーンアップは一度だけでよいため、制約がまだ存在しないことを
    //     ガードにする（ステップ19と同じ考え方）。
    // ==========================================================
    const completedTripsUniqueConstraint = await client.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'completed_trips_daily_trip_id_assignment_id_key'
    `);

    if (completedTripsUniqueConstraint.rows.length === 0) {
      const dupGroups = await client.query(`
        SELECT daily_trip_id, assignment_id, count(*) AS n
        FROM completed_trips
        WHERE daily_trip_id IS NOT NULL AND assignment_id IS NOT NULL
        GROUP BY daily_trip_id, assignment_id
        HAVING count(*) > 1
      `);

      if (dupGroups.rows.length > 0) {
        console.log(`[migrate] completed_trips に (daily_trip_id, assignment_id) の重複を ${dupGroups.rows.length}組 検出しました。重複を排除し、統計を作り直します。`);
        // 各組で最小id（先にアーカイブされた側）だけを残す
        await client.query(`
          DELETE FROM completed_trips a
          USING completed_trips b
          WHERE a.daily_trip_id = b.daily_trip_id
            AND a.assignment_id = b.assignment_id
            AND a.id > b.id
        `);
        await client.query(`TRUNCATE segment_travel_stats`);
        await client.query(`UPDATE completed_trips SET aggregated = FALSE`);
      }

      await client.query(`
        ALTER TABLE completed_trips
        ADD CONSTRAINT completed_trips_daily_trip_id_assignment_id_key UNIQUE (daily_trip_id, assignment_id)
      `);
      console.log('[migrate] ステップ20完了: completed_trips (daily_trip_id, assignment_id) にUNIQUE制約を追加しました。');
    }

    // 21. schedule_stop_times / daily_trip_stop_times に no_pickup / no_drop_off を追加
    //     is_through（乗車も降車もできない真の通過）は既に持っていたが、乗車のみ・降車のみ
    //     （pickup_type/drop_off_typeのどちらか一方だけが1）を個別に区別する列が無く、
    //     リアルタイム運行状況側（trip_stop_progressの元になるdaily_trip_stop_times経由）
    //     では「降車のみ」「乗車のみ」バッジを表示できなかった。表示用メタデータとして
    //     is_throughと同じ扱いで追加する。
    await client.query(`
      ALTER TABLE schedule_stop_times ADD COLUMN IF NOT EXISTS no_pickup BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await client.query(`
      ALTER TABLE schedule_stop_times ADD COLUMN IF NOT EXISTS no_drop_off BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await client.query(`
      ALTER TABLE daily_trip_stop_times ADD COLUMN IF NOT EXISTS no_pickup BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await client.query(`
      ALTER TABLE daily_trip_stop_times ADD COLUMN IF NOT EXISTS no_drop_off BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // ==========================================================
    // 22. tourist_spots に英語版の入力欄（hours_en/stay_duration_en/description_en）を追加
    //     （観光スポット情報_仕様書）。名称・かな・ローマ字・写真URLは言語非依存のため対象外。
    //     新規環境ではschema.sqlのCREATE TABLEに既に含まれているため実質no-op。
    // ==========================================================
    await client.query(`
      ALTER TABLE tourist_spots ADD COLUMN IF NOT EXISTS hours_en TEXT
    `);
    await client.query(`
      ALTER TABLE tourist_spots ADD COLUMN IF NOT EXISTS stay_duration_en TEXT
    `);
    await client.query(`
      ALTER TABLE tourist_spots ADD COLUMN IF NOT EXISTS description_en TEXT
    `);

    // ==========================================================
    // 23. tourist_spots に category（カテゴリ、フリーテキスト・情報のみで現時点は検索/表示に未使用）と
    //     display_tag（表示。空欄、または「観光」「観光スポット」を含まない値のときは
    //     バス停ページの周辺観光スポット表示からのみ除外する）を追加。
    //     地点名検索・詳細ポップアップ取得は display_tag の影響を受けない
    //     （経路検索の地点としては使うが観光スポットではない登録＝学校・病院等への対策）。
    //     新規環境ではschema.sqlのCREATE TABLEに既に含まれているため実質no-op。
    // ==========================================================
    await client.query(`
      ALTER TABLE tourist_spots ADD COLUMN IF NOT EXISTS category TEXT
    `);
    await client.query(`
      ALTER TABLE tourist_spots ADD COLUMN IF NOT EXISTS display_tag TEXT
    `);

    // ==========================================================
    // 24. trip_stop_progress に「付近」状態（STOP_RADIUS_METERS以内に入ったが
    //     まだ離脱=到着確定していない）の最小距離・観測時刻を追加。2段階到着判定
    //     （バス停到着判定およびフロントエンド表示改善案）のため。
    //     新規環境ではschema.sqlのCREATE TABLEに既に含まれているため実質no-op。
    // ==========================================================
    await client.query(`
      ALTER TABLE trip_stop_progress ADD COLUMN IF NOT EXISTS nearby_min_distance_meters DOUBLE PRECISION
    `);
    await client.query(`
      ALTER TABLE trip_stop_progress ADD COLUMN IF NOT EXISTS nearby_min_distance_gps_time TEXT
    `);
    await client.query(`
      ALTER TABLE trip_stop_progress ADD COLUMN IF NOT EXISTS nearby_min_distance_gps_time_ts TIMESTAMPTZ
    `);

    // ==========================================================
    // 25. ETA予測「今日の前便実績・周辺道路実績」対応（仕様書 第9項 追加要素①②）。
    //     combinePaceFactor()が算出する内訳を trip_arrival_predictions に保存し、
    //     管理画面「ETA予測根拠」「当日の状況」から参照できるようにする。
    //     新規環境ではschema.sqlのCREATE TABLEに既に含まれているため実質no-op。
    // ==========================================================
    await client.query(`
      ALTER TABLE trip_arrival_predictions ADD COLUMN IF NOT EXISTS live_factor DOUBLE PRECISION
    `);
    await client.query(`
      ALTER TABLE trip_arrival_predictions ADD COLUMN IF NOT EXISTS today_previous_trip_factor DOUBLE PRECISION
    `);
    await client.query(`
      ALTER TABLE trip_arrival_predictions ADD COLUMN IF NOT EXISTS today_previous_trip_samples INTEGER
    `);
    await client.query(`
      ALTER TABLE trip_arrival_predictions ADD COLUMN IF NOT EXISTS nearby_factor DOUBLE PRECISION
    `);
    await client.query(`
      ALTER TABLE trip_arrival_predictions ADD COLUMN IF NOT EXISTS nearby_factor_samples INTEGER
    `);
    await client.query(`
      ALTER TABLE trip_arrival_predictions ADD COLUMN IF NOT EXISTS nearby_weight_mass DOUBLE PRECISION
    `);
    await client.query(`
      ALTER TABLE trip_arrival_predictions ADD COLUMN IF NOT EXISTS combined_pace_factor DOUBLE PRECISION
    `);

    // 26. 上記②「周辺道路実績」が運行終了直後の割り当てもRECENTLY_ENDED_MINUTES以内なら
    //     候補に含められるようにするための索引。新規環境ではschema.sqlに含まれているため実質no-op。
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_assignments_recently_ended
      ON trip_vehicle_assignments(ended_at) WHERE state = 'ended'
    `);

    // ==========================================================
    // 27. trip_stop_progress に到着判定方法(arrival_method)と判定根拠の詳細(arrival_evidence JSONB)を
    //     追加。管理画面「運行ダッシュボード」のバス停別詳細モーダルで「なぜ到着済になったか」
    //     （付近経由／ベクトル判定／手動 等）と、ベクトル判定の内積・線分距離などの根拠を
    //     表示するため。新規環境ではschema.sqlのCREATE TABLEに既に含まれているため実質no-op。
    // ==========================================================
    await client.query(`
      ALTER TABLE trip_stop_progress ADD COLUMN IF NOT EXISTS arrival_method TEXT
    `);
    await client.query(`
      ALTER TABLE trip_stop_progress ADD COLUMN IF NOT EXISTS arrival_evidence JSONB
    `);

    // ==========================================================
    // 28. 車両ID（car_id）に付ける名前・メモ（管理画面「車両名・メモ管理」）。
    //     運行ダッシュボードの便詳細セクションで、名前を持つ車両を car_id ではなく
    //     名前で表示するために使う。新規環境ではschema.sqlのCREATE TABLEに
    //     既に含まれているため実質no-op。
    // ==========================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS vehicle_labels (
        car_id      TEXT PRIMARY KEY,
        name        TEXT,
        memo        TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ==========================================================
    // 29. 通常のお知らせは system_settings の key='notices' に JSON 配列
    //     （最大3件、題名・本文・配信期間）で保存する。使われていない
    //     notice1 / notice2 の行は削除する。
    //     重要なお知らせ（key='important_notice'）はそのまま。
    // ==========================================================
    await client.query(`DELETE FROM system_settings WHERE key IN ('notice1', 'notice2')`);
    await client.query(`
      INSERT INTO system_settings (key, value) VALUES ('notices', '[]')
      ON CONFLICT (key) DO NOTHING
    `);

    // ==========================================================
    // 30. 使われていないスキーマ要素の削除（既存DBの掃除）。
    //     いずれも現行コードのどこからも読み書きされていない。
    //     全文が IF EXISTS で冪等なので、毎起動で無条件に流してよい
    //     （新規DBではschema.sqlがこれらを作らないため全てno-op）。
    //     ⚠️ ステップ19（古代DB向け一度きり移行）がこれらの列・テーブルを
    //     参照するため、必ずステップ19より後に置くこと。
    //     列を消す前にVIEWの依存を外す必要があるため DROP VIEW が先。
    // ==========================================================
    await client.query(`DROP VIEW IF EXISTS active_vehicle_summary`);
    await client.query(`DROP TABLE IF EXISTS vehicle_stop_status`);
    await client.query(`
      ALTER TABLE vehicles
        DROP COLUMN IF EXISTS business_start_time,
        DROP COLUMN IF EXISTS departure_time,
        DROP COLUMN IF EXISTS trip_type,
        DROP COLUMN IF EXISTS trip_id,
        DROP COLUMN IF EXISTS delay_minutes,
        DROP COLUMN IF EXISTS last_arrived_seq,
        DROP COLUMN IF EXISTS finished_at,
        DROP COLUMN IF EXISTS finish_reason
    `);
    await client.query(`
      ALTER TABLE vehicle_gps_log
        DROP COLUMN IF EXISTS matched_stop_id,
        DROP COLUMN IF EXISTS matched_label
    `);
    await client.query(`
      ALTER TABLE completed_trips
        DROP COLUMN IF EXISTS trip_type,
        DROP COLUMN IF EXISTS business_start_time,
        DROP COLUMN IF EXISTS departure_time
    `);

    await client.query('COMMIT');
    console.log('[migrate] マイグレーション完了');
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