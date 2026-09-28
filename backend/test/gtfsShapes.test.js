const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTripShapeId } = require('../src/services/gtfsShapes');

// 実在する shape_id の集合（値は使わないので null を入れておく）
const shapes = new Map([['191001', null], ['192001', null]]);

test('resolveTripShapeId: shape_id があればそれを使う', () => {
  assert.equal(resolveTripShapeId({ shape_id: '191001', jp_pattern_id: '192001' }, shapes), '191001');
});

test('resolveTripShapeId: shape_id が空なら jp_pattern_id へフォールバックする', () => {
  // ぐるっと松本バス1は全便 shape_id が空欄で、jp_pattern_id が shapes.txt と対応している
  assert.equal(resolveTripShapeId({ shape_id: '', jp_pattern_id: '192001' }, shapes), '192001');
});

test('resolveTripShapeId: shapes.txt に存在しない shape_id なら jp_pattern_id を見る', () => {
  assert.equal(resolveTripShapeId({ shape_id: '999999', jp_pattern_id: '191001' }, shapes), '191001');
});

test('resolveTripShapeId: どちらも実在しなければ null（誤った線形を拾わない）', () => {
  assert.equal(resolveTripShapeId({ shape_id: '999999', jp_pattern_id: '888888' }, shapes), null);
});

test('resolveTripShapeId: 列そのものが無い便は null', () => {
  assert.equal(resolveTripShapeId({}, shapes), null);
});

test('resolveTripShapeId: 前後の空白は無視する', () => {
  assert.equal(resolveTripShapeId({ shape_id: ' 191001 ' }, shapes), '191001');
});

test('resolveTripShapeId: shapes.txt が無い（空Map）フィードでは常に null', () => {
  assert.equal(resolveTripShapeId({ shape_id: '191001' }, new Map()), null);
});
