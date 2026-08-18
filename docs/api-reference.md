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
| GET / POST / DELETE | `/api/admin/holidays`（`/:date`） | 祝日カレンダーの取得・追加・削除（ETA統計の曜日区分に使用） |
| GET / PUT / DELETE | `/api/admin/tourist-spots`（`/:id`） | 観光スポット情報の一覧・テキスト一括登録（全件洗い替え）・1件削除 |
| GET | `/api/admin/bus-positions` | 直近3分以内のバス位置情報（Yahoo!リバースジオコーダによる住所付き） |
| GET | `/api/admin/dashboard-summary` | 運行ダッシュボード（稼働車両数・未割当便数・遅延便数・GPS途絶車両数・GTFSフィード状態） |
| GET | `/api/admin/assignment-monitor` | 便ごとの担当・候補・割当時刻・距離・未割当理由（`?date=YYYY-MM-DD`） |
| GET | `/api/admin/pass-status` | 通過判定の現在状態スナップショット（履歴ではない。`?date=YYYY-MM-DD`） |
| GET | `/api/admin/alerts` | 異常アラート（GPS途絶・未割当便・大幅遅延・予測計算失敗・GTFS取得失敗） |
| GET | `/api/admin/gtfs-feeds` | GTFSフィード監視（最終取得時刻・ファイル件数・エラー内容） |
| POST | `/api/admin/gtfs-feeds/:feedId/refetch` | GTFSフィードの手動再取得 |
| GET | `/api/admin/location-feeds` | 位置情報フィード監視（最終受信時刻・受信件数・形式異常） |
| GET | `/api/admin/api-stats` | API稼働監視（応答時間・エラー率・アクセス数・失敗したエンドポイント） |
| GET | `/api/admin/job-monitor` | ジョブ監視（各パイプライン工程の最終成功時刻・所要時間・失敗履歴） |
| GET | `/api/admin/eta-basis` | ETA予測の根拠表示（`?date=YYYY-MM-DD`） |
| GET | `/api/admin/prediction-accuracy` | 予測精度の集計（`?days=7&routeId=...&thresholdMinutes=3&leadBucket=...&stopsBeforeBucket=...`） |
| GET | `/api/admin/operation-records/export` | 運行実績のエクスポート（`?from=YYYY-MM-DD&to=YYYY-MM-DD&routeId=...`） |

### `GET /api/admin/prediction-accuracy` の集計方針

集計は**すべてSQL側（GROUPING SETSで全軸を1パス）で行い、指定期間内の全サンプルを対象にします**。かつては突合結果を最大20000行だけNodeへ取り出してJSで集計しており、「全期間の集計」と表示しながら実際には最新の一部しか見ていませんでした（実測で全体の約20%。的中率が5ポイント近くずれていました）。行数に依存する処理をDB内に閉じ込めたため、レスポンスは軸ごとの集計値＋明細100件という固定サイズになります。

応答には集計値のほかに`totalSampleCount`（絞り込み前の総サンプル数）・`generatedAt`・`computeMs`・`cached`が含まれます。同一条件の結果は`POLL_INTERVAL_SECONDS`と同じ長さ（既定60秒）だけメモリにキャッシュされます。ログに行が増えるのはパイプラインが走ったときだけなので、絞り込み条件を切り替えて見比べる操作が即応になります。

> 旧`GET/PUT /api/admin/route-mappings`（外部ID⇔route_id対応の編集）・`GET/PUT /api/admin/route-data`（バス停座標・時刻表の直接編集）は、対応関係をコード（`config/routeExternalIdMapping.js`）へ、バス停座標・時刻表をGTFSフィード側の更新へ、それぞれ一本化したため削除済みです。同種のルートを追加する際は、`router`が`/api`配下にマウント済みであることに注意してください（先頭に`/api`を重ねない）。
