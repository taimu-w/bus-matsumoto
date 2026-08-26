const fs = require('fs');
const path = require('path');

// マイグレーション: service_id対応 + 複数事業者対応（feeds）
// フィード構成はコード（config/feeds.js）へ移し、旧 feed_mappings テーブルはステップ8で削除する。
// 外部ID⇔route_idの対応（route_external_ids）は、一時期コードへ移した後、
// 表記ゆれの心配がない厳格な検証を維持したままDB管理・管理画面編集に戻した
// （2026-08-21。schema.sqlのCREATE TABLE IF NOT EXISTSで新規・既存どちらにも保証される）。
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
    
    // 8. 旧 feed_mappings テーブルの削除
    //    位置情報フィード⇔GTFSフィードの対応は config/feeds.js へ移した。
    //    他テーブルから参照される側ではない（routes / feeds を参照する側）ため
    //    CASCADE は不要で、他テーブルへの波及もない。
    //    ⚠️ feeds は DROP しない。稼働状態の記録先として残す（docs/外部IDマッピングのコード化_仕様書.md参照）。
    //    route_external_ids は DROP しない。DB管理・管理画面編集に戻したため（2026-08-21）。
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
    // 19. C-1/C-2 修正: stops.seq_order を「路線×方向で共有される、単一の
    //     直線順序」として便の実際の停車順や物理バス停の一意キーに使っていたのを
    //     やめる（点検所見 バス運行システム点検所見.md 参照）。
    //
    //     - stops は物理バス停(gtfs_stop_id) + 通過回数(occurrence) で一意化する
    //       （旧: route_id, direction_id, seq_order。service_idを含まないため、
    //       停車パターンの異なるservice_idグループが同じseq_orderの行を
    //       別の物理バス停のデータで上書きしていた＝C-2）。
    //     - 便ごとの実際の停車順は schedule_stop_times.stop_sequence
    //       （新規列、便内0始まりの連番）に持たせる。stops.seq_order は
    //       表示順専用に格下げする（旧: 路線内の便パターンの和集合を
    //       擬似的な順序として使っていた＝C-1・C-3・H-3・H-4の根本原因）。
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
      //      無関係な「未使用列」を先にクリアする。vehicles.trip_id と
      //      vehicle_gps_log.matched_stop_id / matched_label は旧・車両起点方式の
      //      名残で、現行コードのどこからも読み書きされていない
      //      （docs/database.md「未使用列・旧方式の名残」参照）。
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
    // 20. C-5 対策: 便クローズの二重実行防止（点検所見 バス運行システム点検所見.md参照）
    //
    //     finishTrips()の運行日終了掃除とパイプラインのreassignOrphanTrips()が、
    //     それぞれ独立したタイマー・DB接続から同じ便を同時にcloseDailyTrip()して
    //     いたため、completed_trips に同一 (daily_trip_id, assignment_id) の行が
    //     二重に入り、その行がupdateSegmentStats()で二重集計されてsegment_travel_stats
    //     まで汚染されうる状態だった。コード側の一次対策（closeDailyTripの行ロック、
    //     updateSegmentStatsのFOR UPDATE SKIP LOCKED化）に加え、DB制約でも
    //     二重挿入を防ぐ。
    //
    //     制約追加に先立ち、既存データの重複を確認する（対応時の検証環境で実際に
    //     6組・12行の重複が見つかっている＝この競合が理論上ではなく実際に発生して
    //     いたことの裏付け）。重複がある状態でUNIQUE制約を追加しようとすると
    //     ALTER TABLEそのものが失敗するため、事前にdaily_trip_id/assignment_idの
    //     組ごとに最小id（先にアーカイブされた側）だけを残して重複行を削除する
    //     （completed_trip_stop_timesはON DELETE CASCADEで追従する）。
    //
    //     重複を含む行は二重集計された可能性があるため、segment_travel_statsの
    //     sample_count・avg_secondsは既に汚染されている。C-1/C-2対応時と同じく
    //     過去の統計値をそのまま維持する前提は置かず、completed_trips.aggregated を
    //     全行FALSEへ戻してTRUNCATEし、重複排除後の（＝正しい件数の）completed_trips
    //     からupdateSegmentStats()に作り直させる。
    //
    //     ⚠️ このクリーンアップは一度だけでよいため、制約がまだ存在しないことを
    //     ガードにする（ステップ19と同じ考え方）。2回目以降の起動では、通常運用で
    //     生じるはずのない重複を誤って掃除しないよう丸ごとスキップする。
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
        console.log(`[migrate] C-5対策: completed_trips に (daily_trip_id, assignment_id) の重複を ${dupGroups.rows.length}組 検出しました。重複を排除し、統計を作り直します。`);
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