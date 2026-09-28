// 外部ID（位置情報CSVの系統ID）⇔ GTFS route_id 対応のメモリキャッシュ層。
//
// route_external_ids テーブルは高々数十件程度しか無いが、位置情報取得
// （パイプライン②、既定60秒間隔）は毎回全件を必要とするため、TTL付きでメモリにキャッシュし、
// 管理画面から追加・変更・削除したときだけ invalidateRouteExternalIdCache() で破棄する
// （services/holidayCalendar.js と同じ流儀）。
//
// 対応は多対多で、1つの外部IDに複数の route_id が紐づきうる（往路・復路が別路線として
// GTFSに入っているのに車載器の系統IDは1つ、というケース）。そのため外部ID→route_id は
// **配列**で返す。逆引き（route_id→外部ID）も同じキャッシュから引ける。
//
// route_id が NULL の行（＝「外部IDは判明しているが対応するGTFS路線がまだ無い」）は
// マッチ対象から除外する。位置情報CSVの突合には使えないため。

const pool = require('../config/db');

const TTL_MS = 60 * 60 * 1000; // 1時間

let cache = null; // { byExternalId: Map<externalId, routeId[]>, byRouteId: Map<routeId, externalId[]> }
let cachedAt = 0;

async function loadCache() {
  const now = Date.now();
  if (cache && (now - cachedAt) < TTL_MS) return cache;

  // 並び順を固定する。route_id 配列の先頭が「代表の路線」（位置情報の観測系統として
  // vehicle_positions_raw.route_id に記録する値）になるため、取得のたびに入れ替わると
  // 同じ設定でも測位の観測系統が揺れてしまう。
  const res = await pool.query(
    `SELECT external_id, route_id FROM route_external_ids
     WHERE route_id IS NOT NULL
     ORDER BY external_id ASC, route_id ASC`
  );

  const byExternalId = new Map();
  const byRouteId = new Map();
  for (const row of res.rows) {
    const routeIds = byExternalId.get(row.external_id) || [];
    routeIds.push(row.route_id);
    byExternalId.set(row.external_id, routeIds);

    const externalIds = byRouteId.get(row.route_id) || [];
    externalIds.push(row.external_id);
    byRouteId.set(row.route_id, externalIds);
  }

  cache = { byExternalId, byRouteId };
  cachedAt = now;
  return cache;
}

/**
 * 外部ID → 対応する route_id の配列（1件以上）の Map を返す。
 */
async function loadExternalIdMap() {
  return (await loadCache()).byExternalId;
}

/**
 * その路線に紐づく外部IDの一覧。便の候補検索（tripAssignment.findCandidates）が
 * 「この便の路線として届きうる外部ID」を知るために使う。
 */
async function getExternalIdsForRoute(routeId) {
  const { byRouteId } = await loadCache();
  return byRouteId.get(routeId) || [];
}

/**
 * 複数のGTFSフィードに属する外部IDだけに絞り込んだ Map を返す。
 * 1つの位置情報フィードが複数のGTFSフィードにまたがるケース（アルピコ交通）のためのもの。
 * 外部IDに紐づく route_id のうち、指定フィードに属さないものは配列から落とす。
 * 配列が空、または1件もマッチしない場合は絞り込みを行わず全件を返す
 * （設定漏れで位置情報が全滅しないようにするための安全側フォールバック）。
 */
async function getExternalIdsForFeeds(gtfsFeedIds) {
  const all = await loadExternalIdMap();
  const ids = Array.isArray(gtfsFeedIds) ? gtfsFeedIds : [];
  if (ids.length === 0) return all;

  const result = new Map();
  for (const [externalId, routeIds] of all.entries()) {
    const matched = routeIds.filter((routeId) => ids.some((feedId) => routeId.startsWith(`${feedId}:`)));
    if (matched.length > 0) result.set(externalId, matched);
  }
  return result.size > 0 ? result : all;
}

function invalidateRouteExternalIdCache() {
  cache = null;
}

module.exports = {
  loadExternalIdMap,
  getExternalIdsForFeeds,
  getExternalIdsForRoute,
  invalidateRouteExternalIdCache
};
