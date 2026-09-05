# データベース構造（`backend/src/db/schema.sql`）

テーブル定義そのものは`schema.sql`を正としてください。このドキュメントは各テーブルの役割の一覧です。

| テーブル | 役割 |
|---|---|
| `routes` | 路線マスタ（`feed_id`でどのGTFSフィード由来かを追跡） |
| `feeds` | **フィードの稼働状態**（`last_fetched_at` / `last_status` / `last_error`）と、**前回DBへ取り込んだGTFS ZIPの指紋**（`content_hash`＝ZIP本体のSHA-256、`last_etag` / `last_modified`＝条件付きGET用）。指紋が前回と一致すれば展開も`seed()`も行わない（内容不変でのマスタ全書き換えを避ける）。**指紋の3列は`seed()`が成功した後にだけ書く**（`gtfsFeedManager.commitFeedFingerprint()`）。ダウンロード直後に書くと、`seed()`が失敗した回の指紋が残って以降ずっと「内容不変」と判定され、DBが古いまま固定される。構成（`feed_type` / `url` / `enabled` 等）は`config/feeds.js`が正で、行は`seed.js`がそこからUPSERTする |
| `route_external_ids` | 外部ID（位置情報CSVの系統ID）⇔GTFS route_idの対応（`external_id`が主キー）。路線名によるあいまい解決はせず、`route_id`（qualified route id）を直接持つ。管理画面「外部IDマッピング」から編集可能。`route_id`が`NULL`の行は「対応するGTFS路線がまだ無い」ことを表し、`note`に理由を残す。`services/routeExternalIdMapping.js`がTTLキャッシュする（詳細は[feed-config.md](feed-config.md)） |
| `route_direction_rules` | 位置情報CSVの「方向列の値」⇔GTFS `direction_id`の対応（`route_id`が主キー、qualified route id）。管理画面「方向マッピング」から編集可能。`mode='ignore'`（方向で絞り込まない）／`mode='map'`（`value_map`でCSV値→`direction_id`変換、表に無い値は`fallback`へ）。**行が無い路線は既定で`ignore`（テーブルが空＝全路線ignore、初期投入なし）**。`services/directionRules.js`がTTLキャッシュ（同期アクセサ）、純ロジックは`config/directionMapping.js`（詳細は[feed-config.md](feed-config.md)） |
| `route_realtime_suspensions` | 路線ごとの「リアルタイム運行情報の表示」一時停止スイッチ（`route_id`が主キー、qualified route id。`reason`/`note`）。管理画面「リアルタイム休止」から編集。行があるとその路線は公開画面でリアルタイムを出さず定刻表示に落ちる（時刻表・経路探索・管理画面の運行監視は影響なし）。`route_external_ids`/`route_direction_rules`とは目的が別（位置情報⇔GTFSの結合設定ではなく、公開画面のキルスイッチ）。`services/realtimeSuspension.js`が60秒TTLキャッシュ（詳細は[realtime-suspension.md](realtime-suspension.md)） |
| `stops` | バス停マスタ（路線・方向・座標・名称（かな/英語）・お知らせ・時刻表リンク）。物理バス停（`gtfs_stop_id`）＋通過回数（`occurrence`。循環路線で1便が同じ停留所を複数回通るケースの識別用）で一意化する。`seq_order`は路線内の表示順専用で、便ごとの実際の停車順には使わない（`schedule_stop_times.stop_sequence`を参照） |
| `schedule_trips` | 時刻表の「便」（`service_id`＝曜日区分ごと、`gtfs_trip_id`＝GTFS原文のtrip_id、`headsign`＝行先表示）。一意キーの`trip_index`は`trips.txt`内の並び順で、**行の同一性を表さない**。そのままUPSERTするとダイヤ改正で便が1本増減しただけで既存行が別の便の内容に上書きされる（`daily_trips.schedule_trip_id`の参照先がずれる）ため、`seed.js`は書き込みの前に`alignTripIndexesByGtfsTripId()`で既存行を`gtfs_trip_id`基準の並びへ整列させる。GTFSから消えた便の行は削除せず後ろの番号へ退避する（`completed_trips.trip_id`がCASCADE無しで参照しているため。副作用は[known-issues.md](known-issues.md) H-6） |
| `schedule_stop_times` | 便ごとのバス停定刻（`scheduled_time`はGTFSの実時刻を常に保持。`is_through`はGTFSの`pickup_type=1`かつ`drop_off_type=1`＝真の通過を表す表示用メタデータで、時刻の有無には影響しない。`no_pickup`/`no_drop_off`は`pickup_type`/`drop_off_type`単独のフラグで「降車のみ」「乗車のみ」バッジの表示用）。`stop_sequence`が便自身の中での実際の停車順（0始まりの連番）で、`daily_trip_stop_times`以降の`seq_order`列はこれを引き継ぐ |
| `schedule_trip_frequencies` | GTFS `frequencies.txt`（頻度ベース運行の定義。当日便生成時に仮想便へ展開する） |
| `system_settings` | 管理画面から編集する設定値（key/value）。`notices`＝通常のお知らせのJSON配列（最大3件・各要素`{title, body, imageUrl, startDate, endDate}`。`body`はリンク記法対応、`imageUrl`は`https://`の画像URLまたは空、配信期間は`YYYY-MM-DD`または空＝無期限）、`important_notice`＝重要なお知らせのJSONオブジェクト`{body, imageUrl, startDate, endDate}`（未設定なら空文字。旧形式のプレーンテキストはmigrate.jsが変換）、`route_name`/`operator_name`＝表示用の既定値。運用パラメータの上書き値もここに入る |
| `holidays` | 祝日カレンダー（`holiday_date`が主キー）。`getDayType()`の休日判定に使う。`seed.js`が国民の祝日を初期投入、以降は管理画面から追加・削除可能 |
| `tourist_spots` | 観光スポット情報（GTFS由来データとは完全独立）。バス停との関連付けは保存時ではなく参照時の近接検索で解決するため外部キーは持たない。`id`（TEXT主キー）は管理画面の一括テキスト入力の1列目で管理者が指定する識別子で、名称による名寄せはせずIDの一致で同一スポットを判定する。写真（`photo_urls`）は複数枚を「,」区切りで連結して保持する。`aliases`（別称、「,」区切り）は「からす城」「国宝」のような検索補助用の呼び名で、経路検索の出発地・目的地／スポット検索の候補一致にだけ使い利用者画面には出さない（かな・ローマ字変換なし） |
| `tourist_spot_link_clicks` | 観光スポットの公式サイトリンク（`tourist_spots.url`）のタップ回数。掲載の有用性判断用にAsia/Tokyo基準で日別集計（主キー`(spot_id, click_date)`、`spot_id`はTEXT）。全件洗い替えでスポットが消えても集計を残すため外部キーは張らず`spot_name`スナップショットを持つ。保持約400日（`services/touristSpots.js`の`purgeOldLinkClicks`、1時間掃除）。[tourist-spots.md](tourist-spots.md) |
| `spot_search_counts` | スポット検索（`services/spotSearch.js`）で観光スポット／その他のスポット／バス停が検索された回数。掲載の有用性を`tourist_spot_link_clicks`と並べて判断するためのAsia/Tokyo基準の日別集計（主キー`(spot_id, search_date)`、`spot_id`はTEXT）。`spot_id <> ''`＝`tourist_spots.id`、`spot_id = ''`＝観光スポット以外（バス停・地名）に解決した検索。外部キーは張らず`spot_name`スナップショットを持つ。保持約400日（`services/spotSearch.js`の`purgeOldSpotSearchCounts`、1時間掃除）。[spot-search.md](spot-search.md) |
| `busstop_notices` | バス停お知らせ配信。1件に見出し・画像（Cloudinary等の`https://`画像URL）・本文（トップ画面のお知らせと同じリンク記法。ただの文章も可）を任意に組み合わせて持つ（画像・本文の少なくとも一方）。バス停詳細ページの「このバス停でできること」の下に出す。`scope='stop'`＝バス停単位（`stop_key`＋その別名で突合、表示モードによらず常に出す）、`scope='platform'`＝乗り場（のりば）単位（`feed_id`+`stop_id`で突合、乗り場別表示のときだけ出す）。`stop_key`/`stop_name`/`platform_code`は管理画面一覧用のスナップショットで、キーが消えれば参照時に一致しなくなるだけ。管理画面「バス停お知らせ」で編集（詳細は[busstop-notices.md](busstop-notices.md)） |
| `daily_trips` | ★**当日の運行便**（`assignment_state`＝pending/assigned/unassigned、`start_at`＝実時刻、`origin`＝static/frequency） |
| `daily_trip_stop_times` | ★当日便のバス停別定刻（frequenciesのオフセット適用済み。以降の全処理はここだけを見る） |
| `trip_vehicle_assignments` | ★**便への車両割り当て**（`role`＝assigned/candidate、`state`＝active/ended、始発時刻時点の距離）。`delay_minutes`は0以上に丸めた遅れ（表示・しきい値判定の正）、`signed_delay_minutes`は同じ差分を符号付きで持つ（負＝早発・早着） |
| `trip_stop_progress` | ★**便×車両ごとのバス停進捗**（定刻・実績・遅延・通過/到着ステータス）。遅延は`delay_minutes`（0以上に丸めた値。表示・判定はこちらが正）と`signed_delay_minutes`（符号付き。負＝定刻より早い＝早発・早着の事後検証用）の2列。`nearby_min_distance_*`は「付近」中に観測した最小距離・GPS時刻。`arrival_method`（`vector`/`nearby`/`promoted`/`interpolated`/`manual`/`start`/`finish`）と`arrival_evidence`（JSONB。ベクトル判定の内積・線分距離・前後GPS点など）は「なぜ到着済になったか」を管理画面「運行ダッシュボード」のバス停別モーダルに出すための表示専用列。`nearby_min_distance_*`と同じく`openAssignment()`のON CONFLICT SET句には含めない |
| `trip_gps_matches` | 通過判定で消費したGPSログ（割り当て単位。1台が複数便の候補になるため車両側の列では管理できない） |
| `vehicles` | 観測されている物理車両（便との紐付けは持たない。運行終了でも削除せず`status='inactive'`にする） |
| `vehicle_labels` | 車両ID（`car_id`が主キー）に管理画面「車両名・メモ管理」から付ける名前・メモ。`vehicles`は路線ごとに行が分かれ運行終了で行が増えるため`car_id`をキーにする。運行ダッシュボードの便詳細セクションで、名前を持つ車両を`car_id`ではなく名前で表示し、名前タップで車両詳細（直近の運行履歴・メモ）を表示する。名前・メモがどちらも空になった時点で行を削除する |
| `vehicle_operation_history` | 車両ごとの「直近の運行履歴」（`(car_id, day_type, start_at)`が複合主キー、1便=1行）。管理画面「車両運用状況」と運行ダッシュボードの車両詳細で使う。`day_type`は`getDayType()`と同じ3区分で、参照・掃除時に`saturday`+`holiday`を「土休日」バケットへまとめる。`finishService.closeDailyTrip()`が`is_official=TRUE`の割り当てについて`archiveAssignment()`から1便追記し、そのバケットの最新`service_date`より前の行を掃除する（`services/vehicleOperationHistory.js`）。掃除は冪等・クローズ順非依存（古い便は自分自身の掃除で消える）なので、平日1日分・土休日1日分だけが常に残る。`completed_trips`と違い保持期間の影響を受けず、たまにしか走らない車両の運用状況も追える |
| `vehicle_positions_raw` | GPSフィードから取得した直後の生ログ（未処理分の一時置き場、取得元`feed_id`付き） |
| `vehicle_gps_log` | 車両ごとに整理された走行ログ |
| `completed_trips` | 運行終了後にアーカイブされた便（`is_official=TRUE`のみが統計学習の対象）。`closeDailyTrip()`の二重実行防止（行ロック）の安全網として`UNIQUE (daily_trip_id, assignment_id)`を持つ |
| `completed_trip_stop_times` | アーカイブされた便のバス停ごとの実績（`actual_minutes`は統計集計用）。`delay_minutes`／`signed_delay_minutes`は`trip_stop_progress`からそのまま引き継ぐ |
| `segment_travel_stats` | ★区間別・曜日区分別・時間帯別の走行時間統計（ETA予測の核。詳細は[eta-prediction-algorithm.md](eta-prediction-algorithm.md)） |
| `trip_arrival_predictions` | ★**プリコンピュートされた到着予測**（パイプラインが60秒ごとに全active割り当て分を保存。`assignment_id, stop_id`が複合主キー。APIはここから読み出すだけ → [eta-prediction-algorithm.md](eta-prediction-algorithm.md)）。`source`が`historical`/`schedule_paced`の行に限り、ペース補正の内訳（`live_factor`・`today_previous_trip_factor`・`nearby_factor`・`combined_pace_factor`等）も保存する。管理画面「ETA予測根拠」「当日の状況」向け |
| `trip_arrival_prediction_log` | ETA予測の履歴ログ（追記のみ）。`trip_arrival_predictions`は最新値のみのUPSERTのため「いつの時点の予測か」が失われる。予測精度監視のため、直前の記録から値が変化した場合のみ1行追記する。`assignment_id`経由でCASCADE削除されるため専用の掃除ジョブを持たない。`source='actual'`だけを対象にした部分インデックスを2本持つ（下記） |
| `service_status_cache` | アルピコ交通公式サイトの運行状況ページをスクレイピングした結果のキャッシュ（1行のみ保持） |

## 予測精度監視まわりのインデックス

`trip_arrival_prediction_log`には、通常のインデックス（`assignment_id, stop_id, computed_at DESC` と `route_id, computed_at DESC`）に加えて、`WHERE source = 'actual'`の部分インデックスが2本あります（`idx_prediction_log_actual_time` / `idx_prediction_log_actual_route_time`）。

予測精度の集計（`services/predictionAccuracy.js`）は「実績が確定した行（`source='actual'`）を期間で絞る」ところから始まりますが、この行はテーブル全体の4割程度しかありません。部分インデックスにすることで、路線を絞る場合・絞らない場合のどちらでも、全件スキャンして`source`でフィルタする形を避けられます。**2本あるのは、路線絞り込みの有無で先頭列が変わるためです。片方だけにしないでください。**
