// spotTags.js のうち、DBアクセスを伴わない純粋関数の回帰テスト。
// タグ文字列の分解（splitTags）と、parsed spot 群からの distinct タグ抽出
// （collectDistinctTags。予約タグ「近い」を除外する）の挙動を固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitTags, collectDistinctTags, NEAR_TAG } = require('../src/services/spotTags');

test('splitTags: "," 区切りで分解し前後空白・空要素を落とす', () => {
  assert.deepEqual(splitTags(' 神社 , パワースポット ,,史跡'), ['神社', 'パワースポット', '史跡']);
  assert.deepEqual(splitTags(''), []);
  assert.deepEqual(splitTags(null), []);
});

test('collectDistinctTags: 全スポットのタグを重複排除し「近い」を除く', () => {
  const spots = [
    { tags: '神社,史跡' },
    { tags: '史跡,公園' },
    { tags: `公園,${NEAR_TAG}` },
    { tags: null }
  ];
  assert.deepEqual(collectDistinctTags(spots).sort(), ['公園', '史跡', '神社']);
});

test('collectDistinctTags: 空・未定義でも落ちない', () => {
  assert.deepEqual(collectDistinctTags([]), []);
  assert.deepEqual(collectDistinctTags(undefined), []);
});
