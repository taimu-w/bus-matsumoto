# 既知の課題（未対応）

現行コードに残っている、把握しておくべき課題の一覧です。いずれも「コードは動くが、特定条件で
誤判定・性能劣化・安全性の懸念がある」類型で、致命的なバグではありません。改修の際の参考にしてください。

重要度は「利用者に見える誤情報を出すか」「復旧に人手が要るか」で付けています。

---

## High（特定条件で運行判定が確実に誤る）

### H-2 GPSが数分途絶しただけで担当が終了し、便のリアルタイム表示が復帰しない

*運行終了判定 / GPS取得* — `finishService.js`（条件④）、`tripAssignment.js`（再割り当ての打ち切り）

GPS途絶しきい値（`GPS_STALE_TIMEOUT_MIN`、既定6分）が他のGPS鮮度しきい値（`GPS_FRESHNESS_MIN`=15分、
`ADMIN_STALE_GPS_MIN`=5分）と揃っていない。条件④で終了した便は再割り当ての候補が居なければ
クローズされ、`assignPendingTrips()`は`assignment_state = 'pending'`の便しか見ないため、GPSが復旧しても
復帰しない。山間路線（四賀線・奈川線・鹿教湯温泉線など）でトンネル・測位途絶が起きたとき、
運行中のバスが利用者画面から突然消える。フィード全体が遅延すると全車両が一斉に`inactive`になる。

**修正案**: 途絶を「終了」ではなく中間状態にし、GPSが戻ったら`active`へ復帰させる。フィード単位の
一斉途絶を検知したら個別車両の終了判定をスキップするサーキットブレーカを入れる。

### H-5 GTFSファイル差し替え中に、時刻表検索・経路検索のインデックス構築が失敗しうる

*GTFS更新 / エラーハンドリング* — `gtfsFeedManager.js`（既存ファイルをbackupへrename → 新ファイルをcopy）

差し替えが「既存ファイルを退避 → 新ファイルを配置」の2段階で、その間フィードディレクトリに必須ファイルが
無い時間帯が生まれる。`gtfsTimetable`/`gtfsCalendar`/`gtfsFare`のインデックス再構築がこの窓に走ると
`readCsv()`がENOENTでthrowし、時刻表検索・経路検索・バス停検索が500を返す。

**修正案**: 新しい展開先を別名ディレクトリに作り、ディレクトリごと1回のrenameで切り替える。あるいは
差し替え中はインデックス構築を待たせ、待機中は既存インデックスを返す。

### H-6 GTFSの内容が変わっていなくても毎時 seed() が全マスタを書き換える

*GTFS更新 / DB整合性* — `gtfsFeedManager.js`（`if (updated > 0) await seed()`）、`seed.js`

ダウンロード成功＝内容変更とみなしており、ETag / Last-Modified / 内容ハッシュの比較が無い。同じZIPでも
毎時 seed() が走り、全 stops・全 stop_times を UPDATE する。`schedule_trips` の一意キーに含まれる
`trip_index` は trips.txt 内の並び順依存なので、ダイヤ改正で便が1本増減すると以降の便が全部ずれ、
`ON CONFLICT` で既存行が別の便の内容に更新される。GTFSから消えた `schedule_trips` は削除されない。

**修正案**: ZIPのSHA-256を`feeds`に記録し、変化があったときだけ展開・seedする。`schedule_trips`の
一意キーを`(route_id, gtfs_trip_id)`へ移す。seed()のトランザクション境界をフィード単位に分け、
ダウンロードをトランザクション外へ出す。

---

## Medium（条件次第で誤判定・性能劣化・安全性の懸念）

### M-1 CURRENT_DATE がDBサーバのTZで評価され、便のクローズと掃除が最大9時間遅れる

*DB整合性 / 運行終了判定* — `finishService.js`（`service_date < CURRENT_DATE`）、`dailyTripBuilder.js`

`service_date`はJST基準で書き込まれるのに、比較対象の`CURRENT_DATE`はDBセッションのTZ（既定UTC）で
評価される。前日の未クローズ便がJST 09:00まで残り、アーカイブと区間統計への反映がずれる。

**修正案**: SQLを`service_date < (now() AT TIME ZONE 'Asia/Tokyo')::date`にするか、アプリ側で
`getServiceDateString()`を計算してパラメータで渡す。DBコンテナに`TZ: Asia/Tokyo`も併用。

### M-2 当日便生成の運行日判定に calendar.txt の有効期間チェックが無い

*当日便生成 / GTFS更新* — `gtfsCalendar.js`（`getActiveServiceIds()`）

`gtfsTimetable.getActiveServices()`は`start_date`/`end_date`の期間内かを見るが、当日便生成用の
`getActiveServiceIds()`は見ない。現在のデータは全serviceが同一期間なので顕在化していないが、
「現行ダイヤ」と「次期ダイヤ」が同じZIPに同梱される運用になると、両方が同時に有効になり、
同じ時刻の便が二重生成される。期間切れ後は逆に「時刻表は運行なし／当日便は生成され続ける」ずれになる。

**修正案**: `getActiveServiceIds()`にも`start_date`/`end_date`の範囲判定を入れる（3つの曜日区分ロジックを
統合するという意味ではなく、有効期間の解釈だけを揃える）。

### M-3 強制終了までの120分に対し、時刻表上の最長所要が90分で余裕が小さい

*運行終了判定* — `finishService.js`（`VEHICLE_MAX_AGE_MIN`、既定120分。割り当て作成時刻からの経過）

条件③は保護期間の対象外で無条件に効く。feed2の最長ダイヤは90分。90分ダイヤの便（奈川・安曇線、
四賀線など）が30分以上遅れると、終点到着直前に強制終了され、大幅遅延中のバスが画面から消える。
終点付近の実績が欠けた状態でアーカイブされ区間統計にも欠損が入る。

**修正案**: 固定値ではなく便ごとの時刻表所要時間 + 余裕（例: 所要 × 1.5 + 30分）で上限を決める。
最低限、既定値を180分へ引き上げる。

### M-4 早発・早着がすべて「遅延0分」に丸められ、運行の乱れとして検知できない

*遅延計算 / 統計データ* — `utils/time.js`（`computeDelayMinutes()`の`Math.max(0, diff)`）

負値＝日跨ぎ誤補正の再発防止という意図的な仕様だが、副作用として「定刻より早い」という事象が
完全に不可視になる。`delay_minutes`もDBに0として保存されるため後から復元できない。早発は乗り遅れを
生む運行事故だが管理画面のアラートに出ない。ETA計算の起点`currentDelay`も常に0以上になる。

**修正案**: 符号付きの差分を返す関数を別途用意し、DBには符号付きで保存する。表示側で`Math.max(0, …)`を
適用すれば利用者向けの見え方は現行のまま維持できる。

### M-5 「通過」確定済みのバス停が「到着済」に書き換えられ、区間統計に混入する

*バス停通過判定* — `passDetection.js`（`WHERE ... AND status != '到着済'` のため `'通過'` も対象）

`passStepConfirm()`の離脱検知と`passInterpolate()`の補間が、`is_through`（真の通過）のバス停でも
120m以内を通過すれば「到着済」にする。降車できないバス停に実績時刻が付き、
`completed_trip_stop_times.actual_minutes`に値が入るため`updateSegmentStats()`が「通過バス停を含む
区間」を統計に取り込む（ETA予測が通過区間を統計から除外している設計と矛盾）。

**修正案**: 到着確定・補間の対象を未確定（`status = ''`）のみに絞るか、少なくとも統計集計側で
`is_through`の区間を除外する。

### M-6 GPS時刻の「未来」判定と日時書式が、時計ずれ・書式変更に弱い

*GPS取得* — `locationFetcher.js`

`gpsDate > now`の`now`は`fetchLocation()`冒頭で1度だけ取得され、フィード取得中ずっと固定。処理が
進むほど正常なデータが「未来」として捨てられる。日時パースが`new Date(str.replace(/-/g,'/') + ' +0900')`
という書式依存の実装で、フィードがISO 8601に変わると全行NaN → 全件破棄。GPSが静かに欠落し
`skippedStaleOrInvalidTime`カウンタにしか現れない。

**修正案**: ループ内で`Date.now()`を取り直し、`gpsDate > now + 許容ずれ（例60秒）`のときだけ破棄する。
パースを正規表現ベースにし、失敗率が閾値を超えたら`last_status = 'error'`にする。

### M-7 同一測位が vehicle_gps_log に重複して蓄積される（一意制約が無い）

*GPS取得 / DB整合性* — `vehicleAssigner.js`（INSERT に ON CONFLICT なし）、`schema.sql`（`(vehicle_id, gps_time_ts)` の一意制約なし）

フィードの更新間隔がポーリング間隔（60秒）より長いと、同じ測位が`GPS_FRESHNESS_MIN`（15分）ぶん
繰り返し挿入される。始発待機中・終点待機中は常時。`pass()`が重複ぶんの距離計算を毎回走らせる。

**修正案**: `CREATE UNIQUE INDEX ON vehicle_gps_log (vehicle_id, gps_time_ts)`を追加し、INSERTを
`ON CONFLICT DO NOTHING`にする。

### M-8 生ログ転記が1回500件で頭打ちのため、車両が増えると恒常的な遅れが出る

*GPS取得 / 非同期処理* — `vehicleAssigner.js`（`sortCarId()` の `LIMIT 500`、1行ごとにトランザクション）

1周期あたりの取得件数が500を超えると未処理行が毎周期積み上がり、GPSが古い状態で割り当て・通過判定に
使われる。原因が「転記の遅れ」だと分かりにくい。

**修正案**: 未処理件数を返り値に含めて`jobMonitor`で可視化する。処理を1トランザクションでまとめ、
`INSERT … SELECT FROM unnest(...)`で一括挿入する。滞留があれば同一周期でループする。

### M-9 系統表示が切り替わる前後の車両が、次の便の候補になれない

*車両割り当て* — `tripAssignment.js`（`WHERE v.route_id = $1`）、`schema.sql`（`vehicles UNIQUE (route_id, car_id)`）

1台の物理バスは位置情報CSVの系統IDごとに別々の`vehicles`行になる。始発時刻直前のGPSが「前の系統の
車両行」に入っていると、次の便の候補検索（`v.route_id = trip.route_id`）にヒットしない。始発バス停に
実際にバスが居るのに`unassigned`になる。

**修正案**: `vehicles`の一意キーを`(feed_id, car_id)`にして物理車両1台＝1行にし、系統は
`vehicle_gps_log`側の観測値として持つ。または候補検索を`car_id` + 距離 + direction で行う。

### M-10 ETAプリコンピュートが区間統計を1停留所ずつ問い合わせる（N+1）

*ETA予測 / 非同期処理* — `etaPredictor.js`（`getSegmentStat(...)`をループ内で実行、全active割り当てを直列処理）

クエリ数は概ね「active割り当て数 × 未到着停留所数」。候補車両も対象なので、ピーク時に数千クエリが
60秒ごとに単一接続で直列に走る。⑧の所要時間がポーリング間隔に近づくと、次周期の`pipelineRunning`
ガードでパイプライン全体がスキップされる。

**修正案**: その日に必要な`segment_travel_stats`を`(day_type, hour_bucket)`単位で1回まとめて読み、
プロセス内Mapに載せる。`predictArrivals()`の引数に統計ルックアップ関数を渡す形にすればアルゴリズム
本体を変えずに済む。

### M-11 予測精度監視の「実績」に、線形補間値やGPS途絶時の救済値が混ざっている

*統計データ / 管理画面* — `predictionAccuracy.js`（`source='actual'` の `predicted_time` を実績とみなす）

`trip_stop_progress.actual_time`にはGPS実測のほかに`passInterpolate()`の補間値と終点救済値が入る。
`interpolated`フラグは持っているのに、予測精度の集計はそれを区別していない。補間値は前後の到着時刻から
作られるため予測と相関が高く、精度が実際より良く見える。

**修正案**: `trip_arrival_prediction_log`に`interpolated`を追加して`source='actual'`の行に記録し、
集計をGPS実測のみ／全件で切り替えられるようにする。

### M-13 プロセス停止中に始発時刻を過ぎた便が、復旧後にまとめて割り当てられる

*車両割り当て* — `tripAssignment.js`（`start_at <= evaluateBefore` のみで下限が無い）

割り当て対象は「pending かつ始発時刻を過ぎた便」で、どれだけ古い便かの上限が無い。GPSログは48時間
保持されるため、数時間前の便でも当時のGPSが残っていれば割り当てが成立する。デプロイ・DB障害からの
復旧時に、とっくに運行を終えた便が一斉に`assigned`になり`/api/buses`に並ぶ。

**修正案**: `start_at >= now() - interval '15 minutes'`のような下限を条件に足し、それより古い
pending便は`unassigned`にして閉じる。

### M-14 候補が1台も居なかった便は closed_at が立たず、保持期間まで残る

*運行終了判定 / DB整合性* — `tripAssignment.js`（`reassignOrphanTrips()`が割り当てゼロの便を除外）

候補ゼロで`unassigned`になった便には割り当て行が1件も無いため`reassignOrphanTrips()`の対象外。
`closed_at`を立てる経路は翌日以降の`finishTrips()`の運行日終了掃除しかない。管理画面の
`unassignedTrip`アラートに一日中残り続け、ノイズ化する。

**修正案**: 候補ゼロを確定した時点で`closed_at`も同時に立てる。または`/api/admin/alerts`の未割当条件に
「始発時刻から◯分以内」の上限を入れる。

### M-15 管理者パスワードの既定値が `admin` / `admin123` のまま起動できる

*API / 管理画面* — `services/adminAuth.js`（`process.env.ADMIN_USERNAME || 'admin'`）

`ADMIN_USERNAME`/`ADMIN_PASSWORD`を設定しなくても起動でき、その場合は誰でも知っている
既定値で管理画面が開く。管理画面からは運用パラメータの変更・車両の手動割り当て・
お知らせ配信・GTFS手動再取得ができるため、乗っ取られると利用者へ誤情報を配信できる。

**修正案**: `ADMIN_PASSWORD`未設定時は起動を拒否するか、ランダム値を生成して起動ログへ1回だけ出す。

同じ項目に含まれていた次の3点は対応済み（[system-review-2026-09.md](system-review-2026-09.md) S-2〜S-4）。

- **CORS全開放** → 公開APIは`CORS_ALLOWED_ORIGINS`で絞れるようになり、管理API（`/api/admin/*`）には
  そもそもCORSヘッダーを付けない。
- **非定数時間の比較** → `crypto.timingSafeEqual`（SHA-256で固定長に潰してから比較）に置き換え済み。
  ユーザー名・パスワードの判定を`&&`で短絡させないことで、どちらが外れたかも応答時間に出ない。
- **総当たり** → 認証失敗をIPごとに数え、`ADMIN_AUTH_MAX_FAILURES`（既定10回）超過で
  `ADMIN_AUTH_WINDOW_MIN`（既定15分）ブロックする。

なお401に`WWW-Authenticate: Basic`は**意図的に付けていない**。付けるとfetchが401を受けた際に
ブラウザ標準の認証ダイアログが出てしまい、管理画面自前のログインフォーム・セッション切れ処理と
二重になるため。

### M-16 migrate.js が require されただけでマイグレーションを実行し、プロセスを終了させる

*エラーハンドリング / DB整合性* — `migrate.js`（トップレベルで`migrate()`を呼び`process.exit()`。`require.main === module`ガードが無い）

`module.exports = { migrate }`と書かれているのに、`require('./db/migrate')`しただけでDDL実行 →
`process.exit()`になる。誰かが`migrate`をインポートした瞬間にサーバープロセスが黙って落ちる。

**修正案**: `seed.js`と同じ`if (require.main === module) { … }`ガードで囲み、`pool.end()`を待ってから終了する。

---

## Low（保守性・整合性・軽微な挙動差）

### L-2 外部IDの照合がCSV行全体の部分一致で、列位置を見ていない

`locationFetcher.js`（`if (joined.includes(externalId))`）。行を`join(',')`した文字列に外部IDが
含まれるかで路線を決めている。現在の外部IDは26文字のULIDなので誤マッチはまず起きないが、事業者が
短い系統コードを導入したり備考欄にIDを含めたりすると誤解決する。
**修正案**: 外部IDが入る列位置を`config/feeds.js`にフィードごとに持ち、その列との完全一致で解決する。

### L-3 route_id や service_id にアンダースコアがあるとグループキーの分解が壊れる

`seed.js`（キーを`route_id + '_' + directionId + '_' + serviceId`で組み、`split('_')`で復元）。
区切り文字がIDに現れないことを前提にしている。現在の2フィードは数値IDなので該当しない。
**修正案**: 文字列キーをやめ、`JSON.stringify([routeId, directionId, serviceId])`を使う。

### L-4 フロントの既定 routeId が未修飾の '11' で、初回描画が空になる

`frontend/app.js`（`let selectedRouteId = '11';`）。DBの`route_id`は`guruttomatsumotobus1:11`形式。
路線一覧取得後に補正されるが、それ以前の`loadAll()`は素の`'11'`で叩き、運行状況が一瞬
「バスがありません」と表示される。
**修正案**: 既定値を`'guruttomatsumotobus1:11'`に揃えるか、routeId無しで`/api/buses`を叩いて
サーバー側の既定に委ねる。

### L-5 SIGTERM を処理しておらず、接続プールも閉じずに終了する

`server.js`（SIGINTのみ、`process.exit(0)`即時）。`docker stop`・RenderのデプロイはいずれもSIGTERMを
送る。進行中のトランザクションが途中で切れる（DB側でロールバックされるため実害は限定的）。
**修正案**: SIGTERM/SIGINTの両方で、タイマー停止 → HTTPサーバーの`close()` → `pool.end()`の順に
待ってから終了する。

### L-6 位置情報CSVのパーサがエスケープされたダブルクォートに対応していない

`locationFetcher.js`。同じ処理のパーサがリポジトリ内に複数あり、`locationFetcher`のものだけ`""`を
扱えず、BOM除去も無い。CSVのフィールドに引用符が含まれると列がずれ、緯度経度がNaNになって静かに
捨てられる。
**修正案**: `utils/csv.js`の行パーサを再利用する。

### L-8 負荷チェックのポーリング自体が閲覧数を押し上げ続ける

`frontend/app.js`（`setInterval(checkServerLoad, POLL_MS)`）と`api.js`（`X-Client-Id`付きリクエストを
全部カウント）。`/api/server-load`は自動更新がOFFでもどの画面でも20秒ごとに呼ばれ、閲覧数として
カウントされる。負荷判定のための通信が負荷指標を作っている。
**修正案**: `/api/server-load`をカウント対象から除外する。`document.visibilityState !== 'visible'`の
ときはポーリングを止める。

### L-9 有効なGTFSフィードが0件のとき、更新間隔の記録が更新されない

`gtfsFeedManager.js`（`if (feeds.length === 0) return`が`lastGtfsUpdateAt = now`より前にある）。
全GTFSフィードを`enabled: false`にすると、60秒ごとに接続を取得してログを出すだけの無駄な処理が回る
（実害は軽微）。
**修正案**: `lastGtfsUpdateAt = now`を関数の入口側かfinallyに移す。

### L-10 data gtfs/ が永続ボリュームでなく、再作成のたびに全フィードを再取得する

`Dockerfile`（`COPY ["data gtfs", "data gtfs"]`）、`docker-compose.yml`（backendサービスにvolume指定なし）。
コンテナ再作成でイメージ内の古いGTFSに巻き戻り、`ensureGtfsFilesPresent()`はファイルが揃っているかしか
見ないので再取得も走らない。デプロイ直後、最大1時間ダイヤ改正前のGTFSで当日便が生成される。
**修正案**: `docker-compose.yml`のbackendに名前付きボリュームを割り当てる。または起動時に必ず1回
`updateAllGtfsFeeds()`を強制実行する。

### L-11 パイプラインが間隔内に終わらなかったことを検知・記録していない

`jobs/scheduler.js`（`if (pipelineRunning) return;`で黙ってスキップ）。多重実行防止は正しい設計だが、
スキップした事実がどこにも残らない。実質的なポーリング間隔が2分・3分へ伸びていても気づけない。
**修正案**: スキップ回数を`jobMonitor`にカウンタとして持たせ、管理画面のジョブ監視に表示する。
連続スキップが閾値を超えたらアラート化する。

### L-12 ETAの遅延キャップが、実際に大きく遅れている便の到着を早く見せる

`etaPredictor.js`（`resolveDelayCeiling()` / `capPredictedDelay()`）。上限は現在の遅れだけで決まり、
残り区間の長さや実際の統計を参照しない。`DELAY_RECOVERY_BOOST`（1.15）は遅れ解消方向の予測を常に
1.15倍強調する。序盤定時・途中で大きく遅れる便で、終盤に過小予測へ偏りうる（仮説。実測で検証してから
手を入れること）。
**修正案**: `/api/admin/prediction-accuracy`の誤差バイアス（符号付き平均）を路線・リードタイム別に
確認し、偏りが確認できたら上限を「残り所要時間に比例した値」へ変える。`DELAY_RECOVERY_BOOST`は
1.0に戻して検証する。
