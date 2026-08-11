// DBの stops テーブルに対するバス停名検索（`/api/stops/search` 専用）。
//
// 【この機能に経路検索は含まれない】
// 2026年8月に、経路検索（乗換案内）はGTFSインメモリインデックスを直接探索する
// `services/gtfsRouteSearch.js` へ全面的に移した（docs/経路検索機能_改善仕様書.md）。
// 旧実装はDBの daily_trips / daily_trip_stop_times を見ていたため、
//   ・当日ぶんの便しか無く日付を選べない
//   ・GTFSの stop_id / zone_id を持たず、運賃も /busstop へのリンクも作れない
//   ・バス停名の完全一致でしかつながらず、経路が見つからないことが多い
// という構造的な限界があった。ここへ経路探索を戻さないこと。
const { resolveRouteId } = require('./gtfsData');

/**
 * バス停名の部分一致検索（全路線対応）
 * @param {boolean} distinct - true の場合は同名バス停を重複除去
 */
async function searchStops(pool, routeId, query, distinct = false) {
  const normalizedRouteId = routeId ? resolveRouteId(routeId) : null;

  let result;
  if (normalizedRouteId) {
    result = await pool.query(
      `SELECT id, direction_id, seq_order, name, lat, lon, route_id
       FROM stops
       WHERE route_id = $1 AND name ILIKE $2
       ORDER BY direction_id ASC, seq_order ASC`,
      [normalizedRouteId, `%${query}%`]
    );
  } else if (distinct) {
    result = await pool.query(
      `SELECT DISTINCT ON (name) id, direction_id, seq_order, name, lat, lon, route_id
       FROM stops
       WHERE name ILIKE $1
       ORDER BY name ASC, route_id ASC, direction_id ASC, seq_order ASC`,
      [`%${query}%`]
    );
  } else {
    result = await pool.query(
      `SELECT id, direction_id, seq_order, name, lat, lon, route_id
       FROM stops
       WHERE name ILIKE $1
       ORDER BY route_id ASC, direction_id ASC, seq_order ASC`,
      [`%${query}%`]
    );
  }
  return result.rows;
}

module.exports = {
  searchStops
};
