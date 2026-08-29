# APIエンドポイント一覧（`routes/api.js`）

`router`は`/api`配下にマウントされています。管理系（`/admin/...`）は`requireAdminAuth`（Basic認証、既定ユーザー名/パスワードは`ADMIN_USERNAME`/`ADMIN_PASSWORD`環境変数）で保護されています。

## 公開API（利用者向け画面）

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/routes` | 利用可能な路線一覧（GTFSの`routes.txt`由来） |
| GET | `/api/settings` | お知らせ・重要なお知らせ |
| GET | `/api/server-load` | 現在のサイト閲覧数とサーバー負荷状況（自動更新の自動OFF判定に使用） |
| GET | `/api/stops` | 全バス停マスタ（時刻表画面・地図表示用） |
| GET | `/api/stops/search` | バス停名の部分一致検索（全路線対応） |
| GET | `/api/timetable` | 本日運行対象の便の時刻表（`daily_trips`ベース。frequencies由来の仮想便も含む） |
| GET | `/api/buses` | **担当車両が割り当てられている当日便のリアルタイム運行状況＋到着予測**（`trip_arrival_predictions`から読み出すだけ。計算はパイプライン側でプリコンピュート済み → [design-eta-precompute.md](design-eta-precompute.md)）。候補車両は公開しない |
| GET | `/api/buses-for-map` | バスマップ用の走行中バス位置（担当車両のみ・到着予測なしの軽量版）。`routeId`は任意で、省略時（および`routeId=all`）は全路線を返す |
| GET | `/api/service-status` | アルピコ交通の運行状況（1時間ごとにスクレイピングしてキャッシュ済み） |

## 経路検索

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/route-search/stops` | 出発地・目的地の候補（漢字/ひらがな/カタカナ/ローマ字。返す`stopKey`は時刻表検索・バス停検索と共通） |
| GET | `/api/route-search` | 経路検索：乗換2回まで・徒歩接続あり・任意日付・運賃つき。`fromStopKey`/`from`・`toStopKey`/`to`・`date=YYYY-MM-DD`・`time=HH:MM`・`limit`（旧`departureTime`は`time`の別名として受付）。詳細設定（すべて任意。未指定なら従来どおりの条件）：`maxTransfers=0..3`（`0`＝乗り換えなし）・`allowWalkTransfer=false`（徒歩での乗り継ぎを使わない）・`minTransferMinutes=1..15`（乗り換えの余裕時間）。詳細は[../docs/経路検索機能_改善仕様書.md](経路検索機能_改善仕様書.md) |

## 時刻表検索・バス停検索

詳細は[timetable-search.md](timetable-search.md)を参照。

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/timetable/stops/search` | バス停名のインクリメンタル検索（漢字/ひらがな/カタカナ/ローマ字） |
| GET | `/api/timetable/stops/map` | バス停マップ用の全バス停一覧（同名で標柱違いは代表点1件に統合済み） |
| GET | `/api/timetable/stops/:stopKey` | バス停の時刻表（標柱一覧・凡例つき。`?date=YYYY-MM-DD`・`?platform=標柱のstop_id`） |
| GET | `/api/timetable/trips/:feedId/:routeId/:tripId/:departureTime` | 便の通過時刻一覧（`?stop=`でハイライト対象を指定） |
| GET | `/api/timetable/trips/:feedId/:routeId/:tripId/:departureTime/realtime` | 上記便のリアルタイム重ね合わせ |
| GET | `/api/busstop/search` | `/api/timetable/stops/search`と同一データ |
| GET | `/api/busstop/nearby` | 現在地から近い順のバス停（既定5件） |
| GET | `/api/busstop/:stopKey/approaching` | 現在時刻±30分以内に到着予定の便一覧 |
| GET | `/api/busstop/:stopKey/nearby-spots` | 周辺の観光スポット |

## 管理API（要Basic認証）

| メソッド | パス | 概要 |
|---|---|---|
| GET / PUT | `/api/admin/settings` | 配信お知らせ設定の取得・更新 |
| GET / PUT / DELETE | `/api/admin/runtime-settings`（`/:key`） | 運用パラメータ（判定半径・タイムアウト・しきい値等）の取得・上書き保存・上書き解除（既定値へ戻す）。定義一覧は[backend/src/config/runtimeSettingsCatalog.js](../backend/src/config/runtimeSettingsCatalog.js) |
| GET / POST / DELETE | `/api/admin/holidays`（`/:date`） | 祝日カレンダーの取得・追加・削除（ETA統計の曜日区分に使用） |
| GET / POST / DELETE | `/api/admin/route-mappings`（`/:externalId`） | 外部ID⇔GTFS route_id対応の取得・追加更新（UPSERT）・削除。`route_id`は`routes`テーブルへの実在チェックあり（路線名による解決はしない） |
| GET / PUT / DELETE | `/api/admin/tourist-spots`（`/:id`） | 観光スポット情報の一覧・テキスト一括登録（全件洗い替え）・1件削除 |
| GET | `/api/admin/vehicle-positions-map` | 運行ダッシュボード（地図）の「全車両（直近3分）」モード用。便に割り当てられていない・候補にすらなっていない車両も含め、直近3分以内にGPSを受信した全車両を1台につき最新の1件だけ返す |
| GET | `/api/admin/assignments/:assignmentId` | 運行ダッシュボード（地図）の詳細パネル用。便のリアルタイム時刻表（停車バス停・定刻・実績・予測）と、その車両がこの便を担当してから記録した位置履歴 |
| GET | `/api/admin/assignments/:assignmentId/stops/:stopId` | バス停別詳細モーダル用。到着済なら判定方法（`付近経由`/`ベクトル判定`/`手動` 等）と根拠（内積・線分距離・前後GPS点／最接近距離・GPS時刻）＋遅れ、未到着ならETA予測根拠（`source`＋ペース補正の内訳）。いずれもETA予測の推移（`trip_arrival_prediction_log`。実績確定時は`actual`行）を返す |
| PUT | `/api/admin/assignments/:assignmentId/stops/:stopId` | 到着判定時刻（`trip_stop_progress.actual_time`）の手動編集。`actualTime`が`H:mm`なら`到着済`へ手動確定（未到着のバス停も可）、**空なら未到着へ差し戻し**（到着判定・実績・遅れ・判定根拠を消去。`trip_gps_matches`は消さない） |
| GET | `/api/admin/assignment-monitor` | 便ごとの担当・候補・割当時刻・距離・未割当理由（`?date=YYYY-MM-DD`） |
| GET | `/api/admin/alerts` | 異常アラート（GPS途絶・未割当便・大幅遅延・予測計算失敗・GTFS取得失敗） |
| GET | `/api/admin/gtfs-feeds` | GTFSフィード監視（最終取得時刻・ファイル件数・エラー内容） |
| POST | `/api/admin/gtfs-feeds/:feedId/refetch` | GTFSフィードの手動再取得 |
| GET | `/api/admin/location-feeds` | 位置情報フィード監視（最終受信時刻・受信件数・形式異常） |
| GET | `/api/admin/api-stats` | API稼働監視（応答時間・エラー率・アクセス数・失敗したエンドポイント） |
| GET | `/api/admin/job-monitor` | ジョブ監視（各パイプライン工程の最終成功時刻・所要時間・失敗履歴） |
| GET | `/api/admin/eta-route-overview` | 「当日の状況」の路線別サマリ（`?date=YYYY-MM-DD`）。路線ごとの稼働中車両数・平均ペース補正（本便／今日の前便実績／周辺道路実績／総合）・平均/最大予測遅延 |
| GET | `/api/admin/delay-mesh` | 「当日の状況」の地図メッシュ（`?cellMeters=100..2000`、既定300）。直近60分の区間実績（他路線含む）を格子に集約し、セルごとの平均ペース比率を返す（`services/delayMesh.js`） |
| GET | `/api/admin/prediction-accuracy` | 予測精度の集計（`?days=7&routeId=...&thresholdMinutes=3&leadBucket=...&stopsBeforeBucket=...`） |
| GET | `/api/admin/operation-records/export` | 運行実績のエクスポート（`?from=YYYY-MM-DD&to=YYYY-MM-DD&routeId=...`） |

### `GET /api/admin/prediction-accuracy` の集計方針

集計は**すべてSQL側（GROUPING SETSで全軸を1パス）で行い、指定期間内の全サンプルを対象にします**。かつては突合結果を最大20000行だけNodeへ取り出してJSで集計しており、「全期間の集計」と表示しながら実際には最新の一部しか見ていませんでした（実測で全体の約20%。的中率が5ポイント近くずれていました）。行数に依存する処理をDB内に閉じ込めたため、レスポンスは軸ごとの集計値＋明細100件という固定サイズになります。

応答には集計値のほかに`totalSampleCount`（絞り込み前の総サンプル数）・`generatedAt`・`computeMs`・`cached`が含まれます。同一条件の結果は`POLL_INTERVAL_SECONDS`と同じ長さ（既定60秒）だけメモリにキャッシュされます。ログに行が増えるのはパイプラインが走ったときだけなので、絞り込み条件を切り替えて見比べる操作が即応になります。

> 旧`GET/PUT /api/admin/route-data`（バス停座標・時刻表の直接編集）は、バス停座標・時刻表をGTFSフィード側の更新へ一本化したため削除済みです。`GET/PUT /api/admin/route-mappings`（外部ID⇔route_id対応の編集）は一時期同様に削除していましたが、上表のとおり`GET/POST/DELETE`として復活しています。同種のルートを追加する際は、`router`が`/api`配下にマウント済みであることに注意してください（先頭に`/api`を重ねない）。
