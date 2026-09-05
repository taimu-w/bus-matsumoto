# バスリアルタイム運行管理システム

松本市内の路線バス（ぐるっと松本バス・アルピコ交通・松本市営など）向けの、GPSベースのリアルタイム運行管理・遅延計算・到着時刻予測システムです。複数事業者の位置情報フィードと複数のGTFSフィードを自動で取り込み、**複数路線**のリアルタイム運行状況を一元管理します。

（ソースコード中のコメントに「GASの◯◯()に相当」という記述があるのは、もともと Google Apps Script + スプレッドシートで作られていた仕組みからの移植のためで、旧処理との対応を追うヒントになります。）

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

この一連の処理が**`backend/src/jobs/pipeline.js`**に定義された順序で、一定間隔（既定60秒）ごとに繰り返し実行されます。便を先に生成し車両を後から割り当てる、という設計の詳細は[docs/vehicle-assignment.md](docs/vehicle-assignment.md)を参照してください。

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
│   │   ├── middleware/           HTTPS強制・セキュリティヘッダー・レートリミット
│   │   ├── services/             ★業務ロジック本体（4章に一覧）
│   │   ├── routes/
│   │   │   └── api.js            REST APIエンドポイント一覧（docs/api-reference.md）
│   │   └── utils/                 時刻・距離・CSV・かな変換などの共通ヘルパー
│   ├── test/                     回帰テスト（node --test）
│   ├── docker-entrypoint.sh      コンテナ起動時にmigrate→seed→serverを実行
│   └── package.json
├── data gtfs/                    GTFS標準形式のマスタデータ（フィードIDごとのディレクトリ）
├── frontend/                     素のHTML/CSS/JS（利用者向け画面・管理画面。ビルドステップなし）
│   └── vendor/                   同梱したTailwind・Leaflet（CDNから読み込まない。手で編集しない）
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
| データ掃除 | 1時間 | 古いGPSログ・古い当日便・古い運行実績アーカイブ（`completed_trips`、既定7日）の削除 |

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
reassignOrphanTrips() … ⑤ 担当車両が終了した便の再割り当て（候補ゼロのまま残った便のクローズも同時に行う）
   ↓
pass()                … ⑥ GPSとバス停座標の突合による通過判定、欠落区間の補完
   ↓
delayCalc()           … ⑦ 定刻と実績の差分から遅延分数を算出
   ↓
computeAndStoreAllArrivals() … ⑧ 全active割り当ての到着予測を一括計算し trip_arrival_predictions へ保存
```

⑥⑦⑧は**担当車両・候補車両を区別せず、有効な割り当てすべて**に対して行われます。

⓪①を深夜帯（既定23:00〜05:00）でもスキップしないのは、最も早い便が**5:40発**で、深夜帯が明ける前に始発時刻が来るためです。ここを止めると当日便が未生成のまま始発時刻を過ぎてしまいます。**②以降（車両割り当て④を含む）は深夜帯には動きません。**

ただし深夜帯でも、「始発時刻を過ぎたのに割り当て判定を受けていない便」が残っている間は②以降も継続します（`countDuePendingTrips()`）。④は②③のGPS取り込み結果を前提にしているため、深夜帯だからと一律に抜けるとその時間帯にかかる便の割り当てが黙って行われないまま消えてしまうからです。既定値では該当する便は存在しないので、これは`NIGHT_END`を早朝便の始発より後ろへ設定した場合の安全弁です。

これとは別に、`finishTrips()`が独立して動き（1分間隔）、運行終了条件を満たした**割り当て**を終了させます。詳細は[docs/trip-lifecycle.md](docs/trip-lifecycle.md)を参照してください。

---

## 4. 主要サービスの責務一覧（`backend/src/services/`）

| ファイル | 責務 | 詳細 |
|---|---|---|
| `gtfsFeedManager.js` | GTFS ZIPフィードの自動ダウンロード・展開（パイプライン⓪）。前回DBへ取り込んだZIPの指紋（`feeds.content_hash` / `last_etag` / `last_modified`）と照合し、内容が変わっていなければ展開も`seed()`も行わない。route_idのフィードプレフィックス操作（`qualifyRouteId`/`unqualifyRouteId`）も提供 | |
| `gtfsFrequencies.js` | `frequencies.txt`の読み込み・仮想便展開 | |
| `dailyTripBuilder.js` | 当日の運行便の生成（①）。既に車両を割り当て済みの便は書き換えない | |
| `locationFetcher.js` | 複数位置情報フィードの取得（②）。フィードごとに独立したtry/catch | |
| `vehicleAssigner.js` | 生ログを車両別ログへ振り分け・新規車両登録（③） | |
| `tripAssignment.js` | 便への担当車両・候補車両の割り当て／再割り当て（④⑤） | [docs/vehicle-assignment.md](docs/vehicle-assignment.md) |
| `passDetection.js` | バス停通過判定・欠落補完（⑥） | [docs/pass-detection.md](docs/pass-detection.md) |
| `delayCalc.js` | 定刻と実績の差から遅延分数を算出（⑦） | [docs/pass-detection.md](docs/pass-detection.md)（通過ステータス確定との関係） |
| `etaPredictor.js` | 到着予測の計算・保存（⑧）。過去統計＋直近ペースを組み合わせる | [docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md) |
| `finishService.js` | 運行終了判定・便のクローズ・アーカイブ | [docs/trip-lifecycle.md](docs/trip-lifecycle.md) |
| `gtfsCalendar.js` | GTFSカレンダー（`calendar.txt`/`calendar_dates.txt`）に基づく当日便生成用の運行日判定 | |
| `gtfsData.js` | route_id解決（`resolveRouteId`）の唯一の窓口 | |
| `gtfsTimetable.js` | 時刻表検索のインメモリインデックス | [docs/timetable-search.md](docs/timetable-search.md) |
| `gtfsRouteSearch.js` | 経路検索エンジン（RAPTOR型。出発時刻指定と到着時刻指定の両方、詳細設定による条件の絞り込み） | [docs/route-search.md](docs/route-search.md) |
| `spotSearch.js` | スポット検索（簡易的な路線・バス停検索。地名・バス停・路線1つから、スポット情報＋付近のバス停＋周辺路線を返す）・検索回数集計 | [docs/spot-search.md](docs/spot-search.md) |
| `gtfsFare.js` | 運賃データ（`fare_attributes.txt`/`fare_rules.txt`）の索引と照会 | |
| `realtimeTripLookup.js` | GTFS識別子⇔当日の運行実績の橋渡し（経路検索・バス停検索が共通で使う）。`findLiveAssignment()` はリアルタイム休止中の路線に `null` を返す | [docs/realtime-suspension.md](docs/realtime-suspension.md) |
| `realtimeSuspension.js` | 路線ごとの「リアルタイム表示」一時停止（`route_realtime_suspensions`テーブル）のキャッシュ。管理画面編集時に即時破棄 | [docs/realtime-suspension.md](docs/realtime-suspension.md) |
| `busStopApproaching.js` | バス停検索の「接近中のバス」 | |
| `routeSearch.js` | `/api/stops/search`専用のDBバス停名検索のみ。**ここへ経路探索を戻さないこと** | |
| `holidayCalendar.js` | 祝日カレンダー（`holidays`テーブル）のキャッシュ | |
| `routeExternalIdMapping.js` | 外部ID⇔route_id対応（`route_external_ids`テーブル）のキャッシュ。管理画面編集時に即時破棄 | |
| `touristSpots.js` | 観光スポット情報の管理・近接検索・公式サイトリンクのタップ数集計 | [docs/tourist-spots.md](docs/tourist-spots.md) |
| `busstopNotices.js` | バス停お知らせ配信（見出し＋画像＋本文。バス停単位／乗り場単位）の管理・取得 | [docs/busstop-notices.md](docs/busstop-notices.md) |
| `predictionAccuracy.js` / `apiMetrics.js` / `jobMonitor.js` / `visitorTracker.js` / `serviceStatusScraper.js` | 管理画面向けの監視・集計系（予測精度・API稼働・ジョブ実行状況・閲覧数・運行状況スクレイピング） | |

`backend/src/utils/time.js`と`utils/geo.js`は、ほぼすべてのサービスで使われる共通ヘルパー（時刻文字列の変換、遅延計算、ハバーサイン距離）です。`utils/csv.js`はGTFSのCSV読み込み、`utils/kana.js`はかな⇔ローマ字変換・検索正規化を担います。

### 複数フィード対応の設計

**フィード構成（URL・有効/無効・位置情報フィード⇔GTFSフィードの対応）はコード（`backend/src/config/feeds.js`）で管理し、`feeds`テーブルは稼働状態（`last_fetched_at`/`last_status`/`last_error`）の記録のみを担います。** 一方、**外部ID⇔GTFS route_idの対応は`route_external_ids`テーブル（DB）で管理し、管理画面「外部IDマッピング」から編集できます。** 詳細は[docs/feed-config.md](docs/feed-config.md)を参照してください。フィード構成の追加・変更はコード側を編集してデプロイします（管理画面からは編集できません）。

---

## 5. `utils/` — 共通ユーティリティ

| モジュール | 役割 |
|---|---|
| `utils/time.js` | JST基準の時刻取得・変換（実時刻表記の`minutesToTimeStr()`／運行日表記の`minutesToServiceTimeStr()`）、深夜帯判定（`isNightTime()`。不正な設定値は既定値へフォールバック）、位置情報フィードのGPS時刻パース（`parseGpsTimeToDate()`。ISO 8601・タイムゾーン指定に対応）、遅延分数算出（`computeDelayMinutes()`＝0以上／`computeSignedDelayMinutes()`＝符号付き）、曜日区分判定（`getDayType()`。ETA統計専用） |
| `utils/geo.js` | `haversineDistanceMeters()`（2点間の距離。GPS座標とバス停座標の距離判定に全編で使われる） |
| `utils/csv.js` | GTFSのCSV読み込み（BOM除去・任意ファイル対応） |
| `utils/kana.js` | かな⇔カタカナ⇔ローマ字（ヘボン式）変換・検索正規化 |

**曜日区分・運行日判定のロジックは用途ごとに3つ独立しています。統合しないでください。** `utils/time.js`の`getDayType()`（ETA統計のバケット分け専用）、`gtfsCalendar.js`の`getActiveServiceIds()`（当日便生成専用）、`gtfsTimetable.js`の`getActiveServices()`（時刻表検索専用）。

---

## 6. データベース・API

- DBスキーマ（テーブル一覧・役割）: [docs/database.md](docs/database.md)
- APIエンドポイント一覧: [docs/api-reference.md](docs/api-reference.md)

代表的な公開エンドポイントだけ挙げると、`GET /api/buses`（担当車両のリアルタイム運行状況＋到着予測）・`GET /api/timetable`（本日の時刻表）・`GET /api/route-search`（経路検索。詳細設定 `maxTransfers`/`allowWalkTransfer`/`minTransferMinutes` は任意で、未指定なら既定の条件）・`GET /api/routes`（路線一覧）です。管理系（`/api/admin/...`）は`requireAdminAuth`で保護されており、認証は**サーバー側セッション（`POST /api/admin/session`で発行するhttpOnly Cookie）**か、従来どおりの**Basic認証ヘッダー**（`ADMIN_USERNAME`/`ADMIN_PASSWORD`）のどちらでも通ります。

`/api/route-search`（RAPTOR探索）と集計値を増やす系（`/api/spot-search`・`/api/tourist-spots/:id/link-click`）には1IPあたりのレートリミットが掛かっています。20秒間隔でポーリングされるホットパス（`/api/buses`等）には掛けていません（利用者の画面が止まるリスクの方が大きいため）。上限は環境変数で調整できます（§8）。

---

## 7. フロントエンド概要

素のHTML/CSS/JS、ビルドステップなし。

- `frontend/index.html` + `frontend/app.js`: 利用者向け運行状況画面。`POLL_MS`（20秒）間隔で`/api/buses`等をポーリング、お気に入りはlocalStorage、SPAルーティングの入口。バスマップ（`#/busmap`、Leaflet + OpenStreetMap）も含む。バスマップには「路線で絞り込み」セレクトがあり、選んだ路線だけを表示できる（既定は全路線。選択は`#/busmap/<feedId>/<routeId>`としてURLに載り共有・リロードで復元できる）。
- `frontend/onboarding.js`: はじめての方向けチュートリアル。初回訪問時にホーム画面でだけ自動表示し、完了フラグ（localStorage `busTimeOnboardingSeen`）を立てる。`/howto` の「使い方ツアー」ボタン（`/?tutorial=1`）や `window.Onboarding.open()` からいつでも再表示できる。
- `frontend/howto.html`: 使い方ページ（`/howto`。静的HTML、JSなし）。目的別の導線・機能別の手順・よくある質問（`<details>`）をまとめる。
- `frontend/timetable.js`（時刻表検索）・`frontend/busstop.js`（バス停検索）・`frontend/stopmap.js`（バス停マップ）・`frontend/routesearch.js`（経路検索）・`frontend/spotsearch.js`（スポット検索）は、いずれもハッシュではなくパス（History API）でルーティングします。経路検索は「経路一覧（`/routesearch?…`）→ 経路詳細（`…&journey=N`）」の2階層で、乗り換え時刻や通過バス停は詳細側に表示します（[docs/route-search.md](docs/route-search.md) 6.3）。経路一覧の上下には「1本前 / 1本後」ボタンがあり、先頭の経路を基準に1本ぶんずらして検索し直します（「1本前」は到着時刻指定へ切り替え。同 6.3.1）。検索フォームには折りたたみの「詳細設定」があり、乗り換え回数（「乗り換えなし」など）・徒歩での乗り継ぎの有無・乗り換えの余裕時間を指定できます。**既定は絞り込みなしの条件**で、既定値の項目はURLにも載せません（同 5.8・6.2）。スポット検索（`/spotsearch`）は地名（観光スポット・その他のスポット）・バス停・路線を1つ入力すると、スポット情報＋付近のバス停＋周辺を通る路線を表示し、路線名クリックでリアルタイム時刻表（`#/realtime/{feedId}/{routeId}`）・バス停名タップでバス停ページへ遷移します（[docs/spot-search.md](docs/spot-search.md)）。
- `frontend/admin.html`: 認証で保護された管理画面（運行ダッシュボード・便の割当監視・予測精度の監視・当日の状況・異常アラート・GTFS/位置情報フィード監視・API稼働監視・ジョブ監視・お知らせ編集・バス停お知らせ・祝日カレンダー・外部IDマッピング・方向マッピング・リアルタイム休止・運用パラメータ設定・観光スポット管理・観光スポットの検索・アクセス数・車両名・メモ管理）。「リアルタイム休止」は、突発的な運休・輸送障害でGPS由来のリアルタイム情報が実態と食い違うとき、路線ごとにリアルタイム表示だけを利用者向け画面（リアルタイム運行状況・バスマップ・経路検索の重ね合わせ・便詳細のリアルタイム切替・接近中のバス）から一時的に止めるキルスイッチです。時刻表ベースの表示・経路探索・管理画面の運行監視は影響を受けません（`route_realtime_suspensions`テーブル、[docs/realtime-suspension.md](docs/realtime-suspension.md)）。「バス停お知らせ」は、バス停詳細ページに出る見出し＋画像＋本文のお知らせで、バス停単位（常に表示）と乗り場単位（乗り場別表示のときだけ）の2つの配信範囲がある（`busstop_notices`テーブル、[docs/busstop-notices.md](docs/busstop-notices.md)）。車両名・メモ管理（`vehicle_labels`テーブル、キーは`car_id`）で名前を付けた車両は、運行ダッシュボードの便詳細セクションで車両IDの代わりに名前で表示され、名前タップでメモが出ます。「観光スポット管理」ではタブ区切りテキストの1列目に指定するID（`tourist_spots.id`）で各スポットを識別し（名称による名寄せはせず、IDが同じなら改称しても同一スポット）、写真を「,」区切りで複数枚登録できます。別称（`aliases`、「からす城」「国宝」など）を「,」区切りで登録すると、その呼び名でも経路検索の出発地・目的地やスポット検索の候補に出せます（検索補助用。利用者画面には表示しません）。別メニュー「観光スポットの検索・アクセス数」でスポット検索の検索回数（`spot_search_counts`）と公式サイトリンクのタップ回数（`tourist_spot_link_clicks`）を指定期間（最大1年）でまとめて集計し、掲載の有用性を確認できます（[docs/spot-search.md](docs/spot-search.md) / [docs/tourist-spots.md](docs/tourist-spots.md)）。
- `frontend/spot-photos.js`: 観光スポットの写真表示の共通モジュール（`window.SpotPhotos`）。バス停ページ・経路検索のスポット詳細ポップアップ・スポット検索が、1枚ずつ表示するカルーセル（複数枚は5秒間隔の自動送り＋スワイプ／矢印／インジケーター）を描画するのに使う。`busstop.js`・`routesearch.js`・`spotsearch.js` より前に読み込む（[docs/tourist-spots.md](docs/tourist-spots.md) の「写真表示（カルーセル）」）。
- `frontend/style.css`: 共通スタイル。
- `frontend/vendor/`: **Tailwind CSS と Leaflet をリポジトリに同梱**したもの（CDNからは読み込みません）。中身はサードパーティ製の配布物そのままなので手で編集せず、更新は[frontend/vendor/README.md](frontend/vendor/README.md)の手順で行ってください。`leaflet.css`が`url(images/…)`と相対参照しているため`leaflet/images/`を消さないこと。Tailwindはファイル名にバージョンが入るので、更新時は参照している4つのHTML（`index.html`・`admin.html`・`howto.html`・`servicestatus.html`）を全部書き換えます。

> **`index.html`の静的ファイル参照は必ず絶対パス（`/app.js`など）にすること。** 時刻表検索は`/timetable/stops/{stop_id}`のような階層のあるURLを使うため、相対パスだと`/timetable/stops/app.js`を読みに行き、サーバーのSPAフォールバックがindex.htmlを返してスクリプトが一切動かなくなります。

---

## 8. 環境変数一覧

| 変数名 | 既定値 | 用途 |
|---|---|---|
| `PORT` | `3000` | HTTPサーバーのポート |
| `SHUTDOWN_TIMEOUT_MS` | `8000` | グレースフルシャットダウンの猶予（ミリ秒）。SIGTERM/SIGINT受信時に「タイマー停止 → HTTPサーバー`close()` → DBプール`end()`」がこの時間で終わらなければ強制終了する。Dockerの`stop`→SIGKILL既定10秒より短く |
| `TZ` | - | コンテナ／プロセスのローカルタイム。`docker-compose.yml`は`backend`に`Asia/Tokyo`を設定（ログの時刻表記用。アプリのコードは時刻をすべて明示的にJSTで扱うため挙動には影響しない）。`db`コンテナには設定していない（`CURRENT_DATE`の評価が変わるため。[docs/system-review-2026-09.md](docs/system-review-2026-09.md) DB-1） |
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
| `GPS_TIMEOUT_TERMINAL_RADIUS_METERS`※ | `300` | GPS途絶時、未到達バス停が終点のみ残っている場合の「終点到着」救済判定の半径（m） |
| `GPS_STALE_TIMEOUT_MIN`※ | `6` | GPSがこの時間（分）以上更新されていない車両を「GPS途絶」とみなす（短すぎると一時的な測位不良で便がリアルタイム表示から外れやすい。[docs/known-issues.md](docs/known-issues.md) H-2） |
| `VEHICLE_MAX_AGE_MIN`※ | `120` | 割り当ての強制終了までの経過時間（分） |
| `FINISH_PROTECTION_MIN`※ | `10` | 運行終了判定を開始しない保護期間（分） |
| `DAILY_TRIP_RETENTION_DAYS`※ | `7` | 当日便（`daily_trips`）の保持日数。ETA予測根拠のログ（`trip_arrival_prediction_log`）もCASCADEでこの期間 |
| `GPS_LOG_RETENTION_HOURS`※ | `48` | GPSログの保持時間（車両行を削除しなくなったため必要） |
| `COMPLETED_TRIP_RETENTION_DAYS`※ | `7` | 運行実績アーカイブ（`completed_trips` / `completed_trip_stop_times`）の保持日数。区間平均（`segment_travel_stats`）はクローズ時に反映済みのため影響なし。管理画面「運行実績ダウンロード」でエクスポートできるのもこの期間内の便だけ |
| `SEGMENT_STATS_MAX_SAMPLES`※ | `500` | 区間統計の実効サンプル数上限。超えると指数移動平均に切り替わり古い実績を徐々に忘れる（ダイヤ改正・道路事情の変化への追従用） |
| `ETA_BLEND_WEIGHT`※ | `0.55` | ETA予測における過去統計への信頼度（0〜1） |
| `NIGHT_START` / `NIGHT_END`※ | `23:00` / `05:00` | 深夜帯の範囲。この間は**当日便の生成（①）だけが動き、位置情報の取得〜到着予測（②〜⑧。車両割り当てを含む）は止まる**（最早便が5:40発のため、当日便の生成まで止めると始発に間に合わない）。ただし**始発時刻が来ているのに未割り当ての便が残っている間は運行処理も継続する**（`NIGHT_END`を早朝便より後ろへ設定した場合の安全弁）。不正な書式を設定した場合は既定値で動く |
| `HIGH_LOAD_VIEWER_THRESHOLD`※ | `50` | サーバー高負荷とみなす同時アクティブ閲覧数 |
| `ADMIN_STALE_GPS_MIN` / `ADMIN_DELAY_ALERT_MIN` / `ADMIN_SEVERE_DELAY_MIN` / `ADMIN_UNASSIGNED_OVERDUE_MIN` / `ADMIN_ETA_STALE_MIN`※ | `5` / `5` / `15` / `5` / `10` | 管理画面ダッシュボード・アラート表示のしきい値（分） |
| `SERVICE_STATUS_POLL_INTERVAL_MIN`※再起動要 | `60` | アルピコ運行状況スクレイピングの間隔（分） |
| `ALPICO_STATUS_URL` | - | アルピコ交通「現在の運行状況」ページのURL |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / (未設定なら起動ごとにランダム生成) | 管理画面の認証情報。**`ADMIN_PASSWORD`未設定だと起動のたびに変わるランダム値になり、パスワードは起動ログにしか出ないため、公開環境では必ず設定すること** |
| `ADMIN_SESSION_TTL_MIN` | `720` | 管理者セッション（httpOnly Cookie）の有効期限（分）。スライド更新なしの絶対期限 |
| `ADMIN_SESSION_COOKIE_SECURE` | `auto` | セッションCookieの`Secure`属性。`auto`＝HTTPSで届いたとき／`FORCE_HTTPS`時に付ける。`true`/`false`で強制も可 |
| `TRUST_PROXY` | - | Expressの`trust proxy`。リバースプロキシ配下では必須（`1`＝1段）。**未設定だと全利用者が同一IP扱いになりレートリミットが正しく効かず、`req.secure`も常にfalseになる** |
| `FORCE_HTTPS` | `false` | 平文HTTPで届いたリクエストをHTTPSへ寄せる（GET/HEADは301、それ以外は403） |
| `HSTS_MAX_AGE_SEC` / `HSTS_INCLUDE_SUBDOMAINS` | `15552000` / `false` | `Strict-Transport-Security`の内容。HTTPSで届いたリクエストにだけ付く。`0`でHSTS自体を出さない |
| `CSP_MODE` | `off` | `Content-Security-Policy`。`off` / `report-only` / `on`。有効化前に`report-only`で全画面を一巡すること |
| `CORS_ALLOWED_ORIGINS` | - | 公開APIで許可するオリジン（カンマ区切り）。空なら全オリジン許可。**管理API（`/api/admin/*`）にはこの設定に関係なくCORSヘッダーを付けない** |
| `RATE_LIMIT_ENABLED` | `true` | 下記レートリミットのマスタースイッチ |
| `ADMIN_AUTH_MAX_FAILURES` / `ADMIN_AUTH_WINDOW_MIN` | `10` / `15` | 管理画面の認証失敗がこの回数を超えたIPをこの分数ブロックする（総当たり対策）。数えるのは資格情報を提示して外したときだけ |
| `ROUTE_SEARCH_RATE_LIMIT_PER_MIN` | `240` | `/api/route-search`（RAPTOR探索）の1IP・1分あたりの上限。`0`で無効 |
| `COUNT_RATE_LIMIT_PER_MIN` | `240` | 集計値を増やす系（`/api/spot-search`・`/api/tourist-spots/:id/link-click`）の1IP・1分あたりの上限。`0`で無効 |
| `VISITOR_MAX_CLIENTS_PER_IP` | `200` | サイト閲覧数（`X-Client-Id`）を1IPあたり何種類まで数えるか。`0`で無制限。上限に達してもリクエスト自体は通る（数えないだけ） |
| `HEALTHZ_PIPELINE_STALE_SEC` | `300` | `GET /healthz`：メインパイプライン1周期がこの秒数を超えて完了していなければ`503`。起動直後の猶予にもこの値を使う |
| `HEALTHZ_GTFS_STALE_SEC` | `10800` | `GET /healthz`：GTFSフィードの最終取得がこの秒数より古いと`gtfs.stale`を`true`にする（情報のみ。`healthy`判定には使わない） |
| `HEALTHZ_DB_TIMEOUT_MS` | `3000` | `GET /healthz`：DB疎通確認がこの時間で返らなければ「DB応答なし」とみなす |

> **セキュリティ関連の設定（`ADMIN_SESSION_*`・`TRUST_PROXY`・`FORCE_HTTPS`・`HSTS_*`・`CSP_MODE`・`CORS_ALLOWED_ORIGINS`・レートリミット各種）は、意図的に管理画面から編集できません。** 定義は[backend/src/config/security.js](backend/src/config/security.js)にまとまっており、変更にはデプロイが必要です。レートリミットの上限やセッションの有効期限を管理画面から変えられると、設定ミスがそのまま管理画面自身へのロックアウト（＝復旧手段が無い状態）になるためです。既定値はすべて「設定しなければこれまでどおり動く」側に倒してあります。`HEALTHZ_*`（ヘルスチェックのしきい値。[backend/src/services/healthCheck.js](backend/src/services/healthCheck.js)）も同じく環境変数だけで、管理画面からは編集できません。

> ※印の項目は、環境変数に加えて**管理画面「運用パラメータ設定」**（`GET/PUT/DELETE /api/admin/runtime-settings`）からも編集できます。優先順位は「管理画面での上書き値(DB) > 環境変数 > コード既定値」で、管理画面で編集しなければこれまでどおり環境変数（未設定ならコード既定値）だけで動きます。定義一覧は[backend/src/config/runtimeSettingsCatalog.js](backend/src/config/runtimeSettingsCatalog.js)。「再起動要」の2項目（ポーリング間隔）は`setInterval`の間隔として起動時にしか読まれないため、管理画面で変更してもサーバー再起動まで反映されません。それ以外は次回のパイプライン実行（既定60秒間隔）までに反映されます。
>
> 位置情報CSVやGTFS ZIPのURL、および位置情報フィード⇔GTFSフィードの対応は、環境変数でもDBでもなく**`backend/src/config/feeds.js`（コード）**で管理されます。変更にはデプロイが必要です（管理画面からは編集できません）。一方、**外部ID⇔route_idの対応は`route_external_ids`テーブル（DB）**で管理され、管理画面「外部IDマッピング」から編集できます（[docs/feed-config.md](docs/feed-config.md)）。

---

## 9. セットアップ・起動方法

### Dockerで起動する場合（推奨）

```bash
docker compose up --build
```

`docker-entrypoint.sh`が起動時に自動で以下を行います：DB接続待機 → `migrate.js`（スキーマ適用）→ `seed.js`（GTFSマスタデータ投入）→ `server.js`起動。`http://localhost:3000` で利用者向け画面、`http://localhost:3000/admin` で管理画面にアクセスできます。`docker-compose.yml`にはPostgreSQL（dbサービス）も含まれています。イメージのビルドは`package-lock.json`に固定したバージョンを`npm ci`で再現インストールします。

- **`.env`は無くても起動できます**（`db`サービスの既定値とコード既定値が一致するため）。`ADMIN_PASSWORD`・`TRUST_PROXY`・`FORCE_HTTPS`など設定を変えたいときだけ、`docker-compose.yml`と同じ階層で `cp backend/.env.example .env` してから編集してください（`env_file`は`required: false`＝任意。Compose v2.24以降が必要）。
- **GTFSデータは名前付きボリューム`gtfs_data`に保存されます。** コンテナを作り直しても、最後に取得したGTFS（ダイヤ改正を反映済みの版）が保持され、イメージ同梱の古い版へ巻き戻りません。初回作成時はイメージの内容で初期化されます。
- **停止（`docker compose stop` / `down`、デプロイ）はSIGTERMで受け、進行中のリクエスト・DBクエリの完了を待ってから終了します**（既定`SHUTDOWN_TIMEOUT_MS`＝8秒で打ち切り）。

`backend`サービスには`GET /healthz`（DB疎通・直近パイプライン完了・GTFS鮮度を返す）を叩くhealthcheckが設定してあり、`docker compose ps`で「起動したが不健全」を確認できます。正常時は`200`、DB不通またはパイプラインが詰まっているときは`503`を返します。

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

### 本番公開時に必ず行うこと

このアプリ自体はTLS終端を行いません（平文HTTPでポートを開くだけです）。公開する場合は
**前段にリバースプロキシ（nginx / Caddy / Cloudflare 等）を置いてHTTPSで終端**し、`.env`に次を設定してください。

| 設定 | 理由 |
|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `ADMIN_PASSWORD`未設定だと起動ごとに変わるランダム値になり、確認には起動ログを見る必要があります |
| `TRUST_PROXY=1` | クライアントIPの判定（レートリミットの単位）とHTTPS判定（HSTS・`Secure` Cookie）に必要。**未設定だと全利用者が同一IP扱いになります** |
| `FORCE_HTTPS=true` | 平文HTTPで届いたリクエストをHTTPSへ寄せます（GET/HEADは301、それ以外は403） |
| `CORS_ALLOWED_ORIGINS` | 公開APIを叩けるオリジンを絞ります（未設定なら全オリジン許可のまま） |

管理画面のログイン情報は**ブラウザに保存されません**（サーバー側セッション＝httpOnly Cookie）。
そのぶんサーバーを再起動・デプロイするとセッションが失効し、再ログインが必要になります。
`CSP_MODE`は既定`off`です。有効にする場合は`report-only`で全画面を一巡し、
ブロックが出ないことを確認してから`on`にしてください。

---

## 10. 既知の注意点・改善余地

コードを読み解く上で把握しておくと良い、現状のクセや注意点をまとめます（いずれも致命的なバグではありませんが、改修の際は意識してください）。

- **`frequencies.txt`・`translations.txt`・`fare_attributes.txt`・`fare_rules.txt`を`gtfsFeedManager.js`の`REQUIRED_GTFS_FILES`に足してはいけない**。持たないフィードがあると、必須にした瞬間にGTFS更新が全フィードで「必須ファイル欠損」となり、システム全体が止まる。`OPTIONAL_GTFS_FILES`側に置いてあるのは意図的。
- **「同時刻帯＝始発時刻の差が10分以内」を「稼働中の車両は他の便に割り当てない」に単純化しないこと**。8:00便の担当車両が8:11便の担当になるのは仕様上正しい動作（[docs/vehicle-assignment.md](docs/vehicle-assignment.md)参照）。
- **`stops`は物理バス停（`gtfs_stop_id`）＋通過回数（`occurrence`）で一意化されており、`seq_order`は路線内の表示順専用**（`UNIQUE (route_id, direction_id, gtfs_stop_id, occurrence)`）。便ごとの実際の停車順は`schedule_stop_times.stop_sequence`（便自身の中での0始まりの連番）が正であり、`daily_trip_stop_times`/`trip_stop_progress`/`completed_trip_stop_times`等の`seq_order`列もこれを引き継ぐ。`stops.seq_order`を便の順序判定に使わないこと（service_idグループ横断で`seq_order`を共有すると、停車パターンの異なる便で順序が壊れる／別のservice_idグループが同じ行を別バス停のデータで上書きする）。
- **`finishService.closeDailyTrip()`は`reassignOrphanTrips()`（パイプライン⑤）と`finishTrips()`自身（運行日終了の掃除）の2つの独立したタイマーから同じ便に対して同時に呼ばれうる**。冒頭の`SELECT … FOR UPDATE`による行ロックで、後発側は先発側の`COMMIT`後に`closed_at`を確認して即座に抜けるため、実績が二重に`completed_trips`へアーカイブされることはない（安全網として`UNIQUE (daily_trip_id, assignment_id)`制約もある）。同様に`etaPredictor.updateSegmentStats()`も両タイマーから呼ばれるため、対象行の取得を`FOR UPDATE SKIP LOCKED`にし、`segment_travel_stats`への反映も原子的なUPSERTにしてある。この排他制御を外す・弱める変更をしないこと（詳細は[docs/trip-lifecycle.md](docs/trip-lifecycle.md)・[docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md)）。
- **当日便の生成は「カレンダーを読めなかった」回に確定させない**: `ensureDailyTrips()`が`builtServiceDate`を立てると以降のポーリングは即リターンするため、読み込み失敗を「今日は運行なし」として確定させると当日便0件のまま固定され、GTFS再取得が成功する（＝`invalidateDailyTripCache()`）まで復旧しません。`getActiveServiceIdsWithStatus()`の`complete`を見て、不完全な回は確定させず5分後に再試行し、GTFSから消えた便の掃除もスキップします。
- **24時以降の便の時刻表記**: `utils/time.js`に用途の違う2つの変換関数がある。`minutesToTimeStr()`は**実時刻**用で24時を折り返す（1500分 → `"1:00"`。ETA予測の到着時刻・通過判定の補間時刻はこちら）。`minutesToServiceTimeStr()`は**運行日の0時起点表記**用で折り返さない（1500分 → `"25:00"`）。`daily_trips.start_time`と`daily_trip_stop_times.scheduled_time`はGTFSの表記をそのまま持つ列なので、frequencies由来の仮想便も必ず後者で作ること。前者を使うと同じ運行日の同じ時刻が素の便`"25:00"`／仮想便`"1:00"`と2通りに割れ、便詳細URLの`departure_time`突合（`realtimeTripLookup.findLiveAssignment()`）が外れる。なお深夜帯停止（23:00〜05:00）でGPS取り込みと運行処理自体が止まるため、24時超え便の**リアルタイム運行判定**は依然として対象外。
- **遅延分数は「0以上に丸めた値」と「符号付きの値」の2本立て**: `computeDelayMinutes()`（0以上）が公開画面の遅延表示・遅延アラートのしきい値・ETA予測の正であり、`computeSignedDelayMinutes()`（負＝早発・早着）は事後検証用に`*.signed_delay_minutes`列へ保存するためのもの。表示・判定側を符号付きに差し替えないこと（公開画面が「−3分遅れ」と出る）。逆に、早発が起きたという事実は符号付き列にしか残らないので、そちらを0で埋めないこと。
- **`getDayType()`（`utils/time.js`）と`getActiveServiceIds()`（`gtfsCalendar.js`）は別の曜日区分ロジック**であり、意図的に分離されています。前者はETA統計のバケット分け専用（日曜固定＋`holidays`テーブルによる祝日カレンダー対応）、後者はGTFSの正式なcalendar.txt/calendar_dates.txtに基づくダイヤ選択用です。混同しないよう注意してください。
- **祝日カレンダー（`holidays`テーブル）**: `utils/japaneseHolidays.js`が国民の祝日を年単位で算出する。`seed.js`の`seedHolidays()`は「その年のデータが1件も無い場合だけ」自動投入する設計で、管理画面からの追加・削除を、GTFS更新に伴う`seed()`実行で上書きしないようにしている。祝日データを更新した際は`services/holidayCalendar.js`の`invalidateHolidayCache()`でキャッシュ（TTL1時間）を破棄する必要がある。`completed_trips.day_type`は便アーカイブ時点の祝日カレンダーで確定した値をそのまま保存するため、後から祝日を追加・削除しても**過去にアーカイブ済みの統計は遡って再集計されない**点に注意。

---

## 11. テスト

`backend/test/`に、DBやネットワークを必要としない純粋関数の現在の挙動を固定する回帰テストがあります。`npm test`（`backend/`から）で実行します。lint設定は現状ありません。

---

## 12. 詳細ドキュメント一覧（`docs/`）

| ドキュメント | 内容 |
|---|---|
| [docs/vehicle-assignment.md](docs/vehicle-assignment.md) | 便起点のデータモデルと車両割り当ての判定条件・処理順序 |
| [docs/pass-detection.md](docs/pass-detection.md) | バス停通過判定・欠落補完の詳細 |
| [docs/trip-lifecycle.md](docs/trip-lifecycle.md) | 運行終了判定・便のクローズ・アーカイブの詳細 |
| [docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md) | 到着予測アルゴリズムの詳細（プリコンピュートのタイミングを含む） |
| [docs/timetable-search.md](docs/timetable-search.md) | 時刻表検索機能の詳細 |
| [docs/route-search.md](docs/route-search.md) | 経路検索エンジンの設計・アルゴリズム詳細 |
| [docs/spot-search.md](docs/spot-search.md) | スポット検索（簡易的な路線・バス停検索）の仕様 |
| [docs/feed-config.md](docs/feed-config.md) | フィード構成・外部IDマッピングの管理方法 |
| [docs/tourist-spots.md](docs/tourist-spots.md) | 観光スポット情報機能の仕様 |
| [docs/busstop-notices.md](docs/busstop-notices.md) | バス停お知らせ配信（バス停単位／乗り場単位、見出し＋画像＋本文）の仕様 |
| [docs/realtime-suspension.md](docs/realtime-suspension.md) | リアルタイム休止（路線ごとにリアルタイム表示だけを一時停止するキルスイッチ）の仕様 |
| [docs/database.md](docs/database.md) | DBスキーマのテーブル一覧・役割 |
| [docs/api-reference.md](docs/api-reference.md) | APIエンドポイント一覧 |
| [docs/known-issues.md](docs/known-issues.md) | 現行コードに残っている既知の課題（未対応） |

開発ルール・現在の設計上の重要な注意点は[CLAUDE.md](CLAUDE.md)にまとめてあります。
