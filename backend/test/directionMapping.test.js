const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDirectionIgnored, resolveDirectionId } = require('../src/config/directionMapping');

test('isDirectionIgnored: 個別ルール未設定の路線でも既定はmapモード', () => {
  assert.equal(isDirectionIgnored('unknown:route'), false);
});

test('isDirectionIgnored: 設定済み路線はignoreモード', () => {
  assert.equal(isDirectionIgnored('guruttomatsumotobus1:11'), true);
});

test('resolveDirectionId: ignoreモードの路線は常にnull', () => {
  assert.equal(resolveDirectionId('guruttomatsumotobus1:11', '0'), null);
});

test('resolveDirectionId: 既定ルールは"0"を1、それ以外を0に変換する', () => {
  assert.equal(resolveDirectionId('unknown:route', '0'), 1);
  assert.equal(resolveDirectionId('unknown:route', '1'), 0);
  assert.equal(resolveDirectionId('unknown:route', '9'), 0);
});

test('resolveDirectionId: 空値はnull', () => {
  assert.equal(resolveDirectionId('unknown:route', ''), null);
  assert.equal(resolveDirectionId('unknown:route', null), null);
});
