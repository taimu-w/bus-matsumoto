/**
 * API稼働状況（応答時間・エラー率・アクセス数・失敗したエンドポイント）を
 * 把握するための簡易トラッカー。visitorTracker.js と同じくプロセスのメモリ上にのみ保持する
 * （再起動でリセットされて構わない、あくまで運用監視用の目安値のため）。
 *
 * キーは生のURL（idを含む等でカーディナリティが無限に増え得る）ではなく、
 * Expressがマッチしたルートパターン（例: "GET /timetable/stops/:stopKey"）を使う。
 */
const RECENT_SAMPLE_LIMIT = 50;
const RECENT_ERROR_LIMIT = 50;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TRACKED_ENDPOINTS = 200; // ルートパターンキーなので通常はここまで増えないが念のため

const statsByEndpoint = new Map();
const recentErrors = [];

function emptyEndpointState() {
  return {
    count: 0,
    errorCount: 0,
    totalDurationMs: 0,
    statusCounts: new Map(),
    lastAccessAt: null,
    recentSamples: []
  };
}

function recordRequest(method, pattern, statusCode, durationMs) {
  const key = `${method} ${pattern}`;
  let state = statsByEndpoint.get(key);
  if (!state) {
    if (statsByEndpoint.size >= MAX_TRACKED_ENDPOINTS) return; // 想定外の暴走を防ぐ安全弁
    state = emptyEndpointState();
    statsByEndpoint.set(key, state);
  }

  state.count += 1;
  state.totalDurationMs += durationMs;
  state.lastAccessAt = new Date();
  state.statusCounts.set(statusCode, (state.statusCounts.get(statusCode) || 0) + 1);

  const isError = statusCode >= 400;
  if (isError) state.errorCount += 1;

  state.recentSamples.push({ ts: state.lastAccessAt, durationMs, statusCode });
  if (state.recentSamples.length > RECENT_SAMPLE_LIMIT) state.recentSamples.shift();

  if (statusCode >= 500) {
    recentErrors.push({ ts: state.lastAccessAt, method, pattern, statusCode });
    if (recentErrors.length > RECENT_ERROR_LIMIT) recentErrors.shift();
  }
}

function getStats() {
  const endpoints = Array.from(statsByEndpoint.entries()).map(([key, state]) => {
    const [method, ...patternParts] = key.split(' ');
    return {
      method,
      pattern: patternParts.join(' '),
      count: state.count,
      errorCount: state.errorCount,
      errorRate: state.count > 0 ? state.errorCount / state.count : 0,
      avgDurationMs: state.count > 0 ? Math.round(state.totalDurationMs / state.count) : 0,
      lastAccessAt: state.lastAccessAt,
      statusCounts: Object.fromEntries(state.statusCounts.entries())
    };
  });
  endpoints.sort((a, b) => b.count - a.count);

  return {
    endpoints,
    recentErrors: recentErrors.slice().reverse()
  };
}

// 想定外にエンドポイント数が膨らんだ場合の安全弁（通常のルートパターン運用では発火しない）。
function cleanup() {
  if (statsByEndpoint.size <= MAX_TRACKED_ENDPOINTS) return;
  const excess = statsByEndpoint.size - MAX_TRACKED_ENDPOINTS;
  const keys = Array.from(statsByEndpoint.keys()).slice(0, excess);
  for (const key of keys) statsByEndpoint.delete(key);
}

setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

module.exports = { recordRequest, getStats };
