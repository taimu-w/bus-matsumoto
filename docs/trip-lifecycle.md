# 運行終了判定・便のクローズ・アーカイブの詳細（`services/finishService.js`）

## `finishTrips()` — 割り当ての終了判定

`jobs/scheduler.js`上、独立したタイマー（1分間隔）で実行されます。**判定単位は車両ではなく「便への割り当て」**です。1台の車両が複数便の候補になり得るため、車両単位で終了させると他便の処理まで巻き添えになるからです（設計の背景は[design-trip-first-assignment.md](design-trip-first-assignment.md)）。

割り当て直後の誤判定を防ぐため、`FINISH_PROTECTION_MIN`（既定10分）が経過するまでは条件①②④の判定を行いません。

| 条件 | 判定単位 | 内容 |
|---|---|---|
| ① 終点到着済み | 割り当て | **その便の最終停留所**の`status`が`到着済`（路線の終点ではなく便ごとの終点なので、途中止まりの便も正しく終了できる） |
| ② 終了エリア到達 | 割り当て | 直近GPSがその便の終点から`END_AREA_RADIUS_METERS`（既定150m）以内 |
| ③ 一定時間経過 | 割り当て | 割り当てから`VEHICLE_MAX_AGE_MIN`（既定120分）経過（保護期間の対象外＝強制終了） |
| ④ GPS更新停止 | 車両 | 直近GPSの受信から3分以上経過。その車両の**全**割り当てを終了させ、`vehicles.status = 'inactive'`にする |

## `closeDailyTrip()` — 便のクローズと実績の確定

**担当車両の割り当てが終了しても、便が終了したとは扱いません。** 便のクローズは次のいずれかの時点で行われます（いずれも`tripAssignment.reassignOrphanTrips()`から呼ばれます。判定条件の詳細は[vehicle-assignment.md](vehicle-assignment.md)）。

- 担当車両が終点まで走り切った（終了理由が`最終バス停到着済`／`終了エリア到達`）
- 再割り当てできる候補車両が居なくなった

クローズ時の保存内容：

1. その便の残った有効な割り当てをすべて`ended`にする。
2. **最後に担当車両だった割り当て1件**を`is_official = TRUE`で`completed_trips`＋`completed_trip_stop_times`に保存する。`actual_time`（"H:mm"文字列）は`actual_minutes`（0時起点の分数）にも変換する（統計集計で使うため。詳細は[eta-prediction-algorithm.md](eta-prediction-algorithm.md)）。
3. 担当を経験した他の車両（再割り当て前の旧担当など）は`is_official = FALSE`で監査用に保存する。
4. **一度も担当にならなかった候補車両はアーカイブしない。** 別経路をたまたま走っていた可能性があり、区間統計を汚染するためです。
5. `daily_trips.closed_at`を立てる。`closed_at`は「リアルタイム運行情報の対象から外れた」ことを表すだけで、便自体は時刻表上のデータとして存続します（経路検索はそもそもGTFSインデックス側を見るため影響を受けません）。

その後`etaPredictor.js`の`updateSegmentStats()`を呼び、区間統計を更新します。つまり**「バスが1便走り終える」→「統計が育つ」→「次の予測精度が上がる」**というループがここで完結しています。
