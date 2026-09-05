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
 * routeId省略時に特定路線（旧・単一路線時代の横田信大循環線）へ黙って決め打ちすることはしない
 * （docs/system-review-2026-09.md A-2）。省略時はnullを返すので、路線が特定できないと
 * 意味を成さない呼び出し元（バス停・時刻表・運行状況など）はnullを400などで弾くこと。
 * 逆にお知らせ設定のように「routeId無し＝全路線共通」で構わない呼び出し元は、
 * このnullをそのまま許容してよい。
 */
function resolveRouteId(routeId) {
  if (!routeId) {
    return null;
  }
  return EXTERNAL_ROUTE_ID_ALIASES[routeId] || routeId;
}

module.exports = {
  resolveRouteId
};
