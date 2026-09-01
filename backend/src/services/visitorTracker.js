/**
 * サイト閲覧数（直近アクティブな利用者数）を把握するための簡易トラッカー。
 * DBは使わず、プロセスのメモリ上でクライアントごとの最終アクセス時刻のみを保持する
 * （再起動でリセットされて構わない、あくまで「今」の目安値のため）。
 *
 * フロントエンドは20秒間隔でポーリングしている（app.jsのPOLL_MS）ため、
 * ACTIVE_WINDOW_MSはそれより十分長く取り、タブが一時的にバックグラウンドになっても
 * 過剰にカウントが落ちないようにする。
 */
const { getRuntimeSetting } = require('./runtimeSettings');
const { VISITOR_MAX_CLIENTS_PER_IP } = require('../config/security');

const ACTIVE_WINDOW_MS = 90 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const lastSeenByClient = new Map();
// IP -> そのIPから受け付けた異なるクライアントIDの集合（水増し防止用。cleanup()ごとに作り直す）
const clientIdsByIp = new Map();

/**
 * 閲覧を記録する。
 *
 * `clientIp`を渡すと、1つのIPから数えるクライアントIDを`VISITOR_MAX_CLIENTS_PER_IP`
 * （既定200・0で無制限）までに制限する。X-Client-Idは無認証のヘッダーなので、
 * IDを振り直しながら叩けば閲覧数もサーバー高負荷判定も一方的に水増しできてしまうため
 * （docs/system-review-2026-09.md S-3）。上限はcleanup()（60秒間隔）ごとにリセットされるので、
 * 実在の利用者が恒久的に締め出されることはない。
 *
 * 上限に達しても**リクエスト自体は通す**（数えないだけ）。CGNAT配下で同じIPを共有する
 * 実利用者が多い場合に起こりうるのは「閲覧数の過小計上」だけで、画面の動作には影響しない。
 * `clientIp`を省略した場合は上限なし（従来どおりの挙動）。
 */
function recordVisit(clientId, clientIp) {
  if (!clientId) return;

  if (clientIp && VISITOR_MAX_CLIENTS_PER_IP > 0) {
    let seenIds = clientIdsByIp.get(clientIp);
    if (!seenIds) {
      seenIds = new Set();
      clientIdsByIp.set(clientIp, seenIds);
    }
    if (!seenIds.has(clientId)) {
      if (seenIds.size >= VISITOR_MAX_CLIENTS_PER_IP) return;
      seenIds.add(clientId);
    }
  }

  lastSeenByClient.set(clientId, Date.now());
}

function getActiveViewerCount() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let count = 0;
  for (const lastSeen of lastSeenByClient.values()) {
    if (lastSeen >= cutoff) count += 1;
  }
  return count;
}

function getServerLoadStatus() {
  const activeViewers = getActiveViewerCount();
  const threshold = getRuntimeSetting('HIGH_LOAD_VIEWER_THRESHOLD');
  return {
    activeViewers,
    threshold,
    highLoad: activeViewers >= threshold
  };
}

function cleanup() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  for (const [clientId, lastSeen] of lastSeenByClient) {
    if (lastSeen < cutoff) lastSeenByClient.delete(clientId);
  }
  // IPごとの上限は毎周期リセットする（作り直さないと、時間とともに集合が膨らんで
  // 実在の利用者を締め出し続けてしまう）。
  clientIdsByIp.clear();
}

// テストプロセスなどをぶら下げたままにしないよう unref() しておく。
setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

module.exports = { recordVisit, getActiveViewerCount, getServerLoadStatus };
