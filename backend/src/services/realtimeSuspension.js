// 路線ごとの「リアルタイム運行情報の表示」一時休止スイッチのメモリキャッシュ層。
//
// route_realtime_suspensions テーブル（管理画面「リアルタイム休止」で編集）を、
// 公開APIのリクエストごとに毎回 SELECT せずに済むよう TTL 付きでメモリにキャッシュし、
// 管理画面から追加・削除したときだけ invalidateRealtimeSuspensionCache() で破棄する
// （services/routeExternalIdMapping.js と同じ流儀）。
//
// TTL は routeExternalIdMapping.js（1時間）より短い60秒にしてある。これは輸送障害の
// 対応中に使う安全機能であり、万一 invalidate を取りこぼしても短時間で自己回復させたいため。
// invalidate が効けば反映は即時なので、通常はこの TTL に頼らない。
//
// route_id は routes.id と同じ「feedId:routeId」形式の qualified route id。
// 詳細は docs/realtime-suspension.md。

const pool = require('../config/db');

const TTL_MS = 60 * 1000; // 60秒

let cache = null; // Map<qualifiedRouteId, { reason: string }>
let cachedAt = 0;

async function loadRealtimeSuspensions() {
  const now = Date.now();
  if (cache && (now - cachedAt) < TTL_MS) return cache;

  try {
    const res = await pool.query('SELECT route_id, reason FROM route_realtime_suspensions');
    cache = new Map(res.rows.map((row) => [row.route_id, { reason: row.reason || '' }]));
    cachedAt = now;
  } catch (err) {
    // DB接続不可のときは「休止なし」（＝従来どおりリアルタイム表示）へ安全側フォールバックする。
    console.error('[realtimeSuspension] route_realtime_suspensions の読み込みに失敗しました:', err.message);
    if (!cache) cache = new Map();
  }
  return cache;
}

function invalidateRealtimeSuspensionCache() {
  cache = null;
}

/** 現在リアルタイム表示を休止中の qualified route id の Set。バスマップのフィルタ用。 */
async function getSuspendedRouteIdSet() {
  return new Set((await loadRealtimeSuspensions()).keys());
}

/** その路線のリアルタイム表示が休止中か。 */
async function isRealtimeSuspended(qualifiedRouteId) {
  if (!qualifiedRouteId) return false;
  return (await loadRealtimeSuspensions()).has(qualifiedRouteId);
}

/** 休止中なら { reason }、休止していなければ null（画面メッセージ用）。 */
async function getRealtimeSuspension(qualifiedRouteId) {
  if (!qualifiedRouteId) return null;
  return (await loadRealtimeSuspensions()).get(qualifiedRouteId) || null;
}

module.exports = {
  loadRealtimeSuspensions,
  invalidateRealtimeSuspensionCache,
  getSuspendedRouteIdSet,
  isRealtimeSuspended,
  getRealtimeSuspension
};
