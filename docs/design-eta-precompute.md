# 設計書：到着予測（ETA）計算のプリコンピュート化

対象：パイプライン内での ETA 計算の最適化  
前提：[README.md](../README.md)（アーキテクチャ全体）、[CLAUDE.md](../CLAUDE.md)（既知の注意点）

> **この設計は2026年8月に実装済みです。** 本書は、オンデマンド方式から バッチ処理方式への移行を正当化し、実装上の判定基準を記す設計記録です。実装後の挙動は[README.md](../README.md) §5.4・[CLAUDE.md](../CLAUDE.md)を参照してください。
>
> 実装差分（本文との相違点）:
> - `trip_arrival_predictions`の主キーは`id`（BIGSERIAL）ではなく、`trip_stop_progress`と同じ複合主キー`(assignment_id, stop_id)`にしました。ON CONFLICTのターゲットにそのまま使え、別途UNIQUE制約を足す必要がないためです。
> - `computeAndStoreAllArrivals()`はパイプライン内の他ステップ（`delayCalc()`等）と同じ呼び出し規約に合わせ、引数を取らず内部で`pool.connect()`する形にしました（`pipeline.js`からは`computeAndStoreAllArrivals()`と引数無しで呼びます）。
> - 割り当てごとのUPSERTは、バス停1行ずつではなく`unnest()`で1クエリにまとめています（§7.2で「後期検討」とされていた改善を初回実装に含めました）。

---

## 0. 背景と課題

### 0.1 現状（オンデマンド方式）

現在の ETA 計算フロー：

```
ユーザー画面（20秒間隔でポーリング）
  ↓ /api/buses リクエスト
APIエンドポイント（routes/api.js）
  ↓ 各割り当てごとに呼び出し
predictArrivals(client, assignmentId)  ←  【毎回ここで計算】
  ├─ trip_stop_progress 全行取得（1 クエリ）
  ├─ 直近のセグメントペースを算出（複数回、segment_travel_stats クエリ）
  └─ 残り全バス停の到着時刻を推定（複数回、getSegmentStat() 呼び出し）
```

### 0.2 負荷分析

ユーザーが多い時間帯：

- アクティブな便（割り当て）が 100 件
- ユーザー（同時接続）が 50 人
- ポーリング間隔 20 秒

毎 20 秒ごとに：
- ETA 計算呼び出し：最大 `100 × 50 = 5000 回`
- DB クエリ数：セグメントごとに増加（10 停車で 9 区間、1 割り当てあたり ~10 クエリ）
- **合計：最大 50,000 DB クエリ / 20 秒 = 2,500 QPS**

### 0.3 問題点

1. **重複計算**：同じ割り当てに対して複数ユーザーから同時にアクセスされても、毎回ゼロから計算
2. **DB スパイク**：複数ユーザーのリクエストが重なると、スパイク状に負荷が増加
3. **CPU 消費**：計算ロジック自体も軽くない（過去統計の参照、ペース係数の算出など）
4. **スケーラビリティ**：ユーザー・便数の増加に比例して負荷が増加

---

## 1. 改善案：プリコンピュート方式

### 1.1 基本方針

**パイプライン内で 60 秒ごとに全便の ETA を一括計算し、結果を DB に保存する。**  
API は DB から読み出すだけ。

```
runPipeline() — 60 秒ごと
  ① ensureDailyTrips()
  ② fetchLocation()
  ③ sortCarId()
  ④ assignPendingTrips()
  ⑤ reassignOrphanTrips()
  ⑥ pass()
  ⑦ delayCalc()
  ⑧ computeAndStoreAllArrivals()  ←【新規追加】
       └─ 全 active assignment のETA計算 → DB 保存

ユーザー画面（20秒間隔でポーリング）
  ↓ /api/buses リクエスト
APIエンドポイント
  └─ trip_arrival_predictions から読み出す（1 クエリ）
```

### 1.2 利点

| 項目 | 効果 |
|---|---|
| **重複計算の排除** | 同じ割り当てに対する複数リクエストが共有キャッシュを使う |
| **DB スパイクの平準化** | バッチ処理により、ポーリング間隔ごとのスパイクが消滅 |
| **レイテンシ削減** | API 応答時間が「1 クエリ + JSON 組み立て」に短縮 |
| **CPU 削減** | 計算コストをパイプライン処理に集約 |

### 1.3 トレードオフ

| 項目 | 影響 |
|---|---|
| **リアルタイム性** | 現在 <5 秒 → 最大 60 秒のラグ。ただしバス運行の性質上 60 秒単位で十分 |
| **計算タイミング** | API 呼び出しのたびに再計算ではなく、パイプライン実行時だけ更新 |

---

## 2. データベース設計

### 2.1 新規テーブル：`trip_arrival_predictions`

```sql
CREATE TABLE IF NOT EXISTS trip_arrival_predictions (
  id                    BIGSERIAL PRIMARY KEY,
  assignment_id         BIGINT NOT NULL REFERENCES trip_vehicle_assignments(id) ON DELETE CASCADE,
  stop_id               BIGINT NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  seq_order             INTEGER NOT NULL,
  predicted_time        TEXT,
  predicted_delay_minutes INT,
  source                TEXT NOT NULL,
  computed_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_arrival_predictions_assignment_id 
  ON trip_arrival_predictions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_trip_arrival_predictions_assignment_stop
  ON trip_arrival_predictions(assignment_id, stop_id);
CREATE INDEX IF NOT EXISTS idx_trip_arrival_predictions_computed_at
  ON trip_arrival_predictions(computed_at DESC);
```

### 2.2 カラムの説明

| カラム | 型 | 説明 |
|---|---|---|
| `id` | BIGSERIAL | プライマリキー |
| `assignment_id` | BIGINT | 割り当て ID（`trip_vehicle_assignments.id`） |
| `stop_id` | BIGINT | バス停 ID（`stops.id`） |
| `seq_order` | INTEGER | 便内での順序 |
| `predicted_time` | TEXT | 予測到着時刻（`"HH:mm"` 形式、例："08:25"） |
| `predicted_delay_minutes` | INT | 予測遅延分数 |
| `source` | TEXT | 計算手法（`'historical'`, `'schedule_paced'`, `'naive_anchored'`, `'through_skip'`, `'naive'`, `'schedule'`, `'actual'`） |
| `computed_at` | TIMESTAMP | この予測を計算した時刻 |
| `created_at` | TIMESTAMP | レコード作成時刻 |
| `updated_at` | TIMESTAMP | 最終更新時刻 |

### 2.3 削除戦略

- 便が `state='closed'` になったら、その便の全割り当てに関連する `trip_arrival_predictions` レコードを削除
  - `ON DELETE CASCADE` により自動的に処理される（`trip_vehicle_assignments` 削除 → 連鎖削除）
  - または明示的に削除バッチを実行：`DELETE FROM trip_arrival_predictions WHERE computed_at < now() - interval '48 hours'`

---

## 3. パイプライン処理の実装

### 3.1 新関数：`computeAndStoreAllArrivals(client)`

**配置**：`backend/src/services/etaPredictor.js`

**責務**：
1. 全 active な `trip_vehicle_assignments` を取得（role に関わらず）
2. 各割り当てに対し `predictArrivals()` を呼び出す
3. 結果を `trip_arrival_predictions` へ UPSERT する
4. 古い予測データを削除（オプション：48 時間以上前）

**シグネチャ**：

```javascript
/**
 * 全 active な割り当てに対する ETA を計算し、trip_arrival_predictions へ保存する。
 * パイプライン内から、delayCalc() の直後に呼び出される。
 *
 * @param {Client} client - PostgreSQL クライアント
 * @returns {Promise<{computed: number, stored: number, deleted: number}>}
 *          computed: 計算した割り当て数
 *          stored: 挿入/更新したレコード数
 *          deleted: 削除した古いレコード数
 */
async function computeAndStoreAllArrivals(client) { ... }
```

**実装フロー**：

```javascript
async function computeAndStoreAllArrivals(client) {
  const startedAt = Date.now();
  
  // 1. 全 active 割り当てを取得
  const assignments = await client.query(`
    SELECT id, daily_trip_id, vehicle_id, role
    FROM trip_vehicle_assignments
    WHERE state = 'active'
    ORDER BY id ASC
  `);
  
  let computed = 0, stored = 0;
  
  // 2. 各割り当てに対し ETA を計算
  for (const assignment of assignments.rows) {
    try {
      const arrivals = await predictArrivals(client, assignment.id);
      
      // 3. 計算結果を UPSERT
      for (const arrival of arrivals) {
        await client.query(`
          INSERT INTO trip_arrival_predictions
            (assignment_id, stop_id, seq_order, predicted_time, predicted_delay_minutes, source, computed_at)
          VALUES ($1, $2, $3, $4, $5, $6, now())
          ON CONFLICT (assignment_id, stop_id) DO UPDATE SET
            predicted_time = EXCLUDED.predicted_time,
            predicted_delay_minutes = EXCLUDED.predicted_delay_minutes,
            source = EXCLUDED.source,
            computed_at = EXCLUDED.computed_at,
            updated_at = now()
        `, [
          assignment.id,
          arrival.stopId,
          arrival.seqOrder,
          arrival.predictedTime,
          arrival.predictedDelayMinutes,
          arrival.source
        ]);
        stored++;
      }
      computed++;
    } catch (err) {
      console.error(`[etaPredictor] assignment=${assignment.id} の ETA 計算エラー:`, err.message);
    }
  }
  
  // 4. 古い予測を削除（48 時間以上前）
  const deleted = await client.query(`
    DELETE FROM trip_arrival_predictions
    WHERE computed_at < now() - interval '48 hours'
  `);
  
  console.log(
    `[etaPredictor] ETA プリコンピュート完了: ${computed} 割り当て / ${stored} レコード保存 ` +
    `/ ${deleted.rowCount} 古いレコード削除 (${Date.now() - startedAt}ms)`
  );
  
  return { computed, stored, deleted: deleted.rowCount };
}
```

### 3.2 パイプラインへの統合

**編集対象**：`backend/src/jobs/pipeline.js`

```javascript
const { updateSegmentStats, predictArrivals, computeAndStoreAllArrivals } = require('../services/etaPredictor');

async function runPipeline() {
  const night = isNightTime();
  try {
    try {
      await updateAllGtfsFeeds();
    } catch (err) {
      console.error('[pipeline] GTFSフィード更新エラー（継続）:', err.message);
    }

    await ensureDailyTrips();

    if (night) {
      console.log('[pipeline] 深夜帯のため運行処理をスキップします。');
      return;
    }

    await fetchLocation();
    await sortCarId();
    await assignPendingTrips();
    await reassignOrphanTrips();
    await pass();
    await delayCalc();
    
    // 【新規追加】ETA のプリコンピュート
    await computeAndStoreAllArrivals(pool);
    
  } catch (err) {
    console.error('[pipeline] 実行エラー:', err);
  }
}
```

---

## 4. API の修正

### 4.1 `getArrivalsForAssignment(assignmentId)` — 新規関数

**配置**：`backend/src/services/etaPredictor.js`

**責備**：`trip_arrival_predictions` から指定割り当ての ETA を読み出す

```javascript
/**
 * 指定した割り当ての到着予測を取得する（DB から読み出すだけ）。
 * @param {Client} client - PostgreSQL クライアント
 * @param {number} assignmentId - 割り当て ID
 * @returns {Promise<Array>} [{stopId, seqOrder, predictedTime, predictedDelayMinutes, source}]
 */
async function getArrivalsForAssignment(client, assignmentId) {
  const res = await client.query(`
    SELECT stop_id, seq_order, predicted_time, predicted_delay_minutes, source
    FROM trip_arrival_predictions
    WHERE assignment_id = $1
    ORDER BY seq_order ASC
  `, [assignmentId]);
  
  return res.rows.map(row => ({
    stopId: row.stop_id,
    seqOrder: row.seq_order,
    predictedTime: row.predicted_time,
    predictedDelayMinutes: row.predicted_delay_minutes,
    source: row.source
  }));
}
```

### 4.2 `routes/api.js` の修正

**編集対象**：現在 `/api/buses` が `predictArrivals()` を呼び出している箇所

**変更前**：

```javascript
const arrivals = await predictArrivals(client, assignment.id);
```

**変更後**：

```javascript
const arrivals = await getArrivalsForAssignment(client, assignment.id);
```

---

## 5. 段階的な取り組み

### Phase 1：DB テーブル・関数の実装

- [x] `trip_arrival_predictions` テーブルを作成
- [x] `computeAndStoreAllArrivals()` を実装
- [x] `getArrivalsForAssignment()` を実装
- [x] `pipeline.js` に `computeAndStoreAllArrivals()` 呼び出しを追加

### Phase 2：API 層の修正

- [x] `routes/api.js` で `getArrivalsForAssignment()` を使う（`services/routeSearch.js` の2箇所も同様に変更）
- [x] 動作確認（Docker環境でmigrate→pipeline実行→`/api/buses`・`/api/route-search`のレスポンスを確認済み）

### Phase 3：既存関数の廃止（オプション）

- [x] `predictArrivals()` を廃止するか、テスト用に残すかを決定 → **残す**。`computeAndStoreAllArrivals()`が計算エンジンとして内部で呼び出しており、アルゴリズム本体は引き続きこの関数が担う。API・ルート検索からの直接呼び出しのみ`getArrivalsForAssignment()`に置き換えた
- [x] ドキュメント（README.md、CLAUDE.md）を更新

---

## 6. テスト・検証項目

| テスト項目 | 確認内容 |
|---|---|
| **ETA 計算の正確性** | プリコンピュート結果とオンデマンド計算が同じ値か |
| **パイプライン実行時間** | `computeAndStoreAllArrivals()` 追加による増加時間 |
| **API レイテンシ** | `/api/buses` の応答時間が短縮されたか |
| **DB スパイク** | ポーリング間隔ごとの QPS が平準化されたか |
| **古いレコード削除** | 48 時間以上前の予測が自動削除されるか |

---

## 7. 既知の考慮事項

### 7.1 リアルタイム性の低下

最大 60 秒のラグが発生します。ただし：
- バス運行の性質上、1 分程度の予測値のズレは許容範囲
- 実績ベースの通過判定・遅延計算は変わらず、ポーリング間隔で更新
- 画面には「予測更新時刻」を表示することで、ユーザーに透明性を提供

### 7.2 パイプライン実行時間の増加

`computeAndStoreAllArrivals()` は全割り当てを直列処理します。  
便数が 100 超の場合、処理時間が顕著になる可能性があります。  
**改善案**（後期検討）：
- DB の UPSERT をバルク実行に変更
- アクティブな割り当てだけを対象にする（完了済み・候補外を除外）

### 7.3 計算タイミングの固定

パイプライン実行に依存するため、パイプラインが遅延した場合 ETA 計算も遅延します。  
独立した定期タイマーで実行したい場合は、`backend/src/jobs/scheduler.js` にタイマーを追加。

---

## 8. 参考：移行後のデータフロー

```
① パイプライン実行（60秒ごと）
  ├─ fetchLocation() → vehicle_positions_raw へ保存
  ├─ pass() → 通過判定、trip_stop_progress 更新
  ├─ delayCalc() → 遅延計算、trip_stop_progress 更新
  └─ computeAndStoreAllArrivals() ← 【新規】
      ├─ 全 active assignment の ETA を計算
      ├─ 結果を trip_arrival_predictions に UPSERT
      └─ 古いレコードを削除

② ユーザーがページを開く（20秒ごとポーリング）
  └─ /api/buses
      └─ trip_arrival_predictions から読み出し（1クエリ）
          └─ JSON 応答
```

---

## 版履歴

| 日付 | 内容 |
|---|---|
| 2026-08-10 | 初版作成 |
| 2026-08-10 | Phase 1〜3実装完了。実装差分をヘッダに追記 |
