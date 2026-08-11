# バスリアルタイム運行管理システム

松本市内の路線バス（ぐるっと松本バス・アルピコ交通・松本市営など）向けの、GPSベースのリアルタイム運行管理・遅延計算・到着時刻予測システムです。複数事業者の位置情報フィードと複数のGTFSフィードを自動で取り込み、**複数路線**のリアルタイム運行状況を一元管理します。

もともと Google Apps Script (GAS) + スプレッドシートで作られていた運行管理の仕組みを、Node.js + PostgreSQL に移植したものです。ソースコード中のコメントに「GASの◯◯()に相当」という記述が多数残っているのはそのためで、旧システムとの対応関係を追うためのヒントになります。

このドキュメントは、コードが機能ごとに整理されておらず全体像が掴みにくいという課題に対応するため、**「どのファイルが」「何の処理を」「どういう順序で」行っているか**を一通り把握できるようにまとめたものです。

---

## 1. システム全体の仕組み（1分でわかる概要）

1. **GTFSフィードの自動更新**: `backend/src/config/feeds.js`に定義されたGTFS ZIPフィードを定期的にダウンロード・展開し、バス停・時刻表・運行日カレンダーのマスタデータを最新に保つ。
2. **当日の運行便を先に生成する**: GTFSの運行日カレンダーに基づき、その日運行する便をあらかじめすべてDBへ展開する（`frequencies.txt`による頻度ベース運行の仮想便も含む）。この時点では担当車両を持たない。
3. 複数の位置情報フィード（事業者ごとのCSV）からGPS位置情報を定期的に取得し、`config/feeds.js`に明記された位置情報フィード⇔GTFSフィードの対応と、`config/routeExternalIdMapping.js`の外部ID⇔route_id対応に基づいて路線を特定する。
4. **便の始発時刻になった時点で車両を割り当てる**: 始発時刻直前のGPSを見て、始発バス停から100m以内にいる車両を候補にし、最も近い車両を担当車両とする。残りも候補車両として保持する。
5. 担当車両・候補車両の両方について、GPSの軌跡から「バス停通過」「運行終了」を検知し、定刻と実績を比較して遅延を計算する。
6. 過去の走行実績（区間ごとの所要時間統計）を使って、まだ到着していない先のバス停の**到着予測時刻**を算出する。
7. 担当車両が運行終了したら、始発時刻時点の候補車両から再割り当てする。候補車両がそれまでに記録した実績は、そのままその便の実績になる。
8. これらの情報をフロントエンド（利用者向け画面・管理画面）にAPI経由で配信する。**利用者に見せるのは担当車両だけ**で、候補車両は内部処理にとどめる。
9. 運行終了した便は統計データとしてアーカイブし、次の予測精度向上に使う。

この一連の処理が **`backend/src/jobs/pipeline.js`** に定義された順序で、一定間隔（既定60秒）ごとに繰り返し実行されます。

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
│   │   ├── config/
│   │   │   ├── db.js             PostgreSQL接続プール設定
│   │   │   └── directionMapping.js 路線別のCSV方向値⇔direction_id対応（コード管理）
│   │   ├── services/             ★業務ロジック本体（詳細は4章）
│   │   │   ├── gtfsFeedManager.js  ★GTFS ZIPフィードの自動ダウンロード・展開
│   │   │   ├── gtfsFrequencies.js  frequencies.txtの読み込み・仮想便展開
│   │   │   ├── dailyTripBuilder.js ★当日の運行便の生成
│   │   │   ├── locationFetcher.js  ★複数位置情報フィード取得（フィード対応）
│   │   │   ├── vehicleAssigner.js  車両別ログへの振り分け・車両登録
│   │   │   ├── tripAssignment.js   ★便への担当車両・候補車両の割り当て／再割り当て
│   │   │   ├── passDetection.js    バス停通過判定・欠落補完
│   │   │   ├── delayCalc.js        遅延時間の算出
│   │   │   ├── etaPredictor.js     ★到着予測（過去統計＋ペース補正）
│   │   │   ├── finishService.js    運行終了判定・便のクローズ・アーカイブ
│   │   │   ├── gtfsCalendar.js     GTFSカレンダー（曜日・祝日の運行区分）
│   │   │   ├── gtfsData.js         GTFSファイルの読み込み・route_id解決
│   │   │   ├── gtfsTimetable.js    ★時刻表検索のインメモリインデックス（16章）
│   │   │   ├── gtfsRouteSearch.js  ★経路検索エンジン（RAPTOR型。8章）
│   │   │   ├── gtfsFare.js         運賃データ（fare_attributes/fare_rules）の索引と照会
│   │   │   ├── realtimeTripLookup.js GTFS識別子⇔当日の運行実績の橋渡し
│   │   │   ├── busStopApproaching.js バス停検索の「接近中のバス」
│   │   │   └── routeSearch.js      DBのバス停名検索（`/api/stops/search`専用）
│   │   ├── routes/
│   │   │   └── api.js            REST APIエンドポイント一覧
│   │   └── utils/
│   │       ├── time.js           時刻文字列⇔分の変換、深夜判定、遅延計算など
│   │       ├── csv.js            GTFSのCSV読み込み（BOM除去・任意ファイル対応）
│   │       ├── kana.js           かな⇔カタカナ⇔ローマ字(ヘボン式)変換・検索正規化
│   │       └── geo.js            2点間距離（ハバーサイン公式）
│   ├── docker-entrypoint.sh      コンテナ起動時にmigrate→seed→serverを実行
│   └── package.json
├── data gtfs/                    GTFS標準形式のマスタデータ（フィードIDごとのディレクトリ）
│   ├── guruttomatsumotobus1/     ぐるっと松本バス1（GTFSフィード展開先）
│   ├── guruttomatsumotobus2/     ぐるっと松本バス2（GTFSフィード展開先）
│   └── ...                       静的GTFS（フィード未設定時のフォールバック）
├── frontend/                     素のHTML/CSS/JS（利用者向け画面・管理画面）
│   ├── index.html / app.js       利用者向け運行状況画面（お気に入り・SPAルーティング）
│   ├── timetable.js              時刻表検索画面（/timetable）
│   ├── busstop.js                バス停検索画面（/busstop）
│   ├── stopmap.js                バス停マップ画面（/stopmap）
│   ├── routesearch.js            経路検索画面（/routesearch。路線カラー基調・8章）
│   ├── admin.html                管理画面（要Basic認証）
│   └── style.css                 共通スタイル
├── Dockerfile / docker-compose.yml
└── .env.example                  環境変数のサンプル
```

---

## 3. 全体データフロー（パイプライン）

`backend/src/jobs/scheduler.js` が3つのタイマーを管理しています。

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

これとは別に、`finishTrips()`が独立して動き（1分間隔）、運行終了条件を満たした**割り当て**を終了させます。便のクローズ（実績確定＋アーカイブ）は`closeDailyTrip()`が担い、再割り当て可能な候補が居なくなった時点、または終点まで走り切った時点で呼ばれます。到着予測（`etaPredictor.js`の`computeAndStoreAllArrivals()`）は上記⑧としてメインパイプラインの一部になっており、**60秒ごとに全active割り当て分をまとめて計算し`trip_arrival_predictions`へ保存**します（詳細は5.4章）。APIはそこから読み出すだけで、リクエストのたびに計算はしません。

---

## 4. 各モジュールの詳細解説

### 4.1 `jobs/scheduler.js` — 定期実行の管理

- `start()`: `setInterval`で`runPipeline()`を`POLL_INTERVAL_SECONDS`ごとに実行。前回の処理が終わっていなければ多重実行を防止（`pipelineRunning`フラグ、GASのLockService相当）。
- 別の`setInterval`で`finishTrips()`を1分ごとに実行。深夜帯（`isNightTime()`が真）は実行をスキップする。
- `stop()`: 両タイマーを停止。`server.js`が`SIGINT`受信時に呼ぶ。

### 4.2 `jobs/pipeline.js` — メイン処理チェーン

- `runPipeline()`: 深夜帯なら即終了。そうでなければ⓪〜⑧を順に`await`で直列実行する。GTFSフィード更新（⓪）だけは単独のtry/catchで囲まれ、失敗しても後続のパイプライン処理は継続する。途中でエラーが起きても`catch`でログを出すのみで、次回のポーリングで継続する（1回の失敗でプロセス全体が止まらない設計）。

### 4.3 `services/gtfsFeedManager.js` — GTFSフィード管理（⓪）

`updateAllGtfsFeeds()`の処理内容：

1. `config/feeds.js`の`getEnabledGtfsFeeds()`で有効なGTFSフィード一覧を取得する（DBは引かない）。
2. `GTFS_UPDATE_INTERVAL_MIN`（既定60分）で更新間隔を制御する。0以下の場合は毎回更新する（プロセス内キャッシュ`lastGtfsUpdateAt`で管理）。
3. 各フィードについてZIPをダウンロードし、以下の必須GTFSファイルをチェックする：
   `agency.txt` / `routes.txt` / `trips.txt` / `stops.txt` / `stop_times.txt` / `calendar.txt` / `calendar_dates.txt`
4. 必須ファイルが揃っている場合のみ、一時ディレクトリに展開してから現在のファイルと置き換える（展開途中で失敗しても既存データを壊さない安全設計）。
5. 結果は`feeds`テーブルの`last_fetched_at` / `last_status` / `last_error`に記録される。1つのフィードの失敗は他のフィードやパイプライン全体に影響しない。

このモジュールはroute_idのプレフィックス操作（`qualifyRouteId` / `unqualifyRouteId`）も提供しており、複数フィード間でroute_idを一意にする（`feedId:routeId`形式）ためにseed.jsやgtfsData.jsで使われます。

### 4.4 `services/locationFetcher.js` — 複数位置情報フィード取得（①）

`fetchLocation()`の処理内容：

1. `config/feeds.js`の`getEnabledLocationFeeds()`で有効な位置情報フィード一覧を取得する（複数事業者対応）。DBは引かない。
2. `config/feeds.js`の`getGtfsFeedIdsFor(feedId)`で、その位置情報フィードに対応するGTFSフィードIDの**配列**を得る。アルピコ交通のように2つのGTFSフィードにまたがる事業者があるため、1件に畳まず配列のまま扱う。
3. `config/routeExternalIdMapping.js`の対応表を、上で得たGTFSフィードのプレフィックス（`feedId:`）で絞り込み、**いずれかに一致する**エントリだけを使って路線を特定する。配列が空、または一致が0件の場合は絞り込みを行わず全件を対象にする（設定漏れで位置情報が全滅しないため）。
4. 各CSVフィードを個別に`fetch`で取得する。ステータスが429/502/503や5xx系ならサーバー障害とみなして今回はスキップ（例外を投げずリトライは次回ポーリングに委ねる）。
5. 各行から車両ID・GPS時刻・緯度経度・方向列を取り出し、`GPS_FRESHNESS_MIN`（既定15分）より古い、または未来の時刻のデータは除外する。
6. 方向列の値を`direction_mapping`（`csvValue0`/`csvValueOther`）に従って自社の`direction_id`に変換する。
7. **同一車両IDについては最新のGPS時刻のもの1件だけ**を採用する（`latestByCar`マップで重複排除）。
8. 有効なデータを`vehicle_positions_raw`テーブル（生ログ）にINSERTする。取得元フィードは`feed_id`列に記録される。
9. 各フィードは独立したtry/catchで処理され、1つの事業者の取得失敗が他に影響しない。結果（成功/失敗）は`feeds`テーブルに記録される。

### 4.3b `services/gtfsFrequencies.js` — frequencies.txt の展開

GTFSの`frequencies.txt`（頻度ベース運行）を読み込み、当日分の仮想便に展開します。

- `expandFrequencies()`: `start_time`から`headway_secs`間隔で、**`end_time`を含まない**範囲（`t < end_time`）まで仮想便を1件ずつ生成する。これはGTFS標準の解釈で、例えば`07:00:00`〜`09:00:00`／600秒なら 7:00・7:10・…・8:50 の12便になる。
- `exact_times`（0:目安の間隔運行／1:厳密な時刻表運行）による扱いの差は設けない。
- `frequencies.txt`に登場する便は**仮想便としてのみ**展開し、素の便は生成しない（GTFS標準では、その便の`stop_times`は所要時間のテンプレートに過ぎないため）。
- ⚠️ このファイルは`gtfsFeedManager.js`の`OPTIONAL_GTFS_FILES`として扱われます。`REQUIRED_GTFS_FILES`に足すと、このファイルを持たない既存フィードが「必須ファイル欠損」で全滅します。

### 4.4b `services/dailyTripBuilder.js` — 当日の運行便の生成（①）

`ensureDailyTrips()`の処理内容：

1. 生成済みチェック（プロセス内キャッシュ）。GTFS再投入時は`invalidateDailyTripCache()`で無効化される。
2. `gtfsCalendar.getActiveServiceIds()`でその日運行する`service_id`を判定する（既存機構をそのまま利用）。
3. 該当する全便の停車時刻を1クエリでまとめて読み、便ごとに：
   - 始発バス停＝その便の最小`seq_order`の停留所、始発時刻＝その定刻（`departure_time`優先。この優先順位は`seed.js`の`departure_time || arrival_time`が既に満たしている）。
   - `frequencies`定義があれば仮想便へ展開し、無ければ通常便1件とする。
   - `daily_trips`をUPSERTし、`daily_trip_stop_times`に**オフセット適用済みの定刻**を焼き込む。
4. GTFSから消えた便のうち、まだ車両を割り当てていないものを削除する。

**オフセットをここで焼き込むのが設計の要点**です。以降の全処理（割り当て・通過判定・遅延計算・ETA・API）は`daily_trip_stop_times`だけを読めばよく、仮想便と通常便を区別する条件分岐がコード全体に散らばりません。

⚠️ **既に車両を割り当て済みの便（`assignment_state <> 'pending'`）は書き換えません。** GTFSは1時間ごとに再取得され、成功すると`seed()`が走ってマスタが入れ替わりますが、走行中の便の定刻まで書き換えると遅延計算と実績が破綻するためです。

### 4.5 `services/vehicleAssigner.js` — 車両別ログへの振り分け（③）

`sortCarId()`の処理内容：

1. `vehicle_positions_raw`のうち`processed = FALSE`（未処理）の行を最大500件取得。
2. 行ごとにトランザクションを開始し、`getOrCreateVehicle()`で車両を特定・なければ新規作成する。既存車両なら`status = 'active'`に戻し、方向と`last_gps_at`を更新する。
3. `vehicle_gps_log`（車両別の走行ログ）へ位置情報をINSERTし、元の`vehicle_positions_raw`行を`processed = TRUE`にする。
4. 路線を解決できなかった行は便に紐づけようがないため、処理済みにして捨てる。

`vehicles`は**便との紐付けを持ちません**（それは`trip_vehicle_assignments`の役割）。運行終了しても行は削除せず`status = 'inactive'`にします。1台が複数便の候補になり得るため、削除すると`vehicle_gps_log`がCASCADEで消えて他便の処理まで壊れるからです。代わりに`purgeOldGpsLogs()`（1時間ごと）で古いログを掃除します。

### 4.6〜4.9 `services/tripAssignment.js` — 便への車両割り当て（④⑤）

旧`businessStart.js`・`departure.js`・`planMaking.js`・`specialBus.js`を置き換えたモジュールです。

#### `assignPendingTrips()` — 初回の割り当て（④）

対象は「`assignment_state = 'pending'` かつ `start_at <= 現在時刻 − ASSIGN_DELAY_SEC`」の便で、**始発時刻の早い順に1件ずつ確定**させます（直前の便で担当になった車両が、次の便の判定に自動的に反映されるため）。

`findCandidates()`が候補車両を抽出します。

| 条件 | 実装 |
|---|---|
| 同じ路線 | `vehicles.route_id`（qualified route id なのでGTFS側と直接比較できる） |
| 始発時刻直前の最新GPS | **始発時刻の3分前〜始発時刻（閉区間）** に存在する最新の1点。始発時刻を1秒でも過ぎたGPSは無効 |
| 始発バス停から100m以内 | `ASSIGN_RADIUS_METERS`（既定100m）。通過判定の120mとは別の設定値 |
| direction条件 | `config/directionMapping.js`。`mode:'ignore'`の路線、および車両側の方向が不明（NULL）の場合は方向で絞り込まない |
| 同時刻帯の別便の担当でない | `hasSamePeriodConflict()`（下記） |

距離が最も近い車両を担当車両（`role = 'assigned'`）にし、残りも候補車両（`role = 'candidate'`）として記録します。候補がゼロなら`assignment_state = 'unassigned'`とし、その便は時刻表上のデータとしては存続しつつリアルタイム情報を持たない扱いになります。

`ASSIGN_DELAY_SEC`（既定60秒）は、位置情報フィードの配信遅れを吸収するための待ち時間です。**判定に使うGPSの時間窓（始発時刻の3分前〜始発時刻）は変わらず**、遅らせるのは評価タイミングだけです。

#### 「同時刻帯」の重複割り当て防止

`hasSamePeriodConflict()`が判定します。**「始発時刻の差が`ASSIGN_SAME_PERIOD_MIN`（既定10分）以内の便どうしでは、同じ車両を担当車両にしない」** というルールです。

⚠️ これを「稼働中の車両は他の便に割り当てない」に単純化してはいけません。8:00便の担当車両が8:11便の担当になるのは**仕様上正しい動作**です（差が11分なので同時刻帯ではない）。

#### `openAssignment()` — 停車予定の展開

担当・候補の区別なく、`daily_trip_stop_times`から`trip_stop_progress`を展開します。ルールは旧`planMaking.js`からそのまま移植しています。

- 便の中で「実際に定刻を持つ最後のバス停（＝実質的な終点）」を`lastValidSeq`として計算する。
- 経由・非停車（`is_through`）扱いのバス停のうち、`lastValidSeq`より**手前**にあるものだけを`status = '通過'`とする（`lastValidSeq`より先にある「経由フラグ付き」バス停は、単に終点より先で未確定なだけなので通過扱いにしない＝これが`delayCalc.js`のコメントで触れられているバグ修正の背景）。
- 始発バス停は`status = '到着済'`とし、`actual_time`に**判定に使ったGPSの時刻**を入れる。旧方式の「出発時刻」に相当し、ETAの起点・ペース算出がここから機能する。

#### `reassignOrphanTrips()` — 再割り当て（⑤）

担当車両の割り当てが`ended`になり、有効な担当が居なくなった便が対象です。

- 終点まで走り切って終了した便（終了理由が`最終バス停到着済`／`終了エリア到達`）は、再割り当てせずクローズする。
- そうでなければ、**始発時刻時点の候補**のうち、まだ`state = 'active'`で、同時刻帯の別便の担当になっていないものから、**距離が最も近い車両**を新しい担当に昇格させる。始発時刻後に近づいてきた車両を候補に追加することはしない。
- 候補が居なければ`closeDailyTrip()`でクローズする。便は時刻表上のデータとしては存続する。

**実績の引き継ぎ処理は存在しません。** 候補車両は始発時刻から自分の`trip_stop_progress`をその便に紐づけて記録し続けているため、昇格した瞬間にそれがそのまま便の実績になります。「最も進んでいる車両を採用する」というマージは、別経路をたまたま走っていた車両を誤って採用する事故につながるため**やってはいけません**。

### 4.10 `services/passDetection.js` — バス停通過判定・欠落補完（⑥）

`pass()`の処理内容。内部で3つの関数に分かれています。**処理単位は車両ではなく「便への割り当て」**で、担当車両・候補車両を区別せず`state = 'active'`の割り当てすべてが対象です。

#### `passStep1And3()` — 候補となる通過を探す
- DB上で確定している「最後に到着したバス停」のインデックス（`lastArrivedIdx`）を基準に、未処理のGPSログ1件ごとに「まだ到着していないバス停」の中から最も近いものを探す。バス停マスタは**その便の停車パターン**（`trip_stop_progress`）で、便が通らない停留所は最初から含まれない。
- **循環線対策①（探索範囲の制限）**: `lastArrivedIdx + 4`より先のバス停は候補にしない。循環路線では出発直後に終点付近のバス停ともGPS距離が近くなってしまう場合があるため、直近から4つ先までしか見ないことで誤判定を防ぐ。
- **循環線対策②（初期の誤判定防止）**: 便の始発時刻から20分以内は、便全体の後半80%のバス停を候補から除外する（旧方式では「出発時刻から」だった基準を、便の始発時刻に置き換えている）。
- **巻き戻り防止**: バッチ処理内で一度マッチしたバス停より手前（`seq_order`が小さい側）は、以降のGPSログで再度候補にしない（`currentMaxIdx`で管理）。
- 半径`STOP_RADIUS_METERS`（既定120m）以内で最も距離が近いバス停を「暫定マッチ」として記録する。

#### `passStep2Dedup()` — 同一バス停への重複マッチを解消
- 1つのバス停に対して複数のGPSログがマッチした場合、そのバス停の座標に**最も近い1件**だけを採用する。

#### `passInterpolate()` — 欠落バス停の補完
- 到着済み（`actual_time`あり）のバス停を`seq_order`順に並べ、間に2つ以上の未確定バス停がある場合、前後の到着時刻を**線形補間**して埋める（GPSが一時的に取得できず、通過検知が飛んでしまった区間の救済措置）。補完した行には`interpolated = TRUE`のフラグを立てる。

#### `pass()` 本体の流れ
1. 割り当てごとに、その車両のGPSログのうち`trip_gps_matches`に未登録のものを取得（便の始発時刻の3分前以降・freshness内）。
2. `passStep1And3()`→`passStep2Dedup()`の順で確定マッチを算出。
3. 確定した分だけ`trip_gps_matches`へ記録し、`trip_stop_progress.status/actual_time`・`trip_vehicle_assignments.last_arrived_seq`を更新。
4. 重複除去で外れたGPSログは`trip_gps_matches`に記録されないため、次回のバッチで自動的に再評価される。
5. 最後に`passInterpolate()`で欠落区間を補完する。

「どのGPSログを処理済みか」を`vehicle_gps_log.matched_label`（車両側の1列）ではなく`trip_gps_matches`（割り当て×GPSログ）で管理しているのは、**1台の車両が複数便の候補になり得る**ためです。同じGPSログ行が便ごとに別々のバス停へマッチし得るので、車両側の1列では表現できません。

### 4.11 `services/delayCalc.js` — 遅延時間の算出（⑦）

`delayCalc()`の処理内容：

- 対象: `state = 'active'`の割り当てすべて（担当・候補を区別しない）。
- 各バス停について、`delay_minutes`が未計算（`到着済`かつ`actual_time`と`scheduled_time`が両方ある）の行だけを対象に`computeDelayMinutes()`（`utils/time.js`）で遅延分数を計算し、DBへ反映する。
- 一番新しい`delay_minutes`を`trip_vehicle_assignments.delay_minutes`（その割り当ての代表遅延値）としても更新する。
- コード冒頭のコメントにある通り、以前は「`scheduled_time`がNULLなら強制的に`status = '通過'`にする」処理がここにあったが、それが「終点より先でまだ運行終了と確定していないだけのバス停」まで巻き込んで`通過`表示にしてしまうバグの原因だったため、**現在は削除されている**。バス停のstatus確定は`tripAssignment.js`の`openAssignment()`が既に正しく行っている前提で、ここでは上書きしない設計に変わっている。

---

## 5. 到着予測（ETA）システムの詳細 — `services/etaPredictor.js`

このモジュールは「過去の走行実績をどう使うか」「実績がない場合にどう到着時刻を計算するか」を担う中核部分です。旧ロジック（現在の遅延をそのまま残り全区間に単純加算するだけ）を、**過去統計＋直近の走行ペースを組み合わせた予測**に置き換えたものです。

### 5.1 データの土台：区間別走行時間統計（`segment_travel_stats`テーブル）

「あるバス停からあるバス停まで」「曜日区分（平日/土曜/休日）」「時間帯（0〜23時の1時間単位）」の組み合わせごとに、**過去の平均所要時間（秒）とサンプル数**を保持しているテーブルです。

#### 統計はどこで作られるか：`updateSegmentStats(client)`

運行が終了した便（`finishService.js`が`completed_trips`にアーカイブしたもの）から統計を作ります。

1. `completed_trips`のうち`aggregated = FALSE`（未集計）**かつ`is_official = TRUE`**の便を最大200件取得。
   `is_official`は「その便の実績として正とみなす記録＝最後に担当車両だった割り当て」を表します。候補車両止まりの記録を混ぜると、別経路をたまたま走っていた車両の所要時間で統計が汚染され、さらに担当が切り替わった便では同じ区間を二重計上してしまうため、意図的に除外しています。
2. 各便について、実績時刻がある停車バス停（`completed_trip_stop_times`）を`seq_order`順に並べる。
3. **隣接する2つのバス停**（`seq_order`の差が1）だけを対象に、実績時刻の差分（分）を計算する。
   - 差分が負になる場合（日を跨いだ場合）は24時間分を足して補正。
   - 差分が0以下、または60分を超える場合は「計測誤り」とみなして統計から除外する。
4. 到着時刻（分）を1時間単位の`hourBucket`に丸め、`day_of_week`から`day_type`（平日/土曜/休日）を決定する。
5. `segment_travel_stats`に該当する行が無ければ新規作成（サンプル数1）、あれば**移動平均**で更新する：
   `newAvg = (既存平均 × 既存件数 + 今回の秒数) / (既存件数 + 1)`
6. 処理した便は`completed_trips.aggregated = TRUE`にして、二重集計を防ぐ。

この関数は`finishService.js`の`finishTrips()`の最後（1件以上運行終了があった場合）に呼び出されます。つまり、**バスが1便完走するたびに統計が少しずつ育っていく**仕組みです。

### 5.2 予測本体：`predictArrivals(client, assignmentId)`

対象の割り当て（便×車両）の「まだ到着していない各バス停」について、到着予測時刻を1つずつ積み上げて計算します。引数は車両IDではなく**割り当てID**です（進捗が`trip_stop_progress`に移ったため）。アルゴリズム自体は便起点方式への移行で一切変更していません。戻り値の各要素には、どのロジックで計算されたかを示す`source`が付きます。

#### ステップ1: 直近の実績ペース（`liveFactor`）を算出する

その便がここまで**実際にどれくらいのペースで走っているか**を数値化します。

- 直近到着済みバス停のうち、隣接区間（`seq_order`差が1）を最大`LIVE_SEGMENTS_FOR_PACE`件（既定3区間）遡って調べる。
- 各区間について「基準となる所要時間」を決める：
  - その区間の統計（`segment_travel_stats`）があり、かつサンプル数が`MIN_SAMPLES_FOR_TRUST`（既定3件）以上あれば、統計の平均秒数を基準にする。
  - 統計が信頼できない場合は、時刻表上の定刻差分を基準にする。
- 「実際にかかった時間 ÷ 基準時間」を各区間で計算し、その平均を`liveFactor`とする。
  - 例: 統計上5分の区間を実際には6分かけていれば、その区間の比は1.2（＝2割増しペース＝やや遅い）。
- 異常値対策として、`liveFactor`は**0.5倍〜2.5倍の範囲にクランプ**する（GPSの一時的な乱れで極端な値が出て予測が暴走しないようにするため）。
- 到着済み区間が2件未満（＝統計を取れるだけの実績がない）場合は`liveFactor = 1`（等倍）とする。

#### ステップ2: 起点（カーソル）を決める

- 直近の到着済みバス停の実績時刻を`cursorMinutes`（予測の起点時刻）、その`seq_order`を`cursorSeq`とする。
- **まだどのバス停にも到着していない（始発前）場合**は、統計もペースも使わず、素直に時刻表の定刻をそのまま返す（`source: 'schedule'`）。これが「過去の実績が全くない」場合の最もシンプルなフォールバックです。

#### ステップ3: 未到着バス停を1つずつ処理し、区間ごとの所要時間を積み上げる

到着済みのバス停（`seq_order <= cursorSeq`）はそのまま実績値を返します（`source: 'actual'`）。それ以降のバス停について、区間ごとに以下のロジックで所要時間（`segmentMinutes`）を決定し、`cursorMinutes`に加算していきます。

##### (a) 通常区間（前後とも有効な定刻を持つバス停同士）の場合

優先順位は次の通りです。過去実績が「ある場合」「ない場合」の切り分けはここで行われます。

1. **過去統計が使える場合（`source: 'historical'`）**
   区間の統計（`segment_travel_stats`）があり、サンプル数が`MIN_SAMPLES_FOR_TRUST`（3件）以上なら、統計の平均所要時間を採用しつつ、直近ペース（`liveFactor`）で補正する：
   ```
   segmentMinutes = 統計の平均所要時間 × (BLEND_WEIGHT + (1 - BLEND_WEIGHT) × liveFactor)
   ```
   `BLEND_WEIGHT`（既定0.55、`ETA_BLEND_WEIGHT`で調整可）は「過去統計をどれだけ信頼するか」の重みです。例えば0.55の場合、55%は過去統計そのまま、残り45%分は直近ペースで揺らす、という按分になります。`liveFactor = 1`（定刻通りのペース）なら結果は統計の平均そのものに近づき、`liveFactor`が1から離れるほど直近の遅れ/早さが反映されます。

2. **過去統計が無い・サンプル不足の場合（`source: 'schedule_paced'`）**
   時刻表上の定刻差分を基準に、直近ペース（`liveFactor`）だけで補正します：
   ```
   segmentMinutes = 時刻表上の所要時間 × liveFactor
   ```
   これが「**過去の実績が無い区間**」に対する第一のフォールバックです。時刻表の所要時間を「その日の混雑状況（直近ペース）」で引き伸ばし/圧縮して使います。

3. **時刻表の定刻すら片方が欠けている等、上記いずれも計算できない場合（`source: 'naive'`）**
   最終手段として、時刻表の定刻差分をそのまま（ペース補正なしで）使うか、それも無理なら固定5分を所要時間とします。

##### (b) 通過区間（`↓`など、定刻が存在しないバス停を跨ぐ区間）の場合

この区間では、統計・ペース補正のどちらも**意図的に使いません**。理由はコード内コメントの通りで、通過区間は定刻が存在しないため統計が汚染されている／存在しないことが多く、無理に使うと予測が破綻するためです。判定は「ステータスが`通過`かどうか」ではなく「`scheduled_time`が有効な時刻データかどうか（`isValidTime()`）」で行います。これは、"本来の経由・非停車駅"だけでなく"その便の終点より先でまだ未確定なだけのバス停（status=''のまま）"も同じ扱いにする必要があるためです。

1. **予測対象のバス停自体が定刻を持たない（通過駅本体）場合（`source: 'through_skip'`）**
   時間を進めずスキップします（`segmentMinutes = 0`）。
2. **直近で有効な定刻を持っていた基準駅（`lastValidStop`）がある場合（`source: 'naive_anchored'`）**
   前の1駅ではなく、**最後に有効な時刻表を持っていた通常停車駅**を基準に、絶対時刻ベースで計算し直します：
   ```
   基準駅から予測対象駅までの定刻差分 = 予測対象駅の定刻 − 基準駅の定刻
   予測対象駅の目標時刻 = 基準駅の実績/予測時刻 + 上記の定刻差分
   segmentMinutes = 目標時刻 − 現在のcursorMinutes
   ```
   こうすることで、通過区間を何駅またいでも「5分固定」を連鎖加算して予測が大きくズレていく（実際に発生していた不具合）ことを防いでいます。前後とも有効な定刻を持つ駅に戻った時点で、自動的に(a)の高度な予測（historical/schedule_paced）に復帰します。
3. **基準駅すら定刻を持たない異常系（`source: 'naive'`）**
   最終手段として固定5分を使います。

#### ステップ4: 早発防止（床打ち）

有効な定刻を持つ通常停車バス停に限り、計算結果の予測時刻がその停留所の定刻を**下回った場合**（＝予定より早く着きすぎる計算結果になった場合）は、バス停での時間調整（定刻までの待機）を織り込んで、定刻まで時刻を引き上げます。通過駅（定刻が存在しない）は対象外です。

#### ステップ5: 遅延分数の算出と次区間への引き継ぎ

計算した予測時刻から`computeDelayMinutes()`で予測遅延分数を出し、結果配列に追加します。計算後の時刻は次の区間の起点（`prevStop`）として引き継がれ、有効な定刻を持つバス停であれば`lastValidStop`（通過区間計算の基準駅）としても更新されます。

### 5.3 まとめ：過去実績の有無によるロジックの切り替え表

| 状況 | 使われるロジック | `source`の値 |
|---|---|---|
| まだどこにも到着していない（始発前） | 時刻表の定刻をそのまま返す | `schedule` |
| 既に到着済みのバス停 | 実績値をそのまま返す | `actual` |
| 通常区間・統計が3件以上ある | 過去平均 × 過去統計と直近ペースの加重平均 | `historical` |
| 通常区間・統計が無い/不足 | 時刻表の所要時間 × 直近ペース | `schedule_paced` |
| 通常区間・時刻表の定刻すら欠けている | 時刻表差分そのまま、または固定5分 | `naive` |
| 通過区間・対象駅自体が定刻なし | 時間を進めない | `through_skip` |
| 通過区間・基準駅から絶対時刻で算出可能 | 基準駅からの定刻差分で計算 | `naive_anchored` |
| 通過区間・基準駅も定刻なし（異常系） | 固定5分 | `naive` |

### 5.4 呼び出され方（プリコンピュート方式）

2026年8月に、APIリクエストのたびに`predictArrivals()`を呼ぶオンデマンド方式から、**パイプライン内で60秒ごとに全active割り当て分を一括計算してDBへ保存するプリコンピュート方式**に移行しました。設計背景は[docs/design-eta-precompute.md](docs/design-eta-precompute.md)を参照してください。

- `etaPredictor.js`の`computeAndStoreAllArrivals()`が、`pipeline.js`の`runPipeline()`から`delayCalc()`の直後（⑧番目のステップ）に呼ばれる。役割（担当・候補）を問わず`state = 'active'`な全割り当てに対して`predictArrivals()`を実行し、結果を`trip_arrival_predictions`テーブルへUPSERTする（`assignment_id, stop_id`が複合主キー）。あわせて`computed_at`が48時間より古いレコードを削除する。
- `predictArrivals()`自体（アルゴリズム本体）は一切変更していない。計算を行う場所が「APIリクエスト時」から「パイプライン実行時」に変わっただけ。
- API側は計算を一切行わず、`getArrivalsForAssignment(client, assignmentId)`で`trip_arrival_predictions`から読み出すだけになった。呼び出し元は主に2箇所：
  - `routes/api.js`の`GET /api/buses`: 稼働中バス一覧の各バス停に予測時刻を付与する。
  - `services/realtimeTripLookup.js`の`buildBusEntry()`: 便詳細ページ・バス停検索の「接近中のバス」・経路検索のリアルタイム重ね合わせ（8.6章）が共通で使う。
- トレードオフ: 予測値のリアルタイム性が「<5秒」から「最大60秒（パイプライン間隔）」に低下する。バス運行の性質上この程度のラグは許容範囲とされている。

---

## 6. `services/finishService.js` — 運行終了判定・便のクローズ・アーカイブ

### 6.1 `finishTrips()` — 割り当ての終了判定

scheduler.js上、独立したタイマー（1分間隔）で実行されます。**判定単位は車両ではなく「便への割り当て」**です。1台の車両が複数便の候補になり得るため、車両単位で終了させると他便の処理まで巻き添えになるからです。

割り当て直後の誤判定を防ぐため、`FINISH_PROTECTION_MIN`（既定10分）が経過するまでは条件①②④の判定を行いません。

| 条件 | 判定単位 | 内容 |
|---|---|---|
| ① 終点到着済み | 割り当て | **その便の最終停留所**の`status`が`到着済`（路線の終点ではなく便ごとの終点なので、途中止まりの便も正しく終了できる） |
| ② 終了エリア到達 | 割り当て | 直近GPSがその便の終点から`END_AREA_RADIUS_METERS`（既定150m）以内 |
| ③ 一定時間経過 | 割り当て | 割り当てから`VEHICLE_MAX_AGE_MIN`（既定120分）経過（保護期間の対象外＝強制終了） |
| ④ GPS更新停止 | 車両 | 直近GPSの受信から3分以上経過。その車両の**全**割り当てを終了させ、`vehicles.status = 'inactive'`にする |

⑤（時刻表照合タイムアウト）は、照合という概念そのものが無くなったため廃止されました。

### 6.2 `closeDailyTrip()` — 便のクローズと実績の確定

**担当車両の割り当てが終了しても、便が終了したとは扱いません。** 便のクローズは次のいずれかの時点で行われます（いずれも`tripAssignment.reassignOrphanTrips()`から呼ばれます）。

- 担当車両が終点まで走り切った（終了理由が`最終バス停到着済`／`終了エリア到達`）
- 再割り当てできる候補車両が居なくなった

クローズ時の保存内容：

1. その便の残った有効な割り当てをすべて`ended`にする。
2. **最後に担当車両だった割り当て1件**を`is_official = TRUE`で`completed_trips`＋`completed_trip_stop_times`に保存する。`actual_time`（"H:mm"文字列）は`actual_minutes`（0時起点の分数）にも変換する（**5章の統計集計で使うため**）。
3. 担当を経験した他の車両（再割り当て前の旧担当など）は`is_official = FALSE`で監査用に保存する。
4. **一度も担当にならなかった候補車両はアーカイブしない。** 別経路をたまたま走っていた可能性があり、区間統計を汚染するためです。
5. `daily_trips.closed_at`を立てる。`closed_at`は「リアルタイム運行情報の対象から外れた」ことを表すだけで、便自体は時刻表上のデータとして存続します（経路検索はそもそもGTFSインデックス側を見るため影響を受けません）。

その後`etaPredictor.js`の`updateSegmentStats()`を呼び、区間統計を更新します。つまり**「バスが1便走り終える」→「統計が育つ」→「次の予測精度が上がる」**というループがここで完結しています。

---

## 7. GTFS関連モジュール

### 7.1 `services/gtfsCalendar.js` — 運行日カレンダー

- `getActiveServiceIds(date)`: GTFS標準の`calendar.txt`（曜日別の基本ダイヤ）と`calendar_dates.txt`（特定日の例外＝祝日ダイヤの追加/運休など）を読み込み、指定日に有効な`service_id`一覧を返す。
  - `calendar_dates.txt`に例外がある`service_id`は、`exception_type = 1`（追加）ならその日は有効、`exception_type = 2`（削除）ならその日は無効として扱う。
  - 例外が無ければ、通常の曜日フラグ（月〜日）で判定する。
- `planMaking.js`が「今日走らせるべき便」を絞り込む際に使用。
- ⚠️ 注: このモジュールは**静的GTFSディレクトリ（`data gtfs`直下）** の`calendar.txt`・`calendar_dates.txt`のみを読み込みます。GTFSフィード（`guruttomatsumotobus1`等）のカレンダーは、`gtfsFeedManager.js`がフィードの展開時に必須ファイルとして含めますが、`seed.js`が`stops`・`schedule_trips`等を登録する際にservice_idはフィードIDプレフィックス付き（`feedId:service_id`形式）になります。詳細な曜日判定はフィード由来のservice_idとの組み合わせで機能します。

### 7.2 `services/gtfsData.js` — GTFSデータの読み込み・route_id解決

依存: `gtfsFeedManager.js`（`getGtfsDir` / `unqualifyRouteId`）

- `resolveRouteId(routeId)`: route_idを解決する。
  - 未指定の場合は既定路線`'guruttomatsumotobus1:11'`を返す。
  - DB（`routes`/`vehicles`/`stops`等）のroute_idは`seed.js`の`qualifyRouteId`により`feedId:routeId`形式のプレフィックス付きで保存されているため、プレフィックスは除去せずそのままDBの値と一致させる（除去すると複数フィード導入後のDBと不一致になり、`/api/buses`等が空配列を返す原因になる）。
  - `EXTERNAL_ROUTE_ID_ALIASES`（例: `01h9j06f82mw3wvnddsbs4z7fs` → `'guruttomatsumotobus1:11'`）のエイリアス解決も行う。
- `loadRouteCatalog()`: DBの`routes`テーブルから路線一覧を取得する（フィードIDプレフィックス付きroute_idも含む）。
- `loadRouteCatalogByFeed(feedId)`: 指定フィードの`routes.txt`から路線一覧を読み込む。
- `loadRouteCatalogForAllFeeds()`: 全有効GTFSフィードの`routes.txt`をまとめて読み込む。
- `loadRouteData(routeId)`: 指定路線の`stops.txt`・`trips.txt`・`stop_times.txt`を突き合わせ、停留所順序付きリストと便ごとの時刻表を構築する。主に`db/seed.js`から呼ばれるマスタデータ投入用のロジック。

### 7.3 `db/seed.js` / `db/migrate.js`

- `seed.js`: GTFSのCSV群から`routes`・`stops`・`schedule_trips`・`schedule_stop_times`テーブルへマスタデータを投入する（起動のたびに実行しても壊れないよう`ON CONFLICT`で冪等化されている）。
  - **フィード稼働状態レコードの用意**: `ensureFeedRows()`が`config/feeds.js`の全フィード（GTFS 2件・位置情報 3件）について`feeds`テーブルの行をUPSERTする。`id`/`feed_type`/`name`/`url`/`enabled`はコードが正で、DBを直接編集しても上書きされる。⚠️ `last_fetched_at`/`last_status`/`last_error`はSET句に含めない（含めると再起動のたびに稼働状態が失われる）。
  - **複数フィード対応**: 有効なGTFSフィード（`config/feeds.js`の`getEnabledGtfsFeeds()`）ごとに`seedRoutes()`と`seedStopsAndTimetable()`を実行する。route_idは`feedId:routeId`形式でグローバル一意にし、service_idも`feedId:service_id`形式にする。
  - **設定の検証**: `validateCodeConfig()`が`config/feeds.js`・`config/routeExternalIdMapping.js`と実際のGTFSデータの整合（フィードIDの重複、未定義フィードの参照、実在しないroute_idの参照など）を確認し、問題があれば**警告ログを出すだけ**で起動は止めない。GTFS更新でroute_idが一時的に消えたときにシステム全体が起動不能になるのを避けるため。
  - 外部ID⇔route_idの対応はDBに投入しない（`config/routeExternalIdMapping.js`をランタイムが直接参照する）。
- `migrate.js`: 既存DBに対する後発のスキーマ変更を`ALTER TABLE ... IF NOT EXISTS`で安全に適用する。`docker-entrypoint.sh`から起動時に毎回呼ばれる。旧`route_external_ids`・`feed_mappings`テーブルの`DROP TABLE IF EXISTS`もここで行う（ステップ8）。

---

## 8. `services/gtfsRouteSearch.js` — 経路検索（乗換案内）

利用者向け画面の「経路検索」（`/routesearch`）を担当します。設計の全体像と要望の対応関係は
[docs/経路検索機能_改善仕様書.md](docs/経路検索機能_改善仕様書.md)にまとめてあります。

### 8.1 探索の土台はDBではなくGTFSインデックス

**探索は`gtfsTimetable.js`のインメモリインデックスだけで完結します（DBを一切見ません）。**
2026年8月に、DBの`daily_trips`/`stops`を検索していた旧実装（`routeSearch.js`）から全面的に移しました。旧実装には次の構造的な限界がありました。

| 旧実装の作り | 引き起こしていた問題 |
|---|---|
| DBの`daily_trips`（当日ぶんしか生成されない）を見る | 日付を選んで検索できない。当日便の生成に失敗すると結果がゼロになる |
| DBの`stops`はGTFSの`stop_id`・`zone_id`・標柱を持たない | 運賃を引けない。`/busstop`のstopKeyへ変換できない |
| 停留所の一致判定がバス停名の完全一致 | 表記の違う近接バス停がつながらず、経路が見つからない |
| 乗換は「直通が0件のときだけ・1回まで・同名バス停のみ・各区間は最速1本」 | 乗換2回や徒歩数十mの乗り継ぎがまったく出ない |

これにより、**任意の日付・ひらがな/ローマ字検索・路線カラー・運賃・通過バス停一覧・`/busstop`への直リンク**がすべて同じ経路で扱えるようになっています。

### 8.2 探索アルゴリズム（RAPTOR型）

ラウンド（＝乗車回数）ごとに到着時刻を更新していくRAPTOR方式です。ダイクストラではなくRAPTORにしているのは、**乗換回数ごとの最良解（パレート最適解）が1回の実行でまとめて得られる**ためで、「直通は遅いが乗換1回なら早い」といった複数案をそのまま列挙できます。

```
ラウンド0 : 出発地に基準時刻を置き、徒歩接続で近傍バス停へ展開
ラウンドk : 直前ラウンドで更新されたバス停から乗車できる便を走査し、
            その便の以降のバス停の到着時刻を更新 → 徒歩接続を relax
```

- 乗車条件は`pickup_type != 1`かつ「発車時刻 ≥ 到着時刻＋乗換余裕（同一バス停60秒／徒歩は徒歩所要時間）」。最初の乗車には乗換余裕を課しません。降車条件は`drop_off_type != 1`。
- **徒歩接続（footpath）**：バス停グループ間の直線距離が既定400m（フォールバック時800m）以内なら徒歩で乗り継げるものとし、80m/分で徒歩時間を見積もります。緯度経度のグリッドで近傍だけ比較し、半径ごとに1度だけ作ってキャッシュします。**旧実装で経路が見つからなかった最大の原因（同名バス停でしか乗り換えられない）への対策です。**
- **徒歩の連鎖は禁止**しています（`relaxFootpaths()`が、そのラウンドで既に徒歩ラベルが付いたバス停からは再relaxしない）。許すと「4分歩いて5分歩いて…」という非現実的な経路が最速解になります。
- 便の走査は1ラウンド1回だけ（`scanned`）。停車時刻は固定なので、どの停留所から乗っても以降の到着時刻は変わらず、再走査しても改善しないためです。
- 目的地への現時点の最良到着時刻を超える更新は捨てます（枝刈り）。
- **日跨ぎ**：前日サービスの24時超え便を−86400秒、翌日サービスを+86400秒シフトして同時に探索対象へ入れます。深夜0時台の検索や終バス後の検索（＝翌朝の始発を提示）が自然に成立します。
- `frequencies.txt`由来の便は仮想便へ展開してから探索します（現行フィードには存在しませんが、将来フィードが変わっても壊れないように）。

### 8.3 複数候補と並び順

先頭区間の発車を1分ずつ進めながら再探索し、次発・次々発を最大5件そろえます。加えて、**徒歩接続を使わない探索も必ず実行して結果に混ぜます**。徒歩を許すと「1駅手前で降りて歩く」方が最速になり、バスだけで完結する案が枝刈りで消えてしまうためです（利用者はふつう歩かない案も知りたい）。

並び順は到着時刻→乗換回数の順。`isRecommended`（おすすめ）は`到着時刻 + 乗換回数×5分 + 徒歩時間×0.5`が最小の1件に付けます。単純な最速ではなく「乗換が少なく歩かない経路」を適度に優遇するためです。

### 8.4 「経路が見つからない」への段階的フォールバック

結果が0件のあいだ、次の順に条件を緩めます。どの段階で見つかったかは`relaxation`としてレスポンスに含め、画面に明示します。

| 段階 | 条件 |
|---|---|
| `normal` | 探索窓6時間・乗換2回まで・徒歩400m |
| `wide-window` | 探索窓を30時間へ拡張 |
| `walk-transfer` | 徒歩800m・乗換3回まで |

それでも0件なら、理由を切り分けて「次に取れる行動」を必ず返します（`buildNotFoundResponse()`）。

- 出発地・目的地にその日1本も発着が無い → 近くのバス停（徒歩圏で発着のあるもの）を提示
- その時刻以降に便が無い → その日の始発時刻を提示
- その日は運行が無い → 7日先まで探して**次の運行日**を提示
- バス停名が解決できない → 名称検索の候補を提示

### 8.5 運賃（`services/gtfsFare.js`）

`fare_attributes.txt`/`fare_rules.txt`をフィードごとに索引し、区間（leg）ごとに運賃を引きます。

- `stops.txt`の`zone_id`を経由して`origin_id`/`destination_id`と突き合わせます（松本市のフィードでは`zone_id = stop_id`ですが、仕様どおり`zone_id`で引きます）。
- 空欄は「何にでも一致」（GTFS仕様）。複数該当した場合は**より限定的なルール**（出発+到着指定 > 片方だけ > 両方なし）を優先し、同順位なら安い方を採用します。該当が無ければ`null`＝運賃不明とし、**推測はしません**。
- 経路全体の運賃は区間の単純合計です（`transfers=0`＝乗継割引なし、というデータどおりの扱い）。一部の区間だけ不明なときは合計に「一部不明」を添えます。
- 運賃ファイルは**任意ファイル**です。`REQUIRED_GTFS_FILES`に足してはいけません（持たないフィードがあると全フィードのGTFS更新が止まる）。

### 8.6 リアルタイムの重ね合わせ

**検索日が本日のときだけ**、確定した経路に対して後からリアルタイムを重ねます。
`realtimeTripLookup.findLiveAssignment()`で当日の担当割り当てを引き、`buildBusEntry()`の停車進捗・到着予測・車両位置を、**バス停名の一致**で各区間に割り当てます（DBの`stops`は標柱を持たないため名前一致が唯一の接点。`busStopApproaching.js`と同じ制約）。
引けなかった区間は定刻のまま表示します（soft-fail）。重ね合わせが失敗しても経路そのものは必ず成立します。

### 8.7 `services/routeSearch.js` に残っているもの

`/api/stops/search`（DBの`stops`に対するバス停名の部分一致検索）だけです。**ここへ経路探索を戻さないでください。**


---

## 9. `utils/` — 共通ユーティリティ

### 9.1 `utils/time.js`

| 関数 | 役割 |
|---|---|
| `nowInTokyo()` | サーバーのタイムゾーン設定に依存せず、常にJST（Asia/Tokyo）で現在時刻を取得 |
| `getNowTimeInt()` | 現在時刻を`HMM`形式の整数で返す（例: 8:05 → 805） |
| `isNightTime()` | `NIGHT_START`〜`NIGHT_END`（既定23:00〜5:45、日跨ぎ対応）の深夜帯判定 |
| `formatNowNoFormat()` / `formatTimeNoFormat()` | 現在時刻・任意のDateを`"H:mm"`形式の文字列に変換 |
| `timeStrToMinutes()` | `"H:mm"`文字列を分単位の数値に変換。`↓`・`通過`・空文字・不正値は`NaN`を返す（＝これが「有効な時刻データかどうか」の判定基盤になっている） |
| `minutesToTimeStr()` | 分を`"H:mm"`形式に戻す |
| `timeStrToDateToday()` | `"H:mm"`文字列を今日の日付のJST Dateオブジェクトに変換 |
| `getDayType()` | 曜日区分（`weekday`/`saturday`/`holiday`）を判定。**ETA統計専用の区分**で、日曜のみholiday扱い（祝日カレンダーは未対応）。GTFSの`service_id`とは別物であることに注意（GTFS側は`gtfsCalendar.js`が担当） |
| `getDayOfWeek()` | 0(日)〜6(土)の曜日番号を返す |
| `computeDelayMinutes()` | 定刻と実績/予測の差分から遅延分数を算出。720分（半日）を超える差分のみ日跨ぎ補正し、それ以外の早着・早発は「遅れなし(0分)」に丸める |

### 9.2 `utils/geo.js`

- `haversineDistanceMeters(lat1, lon1, lat2, lon2)`: 地球を球体とみなした2点間の距離をメートルで返す（ハバーサインの公式）。GPS座標とバス停座標の距離判定に全編で使われる。

---

## 10. データベース構造（`db/schema.sql`）

| テーブル | 役割 |
|---|---|
| `routes` | 路線マスタ（`feed_id`でどのGTFSフィード由来かを追跡） |
| `feeds` | **フィードの稼働状態**（`last_fetched_at` / `last_status` / `last_error`）。構成（`feed_type` / `url` / `enabled` 等）は`config/feeds.js`が正で、行は`seed.js`がそこからUPSERTする |
| `stops` | バス停マスタ（路線・方向・順序・座標・名称（かな/英語）・お知らせ・時刻表リンク） |
| `schedule_trips` | 時刻表の「便」（`service_id`＝曜日区分ごと、`gtfs_trip_id`＝GTFS原文のtrip_id、`headsign`＝行先表示） |
| `schedule_stop_times` | 便ごとのバス停定刻（`scheduled_time`がNULLかつ`is_through=true`は非停車＝`↓`） |
| `schedule_trip_frequencies` | GTFS `frequencies.txt`（頻度ベース運行の定義。当日便生成時に仮想便へ展開する） |
| `daily_trips` | ★**当日の運行便**（`assignment_state`＝pending/assigned/unassigned、`start_at`＝実時刻、`origin`＝static/frequency） |
| `daily_trip_stop_times` | ★当日便のバス停別定刻（frequenciesのオフセット適用済み。以降の全処理はここだけを見る） |
| `trip_vehicle_assignments` | ★**便への車両割り当て**（`role`＝assigned/candidate、`state`＝active/ended、始発時刻時点の距離） |
| `trip_stop_progress` | ★**便×車両ごとのバス停進捗**（定刻・実績・遅延・通過/到着ステータス） |
| `trip_gps_matches` | 通過判定で消費したGPSログ（割り当て単位。1台が複数便の候補になるため車両側の列では管理できない） |
| `system_settings` | お知らせ文言など管理画面から編集する設定値 |
| `vehicles` | 観測されている物理車両（便との紐付けは持たない。運行終了でも削除せず`status='inactive'`にする） |
| `vehicle_positions_raw` | GPSフィードから取得した直後の生ログ（未処理分の一時置き場、取得元`feed_id`付き） |
| `vehicle_gps_log` | 車両ごとに整理された走行ログ |
| `vehicle_stop_status` | **未使用（旧・車両起点方式の名残）**。`trip_stop_progress`に置き換わったが移行のため残置 |
| `completed_trips` | 運行終了後にアーカイブされた便（`is_official=TRUE`のみが統計学習の対象） |
| `completed_trip_stop_times` | アーカイブされた便のバス停ごとの実績（`actual_minutes`は統計集計用） |
| `segment_travel_stats` | ★区間別・曜日区分別・時間帯別の走行時間統計（ETA予測の核） |
| `trip_arrival_predictions` | ★**プリコンピュートされた到着予測**（パイプラインが60秒ごとに全active割り当て分を保存。`assignment_id, stop_id`が複合主キー。APIはここから読み出すだけ → 5.4章） |
| `active_vehicle_summary`（VIEW） | 稼働中車両のサマリ表示用ビュー |

`vehicles`の`business_start_time` / `departure_time` / `trip_id` / `trip_type` / `last_arrived_seq` / `delay_minutes`は旧・車両起点方式の名残で**未使用**です。移行のロールバック余地のために列だけ残しています。

---

## 11. API一覧（`routes/api.js`）

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/routes` | 路線一覧（GTFSのroutes.txt由来） |
| GET | `/api/settings` | 配信中のお知らせ・路線名などの公開設定 |
| GET | `/api/stops` | バス停マスタ一覧（路線指定可） |
| GET | `/api/stops/search` | バス停名の部分一致検索（全路線対応） |
| GET | `/api/timetable` | 本日運行対象の便の時刻表（`daily_trips`ベース。frequencies由来の仮想便も含む） |
| GET | `/api/buses` | **担当車両が割り当てられている当日便のリアルタイム運行状況＋到着予測**（`trip_arrival_predictions`から`getArrivalsForAssignment()`で読み出すだけ。計算はパイプライン側でプリコンピュート済み → 5.4章）。候補車両は公開しない |
| GET | `/api/buses-for-map` | バスマップ用の走行中バス位置（担当車両のみ・到着予測なしの軽量版）。**`routeId`は任意で、省略時（および`routeId=all`）は全路線**を返す |
| GET | `/api/route-search` | **経路検索**（8章）：乗換2回まで・徒歩接続あり・任意日付・運賃つき。`fromStopKey`/`from`・`toStopKey`/`to`・`date=YYYY-MM-DD`・`time=HH:MM`・`limit`（旧`departureTime`は`time`の別名として受付） |
| GET | `/api/route-search/stops` | **経路検索**：出発地・目的地の候補（漢字/ひらがな/カタカナ/ローマ字。返す`stopKey`は時刻表検索・バス停検索と共通） |
| GET | `/api/timetable/stops/search` | **時刻表検索**：バス停名の検索（漢字/ひらがな/カタカナ/ローマ字）。16章参照 |
| GET | `/api/timetable/stops/:stopKey` | **時刻表検索**：バス停の時刻表（`?date=YYYY-MM-DD`・`?platform=標柱のstop_id`） |
| GET | `/api/timetable/trips/:feedId/:routeId/:tripId/:departureTime` | **時刻表検索**：便の通過時刻一覧（`?stop=`でハイライト対象を指定） |
| GET | `/api/admin/settings` | （要Basic認証）お知らせ設定の取得 |
| PUT | `/api/admin/settings` | （要Basic認証）お知らせ設定の更新 |
| GET | `/api/admin/route-data` | （要Basic認証）バス停座標・時刻表の編集用データ取得 |
| PUT | `/api/api/admin/route-data` | （要Basic認証）バス停座標・時刻表の更新　※パスに`/api`が二重になっている点は既存コードのまま |
| GET | `/api/admin/bus-positions` | （要Basic認証）直近3分のバス位置情報＋Yahoo!リバースジオコーダによる住所表示 |

管理系APIは`requireAdminAuth`（Basic認証、既定ユーザー名/パスワードは`ADMIN_USERNAME`/`ADMIN_PASSWORD`環境変数）で保護されています。

---

## 12. フロントエンド概要

- `frontend/index.html` + `frontend/app.js`: 利用者向け運行状況画面。
  - `POLL_MS`（20秒）間隔で`/api/buses`等をポーリングして表示を更新する。
  - 路線セレクターで路線を切り替えられる（複数路線対応）。
  - お気に入りバス停（localStorage連携）で先発・次発を表示。
  - GTFSの`headsign`（行先表示）を優先して方向ラベルを表示する。
  - 開いているアコーディオンやスクロール位置は再描画をまたいで保持される。
  - バスマップ（`#/busmap`、Leaflet + OpenStreetMap）：`/api/buses-for-map`を`POLL_MS`間隔でポーリングし、**全路線**の走行中バスを路線色のマーカーで表示する。注意点は以下の3つ。
    - **地図を作り直すときは`busMarkers`／`userMarker`も必ず捨てる。** 破棄済みの地図に紐づくマーカーを使い回すと、2回目以降にバスマップを開いたとき1台も描画されない。
    - **現在地の取得（`addUserLocation()`）を`await`してからバスを取得しない。** 位置情報の許可ダイアログは利用者が答えるまで解決せず、その間バスが表示されないため。
    - **`#map`の高さはCSSで確定させ、表示直後に`invalidateSize()`を呼ぶ。** 高さ0や非表示状態のコンテナではLeafletが何も描画しない。
- `frontend/timetable.js`: 時刻表検索機能（16章）。**ハッシュではなくHistory API（パス`/timetable...`）でルーティングする**画面のひとつ。`app.js`の`renderCurrentRoute()`から`window.TimetableView.render()`が呼ばれる。`a[data-spa]`のクリック委任リスナーは**この`timetable.js`だけがdocument全体へ登録**しており、`busstop.js`・`routesearch.js`はそれに相乗りする（重複登録しない）。
- `frontend/routesearch.js`: 経路検索画面（8章）。同じくパス（`/routesearch`）でルーティングし、**検索条件をURLのクエリに持たせる**（`?from=…&fromKey=…&to=…&toKey=…&date=…&time=…`）。結果から`/busstop`へ移動して戻っても検索結果が復元されるようにするため。表示は路線カラー基調で、区間の縦帯・路線チップ・所要時間バーに`route_color`を使い、コントラストが足りない色は`chipTextColor()`/`routeColorStyle()`で文字色を反転させる（`timetable.js`・`busstop.js`と同一ロジック）。本日の検索のときだけ20秒間隔でリアルタイム更新する。旧ハッシュ`#/search`は`/routesearch`へリダイレクトされる。
- `frontend/admin.html`: 管理画面（お知らせ編集、バス停座標・時刻表編集、直近バス位置の住所付き一覧）。Basic認証情報をブラウザに保持してAPIを呼び出す。外部IDマッピングの編集セクションは、対応を`config/routeExternalIdMapping.js`へコード化したため削除済み。
- `frontend/style.css`: 共通スタイル（時刻表の「縦=時 / 横=分」レイアウトもここ）。

> **`index.html`の静的ファイル参照は必ず絶対パス（`/app.js`など）にすること。**
> 時刻表検索は`/timetable/stops/{stop_id}`のような階層のあるURLを使うため、相対パスだと
> `/timetable/stops/app.js`を読みに行き、サーバーのSPAフォールバックがindex.htmlを返して
> スクリプトが一切動かなくなる（実際に踏んだ）。

---

## 13. 環境変数一覧

| 変数名 | 既定値 | 用途 |
|---|---|---|
| `PORT` | `3000` | HTTPサーバーのポート |
| `DATABASE_URL` | - | PostgreSQL接続文字列（Render等ホスティング用。指定時はSSL接続） |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | localhost等 | `DATABASE_URL`未指定時のローカル接続情報 |
| `POLL_INTERVAL_SECONDS` | `60` | メインパイプラインの実行間隔（秒） |
| `GTFS_UPDATE_INTERVAL_MIN` | `60` | GTFSフィードの自動更新間隔（分）。0以下なら毎回更新 |
| `GPS_FRESHNESS_MIN` | `15` | GPSデータを「新しい」とみなす分数 |
| `ASSIGN_RADIUS_METERS` | `100` | 候補車両とみなす、始発バス停からの距離（m） |
| `ASSIGN_GPS_WINDOW_MIN` | `3` | 始発時刻から何分前まで遡ってGPSを探すか（始発時刻との閉区間） |
| `ASSIGN_DELAY_SEC` | `60` | 始発時刻から何秒待ってから割り当て判定を行うか（フィード配信遅れの吸収） |
| `ASSIGN_SAME_PERIOD_MIN` | `10` | 「同時刻帯」とみなす始発時刻の差（分）。この範囲では同じ車両を担当車両として重複させない |
| `STOP_RADIUS_METERS` | `120` | バス停通過判定の半径（m） |
| `END_AREA_RADIUS_METERS` | `150` | 終了エリア判定の半径（m） |
| `VEHICLE_MAX_AGE_MIN` | `120` | 割り当ての強制終了までの経過時間（分） |
| `FINISH_PROTECTION_MIN` | `10` | 運行終了判定を開始しない保護期間（分） |
| `DAILY_TRIP_RETENTION_DAYS` | `7` | 当日便（`daily_trips`）の保持日数 |
| `GPS_LOG_RETENTION_HOURS` | `48` | GPSログの保持時間（車両行を削除しなくなったため必要） |
| `ETA_BLEND_WEIGHT` | `0.55` | ETA予測における過去統計への信頼度（0〜1） |
| `NIGHT_START` / `NIGHT_END` | `23:00` / `05:00` | 深夜帯の範囲。**当日便の生成と車両割り当てはこの時間帯でも動く**（最早便が5:40発のため） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin123` | 管理画面のBasic認証情報 |
| `YAHOO_CLIENT_ID` | - | 管理画面の住所逆引き（Yahoo!リバースジオコーダ）用APIキー |

> 位置情報CSVやGTFS ZIPのURL、および位置情報フィード⇔GTFSフィードの対応は、環境変数でもDBでもなく**`backend/src/config/feeds.js`（コード）**で管理されます。外部ID⇔route_idの対応は**`backend/src/config/routeExternalIdMapping.js`**です。いずれも変更にはデプロイが必要です（管理画面からは編集できません）。

---

## 14. セットアップ・起動方法

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

---

## 15. 既知の注意点・改善余地

コードを読み解く上で把握しておくと良い、現状のクセや注意点をまとめます（いずれも致命的なバグではありませんが、改修の際は意識してください）。

- **`frequencies.txt`を`gtfsFeedManager.js`の`REQUIRED_GTFS_FILES`に足してはいけない**。現在有効なフィード（guruttomatsumotobus1 / 2）はいずれもこのファイルを持たないため、必須にするとGTFS更新が全フィードで失敗し、システム全体が止まる。`OPTIONAL_GTFS_FILES`側に置いてあるのは意図的。
- **「同時刻帯＝始発時刻の差が10分以内」を「稼働中の車両は他の便に割り当てない」に単純化しないこと**。8:00便の担当車両が8:11便の担当になるのは仕様上正しい動作（4.6〜4.9節参照）。
- **`vehicles`の`business_start_time` / `departure_time` / `trip_id` / `trip_type` / `last_arrived_seq` / `delay_minutes`、および`vehicle_stop_status`テーブルは未使用**（旧・車両起点方式の名残）。移行のロールバック余地のために残してあるだけなので、新しいコードから参照しないこと。
- **`stops`の`seq_order`は路線×方向で共有されている**（`seed.js`がGTFSの`stop_sequence - 1`を`UNIQUE (route_id, direction_id, seq_order)`に載せる設計）。同一路線内で停車パターンの異なる便があると、同じ`seq_order`に別のバス停が入り込む余地が残っている。便起点方式では進捗を便ごとの停車パターンで作るため悪化はしないが、根本解決は別課題。
- **`services/gtfsCalendar.js`**: `config/feeds.js`で有効な各GTFSフィードのディレクトリから`calendar.txt`・`calendar_dates.txt`を読み込み、`feedId:serviceId`形式で当日有効な`service_id`を返す。フィード未設定時は`data gtfs`直下の静的GTFSへフォールバックする。
- **24時以降の便**: `daily_trips.start_at`（TIMESTAMPTZ）では正しく扱えるが、`"H:mm"`表示と`computeDelayMinutes()`は従来どおりの制約を引きずる。深夜帯停止（23:00〜05:00）と併せ、実質的に対象外である点は変わらない。
- **`routes/api.js`のPUT `/api/admin/route-data`**: エンドポイントのパスに`/api`が二重になっている（`router`が既に`/api`配下にマウントされているため、実際のパスは`/api/api/admin/route-data`になる）。フロントエンド側の呼び出しと整合していれば実害はないが、命名の一貫性という観点では要注意。
- **`getDayType()`（`utils/time.js`）と`getActiveServiceIds()`（`gtfsCalendar.js`）は別の曜日区分ロジック**であり、意図的に分離されています。前者はETA統計のバケット分け専用（祝日カレンダー非対応、日曜のみholiday扱い）、後者はGTFSの正式なcalendar.txt/calendar_dates.txtに基づくダイヤ選択用です。混同しないよう注意してください。

---

## 16. 時刻表検索機能（`services/gtfsTimetable.js` / `frontend/timetable.js`）

GTFSデータから、利用者がバス停名で検索し、時刻表と各便の通過時刻を確認できる機能です。
**リアルタイム運行状況（1〜15章）とはデータ経路が完全に独立しています。**

### 16.1 なぜDBを使わずGTFSファイルを直接読むのか

既存の`stops`テーブルは「路線 × 方向 × 停車順」で正規化されており（`seed.js`）、
**GTFSの`stop_id`・標柱（のりば）・`stop_headsign`を保持していません**。
時刻表検索はこれらをそのまま扱う必要があるため、既存テーブルからは復元できません。

一方でGTFSファイル自体は`gtfsFeedManager.js`によって常にディスク上へ展開されています。
そこで**GTFSファイルをそのままの粒度でメモリにインデックス化する**方式を採りました。

- 既存スキーマ・既存パイプラインに一切影響を与えない
- データ量が小さい（全フィード合計で バス停677件 / 標柱1023件 / 便948件、構築約0.2秒）
- インクリメンタル検索がDB往復なしで返せる

インデックスは初回アクセス時（およびサーバー起動時の事前構築）に作られ、30分でTTL失効します。
GTFS更新に成功すると`gtfsFeedManager.js`が`invalidateTimetableIndex()`を呼び、次回アクセスで作り直されます。

### 16.2 translations.txt の取り込みとローマ字の自動生成

`translations.txt`を`OPTIONAL_GTFS_FILES`へ追加しました（**`REQUIRED`に足してはいけない**理由は
`frequencies.txt`と同じ。持たないフィードでGTFS更新全体が失敗します）。

読み込みは2つの書式に対応します。

| 書式 | 列 |
|---|---|
| 現行GTFS | `table_name, field_name, language, translation, record_id, field_value` |
| GTFS-JP旧書式 | `trans_id, lang, translation` |

`language`の値（`ja-Hrkt` / `en` など）は事業者によってゆれるため、**値の内容で判定**します
（かなだけ→よみがな、ラテン文字を含む→ローマ字）。

よみがなはあるがローマ字が無い場合は、`utils/kana.js`が**ヘボン式ローマ字を自動生成**します（仕様書 3.1）。
検索インデックスには表記ゆれを吸収するため複数の綴りを登録します。

- 長音：`とうきょう` → `toukyou` と `tokyo` の両方
- 撥音：`しんばし` → `shinbashi` と `shimbashi` の両方
- 促音・拗音：`まっちゃ` → `matcha`、`きょう` → `kyo`

検索時の正規化（`normalizeSearchText`）はNFKC正規化 → 小文字化 → カタカナ→ひらがな →
空白・記号・長音符の除去、の順で行います。これにより「マツモト」「まつもと」「ﾏﾂﾓﾄ」「Matsumoto」
「ばすたーみなる」「basutaminaru」がすべて同じキーに落ちます。

> **漢字→よみがなの変換は行いません**（形態素解析が必要でGTFSの範囲外）。
> `translations.txt`が無いフィードでは、そのバス停は漢字表記でのみ検索できます。

### 16.3 バス停の統合ルール（仕様書 3.1）

GTFS-JPのバス停は`100_03`のように「ベースID_枝番」で標柱（のりば）単位に分かれています。
以下の順で「1つのバス停」にまとめます。

1. **標柱→バス停**：`parent_station`があればそれ、無ければ`stop_id`の枝番を落としたベースIDでまとめる
2. **ベースIDが同じで名前も一致** → 同一バス停として統合。URLキーは`{stop_id}`（例：`/timetable/stops/52`）
3. **ベースIDが同じで名前が違う** → 別バス停。URLキーは`{gtfs_id}_{stop_id}`（例：`guruttomatsumotobus1_100`）
4. **同名かつ400m以内** → さらに1件へ統合（`SAME_NAME_MERGE_RADIUS_METERS`）

4が必要な理由：本システムは2つのGTFSフィードを扱いますが、**両フィードのベースIDは
完全に別体系**です（feed1の`100`＝松本バスターミナル、feed2の`100`＝上立田公民館。
231件のベースIDが名前違いで衝突しています）。一方で「本町」「松本駅お城口」のように
**同じ物理バス停が両フィードに別IDで登録されている**ケースがあり（88件）、
統合しないと検索結果に同じ名前が2つ並び、時刻表も事業者ごとに分断されてしまいます。
仕様書3.3の「重複のないユニークなバス停名」を満たすための処理です。

統合されて使われなくなったキーは**別名（alias）として保持**し、古いURLでも開けます。
別名でアクセスされた場合、フロントエンドが`replaceState`で正規URLへ書き換えます。

### 16.4 時刻表の組み立て

- 対象は「選択中のバス停に属する標柱」の`stop_times`。`platform`指定時はその標柱のみ。
- **`pickup_type = 1`（乗車不可）の停車は載せません**。終点や通過扱いの停車が発車時刻表に出てしまうためです。
- 運行日の判定は`calendar.txt`＋`calendar_dates.txt`（`exception_type` 1=運行/2=運休）に加え、
  **`start_date`〜`end_date`の有効期間もチェック**します。
- `frequencies.txt`を持つ便は`gtfsFrequencies.js`で仮想便に展開してから並べます。
- 時（縦軸）ごとに分（横軸）をまとめて返します。24時以降はGTFS表記のまま（24, 25…）保持し、
  画面側で「翌日」バッジ付きで表示します。

> **`getActiveServices()`（gtfsTimetable.js）と`getActiveServiceIds()`（gtfsCalendar.js）は
> 統合しないこと。** 後者は当日便生成専用でDB保存形式の文字列を返し、有効期間チェックを持ちません。
> 前者は任意の日付を指定でき、表示用ラベル（平日/土曜/…）を曜日フラグから機械的に生成します。
> `utils/time.js`の`getDayType()`（ETA統計用）も含め、曜日区分ロジックは用途ごとに3つ独立しています。

### 16.5 画面とURL（仕様書 3.2）

| 画面 | URL |
|---|---|
| 検索 | `/timetable` |
| バス停詳細（すべての乗り場） | `/timetable/stops/{stop_id}` |
| バス停詳細（乗り場別） | `/timetable/stops/{stop_id}?platform={platform_stop_id}` |
| 便詳細（通過時刻） | `/timetable/trips/{gtfs_id}/{route_id}/{trip_id}/{departure_time}` |

`date=YYYY-MM-DD`を付けると任意の日付のダイヤを表示します（省略時は当日）。
`departure_time`は始発バス停の出発時刻（`0805`形式）で、`frequencies.txt`由来の仮想便を
特定するために使います。URLの時刻と実データがずれている場合（GTFS改訂後の古いURLなど）は
`departureTimeMismatch`を立てて画面に注意書きを出し、404にはしません。

- **表示モード切替は標柱が2つ以上あるときだけ表示**します（仕様書 3.4 A）。
- 「乗り場別」を選ぶと「地図から選ぶ」（Leafletのピン）／「方面から選ぶ」（`stop_headsign`を路線カラー付きで一覧）を出します。
  `stop_headsign`が空の便は`trip_headsign`で代替します。
- **路線カラーの視認性**：`route_color`と白背景のコントラスト比が3未満の場合は数字を濃色にし、
  路線カラーは下線＋小さい円形バッジで表現します（仕様書 3.4 C）。判定は`frontend/timetable.js`の
  `routeColorStyle()`（WCAG相対輝度）にあります。
- 日付選択は日付ピッカーに加えて「平日／土曜日／日祝日」タグを持ち、タグはその区分に当てはまる
  **直近の日付へジャンプ**します。実際に適用されるダイヤはその日付に対してGTFSカレンダーから
  判定するので、祝日の特別ダイヤ（`calendar_dates.txt`）も自然に反映されます。
