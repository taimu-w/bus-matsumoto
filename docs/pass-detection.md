# バス停通過判定・欠落補完の詳細（`services/passDetection.js`）

`pass()`の処理内容（パイプライン⑥）。**処理単位は車両ではなく「便への割り当て」**で、担当車両・候補車両を区別せず`state = 'active'`の割り当てすべてが対象です（設計の背景は[vehicle-assignment.md](vehicle-assignment.md)）。

## 2段階到着判定（'' → '付近' → '到着済'）

バス停到着判定は2段階です。`STOP_RADIUS_METERS`（既定120m）以内に入った時点では`付近`とし、そこから遠ざかり始めた時点で`到着済`に確定します。信号待ち・渋滞・到着前の一時停止などで、まだ到着していないのに到着済と誤判定するのを防ぐためです。

- **付近入り(`passStepEntry()`)**: 下記①②③の判定を満たすGPS点で、そのバス停を`付近`状態に入れます（最初の近接観測）。このときGPS点を`trip_gps_matches`に消費します。到着済・付近いずれかの状態のバス停は、新規の付近入り候補から除外します（`excludedSet`）。
- **到着確定(`passStepConfirm()`)**: `付近`状態の間、観測した最小距離を`trip_stop_progress.nearby_min_distance_meters`/`nearby_min_distance_gps_time`/`nearby_min_distance_gps_time_ts`に記録し続けます。このときのGPS点は`trip_gps_matches`に消費しないため、未消費のまま次バッチでも再評価され続けます（同じGPS窓・freshness内であれば毎回候補に残る）。現在距離が「最小距離＋`DEPARTURE_MARGIN_METERS`（既定20m）」を上回った時点＝バス停から遠ざかり始めたと判定し、`到着済`に確定します。`actual_time`には遠ざかったのを確認した時刻ではなく、**最小距離を記録した時点のGPS時刻**を採用します。①②③の制約（探索範囲・始発直後の除外・ETA時間窓）は付近入りの時点で既に適用済みのため、確定判定では再適用しません（純粋に最小距離からの離脱だけで判定します）。
- **付近スタックの遡及昇格(`promoteStuckNearbyStops()`、`passInterpolate()`内)**: `付近`のまま離脱（＝到着確定のトリガー）が起きずに残ってしまうことがあります（典型例は終点：バスが到着後そのまま停車し続け、マージン距離だけ離れることが無い）。それより先のバス停が既に`到着済`になっている＝進行が先に進んだ以上とっくに通過しているはず、という場合、記録済みの最小距離の観測値を使って強制的に`到着済`へ昇格させます。実観測データに基づく確定なので`interpolated = FALSE`とし（後述の線形補間とは区別）、後続の線形補間より先に行うことで、その補間が昇格した区間を新しいアンカーとして使えるようにしています。
- **割り当て終了時の強制昇格(`finishService.js`の`endAssignment()`)**: 上記の遡及昇格はパイプラインの次回実行（`pass()`）まで待つため、割り当てが終了する瞬間にはまだ`付近`のまま残っている場合があります。`endAssignment()`は`state='ended'`にする直前に、記録済みの最小距離の観測時刻を使って同様の強制昇格を行います。GPS途絶時の終点到着救済判定（`finishTrips()`）も、終点が`付近`まで来ていればその観測値をそのまま使い（`interpolated=FALSE`）、`''`のままなら直近の生GPS時刻にフォールバックします（`interpolated=TRUE`）。

`trip_stop_progress`の3列（`nearby_min_distance_meters`/`nearby_min_distance_gps_time`/`nearby_min_distance_gps_time_ts`）は、`tripAssignment.js`の`openAssignment()`のON CONFLICT句のSET句に含めていません。これにより、GTFS再取得（reseed）時にも常に保持されます。`status`/`actual_time`/`delay_minutes`側のCASE式は、既存行が`到着済`・`付近`のどちらでも上書きしません。

## `passStepEntry()` — 候補となる付近入りを探す

- DB上で確定している「最後に到着したバス停」のインデックス（`lastArrivedIdx`、`到着済`のみを対象。`付近`は含まない）を基準に、未処理のGPSログ1件ごとに「まだ到着済・付近になっていないバス停」の中から最も近いものを探す。バス停マスタは**その便の停車パターン**（`trip_stop_progress`）で、便が通らない停留所は最初から含まれない。
- **循環線対策①（探索範囲の制限）**: `lastArrivedIdx + 6`より先のバス停は候補にしない（③のETA時間窓による絞り込みは併用）。循環路線では出発直後に終点付近のバス停ともGPS距離が近くなってしまう場合があるため、直近から6つ先までしか見ないことで誤判定を防ぐ。
- **循環線対策②（初期の誤判定防止）**: 便の始発時刻から一定時間以内は、便全体の後半80%のバス停を候補から除外する。
- **巻き戻り防止**: バッチ処理内で一度マッチしたバス停より手前（`seq_order`が小さい側）は、以降のGPSログで再度候補にしない（`currentMaxIdx`で管理）。付近入りも到着確定と同じくこのカーソルを進める。
- 半径`STOP_RADIUS_METERS`（既定120m）以内で最も距離が近いバス停を「暫定マッチ（付近入り候補）」として記録する。

## `passStep2Dedup()` — 同一バス停への重複マッチを解消

1つのバス停に対して複数のGPSログがマッチした場合、そのバス停の座標に**最も近い1件**だけを採用する。

## `passStepConfirm()` — 付近→到着済の確認（離脱検知）

`付近`状態の各バス停について、GPSログ（`gps_time_ts`昇順）を走査し、最小距離の更新・到着確定を判定する純粋関数。記録済みの最小距離の観測時刻より前のGPS点は評価しない（②の除外時間帯にいたため付近入りできなかった、未消費のまま残っている古いGPS点などが紛れ込み、`actual_time`を不正な過去時刻へ巻き戻すのを防ぐため）。`shouldConfirmDeparture(currentDist, minDist, marginMeters)`が判定本体（`currentDist > minDist + marginMeters`）。

## ベクトル通過判定（到着判定高速化）— `findNextUnarrivedStop()` / `evaluateVectorCrossing()` / `findVectorConfirmation()`

`passStepConfirm()`の離脱検知（最小距離＋`DEPARTURE_MARGIN_METERS`だけ遠ざかるのを待つ）とは別に、到着確定を早めるための補助判定です。双方を並行して動作させ、どちらか早く条件を満たした方で到着確定とします（ベクトル判定はDBへの`UPDATE`に`WHERE status != '到着済'`を付けており、離脱検知の側が同一バッチ内で先に確定していれば単純に0件更新になるだけで安全）。

- **対象（`findNextUnarrivedStop()`）**: 「まだ`到着済`になっていない次の1停留所」だけを対象にする（複数候補ではなく単一）。DB確定済みの最後の到着済バス停（`lastArrivedSeq`）の直後、`seq_order`が最小の1件を返す。`passStepEntry()`の循環線対策①（`lastArrivedIdx+6`先までの探索）とは無関係で、そちらの探索範囲・ロジックには使わない。`stopMaster`はバッチ開始時点のスナップショットのため、同一バッチ内で`passStepConfirm()`が確定した`seq_order`を`extraArrivedSeqOrders`引数で追加考慮する（渡さないと、直前に確定したばかりのバス停をまだ未到着として誤って対象にし、次のバス停への切り替えが1周期分遅れる）。
- **判定（`evaluateVectorCrossing(p1, p2, stop)`）**: 過去位置P1・現在位置P2（同一assignmentのGPSログを時系列で隣接する2点）を使い、以下をすべて満たした場合のみ`confirmed: true`を返す純粋関数。
  1. 前提条件：P1-P2間の距離が10〜700m、P1・P2ともに対象バス停から600m以内、P1またはP2のどちらかが500m以内。
  2. 線分条件：線分P1-P2と対象バス停の最短距離が100m以内（`VECTOR_SEGMENT_DISTANCE_METERS`）。
  3. ベクトル条件：対象バス停を挟んでP1とP2が反対側にいること。対象バス停を原点とする局所平面座標（`utils/geo.js`の`toLocalXYMeters()`）でのP1・P2それぞれの位置ベクトル（S→P1、S→P2）の内積が負であることで判定する（符号反転＝反対側）。
  4. 上記のいずれか一つでも満たさない場合は`confirmed: false`と`reason`（デバッグ・テスト用の理由コード）を返す。呼び出し側はこの場合ベクトル判定を行わず、従来の到着判定（付近入り→離脱検知）だけで判定を続ける（フォールバック）。履歴不足（GPSが1点以下）も同様にフォールバックする。
- **確定時刻（`findVectorConfirmation(gpsRows, stop)`）**: `gpsRows`（`gps_time_ts`昇順）を先頭から走査し、時系列で隣接する2点ごとに`evaluateVectorCrossing()`を評価、最初に条件を満たした時点（＝最も早く到着確定できる時点）で確定する。`actual_time`は、線分P1-P2上で対象バス停に最も近い点の位置（`t`、0=P1・1=P2にクランプ）を使ってP1・P2の`gps_time_ts`を線形補間し、"H:mm"形式（`utils/time.js`の`formatTimeNoFormat()`）に変換したものを採用する。
- **ログ・根拠の保存**: ベクトル判定で到着確定した場合のみ`[pass] 到着確定（ベクトル判定）`のログを出力する（`stepDist`・`distP1Stop`・`distP2Stop`・`segDist`・`dot`・`t`・P1/P2の座標と時刻）。条件を満たさなかった場合（フォールバック）はログを出さない。**同じ値は`trip_stop_progress.arrival_evidence`（JSONB）にも保存され**、管理画面「運行ダッシュボード」のバス停別モーダルで後から確認できる（下記「到着判定方法の記録」）。

## `passInterpolate()` — 付近スタックの遡及昇格＋欠落バス停の補完

まず`promoteStuckNearbyStops()`で付近スタックの遡及昇格を行い、そのうえで到着済み（`actual_time`あり）のバス停を`seq_order`順に並べ、間に2つ以上の未確定バス停がある場合、前後の到着時刻を**線形補間**して埋める（GPSが一時的に取得できず、通過検知が飛んでしまった区間の救済措置）。補完した行には`interpolated = TRUE`のフラグを立てる（遡及昇格は実観測データのため`FALSE`のまま）。

## `pass()` 本体の流れ

1. 割り当てごとに、その車両のGPSログのうち`trip_gps_matches`に未登録のものを取得（便の始発時刻の3分前以降・freshness内）。
2. `passStepEntry()`→`passStep2Dedup()`の順で「付近入り」の確定マッチを算出し、`trip_gps_matches`へ記録、`status='付近'`・`nearby_min_distance_*`・`last_arrived_seq`を更新。
3. `passStepConfirm()`でDB由来の既存「付近」＋今バッチで新規に付近入りしたバス停をまとめて評価し、離脱を検知したものは`status='到着済'`・`actual_time`（＝最小距離観測時点）を確定、まだ離脱していないものは`nearby_min_distance_*`だけを更新する（この更新は`trip_gps_matches`を消費しない）。
4. 重複除去で外れたGPSログ、および確認未了のGPSログは`trip_gps_matches`に記録されないため、次回のバッチで自動的に再評価される。
5. ベクトル通過判定（上記）で、まだ到着済になっていない次の1停留所だけを対象に、より早く到着確定できないかを追加で判定する。3で今回のバッチ内に既に到着確定済みならスキップする。
6. 最後に`passInterpolate()`で付近スタックの遡及昇格・欠落区間の補完を行う。

「どのGPSログを処理済みか」を車両側の列ではなく`trip_gps_matches`（割り当て×GPSログ）で管理しているのは、**1台の車両が複数便の候補になり得る**ためです。同じGPSログ行が便ごとに別々のバス停へマッチし得るので、車両側の1列では表現できません。

## 到着判定方法の記録（`arrival_method` / `arrival_evidence`）

あるバス停が`到着済`になったとき、**どの判定で確定したか**（`arrival_method`）と**その根拠**（`arrival_evidence` JSONB）を`trip_stop_progress`に書き込みます。管理画面「運行ダッシュボード」のバス停別詳細モーダルで「なぜここが到着済になったのか」を確認するためのもので、通過判定のロジック自体には影響しません。

| `arrival_method` | 書き込み箇所 | `arrival_evidence` の主な内容 |
|---|---|---|
| `nearby` | `passStepConfirm()`の離脱検知 → `processAssignmentPass()` | `minDistanceMeters`（最接近距離）・`gpsTime`（採用したGPS時刻）・`marginMeters` |
| `vector` | ベクトル通過判定 → `processAssignmentPass()` | `stepDist`・`distP1Stop`・`distP2Stop`・`segDist`・`dot`・`t`・`p1`/`p2`（前後GPS点の座標・時刻）＝ログと同じ値 |
| `promoted` | `promoteStuckNearbyStops()` | `minDistanceMeters`・`gpsTime` |
| `interpolated` | `passInterpolate()`の線形補間（`interpolated=TRUE`と併記） | 基準にした前後のバス停の`seq_order`・実績時刻 |
| `finish` | `finishService.js`の終了時強制昇格 / GPS途絶時の終点救済 | `minDistanceMeters` or `distanceMeters`・`gpsTime`・`trigger` |
| `start` | `tripAssignment.openAssignment()`の始発バス停 | `distanceMeters`（始発時刻時点の始発バス停からの距離）・`gpsTime` |
| `manual` | `PUT /api/admin/assignments/:id/stops/:stopId`（H:mm指定） | `note`・`editedAt` |

`arrival_method`が`NULL`の`到着済`行は判定方法が記録されていないもので、モーダルでは「判定方法は記録されていません」と表示します（`interpolated=TRUE`なら線形補間だけは判別できます）。`arrival_method` / `arrival_evidence`は`nearby_min_distance_*`と同じく`openAssignment()`のON CONFLICT SET句に含めていないため、GTFS再取得のreseedでも保持されます。

## 未到着への差し戻し（`PUT .../stops/:stopId` に空の `actualTime`）

管理画面から到着判定時刻を空にして保存すると、そのバス停を未到着（真の通過バス停なら`通過`、それ以外は`''`）へ戻します。`status` / `actual_time` / `delay_minutes` / `interpolated` / `arrival_method` / `arrival_evidence` / `nearby_min_distance_*`をクリアし、`trip_vehicle_assignments.last_arrived_seq`と便レベルの`delay_minutes`を残った到着済から引き直します。**`trip_gps_matches`は消しません**（消すと直近48時間の生GPSが次回の`pass()`で即座に再判定を誘発するため）。そのため差し戻したバス停は原則そのまま未到着に留まりますが、前後が到着済で1停留所だけ空くと`passInterpolate()`の線形補間で再び埋まり得ます（仕様）。

## 通過バス停の扱い（`tripAssignment.js`の`openAssignment()` / `delayCalc.js`との関係）

GTFSの`stop_times.txt`に載る行には**必ず実際の時刻**（`arrival_time`/`departure_time`）が入ります。「乗車できない／降車できない／どちらもできない（＝真の通過）」は`pickup_type`/`drop_off_type`という時刻とは無関係な別のフラグで表現されます。

- `is_through`（真の通過）は`pickup_type = 1` かつ `drop_off_type = 1` の場合のみtrue。時刻表検索（`gtfsTimetable.js`）・経路検索（`gtfsRouteSearch.js`）の`isThrough`と同じ定義です。
- `scheduled_time`は`is_through`にかかわらず常に実際のGTFS時刻を保持します（`seed.js`）。
- あるバス停の`status`が`通過`になるかどうかは、`is_through`の値をそのまま使うだけで決まります（`openAssignment()`）。位置ベースの判定は挟みません。

乗車のみ・降車のみのバス停（`pickup_type`/`drop_off_type`のどちらか一方だけが1）は、`schedule_stop_times`・`daily_trip_stop_times`の`no_pickup`/`no_drop_off`列（`is_through`と同じ表示用メタデータ）で表し、時刻表表示・リアルタイム表示のどちらでも実時刻を表示しつつ『降車のみ』『乗車のみ』のバッジを付けます。

**GPS通過判定（`passStepEntry()`）は、`通過`ステータスのバス停を候補から除外しません。** `excludedSet`は`status`が`到着済`または`付近`のバス停だけを含むため、`通過`と確定済みのバス停でもGPSが実際にその座標へ近づけば通常どおり候補になり、`付近`→（離脱検知後）`到着済`へと更新されます。真の通過バス停もGTFS上は実座標・実時刻を持つ現実の地点なので、GPSマッチの対象から外す理由がないという設計です。

`delayCalc.js`は`scheduled_time`が無いことを理由にステータスを強制上書きしません。バス停のstatus確定は`openAssignment()`が正しく行っている前提です（判定条件の詳細は[vehicle-assignment.md](vehicle-assignment.md)）。
