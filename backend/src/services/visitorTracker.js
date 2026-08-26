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

const ACTIVE_WINDOW_MS = 90 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const lastSeenByClient = new Map();

function recordVisit(clientId) {
  if (!clientId) return;
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
}

// テストプロセスなどをぶら下げたままにしないよう unref() しておく。
setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

module.exports = { recordVisit, getActiveViewerCount, getServerLoadStatus };
