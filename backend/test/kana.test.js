const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  toHiragana,
  toKatakana,
  kanaToRomaji,
  normalizeSearchText,
  hasKanji,
  hasLatin
} = require('../src/utils/kana');

test('kanaToRomaji: まつもと -> matsumoto', () => {
  assert.equal(kanaToRomaji('まつもと'), 'matsumoto');
});

test('kanaToRomaji: 長音の畳み込み（とうきょう -> tokyo）', () => {
  assert.equal(kanaToRomaji('とうきょう'), 'tokyo');
});

test('kanaToRomaji: 促音の重ね（がっこう -> gakko）', () => {
  assert.equal(kanaToRomaji('がっこう'), 'gakko');
});

test('toHiragana / toKatakana: 相互変換', () => {
  assert.equal(toHiragana('マツモト'), 'まつもと');
  assert.equal(toKatakana('まつもと'), 'マツモト');
});

test('normalizeSearchText: 表記ゆれを吸収する', () => {
  assert.equal(normalizeSearchText('バスターミナル'), normalizeSearchText('ばすたーみなる'));
});

test('hasKanji / hasLatin: 判定', () => {
  assert.equal(hasKanji('松本駅'), true);
  assert.equal(hasKanji('まつもと'), false);
  assert.equal(hasLatin('Matsumoto'), true);
  assert.equal(hasLatin('まつもと'), false);
});
