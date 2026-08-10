# CLAUDE.md

このファイルは、このリポジトリで作業するClaude Code（claude.ai/code）向けのガイダンスです。

## 言語方針

- ユーザーへの応答は日本語で行うこと。
- コード中のコメントは日本語を中心に書くこと。
- `README.md`をはじめ、このリポジトリ内で新規作成・更新する`.md`ファイルは日本語を中心に記述すること。

## 概要

松本市内の路線バス（ぐるっと松本バス・アルピコ交通・松本市営など）向けの、GPSベースのSPAウェブアプリケーションです。

複数事業者のGPS位置情報フィードと複数のGTFSフィードを取り込み、GTFS上の便に車両を割り当て、遅延を計算し、到着時刻を予測して、利用者向け運行状況画面と管理画面にAPI経由で配信します。

便への車両割り当ての設計背景は[docs/design-trip-first-assignment.md](docs/design-trip-first-assignment.md)にまとめてあります。

**アーキテクチャ・データフロー・モジュールごとの詳細な挙動は[README.md](README.md)に網羅的にまとめられています。大きめの変更を行う前に必ず読んでください。** なぜ現在の構造になっているのか（うっかり再発させやすい実際のバグへの意図的な回避策を含む）が説明されています（下記の「既知の注意点」も参照）。

## コマンド

すべて`backend/`から実行します。

```bash
npm install
npm run setup      # migrate.js（スキーマ適用）→ seed.js（GTFSマスタデータをDBに投入）
npm start           # node src/server.js
npm run dev          # node --watch src/server.js
npm run db:init      # migrate.jsのみ
npm run db:seed      # seed.jsのみ
```

Docker（PostgreSQLを含む）：

```bash
docker compose up --build
```
`docker-entrypoint.sh`がコンテナ起動のたびに、DB接続待機 → `migrate.js` → `seed.js` → `server.js`起動、を実行します。利用者向け画面：`http://localhost:3000`、管理画面：`http://localhost:3000/admin`。

このリポジトリにはテストスイートもlint設定も存在しません。これらのためのnpmスクリプトを勝手に作らないでください。

PostgreSQL接続は`DATABASE_URL`（ホスティング環境向け、SSL接続前提）または`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`（ローカル向け）で設定します。調整可能な環境変数（判定半径・タイムアウト閾値・ポーリング間隔など）は`backend/.env.example`を参照してください。位置情報フィードやGTFS ZIPフィードのURLは環境変数**ではなく**、`feeds`テーブル・`feed_mappings`テーブル（`db/seed.js`の`DEFAULT_FEEDS`/`DEFAULT_FEED_MAPPINGS`で初期投入）で管理されています。

## アーキテクチャ

### 便を中心としたデータモデル（最重要）

このシステムは**GTFS上の便を先に生成し、始発時刻になった時点で車両を割り当てる**方式です。かつては逆（GPSから営業開始・出発を検知し、出発時刻から便を逆引きする）でしたが、2026年8月に全面的に置き換えました。

中核となる考え方は、**進捗データを「車両単位」ではなく「(便 × 車両) の割り当て単位」で持つ**ことです。

```
daily_trips（当日の便。例：8:00発）
  ├─ trip_vehicle_assignments(role=assigned)  ── 担当車両 ── trip_stop_progress（その車両の通過実績）
  ├─ trip_vehicle_assignments(role=candidate) ── 候補車両 ── trip_stop_progress（その車両の通過実績）
  └─ trip_vehicle_assignments(role=candidate) ── 候補車両 ── trip_stop_progress（その車両の通過実績）
```

- 候補車両にも担当車両と**まったく同じ運行処理**（通過判定・遅延計算）を行います。ただし利用者向けAPIには出しません。
- 担当車両が運行終了したら、始発時刻時点の候補から再割り当てします。候補は最初からその便に紐づけて実績を記録しているため、**担当への昇格は「どの割り当てを正とみなすか」の切り替えだけ**で済み、実績のコピーやマージは一切発生しません。
- 「最も進んでいる車両を採用する」というマージは**やってはいけません**。別経路をたまたま走っていた車両を誤って採用する事故につながります。距離が最も近い候補を採用するルールを守ってください。
- `vehicles`は「観測されている物理車両」を表すだけで、便との紐付けを持ちません。運行終了しても行は削除せず`status='inactive'`にします（1台が複数便の候補になり得るため、削除するとGPSログがCASCADEで消えて他便の処理まで壊れます）。

### パイプライン

`backend/src/jobs/scheduler.js`が3つのタイマーを管理します。メインパイプライン（`POLL_INTERVAL_SECONDS`、既定60秒）、運行終了バッチ（1分間隔）、データ掃除（1時間間隔）です。

`backend/src/jobs/pipeline.js`の`runPipeline()`は、以下のステップを**毎回のポーリングでこの順序のまま直列実行**します。各ステップの結果（DBの状態）を次のステップが前提にしているため、順序を変えると壊れます。

```
updateAllGtfsFeeds()  ⓪ feedsテーブルに基づきGTFS ZIPを更新（独自のtry/catch、失敗しても後続は継続）
ensureDailyTrips()     ① 当日の運行便を生成 → daily_trips / daily_trip_stop_times（生成済みなら即リターン）
fetchLocation()         ② 有効な位置情報フィード全件からGPSを取得 → vehicle_positions_raw
sortCarId()              ③ 生ログを車両ごとのログに振り分け（vehicle_gps_log）、新規車両を登録
assignPendingTrips()      ④ 始発時刻が来た便に担当車両・候補車両を割り当て
reassignOrphanTrips()      ⑤ 担当車両が終了した便の再割り当て
pass()                      ⑥ GPSとバス停座標を突合して通過判定、欠落区間を補完（担当・候補すべて）
delayCalc()                  ⑦ 定刻と実績の差から遅延分数を算出（担当・候補すべて）
computeAndStoreAllArrivals()  ⑧ 全active割り当ての到着予測を一括計算し trip_arrival_predictions へ保存（担当・候補すべて）
```

**⓪①は深夜帯（`isNightTime()`）でもスキップしません。** 最も早い便が5:40発で、深夜帯が明ける前に始発時刻が来るためです（`NIGHT_END`は05:00に設定してあります）。②以降だけが深夜帯にスキップされます。

`finishTrips()`（`services/finishService.js`）は独立した1分間隔のタイマーで動作し、**割り当て単位**で運行終了条件を判定して`state='ended'`にします。便のクローズ（実績確定＋アーカイブ）は`closeDailyTrip()`が担当し、再割り当てできる候補が居なくなった時点、または終点まで走り切った時点で呼ばれます。アーカイブ後に`etaPredictor.js`の`updateSegmentStats()`を呼んでETA予測に使う統計データを育てます。

**到着予測はパイプラインの⑧番目のステップとしてプリコンピュートされます**（2026年8月に、API呼び出しのたびに計算するオンデマンド方式から移行。設計背景は[docs/design-eta-precompute.md](docs/design-eta-precompute.md)）。`etaPredictor.js`の`computeAndStoreAllArrivals()`が`delayCalc()`の直後に呼ばれ、全active割り当て（担当・候補とも）の到着予測を一括計算して`trip_arrival_predictions`テーブルへUPSERTします。計算アルゴリズム本体`predictArrivals(client, assignmentId)`自体は従来のまま変更していません（引数は車両IDではなく**割り当てID**）。`/api/buses`・ルート検索は`getArrivalsForAssignment(client, assignmentId)`で`trip_arrival_predictions`から読み出すだけになり、最大60秒のラグと引き換えにDBスパイクと重複計算を排除しています。48時間以上前の予測は`computeAndStoreAllArrivals()`内で毎回掃除されます。

`backend/src/utils/time.js`と`utils/geo.js`は、ほぼすべてのサービスで使われる共通ヘルパー（時刻文字列の変換、遅延計算、ハバーサイン距離）です。

### 複数フィード対応の設計

GTFSフィード・位置情報フィードのいずれもハードコードではなくDB駆動（`feeds`テーブル）で、複数事業者・複数路線を同時にサポートします。`feed_mappings`は、位置情報フィードがどのGTFSフィードの`route_external_ids`を使って路線を解決すべきかを紐付けます。異なるGTFSフィード間でroute_idをグローバルに一意にするため、プレフィックス方式（`feedId:routeId`）を使っており、`gtfsFeedManager.js`の`qualifyRouteId`/`unqualifyRouteId`が変換を担います。`service_id`（`feedId:service_id`）も同様のパターンです。

### 車両割り当ての判定条件（`services/tripAssignment.js`）

始発時刻（`ASSIGN_DELAY_SEC`＝既定60秒だけ待ってから評価）に、次を満たす車両を候補にします。

1. 便と同じ路線（`vehicles.route_id`はqualified route id なのでGTFS側と直接比較できる）
2. **始発時刻の3分前〜始発時刻（閉区間）** に存在する最新GPS1点。始発時刻を1秒でも過ぎたGPSは無効
3. 始発バス停から`ASSIGN_RADIUS_METERS`（既定100m）以内。通過判定の120mとは別の設定値なので共用しないこと
4. `config/directionMapping.js`のdirection条件。`mode:'ignore'`の路線、および車両側の方向が不明（NULL）の場合は方向で絞り込まない
5. 同時刻帯（始発時刻の差が10分以内）の別便の担当車両になっていない

距離が最も近い車両を担当車両にし、残りも候補車両として記録します。便は始発時刻の早い順に1件ずつ確定させるため、直前の便で担当になった車両は次の便の判定に自動的に反映されます。

### 到着予測（`services/etaPredictor.js`）

過去の区間別走行時間統計（`segment_travel_stats`、曜日区分×時間帯でバケット化）と、その車両直近の走行ペース（`liveFactor`、0.5〜2.5倍にクランプ、直近の完了区間から算出）を組み合わせます。データの有無に応じて段階的にフォールバックします：過去統計+ペース補正 → 時刻表所要時間×ペース補正 → 時刻表差分そのまま → 固定5分。定刻を持たない通過専用の区間は`naive_anchored`で別途処理し、直近の「定刻を持っていた」バス停まで遡って基準点にします。これは固定5分の推測が通過区間の連続で積み重なってしまうのを防ぐためです。完全な判定表（`source`フィールドの値：`schedule`、`actual`、`historical`、`schedule_paced`、`naive`、`through_skip`、`naive_anchored`）はREADME.md §5を参照してください。

### 時刻表検索（`services/gtfsTimetable.js` / `frontend/timetable.js`）

リアルタイム運行状況とは**データ経路が完全に独立した機能**です。DB（`stops`/`schedule_*`）を一切使わず、ディスク上のGTFSファイルをそのままの粒度でメモリにインデックス化します。既存の`stops`テーブルはGTFSの`stop_id`・標柱・`stop_headsign`を保持していないため、時刻表検索の要件を満たせないからです。インデックスは30分TTLで、GTFS更新成功時に`invalidateTimetableIndex()`で無効化されます。詳細はREADME.md §16を参照してください。

- バス停の統合キー：同一ベースID＋同名なら`{stop_id}`、名前が違えば`{gtfs_id}_{stop_id}`。さらに同名かつ400m以内のバス停を1件へ統合し（2フィードに同じ物理バス停が別IDで入っているため）、使われなくなったキーは別名として残します。
- よみがな・ローマ字は`translations.txt`から取得し、ローマ字が無ければ`utils/kana.js`がヘボン式で自動生成します。漢字→よみがなの変換は行いません。
- 画面は**この機能だけHistory API（パス`/timetable...`）でルーティング**します。他画面はハッシュ（`#/realtime`など）のままです。

### フロントエンド

素のHTML/CSS/JS、ビルドステップなし。`frontend/index.html` + `app.js`（利用者向け運行状況画面。20秒間隔で`/api/buses`等をポーリング、お気に入りはlocalStorage、ルート検索・乗換UI）。`frontend/timetable.js`（時刻表検索）。`frontend/admin.html`（Basic認証で保護された管理画面。お知らせ編集、路線IDマッピング、バス停・時刻表編集、住所逆引き付きの直近車両位置）。

## 既知の注意点（理解せずに「修正」しないこと）

- **`frequencies.txt`・`translations.txt`を`gtfsFeedManager.js`の`REQUIRED_GTFS_FILES`に足してはいけません。** 持たないフィードがあると、必須にした瞬間にGTFS更新が全フィードで「必須ファイル欠損」となり、システム全体が止まります。`OPTIONAL_GTFS_FILES`側に置いてあるのは意図的です（`translations.txt`が無い場合の扱いは`gtfsTimetable.js`が吸収します）。
- **`frontend/index.html`の静的ファイル参照は必ず絶対パス（`/app.js`・`/style.css`）にしてください。** 時刻表検索は`/timetable/stops/{stop_id}`のような階層のあるURLを使うため、相対パスだとブラウザが`/timetable/stops/app.js`を取りに行き、サーバーのSPAフォールバックがindex.htmlを返してスクリプトが一切動かなくなります。
- **曜日区分・運行日判定のロジックは用途ごとに3つ独立しています。統合しないでください。** `utils/time.js`の`getDayType()`（ETA統計のバケット分け専用）、`gtfsCalendar.js`の`getActiveServiceIds()`（当日便生成専用。DB保存形式の文字列を返し、有効期間チェックなし）、`gtfsTimetable.js`の`getActiveServices()`（時刻表検索専用。任意の日付・有効期間チェック・表示ラベルあり）。
- **「同時刻帯＝始発時刻の差が10分以内」という重複割り当て防止のルールを、「稼働中の車両は他の便に割り当てない」に単純化しないでください。** 8:00便の担当車両が8:11便の担当になるのは仕様上正しい動作です。判定は`tripAssignment.js`の`hasSamePeriodConflict()`に集約してあります（`ASSIGN_SAME_PERIOD_MIN`、既定10分）。
- **通過バス停の扱い（`tripAssignment.js`の`openAssignment()` / `delayCalc.js`）**：あるバス停が`通過`ステータスに確定されるのは、それが便の中で実質的な終点（`lastValidSeq`、実際に定刻を持つ最後のバス停）より**手前**にある経由フラグ付きバス停の場合のみです。`lastValidSeq`より先にある経由フラグ付きバス停は、単に未確定なだけで通過ではありません。この2つを混同したことが実際の過去のバグの原因でした（README §4.11参照）。`delayCalc.js`は`scheduled_time`が無いことを理由にステータスを強制上書きする処理を意図的に廃止しています。
- **`etaPredictor.js`の`updateSegmentStats()`が`is_official = TRUE`だけを集計するのは意図的です。** 候補車両止まりの記録を混ぜると、別経路をたまたま走っていた車両の所要時間で区間統計が汚染され、担当が切り替わった便では同じ区間を二重計上してしまいます。
- **バスマップ（`#/busmap`）で`/api/buses-for-map`に特定の`routeId`を決め打ちしないでください。** 全路線を俯瞰する画面なので、1路線に固定するとその路線が運行していない時間帯に0台になります（実際にそれで「バスが表示されない」不具合になっていました）。同じ画面で、地図を作り直すときに`busMarkers`/`userMarker`を捨て忘れると2回目以降に描画されなくなる点、現在地取得を`await`してからバスを取得すると許可ダイアログの間バスが出ない点にも注意してください（README §12）。
- **`routes/api.js`**：`PUT /api/admin/route-data`は、`router`が既に`/api`配下にマウントされているため、実際には`/api/api/admin/route-data`になります。フロントエンド側の呼び出しはこれに合わせてあるので動作はしますが、パスが二重になっている点に惑わされないこと。また、破壊的変更になるため黙ってリネームしないこと。
- 上記の3つの曜日区分ロジックについて補足：`getDayType()`は平日/土曜/休日の3区分で、日曜のみholiday扱い（祝日カレンダー非対応）。`getActiveServiceIds()`はGTFSの正式な`calendar.txt`/`calendar_dates.txt`に基づく当日便生成用の運行日判定です。
- **`dailyTripBuilder.js`が「既に車両を割り当て済みの便は書き換えない」ガードを持つのは意図的です。** GTFSは1時間ごとに再取得され、成功すると`seed()`が走ってマスタが入れ替わります。このとき走行中の便の定刻まで書き換えると、遅延計算と実績が破綻します。
- **`vehicles`テーブルの`business_start_time` / `departure_time` / `trip_id` / `trip_type` / `last_arrived_seq` / `delay_minutes`は、旧・車両起点方式の名残で未使用です。** 移行のロールバック余地のために列だけ残してあります。新しいコードから参照しないでください。
- GTFSカレンダーの読み込み（`gtfsCalendar.js`）は、`feeds`テーブル上で有効な各GTFSフィードのディレクトリから読みます。フィード由来のカレンダーは`feedId:service_id`というプレフィックス規約によって機能しており、別のコードパスがあるわけではありません。
