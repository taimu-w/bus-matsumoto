# CLAUDE.md

このファイルは、このリポジトリで作業するClaude Code（claude.ai/code）向けのガイダンスです。

## 言語方針

- ユーザーへの応答は日本語で行うこと。
- コード中のコメントは日本語を中心に書くこと。
- `README.md`をはじめ、このリポジトリ内で新規作成・更新する`.md`ファイルは日本語を中心に記述すること。

## 概要

松本市内の路線バス（ぐるっと松本バス・アルピコ交通・松本市営など）向けの、GPSベースのSPAウェブアプリケーションです。

複数事業者のGPS位置情報フィードと複数のGTFSフィードを取り込み、GTFS上の便に車両を割り当て、遅延を計算し、到着時刻を予測して、利用者向け運行状況画面と管理画面にAPI経由で配信します。

便への車両割り当ての設計は[docs/vehicle-assignment.md](docs/vehicle-assignment.md)にまとめてあります。

**アーキテクチャ・データフローの全体像は[README.md](README.md)、各機能の詳細な挙動は[docs/](docs/)以下の各ドキュメントにまとめられています。大きめの変更を行う前に必ず関連するものを読んでください。** なぜ現在の構造になっているのか（うっかり再発させやすい実際のバグへの意図的な回避策を含む）が説明されています（下記の「既知の注意点」も参照）。

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

`backend/test/`に、DBやネットワークを必要としない純粋関数（`utils/time.js`・`utils/geo.js`・`utils/kana.js`・`services/gtfsFrequencies.js`・`config/directionMapping.js`、および`services/busStopApproaching.js`・`services/gtfsCalendar.js`のうちDB/ファイルI/Oを伴わない部分だけを切り出した関数）の現在の挙動を固定する軽量な回帰テストがあります。追加依存なしでNode組み込みの`node --test`（Node 18+）で実行します。`npm test`で実行できます。lint設定は存在しません。テスト・lintのnpmスクリプトを追加する際は、既存の挙動を変えない範囲であることを確認した上で行ってください。

PostgreSQL接続は`DATABASE_URL`（ホスティング環境向け、SSL接続前提）または`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`（ローカル向け）で設定します。調整可能な環境変数（判定半径・タイムアウト閾値・ポーリング間隔など）は`backend/.env.example`を参照してください。**これらの運用パラメータは、環境変数に加えて管理画面「運用パラメータ設定」（`GET/PUT/DELETE /api/admin/runtime-settings`）からも編集できます。** 定義一覧は`backend/src/config/runtimeSettingsCatalog.js`、値の解決（優先順位: 管理画面での上書き値(DB, `system_settings`テーブル) > 環境変数 > コード既定値）は`backend/src/services/runtimeSettings.js`が担います。管理画面で一切編集しなければ環境変数だけで動きます。位置情報フィードやGTFS ZIPフィードのURLは環境変数**でもDBでもなく**、`backend/src/config/feeds.js`（コード）で管理されています（管理画面から編集できません）。外部ID⇔GTFS route_idの対応は`route_external_ids`テーブル（DB）で管理され、管理画面（`/api/admin/route-mappings`）から編集できます。位置情報CSVの方向値⇔GTFS `direction_id`の対応も`route_direction_rules`テーブル（DB）で管理され、管理画面「方向マッピング」（`/api/admin/direction-rules`）から編集できます（行が無い路線は既定で「方向で絞り込まない」）。

## アーキテクチャ

### 便を中心としたデータモデル（最重要）

このシステムは**GTFS上の便を先に生成し、始発時刻になった時点で車両を割り当てる**方式です。

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
updateAllGtfsFeeds()  ⓪ config/feeds.jsに基づきGTFS ZIPを更新（独自のtry/catch、失敗しても後続は継続）
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

**到着予測はパイプラインの⑧番目のステップとしてプリコンピュートされます。** `etaPredictor.js`の`computeAndStoreAllArrivals()`が`delayCalc()`の直後に呼ばれ、全active割り当て（担当・候補とも）の到着予測を一括計算して`trip_arrival_predictions`テーブルへUPSERTします。計算アルゴリズム本体は`predictArrivals(client, assignmentId)`（引数は車両IDではなく**割り当てID**）。`/api/buses`・ルート検索は`getArrivalsForAssignment(client, assignmentId)`で`trip_arrival_predictions`から読み出すだけで、最大60秒のラグと引き換えにDBスパイクと重複計算を排除しています。48時間以上前の予測は`computeAndStoreAllArrivals()`内で毎回掃除されます。詳細は[docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md)。

`backend/src/utils/time.js`と`utils/geo.js`は、ほぼすべてのサービスで使われる共通ヘルパー（時刻文字列の変換、遅延計算、ハバーサイン距離）です。

### 複数フィード対応の設計

**フィード構成（URL・有効/無効・位置情報フィード⇔GTFSフィードの対応）はコード（`backend/src/config/feeds.js`）で管理し、`feeds`テーブルは稼働状態（`last_fetched_at`/`last_status`/`last_error`）の記録のみを担います。** 一方、**外部ID（位置情報CSVの系統ID）⇔GTFS route_idの対応は`route_external_ids`テーブル（DB）で管理し、管理画面から編集できます。** この2つは似て非なる設定で、扱いが異なる点に注意してください。詳細は[docs/feed-config.md](docs/feed-config.md)。

- 位置情報フィードがどのGTFSフィードの路線を解決対象にするかは、`config/feeds.js`の`gtfsFeedIds`（**配列**）で明示します。アルピコ交通のように複数のGTFSフィードにまたがる事業者を1件へ畳まないための配列です。こちらは**コード側を編集してデプロイします**（静的設定であり、誤設定が黙って通るリスクの方が大きいという判断）。
- 外部ID（位置情報CSVの系統ID）から路線を引く対応表は`route_external_ids`テーブル（`external_id`が主キー、`route_id`が**qualified route id**`feedId:routeId`、`note`が備考）にあり、管理画面「外部IDマッピング」（`GET/POST/DELETE /api/admin/route-mappings`）から追加・変更・削除できます。**路線名による解決はしません**（`routes.name`の文字列一致だと「ケ/ヶ」のような表記ゆれ1文字で対応が黙って欠落するため）。管理画面は路線を`/api/routes`の候補一覧から選ばせる方式にしてあり、保存API側でも`route_id`が`routes`テーブルに実在するかを検証して存在しなければ拒否します。`route_id`が`NULL`の行は「外部IDは判明しているが対応するGTFS路線がまだ存在しない」ことを表し（`note`に理由を書く）、消さずに残すことで路線が後から追加された時に再調査せずに済みます。
- 実行時の参照は`backend/src/services/routeExternalIdMapping.js`（TTL付きメモリキャッシュ、既定1時間）経由です。管理画面から追加・変更・削除した際は`invalidateRouteExternalIdCache()`で即時に破棄するため、反映までは次回ポーリング（最大60秒）で済みます。起動時（`seed.js`の`validateCodeConfig()`）に、`route_external_ids.route_id`が実際の`routes`テーブルに存在するかを検証し、存在しなければ警告ログを出します（起動は止めません）。
- 位置情報CSVの方向値⇔GTFS `direction_id`の対応は`route_direction_rules`テーブル（`route_id`が主キー、qualified route id）にあり、管理画面「方向マッピング」（`GET/POST/DELETE /api/admin/direction-rules`）から編集できます。**行が無い路線は既定で`ignore`（方向で候補車両を絞り込まない）。テーブルが空＝全路線ignoreで、初期投入はしません。** `mode:'map'`の路線だけ`value_map`でCSV値→`direction_id`変換します。実行時の参照は`services/directionRules.js`のTTLキャッシュ経由で、`isDirectionIgnored()`/`resolveDirectionId()`は**同期関数**です（`runtimeSettings.js`と同じ理由。DB読み込み`refreshDirectionRulesCache()`は`jobs/pipeline.js`先頭とサーバー起動直後に実行。管理画面での保存/削除直後は`invalidateDirectionRulesCache()`で次回tick（最大60秒）反映）。純ロジック・入力検証は`config/directionMapping.js`（DB非依存）。詳細は[docs/feed-config.md](docs/feed-config.md)。
- 異なるGTFSフィード間でroute_idをグローバルに一意にするため、プレフィックス方式（`feedId:routeId`）を使っており、`gtfsFeedManager.js`の`qualifyRouteId`/`unqualifyRouteId`が変換を担います。`service_id`（`feedId:service_id`）も同様のパターンです。

### 車両割り当ての判定条件（`services/tripAssignment.js`）

始発時刻（`ASSIGN_DELAY_SEC`＝既定60秒だけ待ってから評価）に、次を満たす車両を候補にします。

1. 便と同じ路線（`vehicles.route_id`はqualified route id なのでGTFS側と直接比較できる）
2. **始発時刻の3分前〜始発時刻（閉区間）** に存在する最新GPS1点。始発時刻を1秒でも過ぎたGPSは無効
3. 始発バス停から`ASSIGN_RADIUS_METERS`（既定100m）以内。通過判定の120mとは別の設定値なので共用しないこと
4. `route_direction_rules`（管理画面「方向マッピング」で編集、`services/directionRules.js`が参照）のdirection条件。既定（行が無い路線）・`mode:'ignore'`の路線、および車両側の方向が不明（NULL）の場合は方向で絞り込まない
5. 同時刻帯（始発時刻の差が10分以内）の別便の担当車両になっていない

距離が最も近い車両を担当車両にし、残りも候補車両として記録します。便は始発時刻の早い順に1件ずつ確定させるため、直前の便で担当になった車両は次の便の判定に自動的に反映されます。

### 到着予測（`services/etaPredictor.js`）

過去の区間別走行時間統計（`segment_travel_stats`、曜日区分×時間帯でバケット化）と、その日の走行ペースを組み合わせます。データの有無に応じて段階的にフォールバックします：過去統計+ペース補正 → 時刻表所要時間×ペース補正 → 時刻表差分そのまま → 固定5分。定刻を持たない区間は`naive_anchored`で別途処理し、直近の「定刻を持っていた」バス停まで遡って基準点にします（固定5分の推測が連続で積み重なるのを防ぐため）。完全な判定表（`source`フィールドの値：`schedule`、`actual`、`historical`、`schedule_paced`、`naive`、`through_skip`、`naive_anchored`）は[docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md)を参照してください。

ペース補正は3つのシグナルを動的にブレンドします（`combinePaceFactor`）：`liveFactor`（当該便の直近3区間の実績ペース、0.5〜2.5倍にクランプ）・「今日の前便実績」（同一路線・同方向の当日直前便の実績ペース、`getTodayPreviousTripFactor`）・「周辺道路の最近実績」（対象区間の周辺500m以内を最近走った他便の実績を距離・方位・新しさで重み付け、`getNearbyCandidateSegments`/`computeNearbyFactor`）。サンプル数・重みの合計量に応じた確信度で重み付けし、いずれか欠損時は他のシグナルへ重みが再配分されます（新シグナルが両方欠損すれば`liveFactor`単体に一致）。各新シグナルの基礎重みは`liveFactor`の基礎重み以下に抑えてあり、個々の比率値も0.5〜2.5倍にクランプするため、1便・1区間の異常値がETA全体を支配・暴走させることはありません。詳細（重み表・確信度の算出式）は[docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md)。

### 経路検索（`services/gtfsRouteSearch.js` / `frontend/routesearch.js`）

リアルタイム運行状況とは**探索のデータ経路が完全に独立した機能**です。時刻表検索と同じGTFSインメモリインデックス（`gtfsTimetable.js`）を直接探索します（DBは見ません）。アルゴリズムの詳細は[docs/route-search.md](docs/route-search.md)を参照してください。

- 探索は**DBを一切見ません**。任意の日付で検索でき、当日便の生成状況にも、DBの死活にも影響されません。
- アルゴリズムはRAPTOR型（ラウンド＝乗車回数）。乗換2回まで（フォールバック時3回）、バス停グループ間400m（同800m）以内は徒歩で乗り継げるものとして扱います。
- **出発時刻指定（`runRaptor`）と到着時刻指定（`runRaptorReverse`、`timeMode=arrival`）は、時間軸を反転させた対（つい）の実装です。片方だけを変更しないでください。** 乗車索引と降車索引・乗換余裕を免除するラウンド・探索窓の向き・枝刈りの向きがそれぞれ対応しており、対称性が崩れると「出発時刻指定では出るのに到着時刻指定では出ない区間」が生まれます。対応表は[docs/route-search.md](docs/route-search.md) 5.6にあります。到着時刻指定では最早到着ではなく**最遅出発**を最大化し、並び順・おすすめ判定もそれに合わせて反転します。
- **徒歩の連鎖（徒歩→徒歩）は意図的に禁止しています。** 許すと「4分歩いて5分歩いて…」が最速解になり、現実的でない経路が上位に出ます。
- **徒歩ありの探索結果に、徒歩なしの探索結果を必ず混ぜています。** 徒歩を許すと「1駅手前で降りて歩く」方が最速になり、枝刈りでバスだけの案が消えてしまうためです。
- 結果0件のときは条件を段階的に緩め（`RELAXATION_STEPS`）、それでも0件なら「次の運行日」「その日の始発」「近くのバス停」を返します。**「見つかりませんでした」だけを返さないこと。**
- **詳細設定（乗換回数の上限・徒歩での乗り継ぎ・乗換の余裕時間）は、探索条件を「絞る方向」にだけ効かせます（`applyPreferencesToStep()`）。** 段階的フォールバックは0件のとき条件を緩めますが、利用者が明示した上限は超えさせないでください（「乗り換えなし」で検索したのに段階3のフォールバックで乗換つきの案が出る、という事故になります）。正規化は`normalizeSearchPreferences()`の1箇所に集約し、**未指定・不正値はすべて既定の探索条件へ落とします**（既存のURL・お気に入りの挙動を変えないため）。乗換余裕は探索時とリアルタイム反映後の乗換リスク判定（`flagTransferRisks()`）で同じ値を使ってください。詳細設定つきで0件になったときは、翌日以降を探す前に既定条件で探し直して原因を切り分け、設定が原因なら`no-route-with-conditions`を返して画面に解除の導線を出させます。
- 運賃は`gtfsFare.js`が`fare_attributes.txt`/`fare_rules.txt`（**任意ファイル**）から引きます。該当ルールが無ければ「運賃不明」とし、推測はしません。
- 画面は**「経路一覧」→「経路詳細」の2階層**です（URLは`/routesearch?…`と`/routesearch?…&journey=N`）。一覧は出発／到着時刻・所要時間・運賃・乗換回数・徒歩・おすすめ・直通と路線カラーのバーだけのシンプル表示で、カード全体が詳細を開くボタンです。乗り換え時刻・通過バス停・区間ごとのリアルタイム・便詳細への導線は詳細側にあります。**バッジ・運賃文言・所要時間バーは2画面で同じ関数（`journeyBadges()`/`journeyFareText()`/`renderDurationBar()`）を共用してください**（同じ経路が画面によって違う見た目・違う運賃表記になるのを防ぐため）。詳細内の「前の経路／次の経路」は`replaceState`で移動し（履歴を積まない）、「経路一覧へ戻る」は`smartBack()`でブラウザの戻ると同じ動きにします。`journey`は並び順であって恒久的なIDではないので、指定の経路が無いときは`journey`を外して一覧を表示します（エラーにしない）。
- リアルタイムは**本日の検索のときだけ**、確定した経路に`realtimeTripLookup.js`経由で後から重ねます（重ね合わせに失敗しても定刻で成立させるsoft-fail）。
- `stopKey`は時刻表検索・バス停検索とまったく同じ識別子です。結果のバス停名から`/busstop/{stopKey}`へ、便から`/timetable/trips/...`へそのまま遷移できます。

### 時刻表検索（`services/gtfsTimetable.js` / `frontend/timetable.js`）

リアルタイム運行状況とは**データ経路が完全に独立した機能**です。DB（`stops`/`schedule_*`）を一切使わず、ディスク上のGTFSファイルをそのままの粒度でメモリにインデックス化します。既存の`stops`テーブルはGTFSの`stop_id`・標柱・`stop_headsign`を保持していないため、時刻表検索の要件を満たせないからです。インデックスは30分TTLで、GTFS更新成功時に`invalidateTimetableIndex()`で無効化されます。詳細は[docs/timetable-search.md](docs/timetable-search.md)を参照してください。

- バス停の統合キー：同一ベースID＋同名なら`{stop_id}`、名前が違えば`{gtfs_id}_{stop_id}`。さらに同名かつ400m以内のバス停を1件へ統合し（2フィードに同じ物理バス停が別IDで入っているため）、使われなくなったキーは別名として残します。
- **のりば（標柱）の座標統合**：バス停統合とは別レイヤーで、同一バス停内の標柱のうち座標差0.1m以内のものを1本に畳みます（`mergeCoincidentPlatforms`）。2フィードが同じ物理のりばを別`stop_id`で登録しているため必要。代表標柱（表示名・のりばキー）は`config/feeds.js`の`PLATFORM_DISPLAY_NAME_FEED_PRIORITY`（既定でぐるっと松本バス1）で選び、両フィードの`stop_times`を代表標柱に合算します。畳んだ標柱の行は`index.stops`に残す（`mergedInto`）＝経路検索が`stop_times`→`groupKey`で解決するため消せません。詳細は[docs/timetable-search.md](docs/timetable-search.md)。
- よみがな・ローマ字は`translations.txt`から取得し、ローマ字が無ければ`utils/kana.js`がヘボン式で自動生成します。漢字→よみがなの変換は行いません。
- 画面は**この機能だけHistory API（パス`/timetable...`）でルーティング**します。他画面はハッシュ（`#/realtime`など）のままです。

### スポット検索（`services/spotSearch.js` / `frontend/spotsearch.js`）

「簡易的な路線・バス停検索」。地名（観光スポット・その他のスポット）・バス停・路線を**1つだけ**入力すると、スポット情報（写真・営業時間等）＋**付近のバス停**＋それらを**通る路線**を返します。経路検索（2点入力のRAPTOR探索）とは別物で、GTFSインメモリインデックス（`gtfsTimetable.js`）と`tourist_spots`だけを見ます。詳細は[docs/spot-search.md](docs/spot-search.md)。

- `gtfsTimetable.js`の公開関数（`searchStops`/`searchNearbyStops`/`getStopSummariesByKeys`）は**呼ぶだけ**。シグネチャを変えないこと。
- 付近のバス停は緯度経度の近接検索で**参照時に**都度解決（観光スポット情報機能と同じ方針。半径既定500m）。
- 路線サジェスト・路線解決・結果に載せる路線は**`routes`テーブルに実在する路線だけ**に絞ります（`#/realtime/{feedId}/{routeId}`が必ず開けるようにするため）。路線名の一致は`normalizeSearchText()`の正規化テキストのみ（`routes`にはよみがな・ローマ字が無い）。
- 画面はパスルーティング（`/spotsearch`）。路線チップからリアルタイム時刻表（**ハッシュ**ルーティング`#/realtime/...`）へ移るときは`pushState('/#/realtime/...')`でpathnameを`/`に戻してから`renderCurrentRoute()`を呼びます。**自由文字列が路線に解決したリダイレクトだけ`replaceState`**（`?q=`のURLを履歴に残すと戻るたびに再リダイレクトするため）。
- **検索回数（`spot_search_counts`）は`spotSearch.js`が書き、分析用の読み出し（タップ回数とのマージ）も`spotSearch.getSpotEngagementStats()`が担います。`touristSpots.js`は`spot_search_counts`を参照しません**（循環参照防止。依存は`spotSearch.js`→`touristSpots.js`の一方向）。`tourist_spot_link_clicks`と同じく外部キーは張らず、`spot_id=''`（空文字）は「観光スポット以外（バス停・地名）に解決した検索」。
- **観光スポットの識別子（`tourist_spots.id`、TEXT）は管理画面「観光スポット管理」のテキスト一括入力の1列目で管理者が指定します**（`services/touristSpots.js`、[docs/tourist-spots.md](docs/tourist-spots.md)）。名称による名寄せはせず、IDが同じなら名称が変わっても同一スポット。全件洗い替えはこのIDをキーにUPSERT＋テキストに無いIDをDELETE。`tourist_spot_link_clicks`/`spot_search_counts`の`spot_id`もこのIDです。

### フロントエンド

素のHTML/CSS/JS、ビルドステップなし。`frontend/index.html` + `app.js`（利用者向け運行状況画面。20秒間隔で`/api/buses`等をポーリング、お気に入りはlocalStorage、SPAルーティングの入口）。`frontend/timetable.js`（時刻表検索）、`frontend/busstop.js`（バス停検索）、`frontend/stopmap.js`（バス停マップ）、`frontend/routesearch.js`（経路検索）、`frontend/spotsearch.js`（スポット検索。地名・バス停・路線1つから、スポット情報＋付近のバス停＋周辺路線を表示。路線チップでリアルタイム時刻表`#/realtime/...`へ）はいずれもハッシュではなくパスでルーティングします。`frontend/admin.html`（Basic認証で保護された、PC向けサイドパネル型の運行監視コンソール。運行ダッシュボード・車両運用状況・便の割当監視・予測精度の監視・当日の状況（路線別のペース補正状況・遅延メッシュ地図）・異常アラート・GTFS/位置情報フィード監視・API稼働監視・ジョブ監視・お知らせ編集・乗り場お知らせ・祝日カレンダー・外部IDマッピング・方向マッピング・運用パラメータ設定・観光スポット管理・観光スポットの検索・アクセス数（スポット検索の検索回数`spot_search_counts`と公式サイトリンクのタップ回数`tourist_spot_link_clicks`を指定期間でまとめて集計）・車両名・メモ管理・サイト閲覧数・運行実績ダウンロード）。運行ダッシュボード（`admin-dashboard.js`）はバスアイコンをタップすると右パネルにリアルタイム時刻表（定刻＋予測 or 実績）を表示し、各バス停の行をタップすると詳細モーダルで「到着済＝判定方法（付近経由／ベクトル判定／手動 等）と根拠＋遅れ」「未到着＝ETA予測根拠（`source`＋ペース補正の内訳）」を、いずれもETA予測の推移（`trip_arrival_prediction_log`）を折れ線グラフ（横軸＝予測時刻・縦軸＝予測到着時刻・定刻は破線）＋「変化の記録」リストで表示します。このモーダルは15秒ポーリングで更新されますが、レスポンスが前回と同一なら再描画せず、変化があってもスクロール位置を維持します。到着判定時刻を空にして保存するとそのバス停を未到着に戻せます。「異常アラート」の`gpsLostTrip`（GPS途絶で便打ち切り＝`trip_vehicle_assignments.end_reason='GPS更新停止'`）は「地図で検証」ボタンから全画面モーダル（`admin-gps-outage.js`、`GET /api/admin/gps-outage/:assignmentId`）を開き、運行ダッシュボードと同じ地図で「担当開始以降の走行軌跡」「途絶地点（赤）／復旧地点（緑）と継続分数」「途絶時点で時刻表のどこまで進んでいたか」を表示します（走行軌跡は`GPS_LOG_RETENTION_HOURS`＝既定48時間を過ぎると空）。便詳細セクションの車両表示は、管理画面「車両名・メモ管理」（`GET/PUT/DELETE /api/admin/vehicle-labels`、`vehicle_labels`テーブル、キーは`car_id`）で名前を付けた車両は`car_id`ではなく名前で表示し、車両名（名前が無ければ車両ID）タップで車両詳細（直近の運行履歴＝直近の平日1日分・土休日1日分の全便の運行日/路線名/行先/始発時刻、およびメモ）を表示します（`GET /api/admin/vehicle-operation-history/:carId`、`vehicle_operation_history`テーブル）。同じ内容はサイドバー「車両運用状況」（`admin-vehicle-operation-status.js`、`GET /api/admin/vehicle-operation-status`）で全車両ぶん一覧できます。外部IDマッピング・方向マッピングの編集セクションはいずれも路線を`/api/routes`の候補一覧から選ぶ方式で、路線名の自由入力による表記ゆれ事故が起きない設計です。方向マッピングは「方向で絞り込まない（ignore）」と「変換表で判定（map）」を切り替え、mapのときCSV方向値→`direction_id`の変換表とフォールバックを編集します（`admin-direction-rules.js`）。「乗り場お知らせ」（`admin-platform-notices.js`、`platform_notices`テーブル、`services/platformNotices.js`）は乗り場（のりば）ごとの画像/リンクお知らせで、バス停詳細ページ（`busstop.js`）の「このバス停でできること」の下に**乗り場が確定しているとき（乗り場別表示 or 乗り場が1か所）だけ**表示します。すべての乗り場を統合表示しているときや、その乗り場にお知らせが無いときはセクションごと出しません。GTFSインデックスとは`feed_id`+`stop_id`だけで結びつけ（`gtfsTimetable.resolvePlatformRef()`で解決）、`tourist_spots`と同じく保存時に固い外部キーを張りません。詳細は[docs/platform-notices.md](docs/platform-notices.md)。

## 既知の注意点（理解せずに「修正」しないこと）

- **`frequencies.txt`・`translations.txt`・`fare_attributes.txt`・`fare_rules.txt`・`feed_info.txt`を`gtfsFeedManager.js`の`REQUIRED_GTFS_FILES`に足してはいけません。** 持たないフィードがあると、必須にした瞬間にGTFS更新が全フィードで「必須ファイル欠損」となり、システム全体が止まります。`OPTIONAL_GTFS_FILES`側に置いてあるのは意図的です（`translations.txt`が無い場合の扱いは`gtfsTimetable.js`が、運賃ファイルが無い場合の扱いは`gtfsFare.js`が「運賃不明」として吸収します。`feed_info.txt`が無い場合のGTFS有効期間は`gtfsTimetable.js`の`computeFeedValidity()`が`calendar.txt`／`calendar_dates.txt`から推定します）。
- **`frontend/index.html`の静的ファイル参照は必ず絶対パス（`/app.js`・`/style.css`）にしてください。** 時刻表検索は`/timetable/stops/{stop_id}`のような階層のあるURLを使うため、相対パスだとブラウザが`/timetable/stops/app.js`を取りに行き、サーバーのSPAフォールバックがindex.htmlを返してスクリプトが一切動かなくなります。
- **`services/routeSearch.js`へ経路探索を戻さないでください。** 現在このファイルに残っているのは`/api/stops/search`用のDB検索だけです。経路探索は`services/gtfsRouteSearch.js`（GTFSインデックス直読み）が担当します。
- **曜日区分・運行日判定のロジックは用途ごとに3つ独立しています。統合しないでください。** `utils/time.js`の`getDayType()`（ETA統計のバケット分け専用）、`gtfsCalendar.js`の`getActiveServiceIds()`（当日便生成専用。DB保存形式の文字列を返し、有効期間チェックなし）、`gtfsTimetable.js`の`getActiveServices()`（時刻表検索専用。任意の日付・有効期間チェック・表示ラベルあり）。
- **「同時刻帯＝始発時刻の差が10分以内」という重複割り当て防止のルールを、「稼働中の車両は他の便に割り当てない」に単純化しないでください。** 8:00便の担当車両が8:11便の担当になるのは仕様上正しい動作です。判定は`tripAssignment.js`の`hasSamePeriodConflict()`に集約してあります（`ASSIGN_SAME_PERIOD_MIN`、既定10分）。
- **通過バス停の扱い（`tripAssignment.js`の`openAssignment()` / `delayCalc.js` / `etaPredictor.js`）**：GTFSの`stop_times.txt`に載る行には必ず実際の時刻が入り、「乗車不可／降車不可／その両方（＝真の通過）」は`pickup_type`/`drop_off_type`という時刻とは無関係な別のフラグで表現されます。`is_through`はGTFS本来の意味（`pickup_type=1` かつ `drop_off_type=1`の場合のみ真の通過）で、`scheduled_time`は`is_through`にかかわらず常に実際のGTFS時刻を保持します。あるバス停の`status`が`通過`になるかは`is_through`をそのまま使うだけで決まり、位置ベースの判定（`lastValidSeq`より手前かどうか）は挟みません。`etaPredictor.js`の`through_skip`/`naive_anchored`分岐は「元GTFSフィード側の時刻欠損という外部データ不備に対する保険的フォールバック」で、現行の実データでは発生しません（詳細は[docs/pass-detection.md](docs/pass-detection.md)・[docs/eta-prediction-algorithm.md](docs/eta-prediction-algorithm.md)）。`delayCalc.js`は`scheduled_time`が無いことを理由にステータスを強制上書きしません。
- **`trip_stop_progress`の`arrival_method` / `arrival_evidence`（到着判定方法とその根拠）を`tripAssignment.openAssignment()`のON CONFLICT DO UPDATEのSET句に入れないでください。** `nearby_min_distance_*`とまったく同じ理由で、GTFS再取得（reseed）時に進行中の判定結果・根拠を巻き戻さないためSET句から意図的に外してあります。各到着確定箇所（`passDetection.js`の付近経由/ベクトル/遡及昇格/線形補間、`finishService.js`の終了時昇格/終点救済、`api.js`の手動確定）が個別に書き込みます。管理画面「運行ダッシュボード」のバス停別モーダル表示専用で、通過判定・遅延計算のロジックには影響しません。未到着への差し戻し（`PUT .../stops/:stopId`に空の`actualTime`）はこれらもクリアします（`trip_gps_matches`は消しません＝詳細は[docs/pass-detection.md](docs/pass-detection.md)）。
- **`etaPredictor.js`の`updateSegmentStats()`が`is_official = TRUE`だけを集計するのは意図的です。** 候補車両止まりの記録を混ぜると、別経路をたまたま走っていた車両の所要時間で区間統計が汚染され、担当が切り替わった便では同じ区間を二重計上してしまいます。
- **`completed_trips`/`completed_trip_stop_times`は`COMPLETED_TRIP_RETENTION_DAYS`（既定7日）で掃除されます（`finishService.js`の`purgeOldCompletedTrips()`、データ掃除タイマー1時間間隔）。** ETA予測に使う区間平均（`segment_travel_stats`）は便のクローズ直後に`updateSegmentStats()`がインクリメンタルに反映済みで、生データを消しても平均は変化しません。掃除対象を「`aggregated = TRUE` または `is_official = FALSE`」に限定しているのは、まだ区間統計へ反映されていない正実績を取りこぼさないためと、`is_official = FALSE`の参考記録が永久に`aggregated = FALSE`のまま溜まり続けるのを防ぐためです。この2条件を外さないでください。影響を受ける機能は管理画面「運行実績ダウンロード」だけで、エクスポートできるのは保持期間内の便に限られます。
- **`updateSegmentStats()`が`sample_count`を`SEGMENT_STATS_MAX_SAMPLES`（既定500）で頭打ちにし、上限到達後は指数移動平均（実効重み`k = LEAST(sample_count, N-1)`）へ切り替えるのは意図的です。** 生の走行データが保持期間で消えるため、累積平均のままだと古いサンプルの重みが永久に下がらず、ダイヤ改正・道路事情の変化に平均が追従できなくなります。上限を撤廃して単純累積平均に戻さないでください。
- **`finishService.closeDailyTrip()`冒頭の`SELECT … FOR UPDATE`による行ロック、および`etaPredictor.updateSegmentStats()`の`FOR UPDATE SKIP LOCKED`＋`segment_travel_stats`への原子的UPSERTを外さないでください。** どちらも「便への処理が1箇所からしか呼ばれない」ように見えて、実際には`tripAssignment.reassignOrphanTrips()`（パイプライン⑤、60秒間隔）と`finishService.finishTrips()`自身（運行日終了の掃除、1分間隔）という2つの独立したタイマー・DB接続の両方から同じ便に対して呼ばれます。サーバー起動時に両タイマーがほぼ同時に開始されるため位相が揃いやすく、排他制御を外すと`completed_trips`への実績の二重アーカイブ、`segment_travel_stats`の二重集計が実際に発生します。`completed_trips`の`UNIQUE (daily_trip_id, assignment_id)`制約も同じ対策の一部なので、削除しないでください。
- **バスマップ（`#/busmap`）で`/api/buses-for-map`に特定の`routeId`を決め打ちしないでください。** 全路線を俯瞰する画面なので、1路線に固定するとその路線が運行していない時間帯に0台になります。同じ画面で、地図を作り直すときに`busMarkers`/`userMarker`を捨て忘れると2回目以降に描画されなくなる点、現在地取得を`await`してからバスを取得すると許可ダイアログの間バスが出ない点にも注意してください。
- **`routes/api.js`にルート定義を追加する際は、`router`が`/api`配下にマウントされている前提でパスを書くこと（先頭に`/api`を重ねない）。**
- 上記の3つの曜日区分ロジックについて補足：`getDayType()`は平日/土曜/休日の3区分で、日曜に加えて`holidays`テーブル（`services/holidayCalendar.js`がキャッシュ、`utils/japaneseHolidays.js`が国民の祝日を算出してseed.jsが初期投入、管理画面`/admin`から追加・削除可）に登録された日もholiday扱いになります。`getActiveServiceIds()`はGTFSの正式な`calendar.txt`/`calendar_dates.txt`に基づく当日便生成用の運行日判定です。`getDayType()`自体はDBアクセスを持たない純粋関数のままとし、祝日集合(`holidaySet`)は呼び出し側（`etaPredictor.js`/`finishService.js`）が渡す設計です。
- **`dailyTripBuilder.js`が「既に車両を割り当て済みの便は書き換えない」ガードを持つのは意図的です。** GTFSは1時間ごとに再取得され、成功すると`seed()`が走ってマスタが入れ替わります。このとき走行中の便の定刻まで書き換えると、遅延計算と実績が破綻します。
- GTFSカレンダーの読み込み（`gtfsCalendar.js`）は、`config/feeds.js`で有効な各GTFSフィードのディレクトリから読みます。フィード由来のカレンダーは`feedId:service_id`というプレフィックス規約によって機能しており、別のコードパスがあるわけではありません。
- **有効フィード一覧の取得口は`config/feeds.js`だけです。各サービスが独自に`SELECT ... FROM feeds`を書かないでください。** 同じSQLが複数サービスに重複すると、1箇所でも取り残したときに「サービス間で有効なフィードの認識がずれる」静かなデータ不整合（表示されるのにバスが来ない路線、車両が割り当たらないゴースト便など）を生みます。一覧が欲しくなったら`config/feeds.js`に関数を足してください。
- **`feeds`テーブルへのUPSERT（`seed.js`の`ensureFeedRows()`）で、`last_fetched_at`/`last_status`/`last_error`を`ON CONFLICT DO UPDATE`のSET句に含めてはいけません。** 含めると再起動のたびに稼働状態がリセットされ、「最後に取得に成功したのはいつか」が失われます。逆に`id`/`feed_type`/`name`/`url`/`enabled`はコードが正で、DBを直接編集しても次回起動時に上書きされます。
- **`gtfsTimetable.js`の`listFeedIds()`にある`fs.existsSync()`のフィルタを外さないでください。** これはDB障害対策ではなく「設定にはあるが、まだZIPを展開していないフィード」（初回起動時など）を除外するためのもので、外すと存在しないディレクトリを読みに行って時刻表インデックスの構築が落ちます。
- **`services/runtimeSettings.js`の`getRuntimeSetting()`は意図的に同期関数です。** `tripAssignment.js`・`passDetection.js`・`finishService.js`など多数の同期ヘルパーから呼ばれており、非同期化すると全呼び出し元を`await`化する広範な変更が必要になるためです。実際のDB読み込み（非同期）は`refreshRuntimeSettingsCache()`が別途担い、`jobs/pipeline.js`の先頭・`finishService.finishTrips()`の先頭・サーバー起動時（`server.js`）・管理画面での保存直後に呼ばれます。呼ばれる前やDB接続不可時は環境変数/コード既定値へ自動的にフォールバックするため、このモジュールを一切使わなくても既存の挙動と完全に同じです。同じ理由で`utils/time.js`の`isNightTime()`は引数（`nightStartOverride`/`nightEndOverride`）でオーバーライド値を受け取る設計にしてあり、このファイル自体はDBアクセスを持たない純粋関数のままです（`getDayType()`のholidaySet引数と同じ設計）。
- **`services/directionRules.js`の`isDirectionIgnored()`/`resolveDirectionId()`も同じ理由で同期関数です。** `locationFetcher.js`のCSV行ループ・`tripAssignment.js`の候補ループから何度も呼ばれます。DB読み込み（非同期`refreshDirectionRulesCache()`）は`jobs/pipeline.js`の先頭とサーバー起動時に呼ばれ、管理画面での保存/削除直後は`invalidateDirectionRulesCache()`で次回tick反映になります。読み込み前・DB接続不可時は全路線`ignore`（＝方向で絞り込まない安全側）にフォールバックします。純粋な変換ロジック・入力検証は`config/directionMapping.js`（DB非依存、回帰テストあり）に分けてあります。
- **`route_external_ids`・`route_direction_rules`・`config/feeds.js`の3つは「位置情報とGTFSを結びつける設定」で似ていますが別物です。混同しないでください。** `route_external_ids`＝外部ID⇔route_id（DB・管理画面）、`route_direction_rules`＝CSV方向値⇔direction_id（DB・管理画面・既定ignore）、`config/feeds.js`＝フィードURL/有効無効/位置情報フィード⇔GTFSフィードの対応（コード・要デプロイ）。詳細は[docs/feed-config.md](docs/feed-config.md)。
