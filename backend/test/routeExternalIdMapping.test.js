const { test } = require('node:test');
const assert = require('node:assert/strict');

// DBには繋がず pool.query を差し替える（Poolは最初のクエリまで接続しない）。
const pool = require('../src/config/db');
const {
  loadExternalIdMap,
  getExternalIdsForFeeds,
  getExternalIdsForRoute,
  invalidateRouteExternalIdCache
} = require('../src/services/routeExternalIdMapping');

// route_external_ids の SELECT が返す行（route_id IS NOT NULL のみ・external_id, route_id 昇順）。
function stubRows(rows) {
  invalidateRouteExternalIdCache();
  pool.query = async () => ({ rows });
}

const ROWS = [
  // 1つの外部IDに2路線（往路・復路が別路線でGTFSに入っているケース）
  { external_id: 'EXT-A', route_id: 'feed1:10' },
  { external_id: 'EXT-A', route_id: 'feed1:11' },
  // 1つの路線に2つの外部ID（系統違いの別ID）
  { external_id: 'EXT-B', route_id: 'feed1:20' },
  { external_id: 'EXT-C', route_id: 'feed1:20' },
  // 別のGTFSフィードの路線
  { external_id: 'EXT-D', route_id: 'feed2:30' }
];

test('loadExternalIdMap: 1つの外部IDに紐づく全route_idを配列で返す', async () => {
  stubRows(ROWS);
  const map = await loadExternalIdMap();
  assert.deepEqual(map.get('EXT-A'), ['feed1:10', 'feed1:11']);
  assert.deepEqual(map.get('EXT-B'), ['feed1:20']);
  assert.equal(map.has('EXT-E'), false);
});

test('getExternalIdsForRoute: 路線から外部IDを逆引きできる', async () => {
  stubRows(ROWS);
  assert.deepEqual(await getExternalIdsForRoute('feed1:20'), ['EXT-B', 'EXT-C']);
  // 複数路線に紐づく外部IDは、その全路線から引ける（片方の路線の便を取りこぼさないため）
  assert.deepEqual(await getExternalIdsForRoute('feed1:10'), ['EXT-A']);
  assert.deepEqual(await getExternalIdsForRoute('feed1:11'), ['EXT-A']);
  assert.deepEqual(await getExternalIdsForRoute('feed9:99'), []);
});

test('getExternalIdsForFeeds: フィードに属さないroute_idだけを配列から落とす', async () => {
  stubRows([
    ...ROWS,
    // 1つの外部IDが2つのGTFSフィードにまたがるケース
    { external_id: 'EXT-A', route_id: 'feed2:12' }
  ]);
  const map = await getExternalIdsForFeeds(['feed1']);
  assert.deepEqual(map.get('EXT-A'), ['feed1:10', 'feed1:11']);
  assert.equal(map.has('EXT-D'), false, 'feed2の路線しか持たない外部IDは落ちる');
  assert.deepEqual(map.get('EXT-B'), ['feed1:20']);
});

test('getExternalIdsForFeeds: 空配列・1件もマッチしないときは絞り込まず全件', async () => {
  stubRows(ROWS);
  assert.equal((await getExternalIdsForFeeds([])).size, 4);
  assert.equal((await getExternalIdsForFeeds(['unknownfeed'])).size, 4);
});

test('invalidateRouteExternalIdCache: 破棄すると次回は読み直す', async () => {
  stubRows(ROWS);
  assert.equal((await loadExternalIdMap()).has('EXT-D'), true);
  stubRows([{ external_id: 'EXT-Z', route_id: 'feed1:99' }]);
  const map = await loadExternalIdMap();
  assert.equal(map.has('EXT-D'), false);
  assert.deepEqual(map.get('EXT-Z'), ['feed1:99']);
});
