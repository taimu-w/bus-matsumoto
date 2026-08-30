// spotSearch.js のうち、DBアクセス・GTFSインデックスを伴わない純粋関数の回帰テスト。
// スコアリング（scoreNameMatch）と路線の重複排除（dedupeRoutes）の挙動を固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreNameMatch, dedupeRoutes } = require('../src/services/spotSearch');
const { normalizeSearchText } = require('../src/utils/kana');

test('scoreNameMatch: 完全一致=3 / 前方一致=2 / 部分一致=1 / 不一致=0', () => {
  assert.equal(scoreNameMatch('松本城', normalizeSearchText('松本城')), 3);
  assert.equal(scoreNameMatch('松本城', normalizeSearchText('松本')), 2);
  assert.equal(scoreNameMatch('浅間温泉', normalizeSearchText('温泉')), 1);
  assert.equal(scoreNameMatch('松本城', normalizeSearchText('長野')), 0);
});

test('scoreNameMatch: かな・ローマ字も正規化して一致する', () => {
  // 長音符・記号を落として比較する（normalizeSearchText 経由）
  assert.equal(scoreNameMatch('まつもとバスターミナル', normalizeSearchText('まつもとばすたーみなる')), 3);
  assert.equal(scoreNameMatch('Matsumoto', normalizeSearchText('matsu')), 2);
});

test('scoreNameMatch: name か nq が空なら 0', () => {
  assert.equal(scoreNameMatch('', normalizeSearchText('松本')), 0);
  assert.equal(scoreNameMatch('松本', ''), 0);
  assert.equal(scoreNameMatch(null, 'x'), 0);
});

test('dedupeRoutes: feedId:routeId が同じものは1件にまとめる', () => {
  const result = dedupeRoutes([
    { feedId: 'a', routeId: '1', name: 'X線', shortName: 'X' },
    { feedId: 'a', routeId: '1', name: 'X線（重複）', shortName: 'X' },
    { feedId: 'b', routeId: '1', name: 'Y線', shortName: 'Y' }
  ]);
  assert.equal(result.length, 2);
});

test('dedupeRoutes: 略称→名称の順で五十音ソートする', () => {
  const result = dedupeRoutes([
    { feedId: 'a', routeId: '2', name: 'わ線', shortName: '' },
    { feedId: 'a', routeId: '1', name: 'あ線', shortName: '' }
  ]);
  assert.deepEqual(result.map((r) => r.name), ['あ線', 'わ線']);
});

test('dedupeRoutes: 空配列・未定義でも落ちない', () => {
  assert.deepEqual(dedupeRoutes([]), []);
  assert.deepEqual(dedupeRoutes(undefined), []);
});
