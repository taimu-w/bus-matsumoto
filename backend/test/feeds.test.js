const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getGtfsFeedIdsFor,
  getLocationFeedIdsForRoute
} = require('../src/config/feeds');

// getLocationFeedIdsForRoute は getGtfsFeedIdsFor の逆引き。
// 車両割り当ての候補検索 fallback（system-review-2026-09 DB-5）で、
// 系統表示が切り替わる前後の車両を「同じ位置情報フィードの範囲」に限って拾うために使う。

test('getLocationFeedIdsForRoute: guruttomatsumotobus2 の路線 → 2 を配信する位置情報フィード全て', () => {
  const feedIds = getLocationFeedIdsForRoute('guruttomatsumotobus2:anyRoute');
  assert.deepEqual(
    [...feedIds].sort(),
    ['alpicokotsu', 'matsumotoshicombus', 'matsumotoshiei']
  );
});

test('getLocationFeedIdsForRoute: guruttomatsumotobus1 の路線 → アルピコ交通のみ', () => {
  assert.deepEqual(getLocationFeedIdsForRoute('guruttomatsumotobus1:x'), ['alpicokotsu']);
});

test('getLocationFeedIdsForRoute: getGtfsFeedIdsFor と整合する（逆引きの往復）', () => {
  for (const routeId of ['guruttomatsumotobus1:r', 'guruttomatsumotobus2:r']) {
    const gtfsFeedId = routeId.split(':')[0];
    for (const locationFeedId of getLocationFeedIdsForRoute(routeId)) {
      assert.ok(
        getGtfsFeedIdsFor(locationFeedId).includes(gtfsFeedId),
        `${locationFeedId} は ${gtfsFeedId} を配信するはず`
      );
    }
  }
});

test('getLocationFeedIdsForRoute: 未知フィード・非qualified・不正入力は空配列', () => {
  assert.deepEqual(getLocationFeedIdsForRoute('unknownfeed:route'), []);
  assert.deepEqual(getLocationFeedIdsForRoute('unqualified'), []);
  assert.deepEqual(getLocationFeedIdsForRoute(':route'), []);
  assert.deepEqual(getLocationFeedIdsForRoute(''), []);
  assert.deepEqual(getLocationFeedIdsForRoute(null), []);
  assert.deepEqual(getLocationFeedIdsForRoute(undefined), []);
});
