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

// 何回連続でスキップされたら「実質的にポーリング間隔が伸びている」とみなして
// 警告ログ・異常アラート（/api/admin/alerts の pipelineSkipped）に出すか。
const SKIP_ALERT_THRESHOLD = 3;

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
  // scheduler.pipeline は runPipeline() 1回分（全ステップ）をまとめて計測する、
  // 個々のステップ（pipeline.*）とは別のジョブ。多重実行ガードでのスキップは
  // このジョブに対して recordSkip() される。
  'scheduler.pipeline',
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
    history: [],
    // スキップ（前回の実行が長引いていて今回の周期が実行されなかった回数）の記録。
    // track() が呼ばれる＝実際に実行された、なので開始時に連続スキップ数をリセットする。
    skipCount: 0,
    consecutiveSkips: 0,
    lastSkippedAt: null,
    // 連続スキップが始まった時刻。異常アラートのkeyに使い、スキップが続く間は
    // 同じ異常インスタンスとして扱う（解消してから再発したら新しいkeyになる）。
    skipStreakStartedAt: null
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
  // 実際に実行されたので、連続スキップの記録は途切れる。
  state.consecutiveSkips = 0;
  state.skipStreakStartedAt = null;
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

/**
 * 多重実行ガード（pipelineRunning等）で今回の周期がスキップされたことを記録する。
 * 「1回スキップ」自体は前回処理が長引いただけで正常な範囲だが、これがN回連続すると
 * 実質的なポーリング間隔が伸び続けている（＝処理が詰まって戻ってこない）兆候なので、
 * SKIP_ALERT_THRESHOLD到達時に警告ログを出す。異常アラートへの反映は呼び出し側
 * （/api/admin/alerts）が getJobStatus().consecutiveSkips を見て行う。
 */
function recordSkip(name) {
  const state = getOrCreate(name);
  state.skipCount += 1;
  if (state.consecutiveSkips === 0) {
    state.skipStreakStartedAt = new Date();
  }
  state.consecutiveSkips += 1;
  state.lastSkippedAt = new Date();
  if (state.consecutiveSkips >= SKIP_ALERT_THRESHOLD) {
    console.warn(
      `[jobMonitor] ${name} が ${state.consecutiveSkips} 回連続でスキップされました` +
      `（前回の実行が完了しないまま次の周期に入っています。実質的なポーリング間隔が伸びています）。`
    );
  }
  return state.consecutiveSkips;
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
    history: state.history,
    skipCount: state.skipCount,
    consecutiveSkips: state.consecutiveSkips,
    lastSkippedAt: state.lastSkippedAt
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
    history: state.history,
    skipCount: state.skipCount,
    consecutiveSkips: state.consecutiveSkips,
    lastSkippedAt: state.lastSkippedAt,
    skipStreakStartedAt: state.skipStreakStartedAt
  };
}

module.exports = { track, recordSkip, getJobsStatus, getJobStatus, JOB_NAMES, SKIP_ALERT_THRESHOLD };
