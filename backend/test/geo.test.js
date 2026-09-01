const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  haversineDistanceMeters,
  toLocalXYMeters,
  bearingDegrees,
  angleDiffDegrees,
  estimateWalkingMeters,
  estimateWalkMinutes,
  estimateWalkSeconds
} = require('../src/utils/geo');

test('haversineDistanceMeters: 同一地点は0', () => {
  assert.equal(haversineDistanceMeters(36.2381, 137.9720, 36.2381, 137.9720), 0);
});

test('haversineDistanceMeters: 既知区間の距離が概ね一致する', () => {
  // 松本駅付近 -> 松本城付近、概ね1km前後
  const d = haversineDistanceMeters(36.2380, 137.9720, 36.2385, 137.9700);
  assert.ok(d > 100 && d < 5000, `distance was ${d}`);
});

test('toLocalXYMeters: 基準点自身は原点になる', () => {
  const p = toLocalXYMeters(36.2380, 137.9720, 36.2380, 137.9720);
  assert.equal(p.x, 0);
  assert.equal(p.y, 0);
});

test('toLocalXYMeters: 真北方向のオフセットはyのみに現れる（緯度1度≈111000m）', () => {
  const p = toLocalXYMeters(36.2390, 137.9720, 36.2380, 137.9720); // 0.001度 ≈ 111m北
  assert.ok(Math.abs(p.x) < 0.01, `x should be ~0, was ${p.x}`);
  assert.ok(Math.abs(p.y - 111) < 2, `y should be ~111m, was ${p.y}`);
});

test('toLocalXYMeters: haversineDistanceMetersと近距離では概ね一致する', () => {
  const refLat = 36.2380, refLon = 137.9720;
  const lat = 36.2385, lon = 137.9715;
  const p = toLocalXYMeters(lat, lon, refLat, refLon);
  const localDist = Math.sqrt(p.x * p.x + p.y * p.y);
  const haversineDist = haversineDistanceMeters(refLat, refLon, lat, lon);
  assert.ok(Math.abs(localDist - haversineDist) < 1, `local=${localDist} haversine=${haversineDist}`);
});

test('bearingDegrees: 真北方向は0度', () => {
  const b = bearingDegrees(36.2380, 137.9720, 36.2390, 137.9720); // 緯度のみ増加=真北
  assert.ok(Math.abs(b - 0) < 1, `bearing was ${b}`);
});

test('bearingDegrees: 真東方向は90度', () => {
  const b = bearingDegrees(36.2380, 137.9720, 36.2380, 137.9730); // 経度のみ増加=真東
  assert.ok(Math.abs(b - 90) < 1, `bearing was ${b}`);
});

test('bearingDegrees: 真南方向は180度', () => {
  const b = bearingDegrees(36.2380, 137.9720, 36.2370, 137.9720);
  assert.ok(Math.abs(b - 180) < 1, `bearing was ${b}`);
});

test('angleDiffDegrees: 同じ方位角の差は0', () => {
  assert.equal(angleDiffDegrees(45, 45), 0);
});

test('angleDiffDegrees: 0度と350度は周回方向で10度差', () => {
  assert.equal(angleDiffDegrees(0, 350), 10);
});

test('angleDiffDegrees: 最大差は180度', () => {
  assert.equal(angleDiffDegrees(0, 180), 180);
});

// --- 徒歩距離・所要時間の実態推定（直線距離 × 迂回係数 + 信号バッファ）---

test('estimateWalkingMeters: 0・負値は0m', () => {
  assert.equal(estimateWalkingMeters(0), 0);
  assert.equal(estimateWalkingMeters(-10), 0);
});

test('estimateWalkMinutes: 0・負値でも最低1分', () => {
  assert.equal(estimateWalkMinutes(0), 1);
  assert.equal(estimateWalkMinutes(-10), 1);
});

test('estimateWalkingMeters: 近距離（100m以下）は迂回係数1.15・信号バッファ0', () => {
  assert.ok(Math.abs(estimateWalkingMeters(100) - 100 * 1.15) < 1e-6);
  assert.ok(Math.abs(estimateWalkingMeters(50) - 50 * 1.15) < 1e-6);
});

test('estimateWalkingMeters: 直線距離が伸びると単調に増える', () => {
  assert.ok(estimateWalkingMeters(100) < estimateWalkingMeters(300));
  assert.ok(estimateWalkingMeters(300) < estimateWalkingMeters(500));
  assert.ok(estimateWalkingMeters(500) < estimateWalkingMeters(1000));
});

test('estimateWalkingMeters: 常に直線距離より長い（迂回係数 > 1）', () => {
  for (const d of [120, 250, 400, 600, 900, 1500]) {
    assert.ok(estimateWalkingMeters(d) > d, `d=${d}`);
  }
});

test('estimateWalkingMeters: 1200m以遠は迂回係数1.40・信号バッファ160mで頭打ち', () => {
  // 頭打ち後は「直線距離 × 1.40 + 160」ちょうど
  assert.equal(estimateWalkingMeters(1200), 1200 * 1.4 + 160);
  assert.equal(estimateWalkingMeters(2000), 2000 * 1.4 + 160);
  assert.equal(estimateWalkingMeters(3000), 3000 * 1.4 + 160);
});

test('estimateWalkMinutes: 現行スペックの目安値', () => {
  assert.equal(estimateWalkMinutes(200), 3);
  assert.equal(estimateWalkMinutes(300), 5);
  assert.equal(estimateWalkMinutes(500), 9);
  assert.equal(estimateWalkMinutes(1000), 19);
});

test('estimateWalkSeconds: 推定道のりを分速80mで割った秒数（四捨五入）', () => {
  for (const d of [50, 200, 500, 1000]) {
    assert.equal(estimateWalkSeconds(d), Math.round((estimateWalkingMeters(d) / 80) * 60), `d=${d}`);
  }
});
