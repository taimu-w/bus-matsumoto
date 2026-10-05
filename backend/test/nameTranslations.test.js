const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLang,
  romanizeKana,
  buildNameDictionary,
  putTranslation,
  emptyEntries
} = require('../src/services/nameTranslations');

test('normalizeLang: 地域サブタグを落とし、かな・ローマ字の言語タグは区別して残す', () => {
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang('EN_gb'), 'en');
  assert.equal(normalizeLang('ja-Hrkt'), 'ja-hrkt');
  assert.equal(normalizeLang('ja-Latn'), 'ja-latn');
  assert.equal(normalizeLang('ja'), 'ja');
  assert.equal(normalizeLang(''), '');
});

test('romanizeKana: ヘボン式で単語ごとに先頭を大文字にする（空白・中黒は区切りとして残す）', () => {
  assert.equal(romanizeKana('まつもと'), 'Matsumoto');
  assert.equal(romanizeKana('まつもと ばすたーみなる'), 'Matsumoto Basutaminaru');
  assert.equal(romanizeKana('しんしゅう・まつもと'), 'Shinshu Matsumoto');
  assert.equal(romanizeKana(''), '');
});

test('buildNameDictionary: 表示言語の訳 → ローマ字表記 → かなからの変換 の順に採用する', () => {
  const entries = emptyEntries();
  // 英訳あり（かなもあるが英訳が優先）
  putTranslation(entries, 'stops', '松本バスターミナル', 'ja-hrkt', 'まつもとばすたーみなる');
  putTranslation(entries, 'stops', '松本バスターミナル', 'en', 'Matsumoto Bus Terminal');
  // かなだけ
  putTranslation(entries, 'stops', '本町', 'ja-hrkt', 'ほんまち');
  // ローマ字表記だけ
  putTranslation(entries, 'stops', '大名町', 'ja-latn', 'Daimyocho');
  // どれも無い路線は辞書に載らない（＝画面で日本語のまま）
  putTranslation(entries, 'routes', '浅間線', 'zh', '浅间线');

  const dict = buildNameDictionary(entries, 'en');
  assert.equal(dict.lang, 'en');
  assert.deepEqual(dict.stops['松本バスターミナル'], ['Matsumoto Bus Terminal', 'gtfs']);
  assert.deepEqual(dict.stops['本町'], ['Honmachi', 'romaji']);
  assert.deepEqual(dict.stops['大名町'], ['Daimyocho', 'romaji']);
  assert.equal(dict.routes['浅間線'], undefined);
});

test('buildNameDictionary: 日本語指定なら空の辞書', () => {
  const entries = emptyEntries();
  putTranslation(entries, 'stops', '本町', 'en', 'Hommachi');
  const dict = buildNameDictionary(entries, 'ja');
  assert.deepEqual(dict.stops, {});
  assert.deepEqual(dict.routes, {});
});

test('putTranslation: 言語タグが無い行は内容でかな／ローマ字を判定し、同じ訳・空の訳は無視する', () => {
  const entries = emptyEntries();
  putTranslation(entries, 'stops', '浅間温泉', '', 'あさまおんせん');
  putTranslation(entries, 'stops', '浅間温泉', 'en', '浅間温泉'); // 原文と同じ
  putTranslation(entries, 'stops', '浅間温泉', 'en', '');
  const dict = buildNameDictionary(entries, 'en');
  assert.deepEqual(dict.stops['浅間温泉'], ['Asamaonsen', 'romaji']);
});

test('putTranslation: 同じ日本語名に複数の英訳があれば先勝ち', () => {
  const entries = emptyEntries();
  putTranslation(entries, 'stops', '松本駅', 'en', 'Matsumoto Station');
  putTranslation(entries, 'stops', '松本駅', 'en', 'Matsumoto Sta.');
  assert.deepEqual(buildNameDictionary(entries, 'en').stops['松本駅'], ['Matsumoto Station', 'gtfs']);
});
