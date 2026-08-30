// 位置情報CSVの「方向列の値」→ GTFS direction_id の変換ロジック（純関数のみ）。
//
// ルールそのものは route_direction_rules テーブル（DB）に路線ごとに持ち、管理画面
// 「方向マッピング」（/api/admin/direction-rules）から編集する。実行時の読み込み・
// キャッシュ・同期アクセサは backend/src/services/directionRules.js が担う
// （runtimeSettingsCatalog.js＝純 / runtimeSettings.js＝DB と同じ分担）。
// このファイルはDBを一切見ず、「1つのルールとCSV値から direction_id を決める」
// 計算と、管理画面から来た入力の検証だけを行う。
//
// ⚠️ route_external_ids（外部ID⇔route_id の対応）とは別の設定。混同しないこと
//    （詳細は docs/feed-config.md）。
//
// ルールの形:
//   { mode: 'ignore' }
//     … 方向値を便判定に使わない（路線一致＋始発バス停100m以内のみで候補とする。仕様は
//        docs/vehicle-assignment.md）。テーブルに行が無い路線もこの扱い（DEFAULT_RULE）。
//   { mode: 'map', map: { [csvValue]: 0|1 }, fallback: 0|1|null }
//     … map で CSV方向値を direction_id に変換して便判定に使う。map に無いCSV値は
//        fallback へ。fallback が null なら方向不明（＝方向で絞り込まない）扱い。

const DEFAULT_RULE = Object.freeze({ mode: 'ignore' });

/**
 * このルールが「方向値を便判定に使わない」かどうか。
 * mode:'map' 以外（未知の mode・null 含む）はすべて方向を使わない側に倒す。
 */
function ruleIgnoresDirection(rule) {
  return !rule || rule.mode !== 'map';
}

/**
 * 1つのルールと、位置情報CSVの方向列の値から GTFS の direction_id を決める。
 * @returns {number|null} direction_id。方向を使わない設定・値が空・fallback未設定の場合は null。
 */
function resolveDirectionIdForRule(rule, csvValue) {
  if (ruleIgnoresDirection(rule)) return null;

  const key = csvValue === null || csvValue === undefined ? '' : String(csvValue).trim();
  if (key === '') return null;

  const map = rule.map || {};
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    return map[key];
  }
  return rule.fallback !== undefined && rule.fallback !== null ? rule.fallback : null;
}

function isValidDirectionId(value) {
  return value === 0 || value === 1;
}

/**
 * 管理画面（POST /api/admin/direction-rules）から来た入力を検証・正規化する。
 * @param {{mode?:string, valueMap?:object, fallback?:number|null}} input
 * @returns {{rule: object}|{error: string}}
 *   rule は DB 保存・キャッシュ格納に使える正規形（mode:'ignore' か mode:'map'）。
 */
function normalizeDirectionRuleInput(input) {
  const mode = input && input.mode;
  if (mode !== 'ignore' && mode !== 'map') {
    return { error: 'mode は ignore か map を指定してください。' };
  }
  if (mode === 'ignore') {
    return { rule: { mode: 'ignore', map: {}, fallback: null } };
  }

  const rawMap = input.valueMap;
  if (rawMap === null || rawMap === undefined || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return { error: 'valueMap はオブジェクトで指定してください。' };
  }

  const map = {};
  for (const [rawKey, rawVal] of Object.entries(rawMap)) {
    const key = String(rawKey).trim();
    if (key === '') {
      return { error: 'CSV方向値（変換表のキー）に空の値は指定できません。' };
    }
    const val = typeof rawVal === 'string'
      ? (rawVal.trim() === '' ? NaN : Number(rawVal))
      : rawVal;
    if (!isValidDirectionId(val)) {
      return { error: `変換先の direction_id は 0 か 1 で指定してください（キー「${key}」）。` };
    }
    map[key] = val;
  }
  if (Object.keys(map).length === 0) {
    return { error: 'map モードでは変換表を1件以上指定してください（不要なら ignore を選んでください）。' };
  }

  let fallback = input.fallback;
  if (fallback === '' || fallback === undefined) fallback = null;
  if (fallback !== null) {
    const fb = typeof fallback === 'string' ? Number(fallback) : fallback;
    if (!isValidDirectionId(fb)) {
      return { error: 'フォールバック値は 0・1・未設定（方向不明）のいずれかで指定してください。' };
    }
    fallback = fb;
  }

  return { rule: { mode: 'map', map, fallback } };
}

module.exports = {
  DEFAULT_RULE,
  ruleIgnoresDirection,
  resolveDirectionIdForRule,
  normalizeDirectionRuleInput
};
