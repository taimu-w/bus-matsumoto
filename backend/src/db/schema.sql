-- ==========================================================
-- バスリアルタイム運行管理システム データベーススキーマ
-- 対象路線: ぐるっと松本バス 横田信大循環線
-- ==========================================================

CREATE TABLE IF NOT EXISTS stops (
  id            SERIAL PRIMARY KEY,
  seq_order     INTEGER NOT NULL UNIQUE,      -- 循環線内の停留所順序（0始まり）
  name          TEXT NOT NULL UNIQUE,
  name_kana     TEXT,
  name_en       TEXT,
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
  notice        TEXT,                          -- バス停個別のお知らせ
  timetable_link TEXT                          -- バス停時刻表リンク
);

-- 時刻表: 便（トリップ）ごと・停留所ごとの定刻。
-- scheduled_time が NULL かつ is_through=true の場合は元GASの「↓」（通過・非停車)を表す。
CREATE TABLE IF NOT EXISTS schedule_trips (
  id            SERIAL PRIMARY KEY,
  trip_index    INTEGER NOT NULL UNIQUE,       -- 時刻表内の便番号（列の順序、0始まり）
  first_stop_time TEXT                         -- 始発時刻（表示・検索用キャッシュ）
);

CREATE TABLE IF NOT EXISTS schedule_stop_times (
  trip_id       INTEGER NOT NULL REFERENCES schedule_trips(id) ON DELETE CASCADE,
  stop_id       INTEGER NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  scheduled_time TEXT,                          -- "H:mm" 形式。NULLは非停車(↓)
  is_through    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (trip_id, stop_id)
);

-- システム全体設定・お知らせ（GASの「設定 システム」シート相当）
CREATE TABLE IF NOT EXISTS system_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT
);

-- 稼働中車両（GASの車両IDシート1枚分に相当）
CREATE TABLE IF NOT EXISTS vehicles (
  id                  SERIAL PRIMARY KEY,
  car_id              TEXT NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  business_start_time TEXT,                 -- F2相当
  departure_time      TEXT,                 -- F3相当
  trip_type           TEXT NOT NULL DEFAULT '通常',  -- '通常' | '臨時便'
  trip_id             INTEGER REFERENCES schedule_trips(id),
  delay_minutes       INTEGER NOT NULL DEFAULT 0,     -- L2相当（最新遅延）
  last_arrived_seq    INTEGER NOT NULL DEFAULT -1,    -- 循環線対策用：最後に到着したバス停の順序
  status              TEXT NOT NULL DEFAULT 'active', -- 'active' | 'finished'
  finished_at         TIMESTAMPTZ,
  finish_reason       TEXT
);

-- 位置情報最新（受信直後の生ログ。GASの「位置情報最新」シート相当）
CREATE TABLE IF NOT EXISTS vehicle_positions_raw (
  id            BIGSERIAL PRIMARY KEY,
  car_id        TEXT NOT NULL,
  received_time TEXT NOT NULL,      -- 取得日時 H:mm（書式なしテキスト相当）
  gps_time      TEXT NOT NULL,      -- GPS時刻 H:mm
  gps_time_ts   TIMESTAMPTZ NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
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
  stop_id         INTEGER NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  seq_order       INTEGER NOT NULL,
  scheduled_time  TEXT,                 -- L列相当
  status          TEXT NOT NULL DEFAULT '',  -- '' | '到着済' | '通過'
  actual_time     TEXT,                 -- U列相当
  delay_minutes   INTEGER,              -- V列相当
  interpolated    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (vehicle_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_stop_status_vehicle ON vehicle_stop_status(vehicle_id);

-- 完了トリップのアーカイブ（統計・予測学習用）
CREATE TABLE IF NOT EXISTS completed_trips (
  id                  BIGSERIAL PRIMARY KEY,
  car_id              TEXT NOT NULL,
  trip_id             INTEGER REFERENCES schedule_trips(id),
  trip_type           TEXT,
  day_of_week         INTEGER NOT NULL,     -- 0=日曜 ... 6=土曜
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

CREATE OR REPLACE VIEW active_vehicle_summary AS
SELECT v.id, v.car_id, v.business_start_time, v.departure_time, v.trip_type,
       v.delay_minutes, v.last_arrived_seq, v.status, v.trip_id
FROM vehicles v
WHERE v.status = 'active';
