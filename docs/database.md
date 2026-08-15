# データベース構造（`backend/src/db/schema.sql`）

テーブル定義そのものは`schema.sql`を正としてください。このドキュメントは各テーブルの役割の一覧です。

| テーブル | 役割 |
|---|---|
| `routes` | 路線マスタ（`feed_id`でどのGTFSフィード由来かを追跡） |
| `feeds` | **フィードの稼働状態**（`last_fetched_at` / `last_status` / `last_error`）。構成（`feed_type` / `url` / `enabled` 等）は`config/feeds.js`が正で、行は`seed.js`がそこからUPSERTする |
| `stops` | バス停マスタ（路線・方向・順序・座標・名称（かな/英語）・お知らせ・時刻表リンク） |
| `schedule_trips` | 時刻表の「便」（`service_id`＝曜日区分ごと、`gtfs_trip_id`＝GTFS原文のtrip_id、`headsign`＝行先表示） |
| `schedule_stop_times` | 便ごとのバス停定刻（`scheduled_time`がNULLかつ`is_through=true`は非停車＝`↓`） |
| `schedule_trip_frequencies` | GTFS `frequencies.txt`（頻度ベース運行の定義。当日便生成時に仮想便へ展開する） |
| `system_settings` | お知らせ文言など管理画面から編集する設定値 |
| `holidays` | 祝日カレンダー（`holiday_date`が主キー）。`getDayType()`の休日判定に使う。`seed.js`が国民の祝日を初期投入、以降は管理画面から追加・削除可能 |
| `tourist_spots` | 観光スポット情報（GTFS由来データとは完全独立）。バス停との関連付けは保存時ではなく参照時の近接検索で解決するため外部キーは持たない。管理画面の一括テキスト入力を名称キーのUPSERTで行うため`tourist_spots_name_key`（`name`の一意インデックス）を持つ |
| `daily_trips` | ★**当日の運行便**（`assignment_state`＝pending/assigned/unassigned、`start_at`＝実時刻、`origin`＝static/frequency） |
| `daily_trip_stop_times` | ★当日便のバス停別定刻（frequenciesのオフセット適用済み。以降の全処理はここだけを見る） |
| `trip_vehicle_assignments` | ★**便への車両割り当て**（`role`＝assigned/candidate、`state`＝active/ended、始発時刻時点の距離） |
| `trip_stop_progress` | ★**便×車両ごとのバス停進捗**（定刻・実績・遅延・通過/到着ステータス） |
| `trip_gps_matches` | 通過判定で消費したGPSログ（割り当て単位。1台が複数便の候補になるため車両側の列では管理できない） |
| `vehicles` | 観測されている物理車両（便との紐付けは持たない。運行終了でも削除せず`status='inactive'`にする） |
| `vehicle_positions_raw` | GPSフィードから取得した直後の生ログ（未処理分の一時置き場、取得元`feed_id`付き） |
| `vehicle_gps_log` | 車両ごとに整理された走行ログ |
| `vehicle_stop_status` | **未使用（旧・車両起点方式の名残）**。`trip_stop_progress`に置き換わったが移行のため残置 |
| `completed_trips` | 運行終了後にアーカイブされた便（`is_official=TRUE`のみが統計学習の対象） |
| `completed_trip_stop_times` | アーカイブされた便のバス停ごとの実績（`actual_minutes`は統計集計用） |
| `segment_travel_stats` | ★区間別・曜日区分別・時間帯別の走行時間統計（ETA予測の核。詳細は[eta-prediction-algorithm.md](eta-prediction-algorithm.md)） |
| `trip_arrival_predictions` | ★**プリコンピュートされた到着予測**（パイプラインが60秒ごとに全active割り当て分を保存。`assignment_id, stop_id`が複合主キー。APIはここから読み出すだけ → [design-eta-precompute.md](design-eta-precompute.md)） |
| `trip_arrival_prediction_log` | ETA予測の履歴ログ（追記のみ）。`trip_arrival_predictions`は最新値のみのUPSERTのため「いつの時点の予測か」が失われる。予測精度監視のため、直前の記録から値が変化した場合のみ1行追記する。`assignment_id`経由でCASCADE削除されるため専用の掃除ジョブを持たない |
| `service_status_cache` | アルピコ交通公式サイトの運行状況ページをスクレイピングした結果のキャッシュ（1行のみ保持） |
| `active_vehicle_summary`（VIEW） | 稼働中車両のサマリ表示用ビュー |

## 未使用列・旧方式の名残

現在使われていない列やテーブルも、過去の互換性・移行のロールバック余地のために意図的に残されています。削除しないでください。

- `vehicles`の`business_start_time` / `departure_time` / `trip_id` / `trip_type` / `last_arrived_seq` / `delay_minutes`：旧・車両起点方式の名残（詳細は[design-trip-first-assignment.md](design-trip-first-assignment.md)）。
- `vehicle_stop_status`テーブル：`trip_stop_progress`に置き換わった旧方式のテーブル全体。

## 削除済みの旧テーブル

`feed_mappings`（confidenceによる対応の推測）・`route_external_ids`（外部ID⇔route_idの対応）は、いずれも対応関係をコード（`config/feeds.js`・`config/routeExternalIdMapping.js`）へ移したため削除済みです。`migrate.js`が起動時に`DROP TABLE IF EXISTS`します。
