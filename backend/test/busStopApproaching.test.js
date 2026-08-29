// busStopApproaching.js のうち、DB/GTFSインデックスに依存しない純粋関数部分の回帰テスト。
// 定刻を過ぎた遅延便が接近中バス一覧から消えないことの回帰テスト。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isWithinApproachWindow, computeEtaSeconds } = require('../src/services/busStopApproaching');

const NOW = 8 * 3600; // 8:00:00

test('isWithinApproachWindow: 定刻が現在時刻より先（30分以内）なら候補に入る', () => {
  assert.equal(isWithinApproachWindow(NOW + 10 * 60, NOW), true);
});

test('isWithinApproachWindow: 定刻を10分過ぎていても候補に入る（H-7対応前は候補から即座に落ちていた）', () => {
  assert.equal(isWithinApproachWindow(NOW - 10 * 60, NOW), true);
});

test('isWithinApproachWindow: 定刻を大幅（30分超）に過ぎた便は候補に入らない', () => {
  assert.equal(isWithinApproachWindow(NOW - 31 * 60, NOW), false);
});

test('isWithinApproachWindow: 30分より先の便は候補に入らない', () => {
  assert.equal(isWithinApproachWindow(NOW + 31 * 60, NOW), false);
});

test('computeEtaSeconds: リアルタイム無しなら定刻をそのまま返す（soft-fail方針の維持）', () => {
  const entry = { hasRealtime: false, delayMinutes: null };
  assert.equal(computeEtaSeconds(NOW - 5 * 60, entry), NOW - 5 * 60);
});

test('computeEtaSeconds: リアルタイム有りなら定刻+遅延分を返す', () => {
  const entry = { hasRealtime: true, delayMinutes: 12 };
  assert.equal(computeEtaSeconds(NOW - 5 * 60, entry), NOW - 5 * 60 + 12 * 60);
});

test('H-7再現防止: 定刻を過ぎたが遅延中で、まだ到着していない便は一覧から落ちない', () => {
  // 10分遅れのバス：定刻はNOWの5分前だが、遅延を足した実質到着はNOWの5分後。
  const departureSeconds = NOW - 5 * 60;
  const entry = { hasRealtime: true, delayMinutes: 10 };
  assert.equal(isWithinApproachWindow(departureSeconds, NOW), true);
  const etaSeconds = computeEtaSeconds(departureSeconds, entry);
  assert.equal(etaSeconds >= NOW, true); // 一覧に残る
});

test('H-7再現防止: リアルタイムで既に到着済みと分かった便は一覧から落ちる', () => {
  const departureSeconds = NOW - 5 * 60;
  const entry = { hasRealtime: true, delayMinutes: 2 }; // 実質到着はNOWの3分前
  const etaSeconds = computeEtaSeconds(departureSeconds, entry);
  assert.equal(etaSeconds < NOW, true); // 一覧から落とすべき
});
