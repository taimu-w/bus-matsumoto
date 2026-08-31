# リアルタイム休止（路線ごとのリアルタイム表示 一時停止）

突発的な運休・輸送障害などで、GPS由来のリアルタイム運行情報（現在地・遅延・到着予測）が
実態と大きく食い違うことがある。そのようなとき、**路線単位でリアルタイム表示だけを利用者向け
画面から一時的に取りやめる**ためのキルスイッチ。

**「リアルタイム運行情報の表示をやめる」だけの機能であり、時刻表（定刻）ベースの表示・経路探索は
一切止めない。**

## 何が止まるか

`route_realtime_suspensions` に行がある `route_id`（qualified route id `feedId:routeId`）は、
次の利用者向け機能でリアルタイムを出さなくなる。いずれも定刻ベースの表示に落ちる（soft-fail）。

| 機能 | 休止時の挙動 |
|---|---|
| リアルタイム運行状況画面（`GET /api/buses`） | バスを返さず `realtimeSuspended:true` を返す。画面は休止メッセージ＋「時刻表（参考）」のみ |
| バスマップ（`GET /api/buses-for-map`） | その路線のバスを地図から除外。`suspendedRouteIds` を添えて画面に注記を出させる |
| 経路検索のリアルタイム重ね合わせ | 該当区間は重ねず定刻のまま。探索・運賃・おすすめ判定・並び順は不変。`journey.realtimeSuspended` を立てて画面に注記させる |
| 便詳細の「リアルタイムに切替」（`.../realtime`） | `available:false`（＝現在リアルタイム運行なし）を返す |
| バス停詳細の「接近中のバス」 | リアルタイム突合せず定刻のみ表示 |

## 何が止まらないか

- 時刻表検索・バス停時刻表・経路検索の通常の探索（`GET /api/route-search` の結果そのもの）。
- 管理画面の運行監視: **運行ダッシュボードの地図・便の割当監視・異常アラート・予測精度の監視など。**
  休止中の路線も従来どおり全便を監視できる。

## しくみ

- **キャッシュ層**: `backend/src/services/realtimeSuspension.js`。`route_realtime_suspensions` を
  60秒TTLでメモリキャッシュし、管理画面の保存/削除時に `invalidateRealtimeSuspensionCache()` で即時破棄する
  （`routeExternalIdMapping.js` と同じ流儀。TTLを1時間ではなく60秒にしているのは、障害対応中に使う
  安全機能であり、万一 invalidate を取りこぼしても短時間で自己回復させたいため）。DB接続不可のときは
  「休止なし」（＝従来どおり表示）へ安全側にフォールバックする。

- **集中ガード**: `backend/src/services/realtimeTripLookup.js` の `findLiveAssignment()` 冒頭で
  `isRealtimeSuspended()` を見て、休止路線なら `null`（＝現在リアルタイム運行なし）を返す。
  この関数の外部呼び出し元は「経路検索の重ね合わせ」「便詳細のリアルタイム切替」「接近中のバス」の
  3か所だけで、いずれも `null` を soft-fail するため、ここ1か所で公開面をまとめて止められる。
  管理画面の運行監視は `assignment_id` 直引きの別経路（`getAssignmentDetailForAdmin()` 等）を通り、
  このガードにかからない。

- **`/api/buses` / `/api/buses-for-map`** は `findLiveAssignment()` を経由しない独自クエリなので、
  それぞれ個別に休止判定を持つ。`/api/buses-for-map` は Basic 認証済みの管理画面リクエスト
  （`isAuthenticatedAdmin(req)` が真）のときだけ除外をスキップし、休止路線のバスも返す。

## 管理画面「リアルタイム休止」

`GET/POST/DELETE /api/admin/realtime-suspensions`（`/:routeId`）。

- 路線は `/api/routes` の候補一覧から選ばせ、保存時に `routes` への実在チェックを行う
  （`route_id` の表記ゆれ事故を防ぐ。外部IDマッピング・方向マッピングと同じ方針）。
- `reason`（任意・利用者に表示）／`note`（任意・管理用）を添えられる。
- **解除は行の削除（画面の「再開」）のみ。** 突発運休は復旧見込みが立たないため自動解除は持たない。

## 注意

- `route_realtime_suspensions` は、`route_external_ids`（外部ID⇔route_id）・
  `route_direction_rules`（CSV方向値⇔direction_id）とは目的が違う。あの2つは「位置情報CSVとGTFSを
  結びつける設定」。こちらは「公開画面のリアルタイム表示のキルスイッチ」。混同しないこと。
- スキーマは `schema.sql` の `CREATE TABLE IF NOT EXISTS` のみ（新規テーブルなので `migrate.js` への
  追記は不要）。`seed.js` の `validateCodeConfig()` が、実在しない `route_id` の行に警告ログを出す
  （起動は止めない）。
