# フィード構成・外部IDマッピング

位置情報とGTFSを結びつける設定を3つに分けて扱います。**いずれも似て非なる設定で、管理場所が違います。混同しないでください。**

## (1) 外部ID（位置情報CSVの系統ID）⇔ GTFS route_id の対応

`route_external_ids`テーブル（DB）で管理し、管理画面「外部IDマッピング」（`GET/POST/DELETE /api/admin/route-mappings`）から追加・変更・削除できます。運用担当者が随時追加・修正するため、DB管理・管理画面編集にしています。

**1行＝1つの`(external_id, route_id)`の対応で、多対多です。**（`route_id`は`feedId:routeId`形式のqualified route id）

- 1つのGTFS路線に複数の外部ID：同じ路線に系統違いの別IDが振られているケース。
- 1つの外部IDに複数のGTFS路線：1つの系統IDで往路・復路が別路線としてGTFSに入っているケース（「信大横田循環線」と「横田信大循環線」など）。

一意性は部分索引2本で担保します。`ux_route_external_ids_pair`（`(external_id, route_id)` WHERE `route_id IS NOT NULL`）が同じ対応の二重登録を防ぎ、`ux_route_external_ids_unmapped`（`(external_id)` WHERE `route_id IS NULL`）が「未対応」行を外部IDごと1行に保ちます（`NULL`はUNIQUE制約では重複扱いにならないため索引を分けています）。

- **路線名による解決はしません。** `route_id`を直接保存するため、GTFS側の路線名表記ゆれ（「ケ/ヶ」等）で対応が黙って欠落することがありません。管理画面は路線を`/api/routes`の候補一覧から選ばせる方式で、保存API側も`route_id`が`routes`テーブルに実在するかを検証し、存在しなければ拒否します。
- `route_id`が`NULL`の行は「外部IDは判明しているが対応するGTFS路線がまだ無い」ことを表し、`note`に理由を残します。消さずに残すことで、路線が後から追加された際に再調査せずに済みます。この「未対応」行は同じ外部IDの対応行と同居させません（1件でも対応があれば未対応ではないため）。対応が付いた外部IDを未対応で上書き保存しようとすると、保存APIが400で拒否します。
- 実行時の参照は`backend/src/services/routeExternalIdMapping.js`（TTL1時間のメモリキャッシュ）経由です。管理画面から編集した際は`invalidateRouteExternalIdCache()`で即時破棄します。外部ID→`route_id`は**配列**（`loadExternalIdMap()`）、その逆引きは`getExternalIdsForRoute(routeId)`で引きます。
- **1つの外部IDに複数の路線を紐づけると、その外部IDで届いた測位は紐づけた全路線の便の照合対象になります。** 位置情報は便ではなく車両（`car_id`）単位で届くため測位自体は増えませんが、便の候補検索にかかる便が増えます。最終的にどの便の担当になるかは、従来どおり「始発時刻直前のGPSが始発バス停100m以内」かつ「最も近い1台」で決まります（[vehicle-assignment.md](vehicle-assignment.md)）。
- 測位側は、突合した外部IDを`vehicle_positions_raw.external_id`→`vehicle_gps_log.external_id`に残します。`route_id`列には紐づく路線のうち代表1件（`route_id`昇順の先頭）しか入らないため、便の候補検索は外部ID側を正に使います。これが無いと、代表でない方の路線の便に車両が永久に割り当たりません。
- 1つの外部IDに紐づく路線どうしで方向マッピング（(2)）の変換結果が割れる場合、その測位の`direction_id`は`NULL`（方向不明＝方向で絞り込まない）にします。どれか1つを採ると、採らなかった路線の便で「方向が違う」と誤って候補から外れるためです。紐づく路線が1つだけなら、従来どおりその路線の変換結果そのものです。
- 起動時（`seed.js`の`validateCodeConfig()`）に、`route_external_ids.route_id`が実際の`routes`テーブルに存在するかを検証し、存在しなければ警告ログを出します（起動は止めません）。

## (2) 位置情報CSVの方向値 ⇔ GTFS direction_id の対応

`route_direction_rules`テーブル（DB、`route_id`が主キー、qualified route id）で管理し、管理画面「方向マッピング」（`GET/POST/DELETE /api/admin/direction-rules`）から追加・変更・削除できます。位置情報CSVの「方向列の値」を、その路線でどう扱うかを決めます。

- **行が無い路線は既定で`ignore`**（テーブルが空＝全路線`ignore`）。初期投入（seed）はしません。
- `mode: 'ignore'`：方向値を便判定に使わない（路線一致＋始発バス停100m以内のみで候補とする。[vehicle-assignment.md](vehicle-assignment.md)）。
- `mode: 'map'`：`value_map`（`{ "CSV方向値": direction_id(0|1) }`）でCSV値を`direction_id`へ変換し、便判定に使う。`value_map`に無いCSV値は`fallback`（`0`/`1`、`NULL`なら方向不明扱い）へ。
- 保存時に`route_id`が`routes`テーブルに実在するか検証し、存在しなければ拒否します（管理画面は`/api/routes`の候補一覧から選ばせる）。
- 実行時の参照は`backend/src/services/directionRules.js`のTTL付きメモリキャッシュ経由で、`isDirectionIgnored()`/`resolveDirectionId()`は**同期関数**です（`locationFetcher.js`のCSV行ループ・`tripAssignment.js`の候補ループから多数回呼ばれるため。`runtimeSettings.js`と同じ理由）。DB読み込み（非同期`refreshDirectionRulesCache()`、TTL30秒）は`jobs/pipeline.js`の先頭とサーバー起動直後に行われます。管理画面から保存/削除した際は`invalidateDirectionRulesCache()`でキャッシュを失効させ、次回のパイプライン実行（最大60秒）で反映されます。呼ばれる前・DB接続不可時は全路線`ignore`にフォールバックします。
- 純粋な変換ロジック・入力検証は`backend/src/config/directionMapping.js`（DB非依存）が担います。
- 起動時（`seed.js`の`validateCodeConfig()`）に、`route_direction_rules.route_id`が実際の`routes`テーブルに存在するかを検証し、存在しなければ警告ログを出します（起動は止めません）。

## (3) 位置情報フィード ⇔ GTFSフィードの対応、およびフィードURL構成

`backend/src/config/feeds.js`（コード）で管理します。変更頻度が低く、誤設定時の影響（違う路線に位置情報が紐づく）が大きいため、diffに残りレビューを経るコード管理にしています。変更にはコードの編集とデプロイが必要です（管理画面からは編集できません）。

- 位置情報フィードがどのGTFSフィードの路線を解決対象にするかは`gtfsFeedIds`（**配列**）で明示します。アルピコ交通のように複数のGTFSフィードにまたがる事業者を1件へ畳まないための配列です。`getGtfsFeedIdsFor(locationFeedId)`で引きます。
- `getLocationFeedIdsForRoute(qualifiedRouteId)`は上記の逆引き（qualified route id → GTFSフィードID → それを`gtfsFeedIds`に含む位置情報フィードID配列）。車両割り当ての候補検索（`tripAssignment.findCandidates()`）が、系統表示が切り替わる前後の車両を拾うフォールバックを「同じ位置情報フィードの範囲」に限るために使います（[system-review-2026-09.md](system-review-2026-09.md) DB-5）。
- `PLATFORM_DISPLAY_NAME_FEED_PRIORITY`：時刻表検索での**のりば（標柱）の座標統合**（[timetable-search.md](timetable-search.md)「のりばの座標統合」）で、統合後の表示名・よみがなをどのGTFSフィードの`stop_name`に従わせるかの優先順位。2フィードが同じ物理のりばを別表記で持つため必要です。

### `feeds`テーブルの二重性質

`feeds`テーブルは性質の異なる2種類の情報を1つの表に混在させています。

| 列 | 性質 | 管理場所 |
|---|---|---|
| `id` / `feed_type` / `name` / `url` / `enabled` | 静的な構成設定 | `config/feeds.js`（コード）が正。`seed.js`がそこからUPSERTする |
| `last_fetched_at` / `last_status` / `last_error` | 実行時に書き込まれる稼働状態 | DBのみ（コード化できない観測データ） |

`feeds`へのUPSERT（`seed.js`の`ensureFeedRows()`）の`ON CONFLICT DO UPDATE`のSET句に、稼働状態3列を含めてはいけません。含めると再起動のたびに「最後に取得に成功したのはいつか」が失われます。逆に`id`/`feed_type`/`name`/`url`/`enabled`はコードが正で、DBを直接編集しても次回起動時に上書きされます。

### 有効フィード一覧の取得口を1箇所に保つ

「有効なGTFSフィード一覧」を取得する処理は、`gtfsFeedManager.js`・`gtfsData.js`・`gtfsCalendar.js`・`gtfsTimetable.js`・`locationFetcher.js`の5サービスがそれぞれ必要とします。**取得口は`config/feeds.js`だけにし、各サービスが独自に`SELECT ... FROM feeds`を書かないでください。**

同じSQLが複数箇所に重複すると、1箇所でも設定変更を取り残したときにサービス間で「有効なフィード」の認識がずれる**静かなデータ不整合**を生みます。エラーにはならず、次のような形で現れます。

- `gtfsData.js`だけ古い一覧を見ている：位置情報側は取得を止めているのに`/api/buses`は路線を返し続け、「路線は表示されるがバスが永久に来ない」状態になる。
- `gtfsCalendar.js`だけ古い一覧を見ている：無効フィードの`service_id`が有効と判定され、車両が割り当たらないゴースト便が当日便として生成される。
- `gtfsTimetable.js`だけ古い一覧を見ている：時刻表検索・経路検索がリアルタイム画面と異なるフィード集合を見て、画面によって出てくる便が違うという再現しにくい不整合になる。

一覧が欲しくなったら`config/feeds.js`に関数を足してください。`gtfsFare.js`・`gtfsFrequencies.js`・`gtfsRouteSearch.js`など、`getGtfsDir(feedId)`で渡されたfeedIdからパスを組むだけのサービスはこの対象外です（フィード一覧をDBからもコードからも引かないため）。

## 関連ドキュメント

- テーブル定義: [database.md](database.md)の`route_external_ids`・`route_direction_rules`・`feeds`の項
- 開発ルール上の要点: [CLAUDE.md](../CLAUDE.md)「複数フィード対応の設計」節
