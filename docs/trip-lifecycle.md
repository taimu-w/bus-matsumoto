# 運行終了判定・便のクローズ・アーカイブの詳細（`services/finishService.js`）

## `finishTrips()` — 割り当ての終了判定

`jobs/scheduler.js`上、独立したタイマー（1分間隔）で実行されます。**判定単位は車両ではなく「便への割り当て」**です。1台の車両が複数便の候補になり得るため、車両単位で終了させると他便の処理まで巻き添えになるからです（設計の背景は[vehicle-assignment.md](vehicle-assignment.md)）。

割り当て直後の誤判定を防ぐため、`FINISH_PROTECTION_MIN`（既定10分）が経過するまでは条件①④の判定を行いません。

| 条件 | 判定単位 | 内容 |
|---|---|---|
| ① 終点到着済み | 割り当て | **その便の最終停留所**の`status`が`到着済`（路線の終点ではなく便ごとの終点なので、途中止まりの便も正しく終了できる） |
| ③ 一定時間経過 | 割り当て | 割り当てから`VEHICLE_MAX_AGE_MIN`（既定120分）経過（保護期間の対象外＝強制終了） |
| ④ GPS更新停止 | 車両 | 直近GPSの受信から3分以上経過。その車両の**全**割り当てを終了させ、`vehicles.status = 'inactive'`にする |

運行終了は条件①③④のみで判定します（「終了エリア到達」＝直近GPSが終点から一定距離以内、という判定は循環線・往復線の途中で誤発火するため持ちません）。

**2段階到着判定（[pass-detection.md](pass-detection.md)）では、終点は`付近`のまま条件①が成立しないまま止まり続けることがあります。** 終点は到着後にバスがそのまま停車し続けることが多く、`DEPARTURE_MARGIN_METERS`分だけ離れる（＝到着確定のトリガー）が起きないためです。この場合は条件④（GPS途絶）が成立した際に、`endAssignment()`が`state='ended'`にする直前に`付近`のまま残っている終点を記録済みの最小距離の観測時刻で強制的に`到着済`へ昇格させます（`interpolated=FALSE`）。終点が`付近`まで来ていればその観測値を優先して昇格させます（`''`のままなら直近の生GPS時刻へフォールバックし`interpolated=TRUE`）。

## `closeDailyTrip()` — 便のクローズと実績の確定

**担当車両の割り当てが終了しても、便が終了したとは扱いません。** 便のクローズは次の**2つの独立した経路**から呼ばれます。呼び出し元が2系統あること自体が、後述する二重実行対策が必要になった理由です。

- `tripAssignment.reassignOrphanTrips()`（パイプライン⑤、`POLL_INTERVAL_SECONDS`＝既定60秒間隔）から、担当車両が終点まで走り切ったとき（終了理由が`finishService.SUCCESS_END_REASONS`＝`最終バス停到着済`／`終点到着（GPS途絶時判定）`／`終点到着（GPS途絶時判定・付近経由）`のいずれか。後2者はGPS途絶時の終点到着救済判定で終点到達が確認できたケースで、正常終了扱いとしGPS途絶ロストには含めない）、または再割り当てできる候補車両が居なくなったときに呼ばれる（判定条件の詳細は[vehicle-assignment.md](vehicle-assignment.md)）。
- `finishService.finishTrips()`自身（1分間隔の運行終了バッチ）の末尾、運行日が過ぎてもクローズされていない便を掃除する処理（理由`運行日終了`）からも直接呼ばれる。

この2つのタイマーはサーバー起動時にほぼ同時に開始されるため位相が揃いやすく、日付が変わった直後や再割り当てが発生した便では、同じ`daily_trip_id`に対して両方の経路がほぼ同時に`closeDailyTrip()`を呼ぶことが実際に起こります。

**二重実行対策**: `closeDailyTrip()`は冒頭で`SELECT id FROM daily_trips WHERE id = $1 AND closed_at IS NULL FOR UPDATE`により当該便の行ロックを取ります。後発側のトランザクションはこのロックで先発側の`COMMIT`までブロックされ、ロック取得後に`closed_at`が既に埋まっていることを確認して`{ archived: 0 }`で即座に抜けます。これにより、2系統から同時に呼ばれても実績が二重にアーカイブされることはありません。`completed_trips`には`UNIQUE (daily_trip_id, assignment_id)`制約も張ってあり、万一この行ロックをすり抜けるコード変更が将来入っても、実績が黙って二重に入ることだけは防ぎます（行ロックが一次防御、制約は安全網という位置づけ）。

クローズ時の保存内容：

1. その便の残った有効な割り当てをすべて`ended`にする。
2. **最後に担当車両だった割り当て1件**を`is_official = TRUE`で`completed_trips`＋`completed_trip_stop_times`に保存する。`actual_time`（"H:mm"文字列）は`actual_minutes`（0時起点の分数）にも変換する（統計集計で使うため。詳細は[eta-prediction-algorithm.md](eta-prediction-algorithm.md)）。
3. 担当を経験した他の車両（再割り当て前の旧担当など）は`is_official = FALSE`で監査用に保存する。
4. **一度も担当にならなかった候補車両はアーカイブしない。** 別経路をたまたま走っていた可能性があり、区間統計を汚染するためです。
5. `daily_trips.closed_at`を立てる。`closed_at`は「リアルタイム運行情報の対象から外れた」ことを表すだけで、便自体は時刻表上のデータとして存続します（経路検索はそもそもGTFSインデックス側を見るため影響を受けません）。

その後`etaPredictor.js`の`updateSegmentStats()`を呼び、区間統計を更新します。つまり**「バスが1便走り終える」→「統計が育つ」→「次の予測精度が上がる」**というループがここで完結しています。`updateSegmentStats()`も`reassignOrphanTrips()`と`finishTrips()`の両方から呼ばれるため、同様の二重実行対策（`FOR UPDATE SKIP LOCKED`）が入っています。詳細は[eta-prediction-algorithm.md](eta-prediction-algorithm.md)を参照してください。
