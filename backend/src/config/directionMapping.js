// 位置情報CSVの方向列の値 → GTFS direction_id の対応を、路線ごとにコードで管理する。
//
// 以前は管理画面から route_external_ids.direction_mapping を編集する方式だったが、
// 仕様書 6.1 によりこれを廃止し、コード上の設定に一本化した。
// （DBの direction_mapping 列は互換のため残っているが、もう参照しない）
//
//   mode: 'map'    … map で変換した direction_id を便判定に使う
//   mode: 'ignore' … 方向値を便判定に使わない（路線一致＋始発バス停100m以内のみで候補とする。仕様書 6.3）
//
// キーは routes.id と同じ「feedId:routeId」形式の qualified route id。

const DIRECTION_RULES = {
      'guruttomatsumotobus1:10': { mode: 'ignore' },
      'guruttomatsumotobus1:11': { mode: 'ignore' },
      'guruttomatsumotobus1:12': { mode: 'ignore' },
      'guruttomatsumotobus1:13': { mode: 'ignore' },
      'guruttomatsumotobus1:14': { mode: 'ignore' },
      'guruttomatsumotobus2:10': { mode: 'ignore' },
      'guruttomatsumotobus2:11': { mode: 'ignore' },
      'guruttomatsumotobus2:12': { mode: 'ignore' },
      'guruttomatsumotobus2:13': { mode: 'ignore' },
      'guruttomatsumotobus2:14': { mode: 'ignore' },
      'guruttomatsumotobus2:25': { mode: 'ignore' },
};

// 設定を書いていない路線に適用する既定値。
// 旧実装（route_external_ids.direction_mapping のデフォルト {csvValue0:1, csvValueOther:0}）と
// 同じ変換になるようにしてあり、設定を追加しない限り挙動は変わらない。
const DEFAULT_RULE = { mode: 'map', map: { '0': 1 }, fallback: 0 };

function getRule(routeId) {
  return DIRECTION_RULES[routeId] || DEFAULT_RULE;
}

/**
 * この路線が方向値を便判定に使わない設定かどうか（仕様書 6.3）。
 */
function isDirectionIgnored(routeId) {
  return getRule(routeId).mode === 'ignore';
}

/**
 * 位置情報CSVの方向列の値を GTFS の direction_id へ変換する。
 * @returns {number|null} direction_id。方向を使わない設定・値が空の場合は null。
 */
function resolveDirectionId(routeId, csvValue) {
  const rule = getRule(routeId);
  if (rule.mode === 'ignore') return null;

  const key = csvValue === null || csvValue === undefined ? '' : String(csvValue).trim();
  if (key === '') return null;

  const map = rule.map || {};
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    return map[key];
  }
  // 対応表に無い値は fallback（既定では「0以外はすべて0」という旧実装と同じ挙動）
  return rule.fallback !== undefined ? rule.fallback : null;
}

module.exports = {
  DIRECTION_RULES,
  DEFAULT_RULE,
  isDirectionIgnored,
  resolveDirectionId
};
