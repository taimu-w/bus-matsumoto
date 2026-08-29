# 車両割り当ての詳細（`services/tripAssignment.js`）

設計の全体像（なぜ便を先に生成し車両を後から割り当てるか）は[design-trip-first-assignment.md](design-trip-first-assignment.md)を参照してください。このドキュメントは`tripAssignment.js`が行う判定条件・処理順序の詳細です。

旧`businessStart.js`・`departure.js`・`planMaking.js`・`specialBus.js`を置き換えたモジュールです。

## `assignPendingTrips()` — 初回の割り当て（パイプライン④）

対象は「`assignment_state = 'pending'` かつ `start_at <= 現在時刻 − ASSIGN_DELAY_SEC`」の便で、**始発時刻の早い順に1件ずつ確定**させます（直前の便で担当になった車両が、次の便の判定に自動的に反映されるため）。

`findCandidates()`が候補車両を抽出します。

| 条件 | 実装 |
|---|---|
| 同じ路線 | `vehicles.route_id`（qualified route id なのでGTFS側と直接比較できる） |
| 始発時刻直前の最新GPS | **始発時刻の3分前〜始発時刻（閉区間）** に存在する最新の1点。始発時刻を1秒でも過ぎたGPSは無効 |
| 始発バス停から100m以内 | `ASSIGN_RADIUS_METERS`（既定100m）。通過判定の120mとは別の設定値 |
| direction条件 | `config/directionMapping.js`。`mode:'ignore'`の路線、および車両側の方向が不明（NULL）の場合は方向で絞り込まない |
| 同時刻帯の別便の担当でない | `hasSamePeriodConflict()`（下記） |

距離が最も近い車両を担当車両（`role = 'assigned'`）にし、残りも候補車両（`role = 'candidate'`）として記録します。候補がゼロなら`assignment_state = 'unassigned'`とし、その便は時刻表上のデータとしては存続しつつリアルタイム情報を持たない扱いになります。

`ASSIGN_DELAY_SEC`（既定60秒）は、位置情報フィードの配信遅れを吸収するための待ち時間です。**判定に使うGPSの時間窓（始発時刻の3分前〜始発時刻）は変わらず**、遅らせるのは評価タイミングだけです。

## 「同時刻帯」の重複割り当て防止

`hasSamePeriodConflict()`が判定します。**「始発時刻の差が`ASSIGN_SAME_PERIOD_MIN`（既定10分）以内の便どうしでは、同じ車両を担当車両にしない」**というルールです。

⚠️ これを「稼働中の車両は他の便に割り当てない」に単純化してはいけません。8:00便の担当車両が8:11便の担当になるのは**仕様上正しい動作**です（差が11分なので同時刻帯ではない）。

## `openAssignment()` — 停車予定の展開

担当・候補の区別なく、`daily_trip_stop_times`から`trip_stop_progress`を展開します。ルールは旧`planMaking.js`からの移植だったが、2026年8月にGTFSのデータ構造に合わせて簡素化しました（詳細は[pass-detection.md](pass-detection.md)）。

- `is_through`（GTFSの`pickup_type = 1` かつ `drop_off_type = 1`＝真の通過）のバス停はそのまま`status = '通過'`とする。以前は「便の中で実際に定刻を持つ最後のバス停（`lastValidSeq`）より手前にあるかどうか」という位置ベースの判定を挟んでいたが、これは当時`is_through`のバス停の`scheduled_time`をNULLにしていたことに起因する代償的な措置だった。`scheduled_time`が`is_through`にかかわらず常に実際のGTFS時刻を保持するようになった今は、この判定は不要（`is_through`をそのまま使えば`lastValidSeq`を計算した場合と常に同じ結果になる）。
- 始発バス停は`status = '到着済'`とし、`actual_time`に**判定に使ったGPSの時刻**を入れる。旧方式の「出発時刻」に相当し、ETAの起点・ペース算出がここから機能する。

## `reassignOrphanTrips()` — 再割り当て（パイプライン⑤）

担当車両の割り当てが`ended`になり、有効な担当が居なくなった便が対象です。

- 終点まで走り切って終了した便は、再割り当てせずクローズする。対象の終了理由は`最終バス停到着済`に加え、GPS途絶時の終点到着救済判定で終点到達が確認できた`終点到着（GPS途絶時判定）`・`終点到着（GPS途絶時判定・付近経由）`も含む（`finishService.SUCCESS_END_REASONS`に集約。これらは正常終了扱いで、GPS途絶ロストには含めない）。
- そうでなければ、**始発時刻時点の候補**のうち、まだ`state = 'active'`で、同時刻帯の別便の担当になっていないものから、**距離が最も近い車両**を新しい担当に昇格させる。始発時刻後に近づいてきた車両を候補に追加することはしない。
- 候補が居なければ`closeDailyTrip()`でクローズする（詳細は[trip-lifecycle.md](trip-lifecycle.md)）。便は時刻表上のデータとしては存続する。

**実績の引き継ぎ処理は存在しません。** 候補車両は始発時刻から自分の`trip_stop_progress`をその便に紐づけて記録し続けているため、昇格した瞬間にそれがそのまま便の実績になります。「最も進んでいる車両を採用する」というマージは、別経路をたまたま走っていた車両を誤って採用する事故につながるため**やってはいけません**。
