const { test } = require('node:test');
const assert = require('node:assert/strict');
const { haversineDistanceMeters } = require('../src/utils/geo');

test('haversineDistanceMeters: 同一地点は0', () => {
  assert.equal(haversineDistanceMeters(36.2381, 137.9720, 36.2381, 137.9720), 0);
});

test('haversineDistanceMeters: 既知区間の距離が概ね一致する', () => {
  // 松本駅付近 -> 松本城付近、概ね1km前後
  const d = haversineDistanceMeters(36.2380, 137.9720, 36.2385, 137.9700);
  assert.ok(d > 100 && d < 5000, `distance was ${d}`);
});
