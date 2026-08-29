-- ==========================================================
-- バスリアルタイム運行管理システム データベーススキーマ
-- GTFSベースの複数路線対応を前提に構成
-- ==========================================================

CREATE TABLE IF NOT EXISTS routes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  short_name    TEXT,
  color         TEXT,
  text_color    TEXT,
  feed_id       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- フィードの稼働状態を記録するテーブル。
--
-- ⚠️ これは構成マスタではない。GTFSフィード・位置情報フィードの構成
-- （id / feed_type / name / url / enabled）と、位置情報フィード⇔GTFSフィードの対応は
-- backend/src/config/feeds.js（コード）が唯一の情報源であり、
-- ここの行は seed.js の ensureFeedRows() がそこからUPSERTして用意する。
-- **DBを直接編集しても次回起動時に上書きされる。**
--
-- 実行時に書き込まれる観測データは last_fetched_at / last_status / last_error の3列だけで、
-- これらはコード化できないためDBに残している（docs/外部IDマッピングのコード化_仕様書.md参照）。
--
-- 旧 feed_mappings テーブル（confidence による対応の推測）は
-- コードへ移したため削除済み。migrate.js が DROP する。
-- route_external_ids は下記のとおりDB管理に復帰したため対象外（2026-08-21）。
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
);

-- 位置情報CSVの外部ID（事業者の系統ID）→ GTFS route_id の対応。
-- 管理画面（GET/POST/DELETE /api/admin/route-mappings）から編集する。
--
-- route_id は routes.id と同じ「feedId:routeId」形式のqualified route id。
-- 路線名からのあいまいな解決はしない（「ケ/ヶ」等の表記ゆれ1文字で対応が黙って
-- 欠落する事故が過去にあったため。詳細はdocs/外部IDマッピングのコード化_仕様書.md）。
-- 保存時にroutesテーブルへの実在チェックを行い、存在しないIDは拒否する。
--
-- route_id が NULL の行は「外部IDは判明しているが、対応するGTFS路線がまだ無い」ことを
-- 表す（note列に理由を書いて残す）。削除すると、後で該当路線がGTFSに追加された際に
-- 外部IDを再調査する羽目になるため、行として保持できるようにしてある。
--
-- サービス層は backend/src/services/routeExternalIdMapping.js（TTL付きメモリキャッシュ。
-- 管理画面からの変更時に invalidateRouteExternalIdCache() で破棄）。
CREATE TABLE IF NOT EXISTS route_external_ids (
  external_id   TEXT PRIMARY KEY,
  route_id      TEXT,
  note          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- バス停マスタ。物理バス停（GTFSのstop_id）+ occurrence（同一route_id・direction_id内で
-- その物理バス停を何回目の通過として登録したか。循環路線で1便が同じ停留所を複数回通る
-- ケースの識別に使う。0始まり）で一意化する。この2列が実体キーであり、
-- service_id（平日/土休日等）をまたいでも同じ物理バス停・同じ通過回目なら同じ行を共有する
-- （service_idごとに行を分けると、同じ物理停留所の実績が区間統計上で無用に分裂するため）。
-- seq_orderは路線内の表示順専用（一覧表示・バス停マップの並び替えにのみ使う）。
-- 便ごとの実際の停車順（枝分かれ・逆回りで異なりうる）はschedule_stop_times.stop_sequenceを
-- 参照すること。seq_orderをその用途に使わないこと（旧設計の欠陥。docs参照）。
CREATE TABLE IF NOT EXISTS stops (
  id            SERIAL PRIMARY KEY,
  route_id      TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  direction_id  INTEGER NOT NULL DEFAULT 0,
  gtfs_stop_id  TEXT NOT NULL,                 -- GTFS stops.txt の stop_id（物理バス停の実体識別）
  occurrence    INTEGER NOT NULL DEFAULT 0,    -- 同一route_id・direction_id内でこの物理バス停が何回目の通過かの通し番号（0始まり）
  seq_order     INTEGER NOT NULL,              -- 路線内の表示順専用（0始まり）。便ごとの順序には使わない
  name          TEXT NOT NULL,
  name_kana     TEXT,
  name_en       TEXT,
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
  notice        TEXT,
  timetable_link TEXT,
  UNIQUE (route_id, direction_id, gtfs_stop_id, occurrence)
);

-- 時刻表: 便（トリップ）ごと・停留所ごとの定刻。
CREATE TABLE IF NOT EXISTS schedule_trips (
  id            SERIAL PRIMARY KEY,
  route_id      TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  direction_id  INTEGER NOT NULL DEFAULT 0,
  service_id    TEXT NOT NULL,                 -- GTFSのservice_id（平日/土休日/年末年始フル等）
  trip_index    INTEGER NOT NULL,              -- 同一service_id内での便番号（列の順序、0始まり）
  gtfs_trip_id  TEXT,                          -- GTFS trips.txt の trip_id（frequencies.txt との突合に使う）
  first_stop_time TEXT,
  headsign      TEXT,                          -- GTFS trips.txt の trip_headsign（行先表示）
  UNIQUE (route_id, direction_id, service_id, trip_index)
);

-- GTFS frequencies.txt（頻度ベース運行）。当日便生成時に仮想便へ展開する。
CREATE TABLE IF NOT EXISTS schedule_trip_frequencies (
  trip_id       INTEGER NOT NULL REFERENCES schedule_trips(id) ON DELETE CASCADE,
  start_time    TEXT NOT NULL,                 -- GTFS原文（"07:00:00"。24時超え表記あり）
  end_time      TEXT NOT NULL,
  headway_secs  INTEGER NOT NULL,
  exact_times   INTEGER NOT NULL DEFAULT 0,    -- 値による扱いの差は設けない（仕様書 3.4.2）
  PRIMARY KEY (trip_id, start_time)
);

CREATE TABLE IF NOT EXISTS schedule_stop_times (
  trip_id       INTEGER NOT NULL REFERENCES schedule_trips(id) ON DELETE CASCADE,
  stop_id       INTEGER NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  stop_sequence INTEGER NOT NULL,               -- この便自身の中での停車順（0始まりの連番）。
                                                 -- stops.seq_orderは路線内の表示順（service_idグループ
                                                 -- 横断の共有値）であり便ごとの実際の順序とは一致しないため、
                                                 -- 順序に依存する判定はこちらを正として参照する
  scheduled_time TEXT,                          -- "H:mm" 形式。GTFSのstop_times.txtに載る行には必ず実時刻が
                                                 -- 入るため、通常はNULLにならない（NULLは元GTFSデータの
                                                 -- 時刻欠損など、不整合な入力に対する保険的な状態）
  is_through    BOOLEAN NOT NULL DEFAULT FALSE, -- 真の通過（乗車も降車もできない停車）。GTFSの
                                                 -- pickup_type=1 かつ drop_off_type=1 の場合のみtrue。
                                                 -- 表示上のラベル用メタデータであり、scheduled_timeの
                                                 -- 有無には影響しない
  no_pickup     BOOLEAN NOT NULL DEFAULT FALSE, -- GTFSのpickup_type=1（降車のみ）。表示用メタデータ
  no_drop_off   BOOLEAN NOT NULL DEFAULT FALSE, -- GTFSのdrop_off_type=1（乗車のみ）。表示用メタデータ
  stop_headsign TEXT,                           -- GTFS stop_times.txt の stop_headsign（枝分かれ路線の停留所別行先）
  PRIMARY KEY (trip_id, stop_id)
);

-- システム全体設定・お知らせ（GASの「設定 システム」シート相当）
CREATE TABLE IF NOT EXISTS system_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT
);

-- 祝日カレンダー（ETA統計の曜日区分 day_type を祝日対応させるためのマスタ）。
-- seed.js が国民の祝日の算出値（utils/japaneseHolidays.js）を初期投入するが、
-- 実際に参照されるのはこのテーブルの内容であり、管理画面から追加・削除できる。
CREATE TABLE IF NOT EXISTS holidays (
  holiday_date  DATE PRIMARY KEY,
  name          TEXT
);

-- 異常アラートの確認済み状態。alert_key は種別＋対象エンティティIDから組み立てる
-- 安定キー（api.js の buildAlertKey() 参照）。対象の異常が解消された行は
-- /api/admin/alerts の取得時にガベージコレクトするため、同じ異常が再発すれば
-- 再度アラートとして表示される。
CREATE TABLE IF NOT EXISTS admin_alert_acknowledgements (
  alert_key        TEXT PRIMARY KEY,
  acknowledged_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 観光スポット情報（観光スポット情報_仕様書）。GTFS由来データ（stops等）とは完全独立。
-- バス停との関連付けは保存時ではなく参照時に緯度経度の近接検索で都度解決するため、外部キーは持たない。
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
  hours_en        TEXT,
  stay_duration_en TEXT,
  description_en  TEXT,
  photo_url       TEXT,
  category        TEXT,
  -- 空欄、または「観光」「観光スポット」を含まない値は、バス停ページの周辺観光スポット表示
  -- （findNearbySpots）からのみ除外する（学校・病院等、経路検索の地点としては使うが観光スポット
  -- ではない登録への対策）。地点名検索・詳細ポップアップ取得は本フラグの影響を受けない。
  display_tag     TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 全件洗い替え（管理画面のテキスト一括入力）を名称キーのUPSERTで行うために必須。
CREATE UNIQUE INDEX IF NOT EXISTS tourist_spots_name_key ON tourist_spots (name);

-- 観測されている物理車両。便との紐付けは trip_vehicle_assignments が持つ。
-- 運行終了しても行は削除せず status='inactive' にする（1台が複数便に関与するため）。
CREATE TABLE IF NOT EXISTS vehicles (
  id                  SERIAL PRIMARY KEY,
  route_id            TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  car_id              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction_id        INTEGER,          -- 位置情報CSVから解決した方向。NULLは方向不明／方向を使わない路線
  direction_raw       TEXT,             -- 位置情報CSVの方向列の生値（設定ミス調査用）
  last_gps_at         TIMESTAMPTZ,      -- 直近GPS時刻
  -- 以下は便起点方式への移行で未使用になった列（旧・車両起点方式の名残）。
  business_start_time TEXT,
  departure_time      TEXT,
  trip_type           TEXT NOT NULL DEFAULT '通常',
  trip_id             INTEGER REFERENCES schedule_trips(id),
  delay_minutes       INTEGER NOT NULL DEFAULT 0,
  last_arrived_seq    INTEGER NOT NULL DEFAULT -1,
  status              TEXT NOT NULL DEFAULT 'active',
  finished_at         TIMESTAMPTZ,
  finish_reason       TEXT,
  UNIQUE (route_id, car_id)
);

-- 位置情報最新（受信直後の生ログ。GASの「位置情報最新」シート相当）
CREATE TABLE IF NOT EXISTS vehicle_positions_raw (
  id            BIGSERIAL PRIMARY KEY,
  route_id      TEXT NOT NULL DEFAULT '',
  car_id        TEXT NOT NULL,
  received_time TEXT NOT NULL,      -- 取得日時 H:mm（書式なしテキスト相当）
  gps_time      TEXT NOT NULL,      -- GPS時刻 H:mm
  gps_time_ts   TIMESTAMPTZ NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
  direction_raw TEXT,               -- 位置情報CSVの方向列の生値
  feed_id       TEXT,               -- 取得元フィード（位置情報CSVの事業者）
  processed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_positions_raw_processed ON vehicle_positions_raw(processed);
CREATE INDEX IF NOT EXISTS idx_positions_raw_carid ON vehicle_positions_raw(car_id);

-- 車両別GPS走行ログ（GASの車両IDシートA〜F列相当）
CREATE TABLE IF NOT EXISTS vehicle_gps_log (
  id                BIGSERIAL PRIMARY KEY,
  vehicle_id        INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  received_time     TEXT NOT NULL,
  gps_time          TEXT NOT NULL,
  gps_time_ts       TIMESTAMPTZ NOT NULL,
  lat               DOUBLE PRECISION NOT NULL,
  lon               DOUBLE PRECISION NOT NULL,
  matched_stop_id   INTEGER REFERENCES stops(id),
  matched_label     TEXT             -- バス停名 or '営業開始' or '出発済'
);
CREATE INDEX IF NOT EXISTS idx_gps_log_vehicle ON vehicle_gps_log(vehicle_id, gps_time_ts);

-- 車両×バス停の進捗状況（GASの車両IDシートK〜V列相当）
CREATE TABLE IF NOT EXISTS vehicle_stop_status (
  vehicle_id      INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  route_id        TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  stop_id         INTEGER NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  seq_order       INTEGER NOT NULL,
  scheduled_time  TEXT,
  status          TEXT NOT NULL DEFAULT '',
  actual_time     TEXT,
  delay_minutes   INTEGER,
  interpolated    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (vehicle_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_stop_status_vehicle ON vehicle_stop_status(vehicle_id);

-- ==========================================================
-- 便起点の車両割り当て（GTFS便を先に生成し、車両を後から割り当てる）
-- ==========================================================

-- 当日の運行便。GTFSの個別tripに加え、frequencies.txt から展開した仮想便も含む。
CREATE TABLE IF NOT EXISTS daily_trips (
  id                  BIGSERIAL PRIMARY KEY,
  service_date        DATE NOT NULL,
  route_id            TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  direction_id        INTEGER NOT NULL DEFAULT 0,
  schedule_trip_id    INTEGER NOT NULL REFERENCES schedule_trips(id) ON DELETE CASCADE,
  service_id          TEXT NOT NULL,
  origin              TEXT NOT NULL DEFAULT 'static',   -- 'static' | 'frequency'
  frequency_index     INTEGER NOT NULL DEFAULT 0,       -- 仮想便の連番（通常便は0）
  offset_minutes      INTEGER NOT NULL DEFAULT 0,       -- 元tripの始発時刻からのシフト量（分）
  start_stop_id       INTEGER NOT NULL REFERENCES stops(id),
  start_time          TEXT NOT NULL,                    -- "H:mm"（既存表記との互換用）
  start_at            TIMESTAMPTZ NOT NULL,             -- 実時刻（24時超え便も正しく表現できる）
  headsign            TEXT,
  -- pending: 始発時刻未到来／未評価, assigned: 担当車両あり, unassigned: 候補なしで担当不在
  assignment_state    TEXT NOT NULL DEFAULT 'pending',
  assigned_vehicle_id INTEGER REFERENCES vehicles(id),
  assigned_at         TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_date, schedule_trip_id, frequency_index)
);
CREATE INDEX IF NOT EXISTS idx_daily_trips_pending ON daily_trips(service_date, assignment_state, start_at);
CREATE INDEX IF NOT EXISTS idx_daily_trips_route ON daily_trips(route_id, service_date);

-- 当日便のバス停別定刻。frequencies.txt のオフセットは生成時にここへ焼き込む。
-- 以降の全処理はこのテーブルだけを見れば良く、仮想便と通常便を区別しない（仕様書 3.4.2）。
CREATE TABLE IF NOT EXISTS daily_trip_stop_times (
  daily_trip_id  BIGINT NOT NULL REFERENCES daily_trips(id) ON DELETE CASCADE,
  stop_id        INTEGER NOT NULL REFERENCES stops(id),
  seq_order      INTEGER NOT NULL,
  scheduled_time TEXT,                          -- "H:mm"。schedule_stop_times.scheduled_time と同じく
                                                 -- 通常は常に実時刻が入る
  is_through     BOOLEAN NOT NULL DEFAULT FALSE, -- schedule_stop_times.is_through の当日分コピー
                                                 -- （真の通過＝乗車も降車もできない停車。表示用メタデータ）
  no_pickup      BOOLEAN NOT NULL DEFAULT FALSE, -- schedule_stop_times.no_pickup の当日分コピー（降車のみ）
  no_drop_off    BOOLEAN NOT NULL DEFAULT FALSE, -- schedule_stop_times.no_drop_off の当日分コピー（乗車のみ）
  stop_headsign  TEXT,                          -- schedule_stop_times.stop_headsign の当日分コピー
  PRIMARY KEY (daily_trip_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_trip_stop_times_seq ON daily_trip_stop_times(daily_trip_id, seq_order);

-- 便への車両割り当て。担当車両(assigned)と候補車両(candidate)の両方をここで表す。
-- 候補車両は同時に複数便へ重複して存在してよい（仕様書 8.3）。
CREATE TABLE IF NOT EXISTS trip_vehicle_assignments (
  id                 BIGSERIAL PRIMARY KEY,
  daily_trip_id      BIGINT NOT NULL REFERENCES daily_trips(id) ON DELETE CASCADE,
  vehicle_id         INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  role               TEXT NOT NULL,                    -- 'assigned' | 'candidate'
  state              TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'ended'
  distance_meters    DOUBLE PRECISION NOT NULL,        -- 始発時刻時点の始発バス停からの距離
  eval_gps_time      TEXT NOT NULL,                    -- 判定に使ったGPS時刻（"H:mm"）
  eval_gps_time_ts   TIMESTAMPTZ NOT NULL,
  became_assigned_at TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  end_reason         TEXT,
  last_arrived_seq   INTEGER NOT NULL DEFAULT -1,
  delay_minutes      INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (daily_trip_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_active ON trip_vehicle_assignments(state, role);
CREATE INDEX IF NOT EXISTS idx_assignments_trip ON trip_vehicle_assignments(daily_trip_id, role, state);
CREATE INDEX IF NOT EXISTS idx_assignments_vehicle ON trip_vehicle_assignments(vehicle_id, state);
-- ETA予測の「周辺道路実績」(etaPredictor.js の getRecentSegmentPerformance)が、運行終了
-- 直後（state='ended'）の割り当てもRECENTLY_ENDED_MINUTES以内なら候補に含めるための索引。
CREATE INDEX IF NOT EXISTS idx_assignments_recently_ended ON trip_vehicle_assignments(ended_at) WHERE state = 'ended';

-- 便×車両ごとのバス停進捗（旧 vehicle_stop_status の置換）。
-- 候補車両も担当車両と同じように通過判定・遅延計算を行う（仕様書 9）。
-- 2段階到着判定（バス停到着判定およびフロントエンド表示改善案）により、'到着済'の手前に
-- '付近'（STOP_RADIUS_METERS以内に入ったがまだ離脱=到着確定していない）状態を追加した。
-- nearby_min_distance_* は'付近'中に観測した最小距離とその観測GPS時刻（離脱判定・
-- actual_timeの補完・遡及昇格に使う）。
CREATE TABLE IF NOT EXISTS trip_stop_progress (
  assignment_id  BIGINT NOT NULL REFERENCES trip_vehicle_assignments(id) ON DELETE CASCADE,
  stop_id        INTEGER NOT NULL REFERENCES stops(id),
  seq_order      INTEGER NOT NULL,
  scheduled_time TEXT,
  status         TEXT NOT NULL DEFAULT '',      -- '' | '通過' | '付近' | '到着済'
  actual_time    TEXT,
  delay_minutes  INTEGER,
  interpolated   BOOLEAN NOT NULL DEFAULT FALSE,
  nearby_min_distance_meters      DOUBLE PRECISION,
  nearby_min_distance_gps_time    TEXT,
  nearby_min_distance_gps_time_ts TIMESTAMPTZ,
  -- 到着済に確定した「判定方法」と、その根拠の詳細（管理画面「運行ダッシュボード」の
  -- バス停別詳細モーダル向け。表示専用で絞り込み・JOINには使わない）。
  --   arrival_method: 'vector'（ベクトル通過判定）| 'nearby'（付近経由＝離脱検知）
  --                 | 'promoted'（付近スタックの遡及昇格）| 'interpolated'（線形補間）
  --                 | 'manual'（管理画面で手動確定）| 'start'（始発バス停・割り当て時）
  --                 | 'finish'（割り当て終了時の強制昇格／GPS途絶時の終点救済）
  --                   NULL＝未到着、または本機能導入前に確定した行。
  --   arrival_evidence: 方法別の詳細JSON。ベクトルは stepDist/distP1Stop/distP2Stop/segDist/dot/t
  --                   と前後GPS点(p1/p2)、付近系は最小距離・観測GPS時刻・離脱マージン等。
  -- openAssignment() の ON CONFLICT SET句には含めない（nearby_min_distance_* と同じく
  -- GTFS再取得のreseedで進行中の判定結果を巻き戻さないため）。
  arrival_method   TEXT,
  arrival_evidence JSONB,
  PRIMARY KEY (assignment_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_progress_assignment ON trip_stop_progress(assignment_id, seq_order);

-- 通過判定で消費したGPSログ（旧 vehicle_gps_log.matched_label の置換）。
-- 1台の車両が複数便の候補になるため、車両側の1列では処理済み管理ができない。
CREATE TABLE IF NOT EXISTS trip_gps_matches (
  assignment_id BIGINT NOT NULL REFERENCES trip_vehicle_assignments(id) ON DELETE CASCADE,
  gps_log_id    BIGINT NOT NULL REFERENCES vehicle_gps_log(id) ON DELETE CASCADE,
  stop_id       INTEGER NOT NULL REFERENCES stops(id),
  matched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, gps_log_id)
);

-- 完了トリップのアーカイブ（統計・予測学習用）
CREATE TABLE IF NOT EXISTS completed_trips (
  id                  BIGSERIAL PRIMARY KEY,
  route_id            TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  car_id              TEXT NOT NULL,
  trip_id             INTEGER REFERENCES schedule_trips(id),
  daily_trip_id       BIGINT,
  assignment_id       BIGINT,
  start_time          TEXT,        -- 便の始発時刻
  -- 便の実績として正とみなす記録か。区間統計(segment_travel_stats)はTRUEのみ集計する。
  is_official         BOOLEAN NOT NULL DEFAULT TRUE,
  trip_type           TEXT,
  day_of_week         INTEGER NOT NULL,
  -- 祝日カレンダーを反映した曜日区分('weekday'|'saturday'|'holiday')。
  -- segment_travel_stats の集計キーはこちらを使う（day_of_weekは単なる記録用）。
  day_type            TEXT,
  business_start_time TEXT,
  departure_time      TEXT,
  finished_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finish_reason       TEXT,
  aggregated          BOOLEAN NOT NULL DEFAULT FALSE,
  -- 便のクローズが二重実行されても実績が二重に入らないようにする安全網（点検所見 C-5）。
  -- 一次防御はfinishService.jsのcloseDailyTrip()が取る行ロックで、通常はこの制約に
  -- 触れることはない。NULLはPostgreSQLのUNIQUE制約上重複扱いされないため、
  -- daily_trip_id/assignment_idを持たない行があっても問題にならない。
  UNIQUE (daily_trip_id, assignment_id)
);

CREATE TABLE IF NOT EXISTS completed_trip_stop_times (
  completed_trip_id   BIGINT NOT NULL REFERENCES completed_trips(id) ON DELETE CASCADE,
  stop_id             INTEGER NOT NULL REFERENCES stops(id),
  seq_order           INTEGER NOT NULL,
  scheduled_time      TEXT,
  actual_time         TEXT,
  actual_minutes      INTEGER,     -- 0:00起点の分数（時刻演算・集計用）
  delay_minutes       INTEGER,
  PRIMARY KEY (completed_trip_id, stop_id)
);

-- 区間別走行時間の統計（曜日区分×時間帯×区間）。ETA高度化アルゴリズムが参照する。
CREATE TABLE IF NOT EXISTS segment_travel_stats (
  from_stop_id    INTEGER NOT NULL REFERENCES stops(id),
  to_stop_id      INTEGER NOT NULL REFERENCES stops(id),
  day_type        TEXT NOT NULL,      -- 'weekday' | 'saturday' | 'holiday'
  hour_bucket     INTEGER NOT NULL,   -- 0-23（区間の実績到着時刻の時）
  sample_count    INTEGER NOT NULL DEFAULT 0,
  avg_seconds     DOUBLE PRECISION NOT NULL DEFAULT 0,
  variance_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_stop_id, to_stop_id, day_type, hour_bucket)
);

-- ETAプリコンピュート結果。パイプラインが60秒ごとに全active割り当て分の到着予測を
-- 一括計算してここへUPSERTし、/api/buses等はここから読み出すだけにする（設計書
-- docs/design-eta-precompute.md）。オンデマンド計算(predictArrivals)の重複実行と
-- ポーリング間隔ごとのDBスパイクを避けるのが狙い。
-- assignment_id, stop_id の複合主キーはtrip_stop_progressと同じ構成にしてあり、
-- ON CONFLICT (assignment_id, stop_id) DO UPDATEでUPSERTする。
CREATE TABLE IF NOT EXISTS trip_arrival_predictions (
  assignment_id           BIGINT NOT NULL REFERENCES trip_vehicle_assignments(id) ON DELETE CASCADE,
  stop_id                 INTEGER NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  seq_order                INTEGER NOT NULL,
  predicted_time           TEXT,
  predicted_delay_minutes  INTEGER,
  source                   TEXT NOT NULL,
  -- ETA予測根拠の内訳（管理画面「ETA予測根拠」「当日の状況」向け。source が
  -- 'historical'/'schedule_paced' のときだけ埋まり、それ以外はNULL。
  -- 算出はetaPredictor.jsのcombinePaceFactor参照。
  live_factor                    DOUBLE PRECISION, -- 直近3区間の実績ペース
  today_previous_trip_factor     DOUBLE PRECISION, -- 今日の前便実績（未使用時NULL）
  today_previous_trip_samples    INTEGER,          -- 上記の元になった隣接区間の一致数
  nearby_factor                  DOUBLE PRECISION, -- 周辺道路の最近実績（未使用時NULL）
  nearby_factor_samples          INTEGER,          -- 上記にマッチした周辺区間の件数
  nearby_weight_mass             DOUBLE PRECISION, -- 上記の重み合計（Σ距離×方位×新しさ。確信度の目安）
  combined_pace_factor           DOUBLE PRECISION, -- 上記3つを動的重みでブレンドした最終補正係数
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_arrival_predictions_computed_at ON trip_arrival_predictions(computed_at DESC);

-- ETA予測の履歴ログ（追記のみ）。trip_arrival_predictionsは常に最新値のみをUPSERTで
-- 持つため、「その予測がいつの時点で出されたものか」が失われる。予測精度の監視
-- （何分前の予測が実績とどれだけ乖離していたか）には時系列の履歴が必要なため、
-- 別テーブルとして追加した。既存のtrip_arrival_predictions・パイプラインの挙動は変更しない。
-- 書き込み量を抑えるため、直前に記録した値（predicted_time・source）から変化が
-- あった場合のみ1行追記する（computeAndStoreAllArrivalsの末尾で行う。詳細はetaPredictor.js参照）。
-- 到着済み区間はsource='actual'・predicted_time=実績時刻として記録されるため、
-- このテーブル単体で「その停留所に対する予測の変遷」と「実績」の両方が揃う。
-- assignment_id経由でtrip_vehicle_assignmentsにCASCADE削除させることで、
-- daily_tripsの保持期間（既定7日、DAILY_TRIP_RETENTION_DAYS）と寿命を合わせ、
-- 専用の掃除ジョブを持たずに肥大化を防いでいる。
CREATE TABLE IF NOT EXISTS trip_arrival_prediction_log (
  id                       BIGSERIAL PRIMARY KEY,
  assignment_id            BIGINT NOT NULL REFERENCES trip_vehicle_assignments(id) ON DELETE CASCADE,
  daily_trip_id            BIGINT NOT NULL,
  route_id                 TEXT NOT NULL,
  stop_id                  INTEGER NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  seq_order                INTEGER NOT NULL,
  predicted_time           TEXT,
  predicted_delay_minutes  INTEGER,
  source                   TEXT NOT NULL,
  -- 予測時点で対象停留所の何停留所手前に居たか（etaPredictor.js の predictArrivals()
  -- 参照）。予測精度監視で「何停留所前に出した予測か」の軸に使う付随メタデータ。
  stops_before             INTEGER,
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prediction_log_assignment_stop ON trip_arrival_prediction_log(assignment_id, stop_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_log_route_time ON trip_arrival_prediction_log(route_id, computed_at DESC);
-- 予測精度の監視（services/predictionAccuracy.js）は、まず「実績（source='actual'）」の
-- 行を期間で絞り、そのあと同じ(assignment_id, stop_id)の予測履歴と突き合わせる。
-- source='actual'の行はテーブル全体のごく一部でしかないため、部分インデックスで
-- 「期間内の実績」だけを走査できるようにする（全件スキャン＋source条件のフィルタを避ける）。
-- 路線絞り込みの有無で使われるインデックスが変わるため、2本用意している。
CREATE INDEX IF NOT EXISTS idx_prediction_log_actual_time ON trip_arrival_prediction_log(computed_at DESC) WHERE source = 'actual';
CREATE INDEX IF NOT EXISTS idx_prediction_log_actual_route_time ON trip_arrival_prediction_log(route_id, computed_at DESC) WHERE source = 'actual';

-- アルピコ交通 公式サイトの運行状況ページをスクレイピングした結果のキャッシュ（1行のみ保持）
CREATE TABLE IF NOT EXISTS service_status_cache (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  payload           JSONB NOT NULL,       -- カテゴリ・路線ごとの運行状況（[{category, routes:[{name,status,detail}]}]）
  source_updated_at TEXT,                 -- スクレイピング元ページに表示されている「更新日時」の文字列
  scraped_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

CREATE OR REPLACE VIEW active_vehicle_summary AS
SELECT v.id, v.car_id, v.business_start_time, v.departure_time, v.trip_type,
       v.delay_minutes, v.last_arrived_seq, v.status, v.trip_id
FROM vehicles v
WHERE v.status = 'active';