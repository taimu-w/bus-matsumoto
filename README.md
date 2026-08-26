# バスリアルタイム運行管理システム

松本市内の路線バス（ぐるっと松本バス・アルピコ交通・松本市営など）向けの、GPSベースのリアルタイム運行管理・遅延計算・到着時刻予測システムです。複数事業者の位置情報フィードと複数のGTFSフィードを自動で取り込み、**複数路線**のリアルタイム運行状況を一元管理します。

もともと Google Apps Script (GAS) + スプレッドシートで作られていた運行管理の仕組みを、Node.js + PostgreSQL に移植したものです。ソースコード中のコメントに「GASの◯◯()に相当」という記述が残っている箇所があるのはそのためで、旧システムとの対応関係を追うヒントになります。

このドキュメントは、システム全体の見取り図（何が・どの順で・何をするか）を把握するためのものです。各機能の詳細アルゴリズム・DB設計・API仕様は[docs/](docs/)以下に分けてあります。大きめの変更を行う前に、関連するdocsと[CLAUDE.md](CLAUDE.md)（開発ルール・現在の設計上の注意点）を必ず読んでください。

---

## 1. システム全体の仕組み（1分でわかる概要）

1. **GTFSフィードの自動更新**: `backend/src/config/feeds.js`に定義されたGTFS ZIPフィードを定期的にダウンロード・展開し、バス停・時刻表・運行日カレンダーのマスタデータを最新に保つ。
2. **当日の運行便を先に生成する**: GTFSの運行日カレンダーに基づき、その日運行する便をあらかじめすべてDBへ展開する（`frequencies.txt`による頻度ベース運行の仮想便も含む）。この時点では担当車両を持たない。
3. 複数の位置情報フィード（事業者ごとのCSV）からGPS位置情報を定期的に取得し、`config/feeds.js`に明記された位置情報フィード⇔GTFSフィードの対応と、`route_external_ids`テーブル（DB、管理画面から編集可）の外部ID⇔route_id対応に基づいて路線を特定する。
4. **便の始発時刻になった時点で車両を割り当てる**: 始発時刻直前のGPSを見て、始発バス停から100m以内にいる車両を候補にし、最も近い車両を担当車両とする。残りも候補車両として保持する。
5. 担当車両・候補車両の両方について、GPSの軌跡から「バス停通過」「運行終了」を検知し、定刻と実績を比較して遅延を計算する。
6. 過去の走行実績（区間ごとの所要時間統計）を使って、まだ到着していない先のバス停の**到着予測時刻**を算出する。
7. 担当車両が運行終了したら、始発時刻時点の候補車両から再割り当てする。候補車両がそれまでに記録した実績は、そのままその便の実績になる。
8. これらの情報をフロントエンド（利用者向け画面・管理画面）にAPI経由で配信する。**利用者に見せるのは担当車両だけ**で、候補車両は内部処理にとどめる。
9. 運行終了した便は統計データとしてアーカイブし、次の予測精度向上に使う。

この一連の処理が**`backend/src/jobs/pipeline.js`**に定義された順序で、一定間隔（既定60秒）ごとに繰り返し実行されます。

> かつては逆方向、つまり「GPSから営業開始・出発を検知し、出発時刻から時刻表上の便を逆引きする」方式でした。2026年8月に「GTFS便を先に生成し、車両を後から割り当てる」方式へ全面的に置き換えています。設計の背景は[docs/design-trip-first-assignment.md](docs/design-trip-first-assignment.md)を参照してください。

---

## 2. ディレクトリ構成

```
bussystem/
├── backend/                      Node.js (Express) バックエンド
│   ├── src/
│   │   ├── server.js             Expressサーバー起動、静的ファイル配信
│   │   ├── db/
│   │   │   ├── schema.sql        テーブル定義（DDL）
│   │   │   ├── migrate.js        スキーマ差分マイグレーション
│   │   │   └── seed.js           GTFSファイルからマスタデータを投入
│   │   ├── jobs/
│   │   │   ├── pipeline.js       ★メイン処理チェーンの実行順序を定義
│   │   │   └── scheduler.js      setIntervalによる定期実行の管理
│   │   ├── config/                路線・フィード対応などコード管理の設定
│   │   ├── services/             ★業務ロジック本体（4章に一覧）
│   │   ├── routes/
│   │   │   └── api.js            REST APIエンドポイント一覧（docs/api-reference.md）
│   │   └── utils/                 時刻・距離・CSV・かな変換などの共通ヘルパー
│   ├── test/                     回帰テスト（node --test）
│   ├── docker-entrypoint.sh      コンテナ起動時にmigrate→seed→serverを実行
│   └── package.json
├── data gtfs/                    GTFS標準形式のマスタデータ（フィードIDごとのディレクトリ）
├── frontend/                     素のHTML/CSS/JS（利用者向け画面・管理画面。ビルドステップなし）
├── docs/                         詳細設計資料（一覧は12章）
├── Dockerfile / docker-compose.yml
└── .env.example                  環境変数のサンプル
```

---

## 3. 全体データフロー（パイプライン）

`backend/src/jobs/scheduler.js`が3つのタイマーを管理しています。

| タイマー | 間隔 | 実行内容 |
|---|---|---|
| メインパイプライン | `POLL_INTERVAL_SECONDS`（既定60秒） | `pipeline.js`の`runPipeline()` |
| 運行終了バッチ | 1分 | `finishService.js`の`finishTrips()`（深夜帯は停止） |
| データ掃除 | 1時間 | 古いGPSログ・古い当日便の削除 |

`runPipeline()`（`jobs/pipeline.js`）は、以下の順序で各サービスを**必ずこの順番で**直列実行します。前段の処理結果（DBの状態）を次の処理が前提にしているため、順序を変えると壊れます。

```
updateAllGtfsFeeds()  … ⓪ GTFS ZIPフィードの自動更新（失敗してもパイプライン全体は継続）
   ↓
ensureDailyTrips()    … ① 当日の運行便を生成（生成済みなら即リターン）
   ↓                        ※ ⓪① は深夜帯でもスキップしない
fetchLocation()       … ② 全位置情報フィードを取得しDBに追記
   ↓
sortCarId()           … ③ 車両ごとの走行ログに振り分け（新規車両の登録も含む）
   ↓
assignPendingTrips()  … ④ 始発時刻が来た便に担当車両・候補車両を割り当て
   ↓
reassignOrphanTrips() … ⑤ 担当車両が終了した便の再割り当て
   ↓
pass()                … ⑥ GPSとバス停座標の突合による通過判定、欠落区間の補完
   ↓
delayCalc()           … ⑦ 定刻と実績の差分から遅延分数を算出
   ↓
computeAndStoreAllArrivals() … ⑧ 全active割り当ての到着予測を一括計算し trip_arrival_predictions へ保存
```

⑥⑦⑧は**担当車両・候補車両を区別せず、有効な割り当てすべて**に対して行われます。

⓪①を深夜帯（既定23:00〜05:00）でもスキップしないのは、最も早い便が**5:40発**で、深夜帯が明ける前に始発時刻が来るためです。ここを止めると当日便が未生成のまま始発時刻を過ぎてしまいます。

これとは別に、`finishTrips()`が独立して動き（1分間隔）、運行終了条件を満たした**割り当て**を終了させます。詳細は[docs/trip-lifecycle.md](docs/trip-lifecycle.md)を参照してください。

---

## 4. 主要サービスの責務一覧（`backend/src/services/`）

| ファイル | 責務 | 詳細 |
|---|---|---|
| `gtfsFeedManager.js` | GTFS ZIPフィードの自動ダウンロード・展開（パイプライン⓪）。route_idのフィードプレフィックス操作（`qualifyRouteId`/`unqualifyRouteId`）も提供 | |
| `gtfsFrequencies.js` | `frequencies.txt`の読み込み・仮想便展開 | |
| `dailyTripBuilder.js` | 当日の運行便の生成（①）。既に車両を割り当て済みの便は書き換えない | |
| `locationFetcher.js` | 複数位置情報フィードの取得（②）。フィードごとに独立したtry/catch | |
| `vehicleAssigner.js` | 生ログを車両別ログへ振り分け・新規車両登録（③） | |
| `tripAssignment.js` | 便への担当車両・候補車両の割り当て／再割り当て（④⑤） | [docs/vehicle-assignment.md](docs/vehicle-assignment.md) |
| `passDetection.js` | バス停通過判定・欠落補完（⑥） | [docs/pass-detection.md](docs/pass-detection.md) |
| `delayCalc.js` | 定刻と実績の差から遅延分数を算出（⑦） | [docs/pass-detection.md](docs/pass-detection.md)（通過ステータス確定との関係） |
| `etaPredictor.js` | 到着予測の計算・保存（⑧）。過去統計＋直近ペースを組み合わせる | [docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md)・[docs/design-eta-precompute.md](docs/design-eta-precompute.md) |
| `finishService.js` | 運行終了判定・便のクローズ・アーカイブ | [docs/trip-lifecycle.md](docs/trip-lifecycle.md) |
| `gtfsCalendar.js` | GTFSカレンダー（`calendar.txt`/`calendar_dates.txt`）に基づく当日便生成用の運行日判定 | |
| `gtfsData.js` | route_id解決（`resolveRouteId`）の唯一の窓口 | |
| `gtfsTimetable.js` | 時刻表検索のインメモリインデックス | [docs/timetable-search.md](docs/timetable-search.md) |
| `gtfsRouteSearch.js` | 経路検索エンジン（RAPTOR型。出発時刻指定と到着時刻指定の両方、詳細設定による条件の絞り込み） | [docs/経路検索機能_改善仕様書.md](docs/経路検索機能_改善仕様書.md) |
| `gtfsFare.js` | 運賃データ（`fare_attributes.txt`/`fare_rules.txt`）の索引と照会 | |
| `realtimeTripLookup.js` | GTFS識別子⇔当日の運行実績の橋渡し（経路検索・バス停検索が共通で使う） | |
| `busStopApproaching.js` | バス停検索の「接近中のバス」 | |
| `routeSearch.js` | `/api/stops/search`専用のDBバス停名検索のみ。**ここへ経路探索を戻さないこと** | |
| `holidayCalendar.js` | 祝日カレンダー（`holidays`テーブル）のキャッシュ | |
| `routeExternalIdMapping.js` | 外部ID⇔route_id対応（`route_external_ids`テーブル）のキャッシュ。管理画面編集時に即時破棄 | |
| `touristSpots.js` | 観光スポット情報の管理・近接検索 | |
| `predictionAccuracy.js` / `apiMetrics.js` / `jobMonitor.js` / `visitorTracker.js` / `serviceStatusScraper.js` | 管理画面向けの監視・集計系（予測精度・API稼働・ジョブ実行状況・閲覧数・運行状況スクレイピング） | |

`backend/src/utils/time.js`と`utils/geo.js`は、ほぼすべてのサービスで使われる共通ヘルパー（時刻文字列の変換、遅延計算、ハバーサイン距離）です。`utils/csv.js`はGTFSのCSV読み込み、`utils/kana.js`はかな⇔ローマ字変換・検索正規化を担います。

### 複数フィード対応の設計

**フィード構成（URL・有効/無効・位置情報フィード⇔GTFSフィードの対応）はコード（`backend/src/config/feeds.js`）で管理し、`feeds`テーブルは稼働状態（`last_fetched_at`/`last_status`/`last_error`）の記録のみを担います。** 一方、**外部ID⇔GTFS route_idの対応は`route_external_ids`テーブル（DB）で管理し、管理画面「外部IDマッピング」から編集できます。** 設計背景・過去の問題点と、外部ID対応だけDB管理へ戻した経緯は[docs/外部IDマッピングのコード化_仕様書.md](docs/外部IDマッピングのコード化_仕様書.md)を参照してください。フィード構成の追加・変更はコード側を編集してデプロイします（管理画面からは編集できません）。

---

## 5. `utils/` — 共通ユーティリティ

| モジュール | 役割 |
|---|---|
| `utils/time.js` | JST基準の時刻取得・変換、深夜帯判定（`isNightTime()`）、遅延分数算出（`computeDelayMinutes()`）、曜日区分判定（`getDayType()`。ETA統計専用） |
| `utils/geo.js` | `haversineDistanceMeters()`（2点間の距離。GPS座標とバス停座標の距離判定に全編で使われる） |
| `utils/csv.js` | GTFSのCSV読み込み（BOM除去・任意ファイル対応） |
| `utils/kana.js` | かな⇔カタカナ⇔ローマ字（ヘボン式）変換・検索正規化 |

**曜日区分・運行日判定のロジックは用途ごとに3つ独立しています。統合しないでください。** `utils/time.js`の`getDayType()`（ETA統計のバケット分け専用）、`gtfsCalendar.js`の`getActiveServiceIds()`（当日便生成専用）、`gtfsTimetable.js`の`getActiveServices()`（時刻表検索専用）。

---

## 6. データベース・API

- DBスキーマ（テーブル一覧・役割・未使用列）: [docs/database.md](docs/database.md)
- APIエンドポイント一覧: [docs/api-reference.md](docs/api-reference.md)

代表的な公開エンドポイントだけ挙げると、`GET /api/buses`（担当車両のリアルタイム運行状況＋到着予測）・`GET /api/timetable`（本日の時刻表）・`GET /api/route-search`（経路検索。詳細設定 `maxTransfers`/`allowWalkTransfer`/`minTransferMinutes` は任意で、未指定なら従来どおりの条件）・`GET /api/routes`（路線一覧）です。管理系（`/api/admin/...`）はBasic認証（`ADMIN_USERNAME`/`ADMIN_PASSWORD`）で保護されています。

---

## 7. フロントエンド概要

素のHTML/CSS/JS、ビルドステップなし。

- `frontend/index.html` + `frontend/app.js`: 利用者向け運行状況画面。`POLL_MS`（20秒）間隔で`/api/buses`等をポーリング、お気に入りはlocalStorage、SPAルーティングの入口。バスマップ（`#/busmap`、Leaflet + OpenStreetMap）も含む。
- `frontend/timetable.js`（時刻表検索）・`frontend/busstop.js`（バス停検索）・`frontend/stopmap.js`（バス停マップ）・`frontend/routesearch.js`（経路検索）は、いずれもハッシュではなくパス（History API）でルーティングします。経路検索は「経路一覧（`/routesearch?…`）→ 経路詳細（`…&journey=N`）」の2階層で、乗り換え時刻や通過バス停は詳細側に表示します（[docs/経路検索機能_改善仕様書.md](docs/経路検索機能_改善仕様書.md) 6.3）。検索フォームには折りたたみの「詳細設定」があり、乗り換え回数（「乗り換えなし」など）・徒歩での乗り継ぎの有無・乗り換えの余裕時間を指定できます。**既定は従来どおりの条件**で、既定値の項目はURLにも載せません（同 5.8・6.2）。
- `frontend/admin.html`: Basic認証で保護された管理画面（運行ダッシュボード・便の割当監視・通過判定・異常アラート・GTFS/位置情報フィード監視・API稼働監視・ジョブ監視・お知らせ編集・祝日カレンダー・外部IDマッピング・観光スポット編集・直近車両位置）。
- `frontend/style.css`: 共通スタイル。

> **`index.html`の静的ファイル参照は必ず絶対パス（`/app.js`など）にすること。** 時刻表検索は`/timetable/stops/{stop_id}`のような階層のあるURLを使うため、相対パスだと`/timetable/stops/app.js`を読みに行き、サーバーのSPAフォールバックがindex.htmlを返してスクリプトが一切動かなくなります（実際に踏んだ）。

---

## 8. 環境変数一覧

| 変数名 | 既定値 | 用途 |
|---|---|---|
| `PORT` | `3000` | HTTPサーバーのポート |
| `DATABASE_URL` | - | PostgreSQL接続文字列（Render等ホスティング用。指定時はSSL接続） |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | localhost等 | `DATABASE_URL`未指定時のローカル接続情報 |
| `POLL_INTERVAL_SECONDS`※再起動要 | `60` | メインパイプラインの実行間隔（秒） |
| `GTFS_UPDATE_INTERVAL_MIN`※ | `60` | GTFSフィードの自動更新間隔（分）。0以下なら毎回更新 |
| `GPS_FRESHNESS_MIN`※ | `15` | GPSデータを「新しい」とみなす分数 |
| `ASSIGN_RADIUS_METERS`※ | `100` | 候補車両とみなす、始発バス停からの距離（m） |
| `ASSIGN_GPS_WINDOW_MIN`※ | `3` | 始発時刻から何分前まで遡ってGPSを探すか（始発時刻との閉区間） |
| `ASSIGN_DELAY_SEC`※ | `60` | 始発時刻から何秒待ってから割り当て判定を行うか（フィード配信遅れの吸収） |
| `ASSIGN_SAME_PERIOD_MIN`※ | `10` | 「同時刻帯」とみなす始発時刻の差（分）。この範囲では同じ車両を担当車両として重複させない |
| `STOP_RADIUS_METERS`※ | `120` | バス停通過判定（「付近」入り）の半径（m） |
| `DEPARTURE_MARGIN_METERS`※ | `20` | 2段階到着判定における到着確定の離脱マージン（m）。「付近」状態のバス停から、記録済み最小距離＋この距離だけ離れたことを検知した時点で「到着済」に確定する（[pass-detection.md](docs/pass-detection.md)） |
| `END_AREA_RADIUS_METERS`※ | `150` | 終了エリア判定の半径（m） |
| `GPS_TIMEOUT_TERMINAL_RADIUS_METERS`※ | `300` | GPS途絶時、未到達バス停が終点のみ残っている場合の「終点到着」救済判定の半径（m） |
| `GPS_STALE_TIMEOUT_MIN`※ | `3` | GPSがこの時間（分）以上更新されていない車両を「GPS途絶」とみなす（点検所見 H-2） |
| `VEHICLE_MAX_AGE_MIN`※ | `120` | 割り当ての強制終了までの経過時間（分） |
| `FINISH_PROTECTION_MIN`※ | `10` | 運行終了判定を開始しない保護期間（分） |
| `DAILY_TRIP_RETENTION_DAYS`※ | `7` | 当日便（`daily_trips`）の保持日数 |
| `GPS_LOG_RETENTION_HOURS`※ | `48` | GPSログの保持時間（車両行を削除しなくなったため必要） |
| `ETA_BLEND_WEIGHT`※ | `0.55` | ETA予測における過去統計への信頼度（0〜1） |
| `NIGHT_START` / `NIGHT_END`※ | `23:00` / `05:00` | 深夜帯の範囲。**当日便の生成と車両割り当てはこの時間帯でも動く**（最早便が5:40発のため） |
| `HIGH_LOAD_VIEWER_THRESHOLD`※ | `50` | サーバー高負荷とみなす同時アクティブ閲覧数 |
| `ADMIN_STALE_GPS_MIN` / `ADMIN_DELAY_ALERT_MIN` / `ADMIN_SEVERE_DELAY_MIN` / `ADMIN_UNASSIGNED_OVERDUE_MIN` / `ADMIN_ETA_STALE_MIN`※ | `5` / `5` / `15` / `5` / `10` | 管理画面ダッシュボード・アラート表示のしきい値（分） |
| `SERVICE_STATUS_POLL_INTERVAL_MIN`※再起動要 | `60` | アルピコ運行状況スクレイピングの間隔（分） |
| `ALPICO_STATUS_URL` | - | アルピコ交通「現在の運行状況」ページのURL |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin123` | 管理画面のBasic認証情報 |
| `YAHOO_CLIENT_ID` | - | 管理画面の住所逆引き（Yahoo!リバースジオコーダ）用APIキー |

> ※印の項目は、環境変数に加えて**管理画面「運用パラメータ設定」**（`GET/PUT/DELETE /api/admin/runtime-settings`）からも編集できます。優先順位は「管理画面での上書き値(DB) > 環境変数 > コード既定値」で、管理画面で編集しなければこれまでどおり環境変数（未設定ならコード既定値）だけで動きます。定義一覧は[backend/src/config/runtimeSettingsCatalog.js](backend/src/config/runtimeSettingsCatalog.js)。「再起動要」の2項目（ポーリング間隔）は`setInterval`の間隔として起動時にしか読まれないため、管理画面で変更してもサーバー再起動まで反映されません。それ以外は次回のパイプライン実行（既定60秒間隔）までに反映されます。
>
> 位置情報CSVやGTFS ZIPのURL、および位置情報フィード⇔GTFSフィードの対応は、環境変数でもDBでもなく**`backend/src/config/feeds.js`（コード）**で管理されます。変更にはデプロイが必要です（管理画面からは編集できません）。一方、**外部ID⇔route_idの対応は`route_external_ids`テーブル（DB）**で管理され、管理画面「外部IDマッピング」から編集できます。

---

## 9. セットアップ・起動方法

### Dockerで起動する場合（推奨）

```bash
docker compose up --build
```

`docker-entrypoint.sh`が起動時に自動で以下を行います：DB接続待機 → `migrate.js`（スキーマ適用）→ `seed.js`（GTFSマスタデータ投入）→ `server.js`起動。`http://localhost:3000` で利用者向け画面、`http://localhost:3000/admin` で管理画面にアクセスできます。`docker-compose.yml`にはPostgreSQL（dbサービス）も含まれています。

### ローカルで直接起動する場合

```bash
cd backend
npm install
npm run setup     # migrate.js → seed.js を実行
npm start          # または npm run dev（ファイル変更監視）
```

PostgreSQLは別途起動しておき、`.env`（または環境変数）で接続情報を指定してください。位置情報フィード・GTFSフィードのURLは`backend/src/config/feeds.js`にコードで定義されているため、DBへの登録作業は不要です（`npm run setup`が稼働状態記録用の行を用意します）。

### 開発・検証

```bash
npm test   # backend/test/ の回帰テスト（node --test。DB不要な純粋関数のみ対象）
```

---

## 10. 既知の注意点・改善余地

コードを読み解く上で把握しておくと良い、現状のクセや注意点をまとめます（いずれも致命的なバグではありませんが、改修の際は意識してください）。

- **`frequencies.txt`・`translations.txt`・`fare_attributes.txt`・`fare_rules.txt`を`gtfsFeedManager.js`の`REQUIRED_GTFS_FILES`に足してはいけない**。持たないフィードがあると、必須にした瞬間にGTFS更新が全フィードで「必須ファイル欠損」となり、システム全体が止まる。`OPTIONAL_GTFS_FILES`側に置いてあるのは意図的。
- **「同時刻帯＝始発時刻の差が10分以内」を「稼働中の車両は他の便に割り当てない」に単純化しないこと**。8:00便の担当車両が8:11便の担当になるのは仕様上正しい動作（[docs/vehicle-assignment.md](docs/vehicle-assignment.md)参照）。
- **`vehicles`の未使用列、および`vehicle_stop_status`テーブルは旧・車両起点方式の名残**で削除しないこと（[docs/database.md](docs/database.md)参照）。
- **`stops`は物理バス停（`gtfs_stop_id`）＋通過回数（`occurrence`）で一意化されており、`seq_order`は路線内の表示順専用**（`UNIQUE (route_id, direction_id, gtfs_stop_id, occurrence)`）。便ごとの実際の停車順は`schedule_stop_times.stop_sequence`（便自身の中での0始まりの連番）が正であり、`daily_trip_stop_times`/`trip_stop_progress`/`completed_trip_stop_times`等の`seq_order`列もこれを引き継ぐ。`stops.seq_order`を便の順序判定に使わないこと（かつての設計はservice_idグループ横断で`seq_order`を共有しており、停車パターンの異なる便で順序が壊れる／別のservice_idグループが同じ行を別バス停のデータで上書きする欠陥があった。点検所見 C-1・C-2 で修正済み）。
- **`finishService.closeDailyTrip()`は`reassignOrphanTrips()`（パイプライン⑤）と`finishTrips()`自身（運行日終了の掃除）の2つの独立したタイマーから同じ便に対して同時に呼ばれうる**。冒頭の`SELECT … FOR UPDATE`による行ロックで、後発側は先発側の`COMMIT`後に`closed_at`を確認して即座に抜けるため、実績が二重に`completed_trips`へアーカイブされることはない（安全網として`UNIQUE (daily_trip_id, assignment_id)`制約も追加済み）。同様に`etaPredictor.updateSegmentStats()`も両タイマーから呼ばれるため、対象行の取得を`FOR UPDATE SKIP LOCKED`にし、`segment_travel_stats`への反映も原子的なUPSERTにしてある。この排他制御を外す・弱める変更をしないこと（点検所見 C-5 で修正済み。詳細は[docs/trip-lifecycle.md](docs/trip-lifecycle.md)・[docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md)）。
- **24時以降の便**: `daily_trips.start_at`（TIMESTAMPTZ）では正しく扱えるが、`"H:mm"`表示と`computeDelayMinutes()`は従来どおりの制約を引きずる。深夜帯停止（23:00〜05:00）と併せ、実質的に対象外である点は変わらない。
- **`getDayType()`（`utils/time.js`）と`getActiveServiceIds()`（`gtfsCalendar.js`）は別の曜日区分ロジック**であり、意図的に分離されています。前者はETA統計のバケット分け専用（日曜固定＋`holidays`テーブルによる祝日カレンダー対応）、後者はGTFSの正式なcalendar.txt/calendar_dates.txtに基づくダイヤ選択用です。混同しないよう注意してください。
- **祝日カレンダー（`holidays`テーブル）**: `utils/japaneseHolidays.js`が国民の祝日を年単位で算出する。`seed.js`の`seedHolidays()`は「その年のデータが1件も無い場合だけ」自動投入する設計で、管理画面からの追加・削除を、毎時のGTFS再取得に伴う`seed()`実行で上書きしないようにしている。祝日データを更新した際は`services/holidayCalendar.js`の`invalidateHolidayCache()`でキャッシュ（TTL1時間）を破棄する必要がある。`completed_trips.day_type`は便アーカイブ時点の祝日カレンダーで確定した値をそのまま保存するため、後から祝日を追加・削除しても**過去にアーカイブ済みの統計は遡って再集計されない**点に注意。

---

## 11. テスト

`backend/test/`に、DBやネットワークを必要としない純粋関数の現在の挙動を固定する回帰テストがあります。`npm test`（`backend/`から）で実行します。lint設定は現状ありません。

---

## 12. 詳細ドキュメント一覧（`docs/`）

| ドキュメント | 内容 |
|---|---|
| [docs/design-trip-first-assignment.md](docs/design-trip-first-assignment.md) | 便起点の車両割り当てモデルへの移行背景 |
| [docs/design-eta-precompute.md](docs/design-eta-precompute.md) | ETA予測のプリコンピュート方式への移行背景 |
| [docs/vehicle-assignment.md](docs/vehicle-assignment.md) | 車両割り当ての判定条件・処理順序の詳細 |
| [docs/pass-detection.md](docs/pass-detection.md) | バス停通過判定・欠落補完の詳細 |
| [docs/trip-lifecycle.md](docs/trip-lifecycle.md) | 運行終了判定・便のクローズ・アーカイブの詳細 |
| [docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md) | 到着予測アルゴリズムの詳細 |
| [docs/timetable-search.md](docs/timetable-search.md) | 時刻表検索機能の詳細 |
| [docs/経路検索機能_改善仕様書.md](docs/経路検索機能_改善仕様書.md) | 経路検索エンジンの設計・アルゴリズム詳細 |
| [docs/外部IDマッピングのコード化_仕様書.md](docs/外部IDマッピングのコード化_仕様書.md) | 複数フィード対応・外部ID対応のコード化の背景 |
| [docs/観光スポット情報_仕様書.md](docs/観光スポット情報_仕様書.md) | 観光スポット情報機能の仕様 |
| [docs/database.md](docs/database.md) | DBスキーマのテーブル一覧・役割 |
| [docs/api-reference.md](docs/api-reference.md) | APIエンドポイント一覧 |

開発ルール・現在の設計上の重要な注意点は[CLAUDE.md](CLAUDE.md)にまとめてあります。
