const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectGpsOutages } = require('../src/services/realtimeTripLookup');

const T = (h, m) => `2026-08-30T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`;
const NOW = new Date(T(10, 0)).getTime();

// 位置履歴1点。gps_time_ts だけが判定に効く。
function pt(iso, lat = 36.1, lng = 137.9) {
  return { lat, lng, gpsTime: iso.slice(11, 16), gpsTimeTs: iso };
}

test('detectGpsOutages: 連続点がすべて閾値未満なら途絶なし', () => {
  const history = [pt(T(9, 0)), pt(T(9, 2)), pt(T(9, 4)), pt(T(9, 6))];
  assert.deepEqual(detectGpsOutages(history, 6, NOW, false), []);
});

test('detectGpsOutages: 途中の途絶は lost/recovered つき・ongoing=false で返る', () => {
  const history = [pt(T(9, 0)), pt(T(9, 2)), pt(T(9, 20)), pt(T(9, 22))];
  const outages = detectGpsOutages(history, 6, NOW, false);
  assert.equal(outages.length, 1);
  assert.equal(outages[0].ongoing, false);
  assert.equal(outages[0].lost.gpsTimeTs, T(9, 2));
  assert.equal(outages[0].recovered.gpsTimeTs, T(9, 20));
  assert.equal(outages[0].durationMinutes, 18);
});

test('detectGpsOutages: 末尾の未復旧途絶は endedForGpsLoss=true のときだけ ongoing で返る', () => {
  // 内部の連続点はすべて2分間隔。最後の点(9:54)だけが現在(10:00)から6分前。
  const history = [pt(T(9, 50)), pt(T(9, 52)), pt(T(9, 54))];
  assert.deepEqual(detectGpsOutages(history, 6, NOW, false), []);

  const outages = detectGpsOutages(history, 6, NOW, true);
  assert.equal(outages.length, 1);
  assert.equal(outages[0].ongoing, true);
  assert.equal(outages[0].recovered, null);
  assert.equal(outages[0].lost.gpsTimeTs, T(9, 54));
  assert.equal(outages[0].durationMinutes, 6);
});

test('detectGpsOutages: 途中復旧＋末尾未復旧を時系列順で返す（末尾＝便を打ち切った途絶）', () => {
  const history = [
    pt(T(9, 0)), pt(T(9, 2)), pt(T(9, 4)), // ここまで平常
    pt(T(9, 25)),                          // 9:04→9:25 で21分の途絶（復旧済み）
    pt(T(9, 27)), pt(T(9, 29)), pt(T(9, 31)) // 平常に戻ったあと 9:31 で途絶（10:00現在も未復旧）
  ];
  const outages = detectGpsOutages(history, 6, NOW, true);
  assert.equal(outages.length, 2);
  assert.equal(outages[0].ongoing, false);
  assert.equal(outages[0].lost.gpsTimeTs, T(9, 4));
  assert.equal(outages[0].recovered.gpsTimeTs, T(9, 25));
  assert.equal(outages[1].ongoing, true);
  assert.equal(outages[1].lost.gpsTimeTs, T(9, 31));
  assert.equal(outages[1].durationMinutes, 29);
});

test('detectGpsOutages: 空の履歴でも落ちない', () => {
  assert.deepEqual(detectGpsOutages([], 6, NOW, true), []);
});

test('detectGpsOutages: 末尾の点が新しければ endedForGpsLoss=true でも ongoing を出さない', () => {
  const history = [pt(T(9, 55)), pt(T(9, 57)), pt(T(9, 59))]; // 最終点は現在の1分前
  assert.deepEqual(detectGpsOutages(history, 6, NOW, true), []);
});
