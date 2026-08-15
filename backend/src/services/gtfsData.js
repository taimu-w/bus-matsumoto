// route_id解決の唯一の窓口。
//
// 複数GTFSフィード対応のため、DB（routes/vehicles/stops等）のroute_idは
// 「feedId:routeId」形式のプレフィックス付きで保存されている（seed.jsのqualifyRouteId参照）。
// そのためここではプレフィックスを除去せず、DBの値とそのまま一致させる。

const EXTERNAL_ROUTE_ID_ALIASES = {
  '01h9j06f82mw3wvnddsbs4z7fs': 'guruttomatsumotobus1:11'
};

/**
 * route_id を解決する。
 * システム設定など、routeIdが省略可能なケースではデフォルト値（横田信大循環線）を使用する。
 */
function resolveRouteId(routeId) {
  if (!routeId) {
    return 'guruttomatsumotobus1:11';
  }
  return EXTERNAL_ROUTE_ID_ALIASES[routeId] || routeId;
}

module.exports = {
  resolveRouteId
};
