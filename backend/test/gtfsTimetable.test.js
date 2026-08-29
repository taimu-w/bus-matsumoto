// gtfsTimetable.js のうち、DB/ファイルI/Oを伴わない純粋関数の回帰テスト。
// （インデックス構築・時刻表組み立てはGTFSファイルの読み込みを伴うためここでは扱わない。）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  clusterByProximity,
  computeFeedValidity,
  PLATFORM_MERGE_RADIUS_METERS
} = require('../src/services/gtfsTimetable');
const { haversineDistanceMeters } = require('../src/utils/geo');

// 松本市中心部の緯度。真北方向へ meters だけずらした緯度を返す（経度は不変）。
const BASE_LAT = 36.2381;
const BASE_LON = 137.9720;
const DEG_PER_METER_NORTH = 1 / ((Math.PI / 180) * 6371000); // ≈ 8.993e-6 度/m
const north = (meters) => ({ lat: BASE_LAT + meters * DEG_PER_METER_NORTH, lon: BASE_LON });

test('PLATFORM_MERGE_RADIUS_METERS は 0.1m', () => {
  assert.equal(PLATFORM_MERGE_RADIUS_METERS, 0.1);
});

test('clusterByProximity: 完全同一座標は1クラスタに畳まれる', () => {
  const a = { id: 'a', lat: BASE_LAT, lon: BASE_LON };
  const b = { id: 'b', lat: BASE_LAT, lon: BASE_LON };
  const clusters = clusterByProximity([a, b], PLATFORM_MERGE_RADIUS_METERS);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].map((p) => p.id), ['a', 'b']);
});

test('clusterByProximity: 0.1m以内は同一クラスタ、それを超えると別クラスタ', () => {
  const a = { id: 'a', ...north(0) };
  const near = { id: 'near', ...north(0.08) }; // 0.08m ≈ 0.1m以内
  const far = { id: 'far', ...north(0.2) };    // 0.2m ≈ 0.1m超

  // 前提の座標が意図どおりの距離になっているか数値で確認する
  assert.ok(haversineDistanceMeters(a.lat, a.lon, near.lat, near.lon) <= 0.1);
  assert.ok(haversineDistanceMeters(a.lat, a.lon, far.lat, far.lon) > 0.1);

  const clusters = clusterByProximity([a, near, far], PLATFORM_MERGE_RADIUS_METERS);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.find((c) => c.length === 2).map((p) => p.id).sort(), ['a', 'near']);
  assert.deepEqual(clusters.find((c) => c.length === 1).map((p) => p.id), ['far']);
});

test('clusterByProximity: 座標を持たない点は必ず単独クラスタ', () => {
  const a = { id: 'a', lat: BASE_LAT, lon: BASE_LON };
  const noCoord1 = { id: 'n1', lat: NaN, lon: NaN };
  const noCoord2 = { id: 'n2', lat: null, lon: null };
  const clusters = clusterByProximity([a, noCoord1, noCoord2], PLATFORM_MERGE_RADIUS_METERS);
  assert.equal(clusters.length, 3);
  for (const cluster of clusters) assert.equal(cluster.length, 1);
});

test('clusterByProximity: 離れた同名バス停は畳まれない（0.1mは距離が近すぎて連鎖膨張しない）', () => {
  // 30cm間隔で3点並べても、単リンクの届く範囲は0.1mなので分断される
  const points = [north(0), north(0.3), north(0.6)].map((p, i) => ({ id: `p${i}`, ...p }));
  const clusters = clusterByProximity(points, PLATFORM_MERGE_RADIUS_METERS);
  assert.equal(clusters.length, 3);
});

test('clusterByProximity: 空配列は空配列', () => {
  assert.deepEqual(clusterByProximity([], PLATFORM_MERGE_RADIUS_METERS), []);
});

test('computeFeedValidity: feed_info.txt があれば最優先で使う', () => {
  const result = computeFeedValidity(
    { feedStartDate: '20260401', feedEndDate: '20261231' },
    [{ startDate: '20260801', endDate: '20280331' }],
    ['20270101']
  );
  assert.deepEqual(result, { startDate: '20260401', endDate: '20261231' });
});

test('computeFeedValidity: feed_info が無ければ calendar の最小〜最大', () => {
  const result = computeFeedValidity(
    {},
    [
      { startDate: '20260801', endDate: '20280331' },
      { startDate: '20260901', endDate: '20270930' }
    ],
    []
  );
  assert.deepEqual(result, { startDate: '20260801', endDate: '20280331' });
});

test('computeFeedValidity: calendar_dates の運行追加日も範囲に含める', () => {
  const result = computeFeedValidity(
    {},
    [{ startDate: '20260801', endDate: '20280331' }],
    ['20280401', '20260701']
  );
  assert.deepEqual(result, { startDate: '20260701', endDate: '20280401' });
});

test('computeFeedValidity: feed_info の片側だけあれば他方を calendar で補う', () => {
  const result = computeFeedValidity(
    { feedEndDate: '20261231' },
    [{ startDate: '20260801', endDate: '20280331' }],
    []
  );
  assert.deepEqual(result, { startDate: '20260801', endDate: '20261231' });
});

test('computeFeedValidity: 期間が定まらなければ null', () => {
  assert.equal(computeFeedValidity({}, [], []), null);
  assert.equal(computeFeedValidity({}, [{ startDate: '', endDate: '' }], ['bad']), null);
});
