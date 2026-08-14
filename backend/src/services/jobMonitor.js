/**
 * パイプライン各ステップの実行状況（最終成功時刻・所要時間・失敗履歴）を
 * 把握するための簡易トラッカー。
 * DBは使わず、visitorTracker.js と同じくプロセスのメモリ上にのみ保持する
 * （再起動でリセットされて構わない、あくまで運用監視用の目安値のため）。
 *
 * リングバッファでサイズを有界にしているため、visitorTracker.js のような
 * 時間ベースのcleanupタイマーは持たない（サイズは history の push/shift で管理する）。
 */
const HISTORY_LIMIT = 20;

const JOB_NAMES = [
  'pipeline.gtfsUpdate',
  'pipeline.ensureDailyTrips',
  'pipeline.fetchLocation',
  'pipeline.sortCarId',
  'pipeline.assignPendingTrips',
  'pipeline.reassignOrphanTrips',
  'pipeline.pass',
  'pipeline.delayCalc',
  'pipeline.computeArrivals',
  'pipeline.gtfsManualRefetch',
  'scheduler.finishTrips',
  'scheduler.cleanup'
];

function emptyJobState() {
  return {
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: null,
    lastOk: null,
    lastError: null,
    lastMeta: null,
    history: []
  };
}

const jobs = new Map();
for (const name of JOB_NAMES) {
  jobs.set(name, emptyJobState());
}

function getOrCreate(name) {
  let state = jobs.get(name);
  if (!state) {
    state = emptyJobState();
    jobs.set(name, state);
  }
  return state;
}

/**
 * 返り値のうち、履歴として保持しても問題ないもの（スカラー・配列・プレーンオブジェクト）
 * だけを軽量化して保持する。DB行など巨大/循環参照の恐れがあるものを無制限に溜め込まないため。
 */
function sanitizeMeta(value) {
  if (value === undefined || value === null) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length > 4000) return { truncated: true, preview: json.slice(0, 4000) };
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

/**
 * ジョブ実行を計測する。fn() の呼び出し・返り値・例外はそのまま透過する
 * （呼び出し側の既存 try/catch の意味論を変えないことが最重要。失敗時は必ず re-throw する）。
 */
async function track(name, fn) {
  const state = getOrCreate(name);
  const startedAt = new Date();
  state.lastStartedAt = startedAt;
  const startMs = Date.now();

  try {
    const result = await fn();
    const durationMs = Date.now() - startMs;
    const finishedAt = new Date();
    const meta = sanitizeMeta(result);

    state.lastFinishedAt = finishedAt;
    state.lastDurationMs = durationMs;
    state.lastOk = true;
    state.lastError = null;
    state.lastMeta = meta;
    state.history.push({ startedAt, finishedAt, durationMs, ok: true, error: null, meta });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();

    return result;
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const finishedAt = new Date();
    const message = err && err.message ? err.message : String(err);

    state.lastFinishedAt = finishedAt;
    state.lastDurationMs = durationMs;
    state.lastOk = false;
    state.lastError = message;
    state.lastMeta = null;
    state.history.push({ startedAt, finishedAt, durationMs, ok: false, error: message, meta: null });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();

    throw err;
  }
}

function getJobsStatus() {
  return Array.from(jobs.entries()).map(([name, state]) => ({
    name,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastDurationMs: state.lastDurationMs,
    lastOk: state.lastOk,
    lastError: state.lastError,
    lastMeta: state.lastMeta,
    history: state.history
  }));
}

/**
 * 特定ジョブの直近の実行結果（meta込み）を1件だけ取得する。
 * 他サービスが「前段の最終実行結果」を参照したいとき用（例: 位置情報フィード監視が
 * pipeline.fetchLocation の直近結果を読む）。
 */
function getJobStatus(name) {
  const state = jobs.get(name);
  if (!state) return null;
  return {
    name,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastDurationMs: state.lastDurationMs,
    lastOk: state.lastOk,
    lastError: state.lastError,
    lastMeta: state.lastMeta,
    history: state.history
  };
}

module.exports = { track, getJobsStatus, getJobStatus, JOB_NAMES };
