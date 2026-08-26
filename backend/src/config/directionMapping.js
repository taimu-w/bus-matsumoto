// 位置情報CSVの方向列の値 → GTFS direction_id の対応を、路線ごとにコードで管理する。
//
// 以前は管理画面から route_external_ids.direction_mapping を編集する方式だったが、
// 仕様書 6.1 によりこれを廃止し、コード上の設定に一本化した（ここは今も変わらない）。
// ⚠️ route_external_ids テーブルは、外部ID⇔route_id の対応を管理画面編集に戻すため
// 2026-08-21に再作成されているが、direction_mapping列は持たない。このファイルの
// 対象（方向の対応）とは無関係なので混同しないこと（docs/外部IDマッピングのコード化_仕様書.md）。
//
//   mode: 'map'    … map で変換した direction_id を便判定に使う
//   mode: 'ignore' … 方向値を便判定に使わない（路線一致＋始発バス停100m以内のみで候補とする。仕様書 6.3）
//
// キーは routes.id と同じ「feedId:routeId」形式の qualified route id。

const DIRECTION_RULES = {
  // --- guruttomatsumotobus1 ---
  'guruttomatsumotobus1:10': { mode: 'ignore' }, // 信大横田循環線
  'guruttomatsumotobus1:11': { mode: 'ignore' }, // 横田信大循環線
  'guruttomatsumotobus1:12': { mode: 'ignore' }, // 浅間線
  'guruttomatsumotobus1:13': { mode: 'ignore' }, // 新浅間線
  'guruttomatsumotobus1:14': { mode: 'ignore' }, // 美ヶ原温泉線
  'guruttomatsumotobus1:15': { mode: 'ignore' }, // 北市内線
  'guruttomatsumotobus1:16': { mode: 'ignore' }, // 岡田線
  'guruttomatsumotobus1:17': { mode: 'ignore' }, // アルプス公園線
  'guruttomatsumotobus1:18': { mode: 'ignore' }, // 鹿教湯温泉線
  'guruttomatsumotobus1:19': { mode: 'ignore' }, // 空港今井線
  'guruttomatsumotobus1:20': { mode: 'ignore' }, // 大久保工場団地・神林線
  'guruttomatsumotobus1:21': { mode: 'ignore' }, // 山形線
  'guruttomatsumotobus1:22': { mode: 'ignore' }, // 寿台線
  'guruttomatsumotobus1:23': { mode: 'ignore' }, // 松原線
  'guruttomatsumotobus1:24': { mode: 'ignore' }, // 内田線
  'guruttomatsumotobus1:25': { mode: 'ignore' }, // 並柳団地線
  'guruttomatsumotobus1:26': { mode: 'ignore' }, // 四賀線

  // --- guruttomatsumotobus2 ---
  'guruttomatsumotobus2:10': { mode: 'ignore' }, // タウンスニーカー北コース
  'guruttomatsumotobus2:11': { mode: 'ignore' }, // タウンスニーカー東コース
  'guruttomatsumotobus2:12': { mode: 'ignore' }, // タウンスニーカー南コース
  'guruttomatsumotobus2:13': { mode: 'ignore' }, // 南部循環線
  'guruttomatsumotobus2:14': { mode: 'ignore' }, // 合庁ライナー
  'guruttomatsumotobus2:16': { mode: 'ignore' }, // 松本・島内線
  'guruttomatsumotobus2:17': { mode: 'ignore' }, // 南松本・山形線
  'guruttomatsumotobus2:18': { mode: 'ignore' }, // 梓川・波田線
  'guruttomatsumotobus2:19': { mode: 'ignore' }, // 村井・山形線
  'guruttomatsumotobus2:20': { mode: 'ignore' }, // 朝日・波田線
  'guruttomatsumotobus2:23': { mode: 'ignore' }, // 奈川・安曇線
  'guruttomatsumotobus2:24': { mode: 'ignore' }, // 四賀循環線
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
