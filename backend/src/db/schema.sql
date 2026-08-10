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

-- フィード管理（GTFSフィード・位置情報フィードの両方を管理）
-- 位置情報CSVとGTFSの対応関係はこのテーブル + feed_mappings で動的に管理する
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

-- 位置情報フィードとGTFSフィードの対応関係（動的管理）
-- コードにハードコードせず、DBで管理する
CREATE TABLE IF NOT EXISTS feed_mappings (
  location_feed_id TEXT NOT NULL REFERENCES feeds(id),
  gtfs_feed_id     TEXT NOT NULL REFERENCES feeds(id),
  confidence       REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_feed_id, gtfs_feed_id)
);

CREATE TABLE IF NOT EXISTS route_external_ids (
  route_id      TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,
  feed_id       TEXT REFERENCES feeds(id),
  PRIMARY KEY (route_id, external_id),
  UNIQUE (external_id)
);

CREATE TABLE IF NOT EXISTS stops (
  id            SERIAL PRIMARY KEY,
  route_id      TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  direction_id  INTEGER NOT NULL DEFAULT 0,
  seq_order     INTEGER NOT NULL,              -- 路線内の停留所順序（0始まり）
  name          TEXT NOT NULL,
  name_kana     TEXT,
  name_en       TEXT,
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
  notice        TEXT,
  timetable_link TEXT,
  UNIQUE (route_id, direction_id, seq_order)
);

-- 時刻表: 便（トリップ）ごと・停留所ごとの定刻。
-- scheduled_time が NULL かつ is_through=true の場合は元GASの「↓」（通過・非停車)を表す。
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
  scheduled_time TEXT,                          -- "H:mm" 形式。NULLは非停車(↓)
  is_through    BOOLEAN NOT NULL DEFAULT FALSE,
  stop_headsign TEXT,                           -- GTFS stop_times.txt の stop_headsign（枝分かれ路線の停留所別行先）
  PRIMARY KEY (trip_id, stop_id)
);

-- システム全体設定・お知らせ（GASの「設定 システム」シート相当）
CREATE TABLE IF NOT EXISTS system_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT
);

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
  scheduled_time TEXT,                          -- "H:mm"。NULLは非停車(↓)
  is_through     BOOLEAN NOT NULL DEFAULT FALSE,
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

-- 便×車両ごとのバス停進捗（旧 vehicle_stop_status の置換）。
-- 候補車両も担当車両と同じように通過判定・遅延計算を行う（仕様書 9）。
CREATE TABLE IF NOT EXISTS trip_stop_progress (
  assignment_id  BIGINT NOT NULL REFERENCES trip_vehicle_assignments(id) ON DELETE CASCADE,
  stop_id        INTEGER NOT NULL REFERENCES stops(id),
  seq_order      INTEGER NOT NULL,
  scheduled_time TEXT,
  status         TEXT NOT NULL DEFAULT '',      -- '' | '通過' | '到着済'
  actual_time    TEXT,
  delay_minutes  INTEGER,
  interpolated   BOOLEAN NOT NULL DEFAULT FALSE,
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
  business_start_time TEXT,
  departure_time      TEXT,
  finished_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finish_reason       TEXT,
  aggregated          BOOLEAN NOT NULL DEFAULT FALSE
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
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_arrival_predictions_computed_at ON trip_arrival_predictions(computed_at DESC);

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