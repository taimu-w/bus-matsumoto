// 外部ID（位置情報CSVの系統ID）→ GTFS route_id 対応のメモリキャッシュ層。
//
// route_external_ids テーブルは高々数十件程度しか無いが、位置情報取得
// （パイプライン②、既定60秒間隔）は毎回全件を必要とするため、TTL付きでメモリにキャッシュし、
// 管理画面から追加・変更・削除したときだけ invalidateRouteExternalIdCache() で破棄する
// （services/holidayCalendar.js と同じ流儀）。
//
// route_id が NULL の行（＝「外部IDは判明しているが対応するGTFS路線がまだ無い」）は
// マッチ対象から除外する。位置情報CSVの突合には使えないため。

const pool = require('../config/db');

const TTL_MS = 60 * 60 * 1000; // 1時間

let cache = null; // Map<externalId, routeId>
let cachedAt = 0;

async function loadExternalIdMap() {
  const now = Date.now();
  if (cache && (now - cachedAt) < TTL_MS) return cache;

  const res = await pool.query(
    `SELECT external_id, route_id FROM route_external_ids WHERE route_id IS NOT NULL`
  );
  cache = new Map(res.rows.map((row) => [row.external_id, row.route_id]));
  cachedAt = now;
  return cache;
}

function invalidateRouteExternalIdCache() {
  cache = null;
}

/**
 * 複数のGTFSフィードに属する外部IDだけに絞り込んだ Map を返す。
 * 1つの位置情報フィードが複数のGTFSフィードにまたがるケース（アルピコ交通）のためのもの。
 * 配列が空、または1件もマッチしない場合は絞り込みを行わず全件を返す
 * （設定漏れで位置情報が全滅しないようにするための安全側フォールバック）。
 */
async function getExternalIdsForFeeds(gtfsFeedIds) {
  const all = await loadExternalIdMap();
  const ids = Array.isArray(gtfsFeedIds) ? gtfsFeedIds : [];
  if (ids.length === 0) return all;

  const result = new Map();
  for (const [externalId, routeId] of all.entries()) {
    if (ids.some((feedId) => routeId.startsWith(`${feedId}:`))) {
      result.set(externalId, routeId);
    }
  }
  return result.size > 0 ? result : all;
}

module.exports = { loadExternalIdMap, getExternalIdsForFeeds, invalidateRouteExternalIdCache };
