# APIエンドポイント一覧（`routes/api.js`）

`router`は`/api`配下にマウントされています。管理系（`/admin/...`）は`requireAdminAuth`で保護されています。

**認証は2経路あり、どちらでも通ります**（判定本体は`services/adminAuth.js`）。

| 経路 | 使う場面 | 内容 |
|---|---|---|
| サーバー側セッション | 管理画面（`admin.html`） | `POST /api/admin/session`で発行される`bt_admin_session` Cookie（httpOnly・SameSite=Strict・既定12時間の絶対期限）。ブラウザ側には資格情報もトークンも残らない。Cookie認証のリクエストは`Origin`ヘッダーが自ホストと一致することも要求する（CSRFの多層防御） |
| Basic認証ヘッダー | curl・監視ツールなど | `Authorization: Basic base64(user:pass)`。従来からある経路で、消すと既存の手順書が黙って壊れるため残してある |

資格情報は`ADMIN_USERNAME`/`ADMIN_PASSWORD`環境変数（既定ユーザー名は`admin`。`ADMIN_PASSWORD`が未設定だと起動のたびに変わるランダム値になり、起動ログに1回だけ出ます）で、比較は`crypto.timingSafeEqual`による定数時間比較です。認証に**失敗**した回数はIPごとに数えられ、`ADMIN_AUTH_MAX_FAILURES`（既定10回）を超えると`ADMIN_AUTH_WINDOW_MIN`（既定15分）だけ429を返します（総当たり対策）。数えるのは「資格情報を提示して外したとき」だけなので、期限切れセッションのポーリングや未ログインの素のアクセスでは増えません。

セッションはプロセス内メモリなので、**サーバーの再起動・デプロイで全て失効します**（＝再ログインが必要）。管理画面は401を受け取るとログイン画面へ戻ります。

## 公開API（利用者向け画面）

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/routes` | 利用可能な路線一覧（GTFSの`routes.txt`由来） |
| GET | `/api/settings` | 通常のお知らせ（`notices`。最大3件・各要素`{title, body, imageUrl, startDate, endDate}`。**配信期間内のものだけ**を返す）・重要なお知らせ（`importantNotice`＝`{body, imageUrl, startDate, endDate}`。配信期間外なら中身は空） |
| GET | `/api/server-load` | 現在のサイト閲覧数とサーバー負荷状況（自動更新の自動OFF判定に使用） |
| GET | `/api/stops` | 全バス停マスタ（時刻表画面・地図表示用） |
| GET | `/api/stops/search` | バス停名の部分一致検索（全路線対応） |
| GET | `/api/timetable` | 本日運行対象の便の時刻表（`daily_trips`ベース。frequencies由来の仮想便も含む） |
| GET | `/api/buses` | **担当車両が割り当てられている当日便のリアルタイム運行状況＋到着予測**（`trip_arrival_predictions`から読み出すだけ。計算はパイプライン側でプリコンピュート済み → [eta-prediction-algorithm.md](eta-prediction-algorithm.md)）。候補車両は公開しない。管理画面「リアルタイム休止」中の路線は`{ buses: [], realtimeSuspended: true, suspensionReason }`を返す（[realtime-suspension.md](realtime-suspension.md)） |
| GET | `/api/buses-for-map` | バスマップ用の走行中バス位置（担当車両のみ・到着予測なしの軽量版）。`routeId`は任意（qualified route id）で、省略時（および`routeId=all`）は全路線を返す。利用者向けバスマップの「路線で絞り込み」セレクトで路線を選んだときだけ付く。リアルタイム休止中の路線のバスは除外し（認証済みの管理画面リクエストは除外しない）、`suspendedRouteIds`（休止中のqualified route id一覧）を常に添える |
| GET | `/api/service-status` | アルピコ交通の運行状況（1時間ごとにスクレイピングしてキャッシュ済み） |

## 経路検索

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/route-search/stops` | 出発地・目的地の候補（漢字/ひらがな/カタカナ/ローマ字。返す`stopKey`は時刻表検索・バス停検索と共通） |
| GET | `/api/route-search` | **1IPあたり`ROUTE_SEARCH_RATE_LIMIT_PER_MIN`件/分の上限あり（既定240。超過時は429＋`Retry-After`）。** 経路検索：乗換2回まで・徒歩接続あり・任意日付・運賃つき。`fromStopKey`/`from`・`toStopKey`/`to`・`date=YYYY-MM-DD`・`time=HH:MM`・`limit`（`departureTime`は`time`の別名として受付）。詳細設定（すべて任意。未指定なら既定の条件）：`maxTransfers=0..3`（`0`＝乗り換えなし）・`allowWalkTransfer=false`（徒歩での乗り継ぎを使わない）・`minTransferMinutes=1..15`（乗り換えの余裕時間）。詳細は[route-search.md](route-search.md) |

## スポット検索

「簡易的な路線・バス停検索」。地名（観光スポット・その他のスポット）・バス停・路線を1つ入力すると、スポット情報＋付近のバス停＋周辺を通る路線を返す。詳細は[spot-search.md](spot-search.md)。

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/spot-search/suggest` | 入力候補（`q`・`limit`）。`{ stops, spots, routes }` をまとめて返す（バス停・観光スポットは時刻表検索／経路検索と同じ検索、路線は`routes`テーブルの名称一致） |
| GET | `/api/spot-search` | **1IPあたり`COUNT_RATE_LIMIT_PER_MIN`件/分の上限あり（既定240。検索回数を増やす副作用があるため）。** スポット検索の実行（`spotId`／`stopKey`／`q` のいずれか、`radius=100..3000`（既定500）、`limit=1..20`（既定8））。対象が観光スポット／その他のスポット／バス停に解決したら検索回数を+1する（`spot_search_counts`）。路線に解決した場合は`{ found:true, resolvedFrom:'route', route }`を返し、フロントがリアルタイム時刻表へ遷移する |

## 時刻表検索・バス停検索

詳細は[timetable-search.md](timetable-search.md)を参照。

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/timetable/stops/search` | バス停名のインクリメンタル検索（漢字/ひらがな/カタカナ/ローマ字） |
| GET | `/api/timetable/stops/map` | バス停マップ用の全バス停一覧（同名で標柱違いは代表点1件に統合済み） |
| GET | `/api/timetable/stops/:stopKey` | バス停の時刻表（標柱一覧・凡例つき。`?date=YYYY-MM-DD`・`?platform=標柱のstop_id`） |
| GET | `/api/timetable/trips/:feedId/:routeId/:tripId/:departureTime` | 便の通過時刻一覧（`?stop=`でハイライト対象を指定） |
| GET | `/api/timetable/trips/:feedId/:routeId/:tripId/:departureTime/realtime` | 上記便のリアルタイム重ね合わせ（リアルタイム休止中の路線は`available:false`） |
| GET | `/api/busstop/search` | `/api/timetable/stops/search`と同一データ |
| GET | `/api/busstop/nearby` | 現在地から近い順のバス停（既定5件） |
| GET | `/api/busstop/:stopKey/approaching` | 現在時刻±30分以内に到着予定の便一覧 |
| GET | `/api/busstop/:stopKey/nearby-spots` | 周辺の観光スポット（`photoUrls`は配列） |
| GET | `/api/busstop/:stopKey/notices` | そのバス停のお知らせ。`{ stopNotices, platformNotices }`。`stopNotices`（バス停単位）は常に返す。`platformNotices`（乗り場単位）は`?platform=`が確定しているときだけ（統合表示なら`[]`）（[busstop-notices.md](busstop-notices.md)） |
| GET | `/api/tourist-spots/:id` | 観光スポット1件の詳細。`:id`は管理画面で指定する識別子。経路検索結果のスポット詳細ポップアップ用 |
| POST | `/api/tourist-spots/:id/link-click` | **1IPあたり`COUNT_RATE_LIMIT_PER_MIN`件/分の上限あり（既定240。タップ数を増やす副作用があるため）。** 公式サイトリンクのタップを記録（`sendBeacon`。URL未登録スポットは無視。結果に関わらず`{ok:true}`。[tourist-spots.md](tourist-spots.md)） |

## 管理API（要認証）

冒頭に書いたとおり、セッションCookieとBasic認証ヘッダーのどちらでも通ります。

| メソッド | パス | 概要 |
|---|---|---|
| POST / GET / DELETE | `/api/admin/session` | 管理画面のログイン・セッション確認・ログアウト。POSTは`{username, password}`を受け取り、成功したら`bt_admin_session` Cookie（httpOnly・SameSite=Strict）をSet-Cookieで返す。GETは`requireAdminAuth`つきで、生きていれば`{ok:true, expiresAt}`。DELETEはサーバー側セッションを破棄しCookieも消す（認証不要＝既に失効したセッションでも消せる）。POSTは認証失敗をIPごとに数え、上限超過で429 |
| GET / PUT | `/api/admin/settings` | お知らせ設定の取得・更新。`notices`（通常のお知らせ配列、最大3件。各要素`{title, body, imageUrl, startDate, endDate}`。`imageUrl`は`https://`のみ、`startDate`/`endDate`は`YYYY-MM-DD`または空＝無期限）と`importantNotice`（`{body, imageUrl, startDate, endDate}`。旧形式の文字列も受理）。GETは配信期間切れも含めた全件を返す |
| GET / PUT / DELETE | `/api/admin/runtime-settings`（`/:key`） | 運用パラメータ（判定半径・タイムアウト・しきい値等）の取得・上書き保存・上書き解除（既定値へ戻す）。定義一覧は[backend/src/config/runtimeSettingsCatalog.js](../backend/src/config/runtimeSettingsCatalog.js) |
| GET / POST / DELETE | `/api/admin/holidays`（`/:date`） | 祝日カレンダーの取得・追加・削除（ETA統計の曜日区分に使用） |
| GET / POST / DELETE | `/api/admin/route-mappings`（`/:externalId`） | 外部ID⇔GTFS route_id対応の取得・追加更新（UPSERT）・削除。`route_id`は`routes`テーブルへの実在チェックあり（路線名による解決はしない） |
| GET / POST / DELETE | `/api/admin/direction-rules`（`/:routeId`） | 方向マッピング（位置情報CSVの方向値⇔GTFS `direction_id`）の取得・追加更新（UPSERT）・削除。`mode`は`ignore`/`map`、`map`時は`valueMap`（`{CSV値: 0|1}`）と`fallback`（`0`/`1`/`null`）。`routeId`は`routes`テーブルへの実在チェックあり。行が無い路線は既定`ignore`。定義は[backend/src/config/directionMapping.js](../backend/src/config/directionMapping.js) |
| GET / POST / DELETE | `/api/admin/realtime-suspensions`（`/:routeId`） | リアルタイム休止（路線ごとの「リアルタイム運行情報の表示」一時停止）の取得・追加更新（UPSERT）・削除（＝再開）。`{routeId, reason, note}`。`routeId`は`routes`テーブルへの実在チェックあり。行があるとその路線は公開画面でリアルタイムを出さず定刻表示に落ちる（時刻表・経路探索・管理画面の運行監視は影響なし）。詳細は[realtime-suspension.md](realtime-suspension.md) |
| GET / PUT / DELETE | `/api/admin/tourist-spots`（`/:id`） | 観光スポット情報の一覧・テキスト一括登録（1列目のIDをキーにした全件洗い替え）・1件削除。`:id`は管理画面で指定する識別子（TEXT） |
| GET | `/api/admin/tourist-spots/link-clicks` | 管理画面「観光スポットの検索・アクセス数」。スポット検索の検索回数（`spot_search_counts`）と公式サイトリンクのタップ回数（`tourist_spot_link_clicks`）をスポットごとに期間集計してマージ（`?from=&to=`、最大1年／未指定は直近30日）。[spot-search.md](spot-search.md) / [tourist-spots.md](tourist-spots.md) |
| GET / POST / PUT / PATCH / DELETE | `/api/admin/busstop-notices`（`/:id`） | バス停お知らせの一覧（無効含む）・新規作成・内容更新・有効無効切替・削除。POSTは`{scope, stopKey, platform, title, imageUrl, body, enabled}`。`scope='platform'`は`stopKey`+`platform`を`resolvePlatformRef()`で正規の`feed_id`+`stop_id`へ落として保存（乗り場が特定できなければ400）、`scope='stop'`は統合バス停キーで保存。画像・本文の少なくとも一方が必須。PUTで配信範囲・対象は変更不可（[busstop-notices.md](busstop-notices.md)） |
| GET / PUT / DELETE | `/api/admin/vehicle-labels`（`/:carId`） | 車両ID（`car_id`）ごとの名前・メモの取得・追加更新（UPSERT）・削除。GETは登録済み一覧に加えて最近観測された車両ID一覧（`knownVehicles`）も返す。PUTで名前・メモがどちらも空の場合は行を削除する。運行ダッシュボードの便詳細セクションで名前表示・名前タップで車両詳細表示に使う |
| GET | `/api/admin/vehicle-operation-history/:carId` | 1台ぶんの「直近の運行履歴」（`history: { weekday: [便...], weekendHoliday: [便...] }`。各バケットは直近1日分の全便を始発時刻昇順で、履歴が無ければ空配列。各便は`serviceDate`/`routeName`/`headsign`/`startTime`ほか）＋車両名・メモ（`carName`/`carMemo`）。運行ダッシュボードで車両名/車両IDをタップしたときの詳細展開用（`vehicle_operation_history`） |
| GET | `/api/admin/vehicle-operation-status` | 管理画面「車両運用状況」。運行履歴のある車両・名前を登録済みの車両ごとに`{ carId, name, history: { weekday: [便...], weekendHoliday: [便...] } }`。`name ASC NULLS LAST, car_id ASC`順 |
| GET | `/api/admin/vehicle-positions-map` | 運行ダッシュボード（地図）の「全車両（直近3分）」モード用。便に割り当てられていない・候補にすらなっていない車両も含め、直近3分以内にGPSを受信した全車両を1台につき最新の1件だけ返す |
| GET | `/api/admin/assignments/:assignmentId` | 運行ダッシュボード（地図）の詳細パネル用。便のリアルタイム時刻表（停車バス停・定刻・実績・予測）と、その車両がこの便を担当してから記録した位置履歴。車両に名前が登録されていれば`carName`/`carMemo`も含む |
| GET | `/api/admin/assignments/:assignmentId/stops/:stopId` | バス停別詳細モーダル用。到着済なら判定方法（`付近経由`/`ベクトル判定`/`手動` 等）と根拠（内積・線分距離・前後GPS点／最接近距離・GPS時刻）＋遅れ、未到着ならETA予測根拠（`source`＋ペース補正の内訳）。いずれもETA予測の推移（`trip_arrival_prediction_log`。実績確定時は`actual`行）を返す |
| PUT | `/api/admin/assignments/:assignmentId/stops/:stopId` | 到着判定時刻（`trip_stop_progress.actual_time`）の手動編集。`actualTime`が`H:mm`なら`到着済`へ手動確定（未到着のバス停も可）、**空なら未到着へ差し戻し**（到着判定・実績・遅れ・判定根拠を消去。`trip_gps_matches`は消さない） |
| GET | `/api/admin/assignment-monitor` | 便ごとの担当・候補・割当時刻・距離・未割当理由（`?date=YYYY-MM-DD`） |
| GET | `/api/admin/gps-outage/:assignmentId` | 異常アラート「GPS途絶で便打ち切り」(`gpsLostTrip`)の「地図で検証」用。`/api/admin/assignments/:assignmentId`の詳細（停車バス停・位置履歴・リアルタイム時刻表）に、途絶の一覧（`outages[]`：途絶/復旧の時刻・座標・継続分数・`ongoing`）と`primaryOutage`（便を打ち切った途絶）、`progressAtLoss`（途絶時点の直近到着済バス停・次のバス停）を添えて返す。走行経路は`GPS_LOG_RETENTION_HOURS`（既定48時間）を過ぎると空になり`historyRetentionExpired: true`で返る |
| GET | `/api/admin/alerts` | 異常アラート（`staleGps`＝車両単位のGPS途絶／`gpsLostTrip`＝GPS途絶で打ち切られた便・未割当便・大幅遅延・予測計算失敗・GTFS取得失敗）。`staleGps`は6分の途絶タイムアウトで`vehicles.status='inactive'`になると消えるが、`gpsLostTrip`は`trip_vehicle_assignments.end_reason='GPS更新停止'`をアンカーにするため復旧後も当日中は残る |
| GET | `/api/admin/gtfs-feeds` | GTFSフィード監視（最終取得時刻・ファイル件数・エラー内容） |
| POST | `/api/admin/gtfs-feeds/:feedId/refetch` | GTFSフィードの手動再取得 |
| GET | `/api/admin/location-feeds` | 位置情報フィード監視（最終受信時刻・受信件数・破棄内訳）。破棄は「路線不一致／時刻異常（書式・古い・未来の内訳つき）／座標異常」に分かれ、時刻の書式エラーは実例を1件添える。路線が一致した行の50%以上が書式エラーなら `lastStatus="error"` になる |
| GET | `/api/admin/api-stats` | API稼働監視（応答時間・エラー率・アクセス数・失敗したエンドポイント） |
| GET | `/api/admin/job-monitor` | ジョブ監視（各パイプライン工程の最終成功時刻・所要時間・失敗履歴） |
| GET | `/api/admin/eta-route-overview` | 「当日の状況」の路線別サマリ（`?date=YYYY-MM-DD`）。路線ごとの稼働中車両数・平均ペース補正（本便／今日の前便実績／周辺道路実績／総合）・平均/最大予測遅延 |
| GET | `/api/admin/delay-mesh` | 「当日の状況」の地図メッシュ（`?cellMeters=100..2000`、既定300）。直近60分の区間実績（他路線含む）を格子に集約し、セルごとの平均ペース比率を返す（`services/delayMesh.js`） |
| GET | `/api/admin/prediction-accuracy` | 予測精度の集計（`?days=7&routeId=...&thresholdMinutes=3&leadBucket=...&stopsBeforeBucket=...`） |
| GET | `/api/admin/operation-records/export` | 運行実績のエクスポート（`?from=YYYY-MM-DD&to=YYYY-MM-DD&routeId=...`）。CSVの「遅延分」は0以上に丸めた値、末尾の「遅延分(符号付き)」は負なら早発・早着（符号付き列の導入前に確定した実績は空欄） |

### `GET /api/admin/prediction-accuracy` の集計方針

集計は**すべてSQL側（GROUPING SETSで全軸を1パス）で行い、指定期間内の全サンプルを対象にします**。行数に依存する処理をDB内に閉じ込めているため、レスポンスは軸ごとの集計値＋明細100件という固定サイズになります。

`days`は**1〜7**にクランプします（`MAX_DAYS`）。突合結果（実績×予測履歴）はサンプル数が増えるほど突合とハッシュ集計が重くなり、期間を延ばすと計算に失敗するためです。実運用で必要なのは直近の傾向確認なので上限を7日にしています。予測側を突合するCTEも「集計期間＋2日」の範囲に絞っており（`DAILY_TRIP_RETENTION_DAYS`を延ばしてログが厚くなっても、このCTEだけ全期間をmaterializeしてメモリを溢れさせない）、2日の余裕は期間の境目をまたぐ予測を取りこぼさないためのものです。

応答には集計値のほかに`totalSampleCount`（絞り込み前の総サンプル数）・`generatedAt`・`computeMs`・`cached`が含まれます。同一条件の結果は`POLL_INTERVAL_SECONDS`と同じ長さ（既定60秒）だけメモリにキャッシュされます。ログに行が増えるのはパイプラインが走ったときだけなので、絞り込み条件を切り替えて見比べる操作が即応になります。

> ルート定義を追加する際は、`router`が`/api`配下にマウント済みであることに注意してください（パス先頭に`/api`を重ねない）。

## 運用エンドポイント（`server.js`・`/api` の外）

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/healthz` | ヘルスチェック（`services/healthCheck.js`）。`{ status, healthy, uptimeSec, checks:{ db, pipeline, gtfs } }` を返す。正常時`200`、**DB不通またはメインパイプラインが詰まっているとき`503`**。GTFS鮮度は情報のみで`healthy`判定には使わない。認証なし・レートリミットなし・閲覧数にも数えない（`httpsRedirect`より手前にあるため`FORCE_HTTPS=true`でも平文`localhost`から到達できる）。`docker-compose.yml`の`backend` healthcheckが使う。しきい値は`HEALTHZ_PIPELINE_STALE_SEC`/`HEALTHZ_GTFS_STALE_SEC`/`HEALTHZ_DB_TIMEOUT_MS`（README §8） |
