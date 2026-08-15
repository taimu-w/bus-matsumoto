# 設計背景：到着予測のプリコンピュート方式

## 何を変えたか

2026年8月に、到着予測（ETA）の計算方式を「APIリクエストのたびに`predictArrivals()`を呼ぶオンデマンド方式」から、**「パイプライン内で60秒ごとに全active割り当て分を一括計算してDBへ保存するプリコンピュート方式」**に移行しました。

- `etaPredictor.js`の`computeAndStoreAllArrivals()`が、`jobs/pipeline.js`の`runPipeline()`から`delayCalc()`の直後（パイプラインの⑧番目のステップ）に呼ばれます。役割（担当・候補）を問わず`state = 'active'`な全割り当てに対して`predictArrivals()`を実行し、結果を`trip_arrival_predictions`テーブルへUPSERTします（`assignment_id, stop_id`が複合主キー）。あわせて`computed_at`が48時間より古いレコードを削除します。
- API側は計算を一切行わず、`getArrivalsForAssignment(client, assignmentId)`で`trip_arrival_predictions`から読み出すだけになりました。呼び出し元は主に2箇所です。
  - `routes/api.js`の`GET /api/buses`: 稼働中バス一覧の各バス停に予測時刻を付与する。
  - `services/realtimeTripLookup.js`の`buildBusEntry()`: 便詳細ページ・バス停検索の「接近中のバス」・経路検索のリアルタイム重ね合わせが共通で使う。

`predictArrivals(client, assignmentId)`自体（アルゴリズム本体）は一切変更していません。計算を行う場所が「APIリクエスト時」から「パイプライン実行時」に変わっただけです。引数は車両IDではなく**割り当てID**です（進捗が`trip_stop_progress`に移ったため）。アルゴリズムの詳細は[eta-prediction-algorithm.md](eta-prediction-algorithm.md)を参照してください。

## なぜ変えたか

オンデマンド方式では、APIリクエストのたびに全ての未到着バス停に対して統計参照・ペース計算・キャップ処理を行っていました。リクエスト数が増えるとDBへの負荷が比例して増加し、同じ割り当てに対して短時間に何度も同じ計算が繰り返される無駄がありました。

プリコンピュート方式に移行することで、計算回数を「ポーリング間隔（既定60秒）× active割り当て数」に固定し、APIリクエスト数がどれだけ増えても計算コストが増えないようにしています。

## トレードオフ

予測値のリアルタイム性が「リクエストごとに最新計算（<5秒）」から「最大60秒（パイプライン間隔）遅れる」に低下します。バス運行の性質上この程度のラグは許容範囲とされています。

## 関連ドキュメント

- ETA予測アルゴリズムの詳細: [eta-prediction-algorithm.md](eta-prediction-algorithm.md)
- パイプライン全体の実行順序: [../README.md](../README.md)
- DBスキーマ（`trip_arrival_predictions`・`trip_arrival_prediction_log`）: [database.md](database.md)
