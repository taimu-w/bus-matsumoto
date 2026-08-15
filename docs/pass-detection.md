# バス停通過判定・欠落補完の詳細（`services/passDetection.js`）

`pass()`の処理内容（パイプライン⑥）。内部で3つの関数に分かれています。**処理単位は車両ではなく「便への割り当て」**で、担当車両・候補車両を区別せず`state = 'active'`の割り当てすべてが対象です（設計の背景は[design-trip-first-assignment.md](design-trip-first-assignment.md)）。

## `passStep1And3()` — 候補となる通過を探す

- DB上で確定している「最後に到着したバス停」のインデックス（`lastArrivedIdx`）を基準に、未処理のGPSログ1件ごとに「まだ到着していないバス停」の中から最も近いものを探す。バス停マスタは**その便の停車パターン**（`trip_stop_progress`）で、便が通らない停留所は最初から含まれない。
- **循環線対策①（探索範囲の制限）**: `lastArrivedIdx + 4`より先のバス停は候補にしない。循環路線では出発直後に終点付近のバス停ともGPS距離が近くなってしまう場合があるため、直近から4つ先までしか見ないことで誤判定を防ぐ。
- **循環線対策②（初期の誤判定防止）**: 便の始発時刻から20分以内は、便全体の後半80%のバス停を候補から除外する（旧方式では「出発時刻から」だった基準を、便の始発時刻に置き換えている）。
- **巻き戻り防止**: バッチ処理内で一度マッチしたバス停より手前（`seq_order`が小さい側）は、以降のGPSログで再度候補にしない（`currentMaxIdx`で管理）。
- 半径`STOP_RADIUS_METERS`（既定120m）以内で最も距離が近いバス停を「暫定マッチ」として記録する。

## `passStep2Dedup()` — 同一バス停への重複マッチを解消

1つのバス停に対して複数のGPSログがマッチした場合、そのバス停の座標に**最も近い1件**だけを採用する。

## `passInterpolate()` — 欠落バス停の補完

到着済み（`actual_time`あり）のバス停を`seq_order`順に並べ、間に2つ以上の未確定バス停がある場合、前後の到着時刻を**線形補間**して埋める（GPSが一時的に取得できず、通過検知が飛んでしまった区間の救済措置）。補完した行には`interpolated = TRUE`のフラグを立てる。

## `pass()` 本体の流れ

1. 割り当てごとに、その車両のGPSログのうち`trip_gps_matches`に未登録のものを取得（便の始発時刻の3分前以降・freshness内）。
2. `passStep1And3()`→`passStep2Dedup()`の順で確定マッチを算出。
3. 確定した分だけ`trip_gps_matches`へ記録し、`trip_stop_progress.status/actual_time`・`trip_vehicle_assignments.last_arrived_seq`を更新。
4. 重複除去で外れたGPSログは`trip_gps_matches`に記録されないため、次回のバッチで自動的に再評価される。
5. 最後に`passInterpolate()`で欠落区間を補完する。

「どのGPSログを処理済みか」を`vehicle_gps_log.matched_label`（車両側の1列）ではなく`trip_gps_matches`（割り当て×GPSログ）で管理しているのは、**1台の車両が複数便の候補になり得る**ためです。同じGPSログ行が便ごとに別々のバス停へマッチし得るので、車両側の1列では表現できません。

## 通過バス停の扱い（`tripAssignment.js`の`openAssignment()` / `delayCalc.js`との関係）

あるバス停が`通過`ステータスに確定されるのは、それが便の中で実質的な終点（`lastValidSeq`、実際に定刻を持つ最後のバス停）より**手前**にある経由フラグ付きバス停の場合のみです。`lastValidSeq`より先にある経由フラグ付きバス停は、単に未確定なだけで通過ではありません。この2つを混同したことが実際の過去のバグの原因でした。`delayCalc.js`は`scheduled_time`が無いことを理由にステータスを強制上書きする処理を意図的に廃止しています。バス停のstatus確定は`tripAssignment.js`の`openAssignment()`が既に正しく行っている前提で、`delayCalc.js`側では上書きしません（判定条件の詳細は[vehicle-assignment.md](vehicle-assignment.md)）。
