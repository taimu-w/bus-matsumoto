// vehicleHeading.js のうち、DBアクセスを伴わない純粋関数の回帰テスト。
// 地図上のバスアイコンの向きの元になる方位角（真北=0・東=90・時計回り）の求め方を固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { headingFromMovement, headingToNextStop } = require('../src/services/vehicleHeading');

// 松本駅付近。緯度0.001度≒111m、経度0.001度≒90m。
const LAT = 36.2308;
const LON = 137.9645;
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 5, 0, 0, 0);

function near(actual, expected, tol = 1) {
  const diff = Math.abs(((actual - expected + 540) % 360) - 180);
  assert.ok(diff <= tol, `expected ≈${expected}, got ${actual}`);
}

test('headingFromMovement: 東へ進んでいれば約90度、北なら約0度', () => {
  near(headingFromMovement([
    { lat: LAT, lon: LON + 0.001, timeMs: T0 + MIN },
    { lat: LAT, lon: LON, timeMs: T0 }
  ]), 90);
  near(headingFromMovement([
    { lat: LAT + 0.001, lon: LON, timeMs: T0 + MIN },
    { lat: LAT, lon: LON, timeMs: T0 }
  ]), 0);
});

test('headingFromMovement: 20m未満の揺らぎは飛ばして、離れた直近の点を使う', () => {
  near(headingFromMovement([
    { lat: LAT + 0.0001, lon: LON - 0.001, timeMs: T0 + 2 * MIN }, // 最新（西へ約90m進んだ）
    { lat: LAT, lon: LON - 0.00095, timeMs: T0 + MIN },            // 約11m：揺らぎ扱い
    { lat: LAT + 0.0001, lon: LON, timeMs: T0 }                    // ここから西向き
  ]), 270);
});

test('headingFromMovement: 停車中（動きが無い）・5分より古い点しか無いときは null', () => {
  assert.equal(headingFromMovement([
    { lat: LAT, lon: LON, timeMs: T0 + MIN },
    { lat: LAT + 0.00005, lon: LON, timeMs: T0 }
  ]), null);
  assert.equal(headingFromMovement([
    { lat: LAT, lon: LON + 0.001, timeMs: T0 + 6 * MIN },
    { lat: LAT, lon: LON, timeMs: T0 }
  ]), null);
  assert.equal(headingFromMovement([{ lat: LAT, lon: LON, timeMs: T0 }]), null);
});

test('headingToNextStop: 30m未満のバス停（停車中のバス停）は飛ばして次へ向く', () => {
  near(headingToNextStop({ lat: LAT, lon: LON }, [
    { lat: LAT + 0.0001, lon: LON },  // 約11m
    { lat: LAT - 0.002, lon: LON }    // 南へ約220m
  ]), 180);
  assert.equal(headingToNextStop({ lat: LAT, lon: LON }, []), null);
  assert.equal(headingToNextStop({ lat: NaN, lon: LON }, [{ lat: LAT + 0.01, lon: LON }]), null);
});
