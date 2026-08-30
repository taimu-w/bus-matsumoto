const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RULE,
  ruleIgnoresDirection,
  resolveDirectionIdForRule,
  normalizeDirectionRuleInput
} = require('../src/config/directionMapping');

test('DEFAULT_RULE は ignore（行が無い路線は方向で絞り込まない）', () => {
  assert.equal(DEFAULT_RULE.mode, 'ignore');
  assert.equal(ruleIgnoresDirection(DEFAULT_RULE), true);
  assert.equal(resolveDirectionIdForRule(DEFAULT_RULE, '0'), null);
});

test('ruleIgnoresDirection: map 以外（null・未知mode含む）はすべて ignore 扱い', () => {
  assert.equal(ruleIgnoresDirection({ mode: 'ignore' }), true);
  assert.equal(ruleIgnoresDirection(null), true);
  assert.equal(ruleIgnoresDirection({ mode: 'unknown' }), true);
  assert.equal(ruleIgnoresDirection({ mode: 'map', map: { '0': 1 } }), false);
});

test('resolveDirectionIdForRule: ignore は常に null', () => {
  assert.equal(resolveDirectionIdForRule({ mode: 'ignore' }, '0'), null);
});

test('resolveDirectionIdForRule: map は変換表を引き、外れは fallback へ', () => {
  const rule = { mode: 'map', map: { '0': 1 }, fallback: 0 };
  assert.equal(resolveDirectionIdForRule(rule, '0'), 1);
  assert.equal(resolveDirectionIdForRule(rule, '1'), 0);
  assert.equal(resolveDirectionIdForRule(rule, '9'), 0);
});

test('resolveDirectionIdForRule: fallback 未設定なら外れ値は null（方向不明）', () => {
  const rule = { mode: 'map', map: { '1': 0, '2': 1 }, fallback: null };
  assert.equal(resolveDirectionIdForRule(rule, '1'), 0);
  assert.equal(resolveDirectionIdForRule(rule, '3'), null);
});

test('resolveDirectionIdForRule: 空値・null は null', () => {
  const rule = { mode: 'map', map: { '0': 1 }, fallback: 0 };
  assert.equal(resolveDirectionIdForRule(rule, ''), null);
  assert.equal(resolveDirectionIdForRule(rule, null), null);
  assert.equal(resolveDirectionIdForRule(rule, undefined), null);
});

test('normalizeDirectionRuleInput: ignore は map/fallback を捨てて正規化', () => {
  const { rule, error } = normalizeDirectionRuleInput({ mode: 'ignore', valueMap: { '0': 1 }, fallback: 0 });
  assert.equal(error, undefined);
  assert.deepEqual(rule, { mode: 'ignore', map: {}, fallback: null });
});

test('normalizeDirectionRuleInput: map は文字列値も数値化して受け付ける', () => {
  const { rule } = normalizeDirectionRuleInput({ mode: 'map', valueMap: { ' 0 ': '1', '2': 0 }, fallback: '1' });
  assert.deepEqual(rule, { mode: 'map', map: { '0': 1, '2': 0 }, fallback: 1 });
});

test('normalizeDirectionRuleInput: map で fallback 未指定は null（方向不明）', () => {
  const { rule } = normalizeDirectionRuleInput({ mode: 'map', valueMap: { '0': 1 } });
  assert.equal(rule.fallback, null);
});

test('normalizeDirectionRuleInput: 異常系はエラー文字列を返す', () => {
  assert.ok(normalizeDirectionRuleInput({ mode: 'bogus' }).error);
  assert.ok(normalizeDirectionRuleInput({ mode: 'map', valueMap: {} }).error);
  assert.ok(normalizeDirectionRuleInput({ mode: 'map', valueMap: { '0': 2 } }).error);
  assert.ok(normalizeDirectionRuleInput({ mode: 'map', valueMap: { '': 1 } }).error);
  assert.ok(normalizeDirectionRuleInput({ mode: 'map', valueMap: { '0': 1 }, fallback: 5 }).error);
});
