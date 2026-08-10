# 設計書：便起点の車両割り当て方式への移行

対象仕様：「バス便・車両割り当て方式変更 仕様書 v2」
前提ドキュメント：[README.md](../README.md)（現行アーキテクチャの詳細）、[CLAUDE.md](../CLAUDE.md)

> **この設計は実装済みです（2026年8月）。** 実際のモジュール構成・挙動は[README.md](../README.md)が正となります。本書は「なぜこの構造にしたか」を残すための設計記録です。
>
> 実装時に仕様書から変更した点が1つあります。§4.5 の「同時刻帯（10分）を実装条件にしない」という当初案は採用せず、**仕様書どおり「始発時刻の差が10分以内の便どうしで担当車両を重複させない」というルールをそのまま実装**しました。したがって 8:00便の担当車両が 8:11便の担当になることは許されます。詳細は §4.5 を参照してください。

---

## 0. 設計の中心となる考え方

仕様書 §19 が求めている「データモデルそのものの変更」を、次の一点に集約する。

> **便（`daily_trips`）を第一級エンティティにし、通過実績・遅延などの進捗データを「車両単位」ではなく「(便 × 車両) の割り当て単位」で保持する。**

現行は `vehicles` 1行が「1台の車両」と「その車両が走っている1便」を兼ねており、進捗（`vehicle_stop_status`）も `vehicle_id` で紐づいている。この構造のままでは仕様書の以下の要求を満たせない。

| 仕様 | 現行構造での不都合 |
|---|---|
| §8.3 候補車両は複数便に重複してよい | `vehicles` は `UNIQUE (route_id, car_id)`。1台＝1便しか表現できない |
| §9 候補車両にも通常の運行処理を行う | 進捗が車両単位のため、同じ車両が2便分の通過判定結果を同時に保持できない |
| §11 再割り当て時、新担当が記録済みの実績を便の実績として引き継ぐ | 車両ごとに実績があると「移し替え」処理が必要になり、§11.1 が禁じる進行度マージの誘惑が生まれる |

進捗を **(便 × 車両)** で持てば、§11 の「引き継ぎ」は**処理ではなく視点の切り替え**になる。候補車両B は最初から「8:00便のB車としての実績」を記録しているので、担当をA→Bに切り替えた瞬間、B の実績がそのまま便の実績になる。データのコピーもマージも発生せず、§11.1（進行度で選ばない）が構造的に守られる。

```
daily_trips（8:00便）
  ├─ assignment(role=assigned)  ── vehicle A ── trip_stop_progress（Aの通過実績）
  ├─ assignment(role=candidate) ── vehicle B ── trip_stop_progress（Bの通過実績）← §9で常時更新
  └─ assignment(role=candidate) ── vehicle C ── trip_stop_progress（Cの通過実績）

A が運行終了 → B の role を assigned に昇格するだけ。実績の移動は不要。
利用者向けAPIは「role=assigned の assignment」だけを読む（§15）。
```

---

## 1. データベース設計

### 1.1 新規テーブル

#### `daily_trips` — 当日の運行便（§3）

```sql
CREATE TABLE IF NOT EXISTS daily_trips (
  id                  BIGSERIAL PRIMARY KEY,
  service_date        DATE    NOT NULL,
  route_id            TEXT    NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  direction_id        INTEGER NOT NULL DEFAULT 0,
  schedule_trip_id    INTEGER NOT NULL REFERENCES schedule_trips(id) ON DELETE CASCADE,
  service_id          TEXT    NOT NULL,
  origin              TEXT    NOT NULL DEFAULT 'static',  -- 'static' | 'frequency'
  frequency_index     INTEGER NOT NULL DEFAULT 0,         -- 仮想便の連番（通常便は0）
  offset_minutes      INTEGER NOT NULL DEFAULT 0,         -- 元tripの始発時刻からのシフト量
  start_stop_id       INTEGER NOT NULL REFERENCES stops(id),
  start_time          TEXT    NOT NULL,        -- "H:mm"（既存表記との互換用）
  start_at            TIMESTAMPTZ NOT NULL,    -- 実時刻（24時超え便も正しく表現できる）
  headsign            TEXT,
  assignment_state    TEXT    NOT NULL DEFAULT 'pending', -- pending | assigned | unassigned
  assigned_vehicle_id INTEGER REFERENCES vehicles(id),
  assigned_at         TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_date, schedule_trip_id, frequency_index)
);
CREATE INDEX IF NOT EXISTS idx_daily_trips_pending
  ON daily_trips(service_date, assignment_state, start_at);
```

`assignment_state` の意味：

| 値 | 意味 | 利用者向け表示（§10.5・§15） |
|---|---|---|
| `pending` | 始発時刻がまだ来ていない／未評価 | 時刻表として表示。リアルタイム情報なし |
| `assigned` | 担当車両あり | リアルタイム時刻表・ルート検索・現在位置・ETAすべて対象 |
| `unassigned` | 候補評価済みだが担当なし（初回候補なし／再割り当て不能） | 時刻表として表示。リアルタイム情報なし |

`unassigned` は §12（臨時便判定の廃止）と §10.4 の受け皿で、`pending` から一方通行で遷移する（§10.2 により、始発時刻後に新規候補を追加しないため `unassigned → assigned` は起きない）。

#### `daily_trip_stop_times` — 当日便のバス停別定刻

```sql
CREATE TABLE IF NOT EXISTS daily_trip_stop_times (
  daily_trip_id  BIGINT  NOT NULL REFERENCES daily_trips(id) ON DELETE CASCADE,
  stop_id        INTEGER NOT NULL REFERENCES stops(id),
  seq_order      INTEGER NOT NULL,
  scheduled_time TEXT,                       -- "H:mm"。NULLは非停車（↓）
  is_through     BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (daily_trip_id, stop_id)
);
```

**`frequencies.txt` のオフセットをここで焼き込んでしまう**のが設計上の要点。仕様書 §3.4.2 が求める「仮想tripを通常便と完全に同一に扱う」を、条件分岐ではなく**データの形**で保証する。以降の全モジュール（通過判定・遅延計算・ETA・時刻表API・ルート検索）は `daily_trip_stop_times` だけを読めばよく、`offset_minutes` を意識するコードは生成処理の1箇所に閉じる。

規模見積り：GTFSフィード2件で trip 計950件・stop_times 計約24,000行。1日に有効な `service_id` は通常その一部で、`frequencies` 展開を含めても当日分は概ね1万行前後。日次生成・日次パージで十分に扱える。

#### `trip_vehicle_assignments` — 便への車両割り当て（担当・候補）（§18.2への回答）

```sql
CREATE TABLE IF NOT EXISTS trip_vehicle_assignments (
  id                 BIGSERIAL PRIMARY KEY,
  daily_trip_id      BIGINT  NOT NULL REFERENCES daily_trips(id) ON DELETE CASCADE,
  vehicle_id         INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  role               TEXT    NOT NULL,                 -- 'assigned' | 'candidate'
  state              TEXT    NOT NULL DEFAULT 'active',-- 'active' | 'ended'
  distance_meters    DOUBLE PRECISION NOT NULL,        -- 始発時刻時点の始発バス停からの距離
  eval_gps_time_ts   TIMESTAMPTZ NOT NULL,             -- 判定に使ったGPSの時刻
  eval_gps_time      TEXT NOT NULL,                    -- 同上（"H:mm"表記）
  became_assigned_at TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  end_reason         TEXT,
  last_arrived_seq   INTEGER NOT NULL DEFAULT -1,
  delay_minutes      INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (daily_trip_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_active ON trip_vehicle_assignments(state, role);
CREATE INDEX IF NOT EXISTS idx_assignments_trip   ON trip_vehicle_assignments(daily_trip_id, role, state);
CREATE INDEX IF NOT EXISTS idx_assignments_vehicle ON trip_vehicle_assignments(vehicle_id, state);
```

候補は `role='candidate'` として複数便に重複してよい（§8.3）。担当車両は `role='assigned'` の1行として表現し、候補行と担当行を分けて二重に持たない（昇格は `UPDATE ... SET role='assigned'`）。

1台の車両が「同時刻帯でない複数便」の担当になるのは正当な状態なので、`(vehicle_id) WHERE role='assigned' AND state='active'` のような部分ユニークインデックスは**かけない**（§4.5）。重複割り当て防止は `hasSamePeriodConflict()` によるアプリケーション側の判定で行う。

#### `trip_stop_progress` — 便×車両ごとのバス停進捗（旧 `vehicle_stop_status` の置換）

```sql
CREATE TABLE IF NOT EXISTS trip_stop_progress (
  assignment_id  BIGINT  NOT NULL REFERENCES trip_vehicle_assignments(id) ON DELETE CASCADE,
  stop_id        INTEGER NOT NULL REFERENCES stops(id),
  seq_order      INTEGER NOT NULL,
  scheduled_time TEXT,
  status         TEXT    NOT NULL DEFAULT '',   -- '' | '通過' | '到着済'
  actual_time    TEXT,
  delay_minutes  INTEGER,
  interpolated   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (assignment_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_progress_assignment ON trip_stop_progress(assignment_id, seq_order);
```

列構成は `vehicle_stop_status` とほぼ同一（`vehicle_id, route_id` → `assignment_id`）。`status` の語彙・意味は完全に据え置き、§14 が要求する既存の通過判定ルールをそのまま移植できるようにする。

#### `trip_gps_matches` — 通過判定で消費したGPSログ（旧 `vehicle_gps_log.matched_label` の置換）

```sql
CREATE TABLE IF NOT EXISTS trip_gps_matches (
  assignment_id BIGINT  NOT NULL REFERENCES trip_vehicle_assignments(id) ON DELETE CASCADE,
  gps_log_id    BIGINT  NOT NULL REFERENCES vehicle_gps_log(id) ON DELETE CASCADE,
  stop_id       INTEGER NOT NULL REFERENCES stops(id),
  matched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, gps_log_id)
);
```

**この分離は必須**。現行 [passDetection.js](../backend/src/services/passDetection.js) は「どのGPSログを処理済みか」を `vehicle_gps_log.matched_label` に書いて管理しているが、1台の車両が複数便の候補になる新モデルでは、同じGPSログ行が便ごとに別々のバス停へマッチし得るため、車両側の1列では表現できない。

#### `schedule_trip_frequencies` — GTFS `frequencies.txt`（§3.4）

```sql
ALTER TABLE schedule_trips ADD COLUMN IF NOT EXISTS gtfs_trip_id TEXT;
CREATE INDEX IF NOT EXISTS idx_schedule_trips_gtfs_trip_id ON schedule_trips(gtfs_trip_id);

CREATE TABLE IF NOT EXISTS schedule_trip_frequencies (
  trip_id      INTEGER NOT NULL REFERENCES schedule_trips(id) ON DELETE CASCADE,
  start_time   TEXT    NOT NULL,   -- GTFS原文（"07:00:00"、24時超え表記あり）
  end_time     TEXT    NOT NULL,
  headway_secs INTEGER NOT NULL,
  exact_times  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, start_time)
);
```

> **`schedule_trips.gtfs_trip_id` の追加は frequencies 対応の前提条件。** 現行 [seed.js](../backend/src/db/seed.js) は `schedule_trips` に GTFS の `trip_id` を保存しておらず、`trip_index`（route×direction×service 内での連番）しか持たない。このため `frequencies.txt` の `trip_id` を DB上の便に対応づける手段が存在しない。

### 1.2 既存テーブルの変更

#### `vehicles` — 「便を走っている実体」から「観測されている物理車両」へ

| 列 | 変更後の扱い |
|---|---|
| `business_start_time` / `departure_time` / `trip_id` / `trip_type` | **書き込みも参照も停止**（§13・§12）。列自体は残置（移行のロールバック余地と、既存 `completed_trips` との整合のため） |
| `last_arrived_seq` / `delay_minutes` | `trip_vehicle_assignments` 側へ移動。車両側は参照しない |
| `direction_id` | 位置情報CSVから解決した方向。**NULL を許容**し「方向不明／方向を使わない路線」を表現する（§6.3） |
| `status` | `active`（GPS受信中）／`inactive`（GPS途絶）。**運行終了で行を削除しない**（下記） |
| `last_gps_at`（新規 TIMESTAMPTZ） | 直近GPS時刻。候補抽出・GPS途絶判定を高速化 |
| `direction_raw`（新規 TEXT） | 位置情報CSVの方向列の生値。デバッグ・設定ミス調査用 |

**車両行を削除しない方針への変更**が重要。現行 [finishService.js](../backend/src/services/finishService.js) は運行終了時に `DELETE FROM vehicles` している。新モデルでは車両は複数便にまたがる長寿命の識別子であり、削除すると `vehicle_gps_log` が CASCADE で消え、他便の候補としての進捗計算も壊れる。代わりに `status='inactive'` にし、GPSが戻れば `active` に復帰させる。GPSログは日次パージで削る。

#### `completed_trips` / `completed_trip_stop_times`

```sql
ALTER TABLE completed_trips ADD COLUMN IF NOT EXISTS daily_trip_id BIGINT REFERENCES daily_trips(id);
ALTER TABLE completed_trips ADD COLUMN IF NOT EXISTS assignment_id BIGINT;
ALTER TABLE completed_trips ADD COLUMN IF NOT EXISTS start_time    TEXT;    -- 便の始発時刻
ALTER TABLE completed_trips ADD COLUMN IF NOT EXISTS is_official   BOOLEAN NOT NULL DEFAULT TRUE;
```

`is_official` が §18.3（ETA学習データとの接続）への回答（後述 §6.3）。`business_start_time` / `departure_time` は以後 NULL 固定。

#### 廃止するテーブル

`vehicle_stop_status` は参照をやめる。**DROP はせず残置**（移行期のロールバックと、旧データの目視確認のため）。移行完了後に別途削除。

### 1.3 マイグレーション方針

既存の [migrate.js](../backend/src/db/migrate.js) の流儀（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` の冪等な積み上げ）をそのまま踏襲する。`schema.sql` にも新テーブルのDDLを追加し、`docker-entrypoint.sh` の毎回実行で自然に反映されるようにする。

---

## 2. モジュール構成

### 2.1 新規

| ファイル | 責務 |
|---|---|
| `services/dailyTripBuilder.js` | 当日便の生成（§3）。`ensureDailyTrips(serviceDate)` |
| `services/gtfsFrequencies.js` | `frequencies.txt` の読み込みと仮想trip展開（純関数中心・テストしやすい形） |
| `services/tripAssignment.js` | 候補抽出・初回割り当て・再割り当て（§4〜§8・§10） |
| `config/directionMapping.js` | 路線別の direction 対応設定（§6） |

### 2.2 改修

| ファイル | 改修内容 |
|---|---|
| [passDetection.js](../backend/src/services/passDetection.js) | 処理対象を「車両」から「有効な割り当て」へ。判定アルゴリズム本体は不変（§14） |
| [delayCalc.js](../backend/src/services/delayCalc.js) | 同上。`scheduled_time` による status 上書きをしない設計も維持 |
| [finishService.js](../backend/src/services/finishService.js) | 割り当て単位の終了判定＋アーカイブ。条件⑤（時刻表照合タイムアウト）を削除 |
| [etaPredictor.js](../backend/src/services/etaPredictor.js) | `predictArrivals(client, assignmentId)` に変更。予測アルゴリズムは一切変更しない |
| [locationFetcher.js](../backend/src/services/locationFetcher.js) | 方向解決を DB(`direction_mapping`) からコード設定へ |
| [gtfsFeedManager.js](../backend/src/services/gtfsFeedManager.js) | `frequencies.txt` を**任意ファイル**として展開・保持 |
| [seed.js](../backend/src/db/seed.js) | `gtfs_trip_id` の保存、`frequencies.txt` の投入 |
| [api.js](../backend/src/routes/api.js) / [routeSearch.js](../backend/src/services/routeSearch.js) | 便起点への切り替え（§15） |
| [pipeline.js](../backend/src/jobs/pipeline.js) / [scheduler.js](../backend/src/jobs/scheduler.js) | ステップ構成と深夜帯スキップ範囲の見直し |
| [admin.html](../frontend/admin.html) | direction_mapping 編集UIの削除（§6.1） |
| [app.js](../frontend/app.js) | 「臨時便」バッジ削除、`isRealtime` の意味を「担当車両あり」に変更 |

### 2.3 廃止

`services/businessStart.js`、`services/departure.js`、`services/planMaking.js`、`services/specialBus.js`（§13・§12）。

`specialBus.js` の `client.release()` 二重呼び出し問題（[CLAUDE.md](../CLAUDE.md) の既知の注意点）は、ファイルごと消えることで解消する。

---

## 3. 当日便の生成（§3）

### 3.1 処理フロー

```
ensureDailyTrips(serviceDate):
  1. 生成済みチェック（daily_trips に service_date の行があり、かつ
     前回生成後にGTFS再seedが走っていなければ何もしない）
  2. activeServiceIds = gtfsCalendar.getActiveServiceIds(serviceDate)   ← 既存機構をそのまま利用（§3.2）
  3. schedule_trips WHERE service_id = ANY(activeServiceIds) を全件走査
     3-1. その便の schedule_stop_times を seq_order 昇順で取得
     3-2. baseStartTime = 最小 seq_order の有効な scheduled_time
     3-3. schedule_trip_frequencies を引く
          - 無し → インスタンス1件（offset=0, frequency_index=0）
          - 有り → 仮想便を展開（§3.4）。**元の素の便は生成しない**
     3-4. 各インスタンスについて
          - daily_trips を UPSERT
          - daily_trip_stop_times を UPSERT（全定刻に offset_minutes を加算）
```

### 3.2 始発時刻・始発バス停の決定（§4.3）

**§4.3 の優先順位は現行 [seed.js](../backend/src/db/seed.js) の `toClockTime(row.departure_time || row.arrival_time)` が既に満たしている。** `departure_time` があればそれを採用し、空なら `arrival_time` にフォールバックする。したがって §4.3 のために新たな実装は不要で、`schedule_stop_times.scheduled_time` をそのまま使えばよい。この事実をコード上のコメントに明記しておく。

始発バス停は **その便の `stop_times` の最小 `seq_order` の停留所**とする。現行 [businessStart.js](../backend/src/services/businessStart.js) は `seq_order = 0` 決め打ちだったため、路線内で始発が異なる便を正しく扱えなかった。便起点になることで自然に解消する。

### 3.3 冪等性と「運行中の便を書き換えない」ガード

GTFSフィードは1時間ごとに再取得され、成功すると [gtfsFeedManager.js](../backend/src/services/gtfsFeedManager.js) が `seed()` を呼んでマスタを入れ替える。当日便生成もこれに追随する必要があるが、**すでに車両を割り当て済みの便の時刻を書き換えてはならない**（走行中の便の定刻が突然ずれ、遅延計算と実績が破綻する）。

```
UPSERT ルール：
  assignment_state = 'pending'          → 時刻・停車パターンを更新する
  assignment_state IN ('assigned','unassigned') → 更新しない（当日はそのまま走り切る）
GTFSから消えた便：
  assignment_state = 'pending' のものだけ削除。割り当て済みは残す
```

### 3.4 `frequencies.txt` の展開（§3.4）

#### 展開規則

```
for each frequencies 行 (trip_id, start_time, end_time, headway_secs):
    for t = start_time; t < end_time; t += headway_secs:
        仮想便を1件生成（offset_minutes = t − 元tripの始発時刻）
```

終端は **`end_time` を含まない**（`t < end_time`）。これはGTFS標準の解釈であり、仕様書 §3.4.1 の例（07:00〜09:00 / 600秒 → 7:00・7:10・…・8:50 の12便）とも一致する。

`exact_times` の値による分岐は設けない（§3.4.2）。`0`（目安の間隔運行）でも `1`（厳密な時刻表運行）でも、展開時に算出した時刻をそのまま始発時刻として扱う。

`frequencies.txt` に登場する trip は**仮想便としてのみ**展開し、素の便としては生成しない。GTFS標準では frequencies を持つ trip の `stop_times` は所要時間のテンプレートに過ぎないため、両方を生成すると同じ便が二重に現れる。

#### GTFSフィード側の対応（見落としやすい罠）

現行 [gtfsFeedManager.js](../backend/src/services/gtfsFeedManager.js) の `REQUIRED_GTFS_FILES` は7ファイル固定で、**ZIP内の必須ファイル以外は展開先に配置しない**実装になっている（170行目付近）。このため `frequencies.txt` が入っているフィードでも、現状は展開時に捨てられる。

```js
// 対応方針
const REQUIRED_GTFS_FILES = [ /* 現状のまま7件。変更しない */ ];
const OPTIONAL_GTFS_FILES = ['frequencies.txt'];
// 必須チェックには含めず、配置ループの対象にだけ加える
```

**`frequencies.txt` を `REQUIRED_GTFS_FILES` に足してはならない。** 現在有効な2フィード（guruttomatsumotobus1 / 2）はいずれも `frequencies.txt` を含んでおらず、必須にすると全フィードが「必須ファイル欠損」で更新失敗し、システム全体が停止する。

`frequencies.txt` が存在しないフィードでは、当日便生成は従来通り個別 trip のみを展開する（現行データに対する挙動変更はゼロ）。

### 3.5 生成タイミング（§3.3）と深夜帯の扱い

生成は `pipeline.js` の先頭で `ensureDailyTrips()` を呼ぶ（当日分が生成済みなら即リターンする軽量ガード付き）。加えて GTFS 再 seed の直後にも呼ぶ。

> ⚠️ **深夜帯スキップとの衝突（要対応）**
> 現行 [pipeline.js](../backend/src/jobs/pipeline.js) は `isNightTime()`（既定 23:00〜05:45）で処理全体をスキップする。一方、GTFSデータ上の最早の便は **05:40発**（guruttomatsumotobus1）であり、深夜帯が明ける前に始発時刻が来る。
> 現行方式（車両起点）でもこの便は取りこぼしていたが、便起点になると「当日便が未生成のまま始発時刻を過ぎる」という形で顕在化する。
> **対応**：`ensureDailyTrips()` と `assignPendingTrips()` を深夜帯スキップの対象外にする（GPS取得も同様に必要）。あるいは `NIGHT_END` を 05:00 程度に前倒しする。前者を推奨。

---

## 4. 車両割り当て（§4〜§8）

### 4.1 全体フロー

```
assignPendingTrips(now):
  targets = daily_trips
            WHERE service_date = 今日
              AND assignment_state = 'pending'
              AND start_at <= now - ASSIGN_DELAY_SEC
            ORDER BY start_at ASC, id ASC          ← §8.2（始発時刻の早い順）
  for trip in targets:                              ← 1便ずつ順に確定させる
     candidates = findCandidates(trip)
     if candidates.length === 0:
         trip.assignment_state = 'unassigned'       ← §12・§10.4
         continue
     candidates.sort(距離昇順)                       ← §7
     担当 = candidates[0]
     for c in candidates:
         openAssignment(trip, c, role = (c === 担当 ? 'assigned' : 'candidate'))
     trip.assignment_state = 'assigned'
     trip.assigned_vehicle_id = 担当.vehicle_id
```

1便ずつ確定してから次の便を処理するため、直前の便で担当になった車両は次の便の候補抽出時点で自動的に除外される（§8.2 の逐次性）。

### 4.2 候補抽出 `findCandidates(trip)`

```sql
-- 車両ごとに「[start_at − 3分, start_at] の範囲内で最新のGPS」を1点ずつ取る（§4.2）
SELECT DISTINCT ON (v.id)
       v.id AS vehicle_id, v.car_id, v.direction_id,
       g.id AS gps_log_id, g.lat, g.lon, g.gps_time, g.gps_time_ts
FROM vehicles v
JOIN vehicle_gps_log g ON g.vehicle_id = v.id
WHERE v.route_id = $routeId                          -- 条件1：路線一致（§5.1）
  AND v.status  = 'active'
  AND g.gps_time_ts >= $startAt - INTERVAL '3 minutes'  -- 下限：閉区間
  AND g.gps_time_ts <= $startAt                         -- 上限：閉区間（1秒でも超えたら無効）
ORDER BY v.id, g.gps_time_ts DESC
```

SQL で絞り込んだ後、アプリ側で以下を適用する。

| 仕様の条件 | 実装 |
|---|---|
| 1. 同じ路線 | 上記SQL の `v.route_id`。`vehicles.route_id` は [locationFetcher.js](../backend/src/services/locationFetcher.js) が `route_external_ids` 経由で解決した qualified route id（`feedId:routeId`）なので、GTFS便の `route_id` と直接比較できる（§5.1への回答） |
| 2. 範囲内の最新GPSが存在 | `DISTINCT ON (v.id) ... ORDER BY gps_time_ts DESC` |
| 3. GPS時刻が始発時刻の3分以内 | 条件2のウィンドウと同義（重複条件）。追加判定は不要 |
| 4. 始発バス停から100m以内 | `haversineDistanceMeters()` ≦ `ASSIGN_RADIUS_METERS`（既定100） |
| 5. 別便の担当車両でない | `trip_vehicle_assignments` に `role='assigned' AND state='active'` の行がないこと |
| direction条件（§6） | `directionMapping` の設定が `ignore` でなければ `vehicle.direction_id === trip.direction_id` |

条件5について：仕様書 §5 は「担当車両として割り当て済みでない」を**候補条件**として挙げ、§8.3 は「候補としての重複は許容」としている。両者を素直に合わせると、**他便の担当になっている車両は候補にもしない／候補同士の重複は許容する**、となる。再割り当て時（§10.3）には同じ条件をその時点で再評価する。

**距離判定の半径は 100m（`ASSIGN_RADIUS_METERS`）で、通過判定の 120m（`STOP_RADIUS_METERS`）とは別の設定値**とする。用途が違うため共用しない。

### 4.3 割り当ての開始 `openAssignment(trip, cand, role)`

担当・候補の区別なく、以下を1トランザクションで行う（§9：候補にも通常の運行処理を行うため、初期化内容は同一）。

```
1. trip_vehicle_assignments に1行INSERT（role, distance_meters, eval_gps_time_ts）
2. daily_trip_stop_times から trip_stop_progress を展開
   - lastValidSeq = 「実際に定刻を持つ最後のバス停」の seq_order
   - is_through かつ seq_order < lastValidSeq のバス停のみ status='通過'
     （lastValidSeq より先の経由フラグ付きバス停は '' のままにする）      ← §14／README §4.8 のルールを厳守
   - 始発バス停は status='到着済'、actual_time = 判定に使ったGPS時刻、遅延も算出
3. vehicles 側のカウンタ更新は行わない（割り当て行が持つ）
```

**始発バス停を `到着済` にする理由**：旧 [planMaking.js](../backend/src/services/planMaking.js) は始発停に `departure_time` を入れていたが、出発判定は廃止された（§13）。代わりに「始発時刻時点で始発バス停から100m以内にいた」という確定した観測事実（判定に使ったGPS時刻）を実績として入れる。これにより ETA の `liveFactor` 算出とカーソル起点が従来どおり機能する（到着済が0件だと [etaPredictor.js](../backend/src/services/etaPredictor.js) は `source: 'schedule'` の素通し予測に落ちるため）。

### 4.4 割り当て遅延パラメータ `ASSIGN_DELAY_SEC`

位置情報CSVは配信側の都合で数十秒遅れて更新され得る。始発時刻ちょうどに評価すると、7:59:50 のGPSがまだ取り込まれておらず候補を取りこぼす可能性がある。

`start_at + ASSIGN_DELAY_SEC`（既定 60秒＝ポーリング1回分）を過ぎてから評価する。判定に使うGPSの時間窓（`[start_at − 3分, start_at]`）は §4.2 の通り固定で、遅延させるのは**評価タイミングだけ**である点に注意。値を大きくすると候補の取りこぼしは減るが、割り当てとリアルタイム表示の開始が遅れる。

なお `pipeline.js` は `fetchLocation()` → 割り当ての順で直列実行されるため、同一ティック内で取得した最新GPSは必ず判定対象に入る。

### 4.5 「同時刻帯」（§8.1）の実装

仕様書どおり、**「始発時刻の差が `ASSIGN_SAME_PERIOD_MIN`（既定10分）以内の便どうしでは、同じ車両を担当車両にしない」** というルールを実装する。判定は `tripAssignment.js` の `hasSamePeriodConflict()` に集約する。

```
8:00便の担当車両を 8:05便の担当にする → 不可（差5分）
8:00便の担当車両を 8:10便の担当にする → 不可（差10分・境界を含む）
8:00便の担当車両を 8:11便の担当にする → 可（差11分）
```

推移性の問題は、便を始発時刻の早い順に1件ずつ確定させること（§8.2）で自然に解消される。8:00便と8:16便が同じ車両を担当することは、両者が同時刻帯でない以上あり得てよい。

当初は「稼働中の車両は他の便に割り当てない」というより単純で厳しい制約も検討したが、**採用しなかった**。それでは 8:00便の担当車両が 8:11便の担当になれず、仕様の意図（10分を超えて離れた便なら同じ車両でよい）を満たせないためである。

この判定はアプリケーションロジックにのみ存在する。1台の車両が同時刻帯でない複数便の担当になることは正当なので、DB側の部分ユニークインデックスによる排他は**かけられない**（かけると上記の 8:11便のケースが弾かれてしまう）。

---

## 5. direction_id の対応（§6）

### 5.1 コード設定への移行

```js
// backend/src/config/directionMapping.js
//
// 位置情報CSVの方向列の値 → GTFS direction_id の対応を、路線ごとにコードで管理する。
// 管理画面からの設定（route_external_ids.direction_mapping）は廃止した（仕様書 §6.1）。
//
//   mode: 'map'    … map で変換した direction_id を便判定に使う
//   mode: 'ignore' … 方向値を便判定に使わない（路線一致＋100m以内のみで候補とする。§6.3）

const DIRECTION_RULES = {
  // 例）
  // 'guruttomatsumotobus1:11': { mode: 'map',    map: { '0': 1, '1': 0 } },
  // 'guruttomatsumotobus2:25': { mode: 'ignore' },
};

// 既定値は現行DBの direction_mapping 既定値 {csvValue0:1, csvValueOther:0} と一致させ、
// 設定を書かない路線の挙動を変えないこと。
const DEFAULT_RULE = { mode: 'map', map: { '0': 1, '1': 0 } };

function resolveDirectionId(routeId, csvValue) { /* → number | null */ }
function isDirectionIgnored(routeId) { /* → boolean */ }
```

`mode: 'ignore'` の路線では `resolveDirectionId()` が `null` を返し、`vehicles.direction_id` も NULL になる。候補抽出では direction 条件をスキップする（§6.3）。

### 5.2 影響範囲

- [locationFetcher.js](../backend/src/services/locationFetcher.js)：`route_external_ids.direction_mapping` の読み出しを `directionMapping.resolveDirectionId()` に置換。CSV原値は `vehicle_positions_raw.direction_raw` に残す
- [admin.html](../frontend/admin.html)：方向対応の入力欄（191〜205行・396〜401行付近）を削除
- [api.js](../backend/src/routes/api.js)：`GET/PUT /api/admin/route-mappings` から `directionMapping` の受け渡しを削除（外部ID⇔route_id の対応表そのものは維持）
- DB列 `route_external_ids.direction_mapping` は残置し、参照をやめるだけにする

---

## 6. 運行処理・終了・再割り当て

### 6.1 通過判定・遅延計算（§9・§14）

処理対象を「`status='active'` の車両」から「`state='active'` の割り当て」に変えるだけで、**アルゴリズムには一切手を入れない**。担当・候補を区別せず全割り当てを処理する（§9）。

`pass()` の変更点：

| 現行 | 変更後 |
|---|---|
| 対象：`vehicles` で `departure_time` かつ `trip_id` あり | 対象：`trip_vehicle_assignments` で `state='active'` |
| 停留所マスタ：`vehicle_stop_status JOIN stops`（路線×方向の全停留所） | `trip_stop_progress JOIN stops`（**その便の停留所のみ**） |
| 未処理GPS：`vehicle_gps_log WHERE matched_label IS NULL` | `vehicle_gps_log` のうち `trip_gps_matches` に未登録、かつ `gps_time_ts >= daily_trips.start_at − 3分`、かつ freshness 内 |
| 循環線対策②の基準 `minSinceDep` | `vehicle.departure_time` → `daily_trips.start_time`（意味は同じ「始発からの経過分」） |
| 進捗更新先 | `vehicle_stop_status` → `trip_stop_progress`、`vehicles.last_arrived_seq` → `trip_vehicle_assignments.last_arrived_seq` |

維持するもの：循環線対策①（`lastArrivedIdx + 4` まで）、循環線対策②（出発20分以内は後半80%除外）、巻き戻り防止（`currentMaxIdx`）、`passStep2Dedup()` の最近接1件採用、`passInterpolate()` の線形補間。

GPSログの取得を SQL 側で freshness 絞り込みするのは、現行のように「マッチしなかった行を毎バッチ再走査し続ける」挙動を有界にするための小さな改善。判定結果は変わらない。

`delayCalc()` の変更点：対象を割り当て単位にし、前提条件 `business_start_time && trip_id` を「割り当てが active」に置換する。**`scheduled_time` が無いことを理由に status を上書きしない**という現行の意図的な設計（[delayCalc.js](../backend/src/services/delayCalc.js) 冒頭コメント）はそのまま維持する。

**副次的な改善**：現行は車両作成時に「路線×方向の全停留所」の進捗行を作り、後から `planMaking` が便の停車パターンで部分的に上書きしていたため、便に含まれない停留所の行が残っていた。新方式では便の停車パターンだけを展開するので、この不整合が消える。

### 6.2 運行終了判定（§10.1）

`finishTrips()` を **割り当て単位**の判定に組み替える。判定条件の内容と閾値は現行を維持する（§10.1「運行終了判定のロジック自体は変更しない」）。

| 条件 | 判定単位 | 効果 |
|---|---|---|
| ① 終点到着済（**その便の最終停留所**） | 割り当て | その割り当てを `ended` |
| ② 終点から `END_AREA_RADIUS_METERS` 以内 | 割り当て | その割り当てを `ended` |
| ③ 割り当てから `VEHICLE_MAX_AGE_MIN` 経過 | 割り当て | その割り当てを `ended`（保護期間の対象外） |
| ④ GPS更新が3分以上停止 | 車両 | その車両の**全**割り当てを `ended`＋`vehicles.status='inactive'` |
| ⑤ 時刻表照合タイムアウト | — | **削除**（§12・§13で照合概念自体が消えるため） |

`FINISH_PROTECTION_MIN`（既定10分）は「割り当てからの経過時間」に対して従来どおり①②に適用する。

条件①の「終点」は路線の `seq_order` 最大ではなく **その便の最終停留所** を使う。現行 [finishService.js](../backend/src/services/finishService.js) は路線×方向の終点を決め打ちしていたため、途中止まりの便を正しく終了できなかった。

### 6.3 再割り当て（§10.2〜§10.4・§11）

```
reassignOrphanTrips():
  targets = daily_trips
            WHERE assignment_state = 'assigned'
              AND 担当割り当てが state='ended'
  for trip in targets:
     pool = trip_vehicle_assignments
            WHERE daily_trip_id = trip.id
              AND role  = 'candidate'
              AND state = 'active'                        ← 生存している候補のみ
              AND 当該車両が他便の担当(active)でない        ← §10.3
     if pool 空:
         trip.assignment_state = 'unassigned'              ← §10.4
         trip.assigned_vehicle_id = NULL
         archiveTrip(trip, 最後の担当割り当て)             ← 実績を確定
     else:
         新担当 = pool の distance_meters 最小              ← §10.3・§11.1（進行度は見ない）
         新担当.role = 'assigned'; became_assigned_at = now()
         trip.assigned_vehicle_id = 新担当.vehicle_id
```

再割り当て候補は**始発時刻時点で記録した候補行のみ**で、始発時刻後に近づいてきた車両は追加しない（§10.2）。判定に使う「100m以内・路線一致・direction条件」は始発時刻時点の観測値（`distance_meters`）として凍結済みなので、再評価は「他便の担当でないか」と「候補割り当てがまだ生きているか」の2点だけになる。

> **設計判断（仕様書に明記のない部分）**：`state='active'` の候補に限定する。仕様書 §10.3 は生存条件を明示していないが、GPSが途絶した車両や既に終点に達した車両を担当に昇格させても、リアルタイム情報を提供できず即座に再び終了判定されるだけであるため。候補の生存判定には §6.2 の条件④（GPS更新停止）が効く。

**§11 の実績引き継ぎは処理不要**。新担当となった候補車両の `trip_stop_progress` は、始発時刻からその便に紐づけて記録されてきたものであり、昇格した瞬間からそれが便の実績として参照される。旧担当の実績とマージしない＝§11.1 が禁じる「進行度の大きい方を採用」が構造的に起こり得ない。

### 6.4 アーカイブとETA学習データ（§18.3への回答）

便がクローズされる（担当なしが確定する、または担当が最終停留所に到達する）時点で、`completed_trips` へ保存する。

```
archiveTrip(trip):
  official   = 最後に担当だった割り当て（存在すれば）
  others     = それ以外の候補割り当て
  official が存在 → completed_trips(is_official = TRUE)  を1件
  others         → completed_trips(is_official = FALSE) を必要に応じて保存（監査用）
```

`updateSegmentStats()`（[etaPredictor.js](../backend/src/services/etaPredictor.js)）の集計対象クエリに **`AND is_official = TRUE`** を1条件加える。変更はこの1行のみ。

この方針の根拠：

- 1便につき official は必ず1件なので、**区間統計の二重計上が起こらない**。A（8:00〜8:03担当）→B（8:03〜終点担当）と切り替わった場合、B の記録は 8:00 から終点まで連続しているため、official として B だけを採るのが最も自然かつ欠損がない
- 候補止まりの車両は「たまたま近くにいて別の経路を走っていた」可能性があり（§11.1 が警戒しているケースそのもの）、学習データに混ぜると区間統計を汚染する
- `segment_travel_stats` のスキーマ・移動平均ロジック・`day_type`／`hour_bucket` のバケット分けは一切変更しない（§16.1）

担当が一度も付かなかった便（`unassigned`）は `completed_trips` を作らない（学習すべき実績が存在しない）。

---

## 7. 利用者向けデータ（§15）

### 7.1 予測モジュール

`predictArrivals(client, vehicleId)` → `predictArrivals(client, assignmentId)` に変更。内部クエリの `vehicle_stop_status WHERE vehicle_id` を `trip_stop_progress WHERE assignment_id` に置き換えるだけで、**予測アルゴリズム（liveFactor・historical・schedule_paced・naive_anchored・through_skip・早発防止の床打ち）は完全に据え置く**（§16.1）。README §5 の判定表もそのまま有効。

### 7.2 API

| エンドポイント | 変更内容 |
|---|---|
| `GET /api/buses` | 列挙対象を `vehicles` から **`daily_trips`（当日・`assignment_state='assigned'`・未クローズ）** に変更。各便について担当割り当ての進捗と `predictArrivals(assignmentId)` を返す。候補車両は返さない（§9.1）。レスポンスに `tripId` / `startTime` を追加し、`tripType`（臨時便）を削除 |
| `GET /api/timetable` | `schedule_trips` ベースから **`daily_trips` ベース**に変更。これにより frequencies 由来の仮想便が時刻表にも自然に現れる |
| `GET /api/route-search` | 下記 `routeSearch.js` の変更に追随（インタフェース変更なし） |
| `GET /api/buses-for-map` | 「担当車両のみ表示」（§15）に合わせ、担当割り当てを持つ車両に限定する |
| `PUT /api/admin/route-mappings` | `directionMapping` の受け渡しを削除（§6.1） |

`GET /api/buses` の `allGps=true`（管理・地図デバッグ用）は、車両単位の生の位置を見るための経路として残す。

### 7.3 ルート検索（[routeSearch.js](../backend/src/services/routeSearch.js)）

- `getRealtimeCandidates()`：走査対象を `vehicles`（`departure_time` あり・臨時便でない）から「**担当割り当てを持つ当日の `daily_trips`**」に変更
- `getTimetableCandidates()`：現行は「activeな車両が持つ `trip_id`」を除外している。これを「**担当割り当てを持つ `daily_trip`**」の除外に置き換える。結果として、担当車両不在の便（`pending` / `unassigned`）は自動的に時刻表候補として残り、§10.4・§15 の「便は時刻表としてルート検索結果に表示し続ける」が満たされる
- 参照する定刻は `schedule_stop_times` ではなく `daily_trip_stop_times`（frequencies のオフセット適用済み）

### 7.4 フロントエンド（[app.js](../frontend/app.js)）

- `bus.tripType === '臨時便'` のバッジ表示（424〜425行付近）を削除（§12）
- `isRealtime` の意味を「出発検知済み」から「担当車両あり」に読み替える。API側で `isRealtime: true` を担当ありの便にのみ返すので、表示ロジックの変更は最小限
- 時刻表画面は `/api/timetable` の戻り値をそのまま使うため、仮想便対応のための変更は不要

---

## 8. パイプライン構成

```
                        ┌ 深夜帯スキップの対象外にする（05:40発の便があるため）
updateAllGtfsFeeds()  ⓪ │ GTFS ZIP更新（既存どおり独自try/catch）
ensureDailyTrips()     ③ ┤ 当日便の生成（生成済みなら即リターン）
fetchLocation()        ① │ 位置情報の取得 → vehicle_positions_raw
sortCarId()            ② │ 車両別ログへ振り分け・車両の新規登録
assignPendingTrips()   ④ ┘ 始発時刻が来た便への担当・候補の割り当て
reassignOrphanTrips()  ⑤   担当が終了した便の再割り当て
pass()                 ⑥   通過判定・欠落補完（全 active 割り当て）
delayCalc()            ⑦   遅延計算（全 active 割り当て）
```

- 廃止：`startBusiness()`・`departure()`・`planMaking()`・`specialBus()`
- `finishTrips()` は従来どおり **1分間隔の独立タイマー**。`ended` にするところまでを担当し、再割り当ては次のパイプラインの ⑤ が拾う（責務分離。`specialBus()` が `finishTrips()` を直接呼んでいたような相互呼び出しを作らない）
- ⑤ を ④ の直後に置くのは、再割り当て後すぐに ⑥⑦ でその便の通過判定・遅延計算が走るようにするため
- [scheduler.js](../backend/src/jobs/scheduler.js) のログ文言「終了判定: 1分間隔」はコードと一致しているので変更不要（README・CLAUDE.md 記載の「10分と表示される」箇所は本ファイルには無い）

---

## 9. 環境変数の追加・廃止

### 追加

| 変数名 | 既定値 | 用途 |
|---|---|---|
| `ASSIGN_RADIUS_METERS` | `100` | 候補車両判定の半径（§5-4） |
| `ASSIGN_GPS_WINDOW_MIN` | `3` | 始発時刻から遡るGPS探索幅（§4.2） |
| `ASSIGN_DELAY_SEC` | `60` | 始発時刻から何秒後に割り当て判定を行うか（§4.4） |
| `DAILY_TRIP_RETENTION_DAYS` | `7` | `daily_trips` 等の保持日数 |
| `GPS_LOG_RETENTION_HOURS` | `48` | `vehicle_gps_log` の保持時間（車両行を消さなくなるため必要） |

### 廃止

`START_AREA_RADIUS_METERS`、`DEPARTURE_OFFSET_METERS`、`SCHEDULE_MATCH_BEFORE_MIN`、`SCHEDULE_MATCH_AFTER_MIN`、`TIMETABLE_MATCH_TIMEOUT_MIN`（いずれも営業開始・出発・時刻表照合の廃止に伴う）。

### 維持

`STOP_RADIUS_METERS`、`END_AREA_RADIUS_METERS`、`VEHICLE_MAX_AGE_MIN`、`FINISH_PROTECTION_MIN`、`GPS_FRESHNESS_MIN`、`ETA_BLEND_WEIGHT`、`POLL_INTERVAL_SECONDS`、`GTFS_UPDATE_INTERVAL_MIN`、`NIGHT_START`/`NIGHT_END`。

---

## 10. 移行手順

一度に切り替えず、既存の運行を止めないステップに分ける。

| 段階 | 内容 | 挙動の変化 |
|---|---|---|
| 1 | スキーマ追加（新テーブル・`gtfs_trip_id`・`is_official` 等）、`seed.js` で `gtfs_trip_id`・`frequencies` を投入、`gtfsFeedManager` の任意ファイル対応 | なし（データが増えるだけ） |
| 2 | `dailyTripBuilder` を導入し**生成のみ**実行。管理画面やログで生成結果（便数・始発時刻・仮想便展開）を検証 | なし（誰も `daily_trips` を読まない） |
| 3 | `tripAssignment` を導入、`pass`/`delayCalc`/`finishService` を割り当て単位へ切り替え、旧4サービスをパイプラインから外す | **本切り替え**。旧 `vehicle_stop_status` への書き込みが止まる |
| 4 | API・フロントエンドを便起点へ切り替え | 利用者向け表示が担当車両ベースになる |
| 5 | 旧サービスファイル・`vehicle_stop_status`・未使用列の削除 | なし（クリーンアップ） |

段階3と4の間はデータ的に不整合な状態になるため、両者は同一リリースに含めるのが望ましい。

---

## 11. リスクと要確認事項

1. **深夜帯スキップ（05:45）と最早便（05:40）の衝突** — §3.5 の通り、当日便生成と割り当てを深夜帯スキップの対象外にする必要がある。現行方式でも取りこぼしていた既存問題だが、便起点にすると影響が明確化する。
2. **`frequencies.txt` を必須ファイルにしてはならない** — 現在有効な2フィードとも同ファイルを持たないため、必須化するとGTFS更新が全滅する（§3.4）。
3. **`stops` の `seq_order` が路線×方向で共有されている既存の脆さ** — [seed.js](../backend/src/db/seed.js) は `stop_sequence − 1` を `seq_order` として `UNIQUE (route_id, direction_id, seq_order)` に載せるため、同一路線内で停車パターンの異なる便があると同じ `seq_order` に別のバス停が入り込む余地がある。本変更で悪化はしない（むしろ便ごとの停車パターンで進捗を作るぶん改善する）が、根本解決は別課題として残る。
4. **24時以降の便** — `start_at`（TIMESTAMPTZ）を持たせることで割り当て判定は正しく行えるが、`"H:mm"` 表示と `computeDelayMinutes()` は従来どおりの制約を引きずる。深夜帯停止（23:00〜05:45）と併せ、実質的に対象外である点は変わらない。
5. **候補車両の計算コスト** — 1台が複数便の候補になるため `pass()` の処理量が候補数に比例して増える。当日便数百・車両数十の規模では問題にならない想定だが、候補割り当てにも `VEHICLE_MAX_AGE_MIN` による終了（§6.2 条件③）が効くため無制限には増えない。
6. **`assignment_state` の遷移が一方通行である前提** — §10.2 が始発時刻後の候補追加を禁じているため `unassigned → assigned` は起こらない。将来この方針が変わる場合は状態遷移の見直しが必要。
7. **§8.1 の「10分以内」は仕様書どおり実装した** — §4.5 の通り。DB制約ではなくアプリケーション判定なので、割り当て処理を並列化する場合は競合に注意すること（現状はパイプラインが直列実行なので問題ない）。
8. **候補割り当ての生存条件** — §6.3 の設計判断（`state='active'` の候補のみを再割り当て対象にする）は仕様書に明記がない補完箇所。

---

## 12. 仕様書の各項と設計の対応表

| 仕様 | 対応箇所 |
|---|---|
| §3 当日の便生成 | §3（`dailyTripBuilder` / `daily_trips`） |
| §3.2 運行日判定 | 既存 `gtfsCalendar.getActiveServiceIds()` をそのまま利用 |
| §3.4 frequencies.txt | §3.4（`schedule_trip_frequencies` → `daily_trips` 展開、`daily_trip_stop_times` にオフセット焼き込み） |
| §4.1〜4.2 割り当てタイミング・GPS窓 | §4.1・§4.2・§4.4 |
| §4.3 始発時刻の定義 | §3.2（既存 seed の `departure_time \|\| arrival_time` が既に充足） |
| §5 候補車両の条件 | §4.2 の条件表 |
| §5.1 路線判定 | §4.2（`vehicles.route_id` = qualified route id） |
| §6 direction_id | §5（`config/directionMapping.js`） |
| §7 最初の担当車両 | §4.1（距離昇順の先頭） |
| §8 重複割り当て防止 | §4.1（処理順）＋§4.5（同時刻帯10分ルール） |
| §9 候補車両の運行処理 | §6.1（担当・候補を区別せず全 active 割り当てを処理） |
| §10 再割り当て | §6.2・§6.3 |
| §10.4/§10.5 担当不在時 | `assignment_state='unassigned'`、§7.3（時刻表候補として残る） |
| §11・§11.1 実績の引き継ぎ | §0・§6.3（進捗が (便×車両) 単位のため引き継ぎ処理が不要） |
| §12 臨時便判定の廃止 | `specialBus.js` 廃止、`trip_type` 参照停止 |
| §13 営業開始・出発判定の廃止 | `businessStart.js` / `departure.js` / `planMaking.js` 廃止 |
| §14 通過判定・遅延計算の維持 | §6.1（`lastValidSeq` ルール・循環線対策を厳守） |
| §15 利用者向けデータ | §7 |
| §16.1 維持するもの | ETA・`finishService`・`segment_travel_stats`・qualified route id いずれも維持 |
| §18.2 候補車両のDB管理 | §1.1（`trip_vehicle_assignments` + `trip_stop_progress`） |
| §18.3 ETA学習データとの接続 | §6.4（`is_official` による official 1件のみ集計） |
| §19 一貫した状態管理 | §0（便を中心とした状態機械：`assignment_state` × `role` × `state`） |
