// 方向マッピング（route_direction_rules）のメモリキャッシュ層。
//
// 位置情報CSVの「方向列の値」→ GTFS direction_id の対応を、路線ごとに DB で持ち、
// 管理画面「方向マッピング」（/api/admin/direction-rules）から編集する。
// 行が無い路線は既定で mode:'ignore'（テーブルが空＝全路線 ignore）。
//
// route_external_ids・holidays と同じ流儀の TTL 付きメモリキャッシュだが、
// resolveDirectionId()/isDirectionIgnored() は locationFetcher.js の CSV 行ループや
// tripAssignment.js の候補ループから何度も呼ばれるため同期関数にしてある
// （runtimeSettings.js の getRuntimeSetting() と同じ理由）。実際のDB読み込み（非同期）は
// refreshDirectionRulesCache() が担い、jobs/pipeline.js の先頭・サーバー起動直後
// （server.js）・管理画面からの保存/削除直後に呼ばれる。呼ばれる前・DB接続不可時は
// キャッシュが空のまま＝全路線 ignore にフォールバックする（候補を過剰に絞らない安全側）。
const pool = require('../config/db');
const {
  DEFAULT_RULE,
  ruleIgnoresDirection,
  resolveDirectionIdForRule
} = require('../config/directionMapping');

const TTL_MS = 30 * 1000; // パイプラインの既定ポーリング間隔(60秒)より短くし、次回tickで確実に反映する

let rules = new Map(); // routeId -> 正規化済みルール
let cachedAt = 0;

/**
 * DBから方向マッピングを読み込む。TTL内であれば何もしない（force=trueで強制再読込）。
 * 失敗時は既存キャッシュを保持したまま（空なら全路線 ignore で動作継続する）。
 */
async function refreshDirectionRulesCache(force = false) {
  const now = Date.now();
  if (!force && (now - cachedAt) < TTL_MS) return;

  try {
    const res = await pool.query(
      `SELECT route_id, mode, value_map, fallback FROM route_direction_rules`
    );
    const next = new Map();
    for (const row of res.rows) {
      if (row.mode === 'map') {
        next.set(row.route_id, {
          mode: 'map',
          map: row.value_map || {},
          fallback: row.fallback === undefined ? null : row.fallback
        });
      } else {
        next.set(row.route_id, { mode: 'ignore' });
      }
    }
    rules = next;
    cachedAt = now;
  } catch (err) {
    console.error('[directionRules] 方向マッピングの読み込みに失敗しました（全路線ignoreで継続します）:', err.message);
  }
}

/** 次回参照時にDBから再読込させる。管理画面からの保存・削除直後に呼ぶ。 */
function invalidateDirectionRulesCache() {
  cachedAt = 0;
}

/** その路線の方向ルールを返す（同期）。行が無ければ DEFAULT_RULE（ignore）。 */
function getDirectionRule(routeId) {
  return rules.get(routeId) || DEFAULT_RULE;
}

/**
 * この路線が方向値を便判定に使わない設定かどうか（同期）。
 */
function isDirectionIgnored(routeId) {
  return ruleIgnoresDirection(getDirectionRule(routeId));
}

/**
 * 位置情報CSVの方向列の値を GTFS の direction_id へ変換する（同期）。
 * @returns {number|null} direction_id。方向を使わない設定・値が空の場合は null。
 */
function resolveDirectionId(routeId, csvValue) {
  return resolveDirectionIdForRule(getDirectionRule(routeId), csvValue);
}

module.exports = {
  refreshDirectionRulesCache,
  invalidateDirectionRulesCache,
  getDirectionRule,
  isDirectionIgnored,
  resolveDirectionId
};
