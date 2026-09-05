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

### H-6 GTFSから消えた便の schedule_trips 行が残り、実在しない便が当日便に混ざる

*GTFS更新 / DB整合性* — `seed.js`（`alignTripIndexesByGtfsTripId()`）、`dailyTripBuilder.js`（`loadScheduleTrips`）

reseed は GTFS から消えた `schedule_trips` の行を**削除しない**。`completed_trips.trip_id` が
CASCADE無しの外部キーでこの行を参照しており、削除するとアーカイブ済みの運行実績を巻き添えにするため、
`alignTripIndexesByGtfsTripId()` は消えた便を `trip_index` の後ろへ退避するだけにしている。
その `service_id` が現役のままだと `dailyTripBuilder` がこの行からも当日便を生成し、実在しない便が
時刻表・運行状況に出る。

**修正案**: `completed_trips.trip_id` を `ON DELETE SET NULL` にしたうえで、消えた便を DELETE する。
あるいは `schedule_trips` に「今回のGTFSに存在するか」のフラグを持たせ、`dailyTripBuilder` 側で除外する。

同じ項目に含まれていた次の3点は対応済み（[system-review-2026-09.md](system-review-2026-09.md) G-1）。

- **内容不変でも毎時 seed() が全マスタを書き換える** → `feeds.content_hash`（ZIPのSHA-256）と
  条件付きGET（ETag / Last-Modified）で内容不変を判定し、変わったフィードが1件も無ければ
  展開も `seed()` も行わない。指紋の確定は `seed()` 成功後（`commitFeedFingerprint()`）。
- **`trip_index` の位置依存キーでダイヤ改正時に便がずれる** → UPSERTの前に
  `alignTripIndexesByGtfsTripId()` が既存行を `gtfs_trip_id` 基準で今回の並びへ整列させるため、
  UPSERTは必ず同じ便の行に当たる。
- **毎デプロイでフル再ダウンロード＋seed()** → 指紋をプロセス内変数ではなくDBに持つため、
  再起動直後の初回実行でも内容が同じなら `seed()` は走らない。

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

### M-4 早発を検知して管理画面のアラートに出す仕組みが無い

*遅延計算 / 管理画面* — `utils/time.js`（`computeSignedDelayMinutes()`）、`frontend/admin-alerts.js`

符号付きの遅延（負＝定刻より早い）は`trip_stop_progress.signed_delay_minutes`ほかに保存されるように
なったが、それを見て「定刻より早く発車した便」を異常アラートとして挙げる処理はまだ無い。
管理画面のバス停別詳細で1件ずつ開けば「定刻より◯分早い」バッジは見えるが、能動的には気づけない。

なお**表示・しきい値判定は`delay_minutes`（0以上に丸めた値）を使うのが正**で、
これを符号付きに置き換えないこと（公開画面が「−3分遅れ」と出るようになる）。

**修正案**: 便レベルの`trip_vehicle_assignments.signed_delay_minutes`が一定値（例: −2分）を
下回った便を、遅延アラートと同じ枠組みで一覧に出す。

### M-8 ✅ 生ログ転記が1回500件で頭打ちのため、車両が増えると恒常的な遅れが出る — 対応済み

*GPS取得 / 非同期処理* — `vehicleAssigner.js`（`sortCarId()`）

**指摘だった状態**: 1周期あたりの取得件数が500を超えると未処理行が毎周期積み上がり、GPSが古い状態で
割り当て・通過判定に使われる。原因が「転記の遅れ」だと分かりにくい。

対応内容は[system-review-2026-09.md](system-review-2026-09.md) P-3を参照。

- **滞留の可視化がない** → 返り値に`transferred`/`duplicateSkipped`/`batches`/`backlogRemains`を
  含めるようにし、`jobMonitor`の`pipeline.sortCarId`から見えるようにした。
- **1周期500件で頭打ち** → 取得件数がLIMIT未満になるまで、または上限（既定5バッチ＝2500件）に
  達するまで、同一周期内でバッチを繰り返すようにした。

**残っている課題**: 行ごとのBEGIN/COMMITは変えていない（1トランザクションへまとめて
`INSERT … SELECT FROM unnest(...)`で一括化する案は見送った。1行の失敗が他行を巻き込まない
という既存の耐障害性を保つため）。上限（既定2500件/周期）を超える滞留は次回以降のポーリングに持ち越す。

### M-9 系統表示が切り替わる前後の車両が、次の便の候補になれない

*車両割り当て* — `tripAssignment.js`（`WHERE v.route_id = $1`）、`schema.sql`（`vehicles UNIQUE (route_id, car_id)`）

1台の物理バスは位置情報CSVの系統IDごとに別々の`vehicles`行になる。始発時刻直前のGPSが「前の系統の
車両行」に入っていると、次の便の候補検索（`v.route_id = trip.route_id`）にヒットしない。始発バス停に
実際にバスが居るのに`unassigned`になる。

**修正案**: `vehicles`の一意キーを`(feed_id, car_id)`にして物理車両1台＝1行にし、系統は
`vehicle_gps_log`側の観測値として持つ。または候補検索を`car_id` + 距離 + direction で行う。

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

### M-15 ✅ 管理者パスワードの既定値が `admin` / `admin123` のまま起動できる — 対応済み

*API / 管理画面* — `services/adminAuth.js`（`process.env.ADMIN_USERNAME || 'admin'`）

**指摘だった状態**: `ADMIN_USERNAME`/`ADMIN_PASSWORD`を設定しなくても起動でき、その場合は
誰でも知っている既定値で管理画面が開いていた。管理画面からは運用パラメータの変更・
車両の手動割り当て・お知らせ配信・GTFS手動再取得ができるため、乗っ取られると利用者へ
誤情報を配信できる。

同じ項目に含まれていた次の4点はすべて対応済み
（[system-review-2026-09.md](system-review-2026-09.md) S-1〜S-4）。

- **既定パスワード** → `ADMIN_PASSWORD`未設定時は起動を拒否する代わりに、起動のたびに変わる
  ランダムなパスワードを生成し、起動ログに1回だけ出す方式にした。`ADMIN_PASSWORD`を
  設定済みの環境は影響を受けない。
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
