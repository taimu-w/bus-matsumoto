const { test } = require('node:test');
const assert = require('node:assert/strict');
const { haversineDistanceMeters, toLocalXYMeters, bearingDegrees, angleDiffDegrees } = require('../src/utils/geo');

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
