/**
 * 外形監視・コンテナオーケストレータ（docker-compose の healthcheck 等）向けの
 * 軽量ヘルスチェック（docs/system-review-2026-09.md D-8）。
 *
 * 返すのは3点だけ:
 *   - db       … DB接続（`feeds` の最終取得時刻を1本引くついでに疎通確認）
 *   - pipeline … メインパイプライン1周期（`scheduler.pipeline`）が直近で完了しているか
 *   - gtfs     … GTFSフィードの最終取得がどれくらい前か（情報のみ。全体判定には使わない）
 *
 * DB問い合わせは1本、jobMonitor はプロセス内メモリの読み取りだけなので、
 * 20秒ポーリングのホットパスより十分軽い。`/healthz` は認証・レートリミット・
 * 閲覧数カウントのいずれの対象でもない（server.js でミドルウェアより手前に置く）。
 */
const pool = require('../config/db');
const jobMonitor = require('./jobMonitor');

// 正の整数の環境変数を読む。未設定・0以下・数値でなければ既定値へ落とす。
function positiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// scheduler.pipeline（1周期まるごと）がこの秒数を超えて完了していなければ「詰まっている」とみなす。
// 既定のポーリング間隔60秒＋1周期の所要時間を見込んで5分（＝5周期ぶん）。深夜帯でも
// ⓪①は毎周期回り scheduler.pipeline の計測自体は続くため、この前提は崩れない。
const PIPELINE_STALE_SEC = positiveIntEnv('HEALTHZ_PIPELINE_STALE_SEC', 300);
// GTFSフィードの最終取得がこの秒数より古ければ stale フラグを立てる（あくまで情報。
// GTFS_UPDATE_INTERVAL_MIN やフィード側の都合で取得間隔が開くことはあり、それ自体は
// 稼働不能ではないため、全体の健全性判定には用いない）。既定3時間。
const GTFS_STALE_SEC = positiveIntEnv('HEALTHZ_GTFS_STALE_SEC', 3 * 60 * 60);
// DB問い合わせがこの時間で返らなければ「DB応答なし」とみなす（ヘルスチェック自体が
// 固まらないようにするため。プールが枯渇していると pool.query は既定で無限に待つ）。
const DB_TIMEOUT_MS = positiveIntEnv('HEALTHZ_DB_TIMEOUT_MS', 3000);

/** 過去時刻から現在までの経過秒。null/不正値は null。 */
function ageSeconds(since, nowMs) {
  if (!since) return null;
  const t = since instanceof Date ? since.getTime() : new Date(since).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

async function queryWithTimeout(sql) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DB応答なし（${DB_TIMEOUT_MS}ms）`)), DB_TIMEOUT_MS);
  });
  // タイムアウトが勝ったときも pool.query 側の promise は後から必ず決着する。
  // 未処理のまま放置すると unhandledRejection になるので握りつぶす受け皿を付けておく。
  const query = pool.query(sql);
  query.catch(() => {});
  try {
    return await Promise.race([query, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @returns {{status:'ok'|'starting'|'unhealthy', healthy:boolean, uptimeSec:number, checks:object}}
 */
async function getHealth() {
  const nowMs = Date.now();
  const uptimeSec = Math.round(process.uptime());
  const checks = {};

  // --- DB疎通 ＆ GTFS鮮度（問い合わせ1本）---
  let gtfsLatest = null;
  try {
    const result = await queryWithTimeout(
      "SELECT max(last_fetched_at) AS gtfs_latest FROM feeds WHERE feed_type = 'gtfs'"
    );
    gtfsLatest = result.rows[0] ? result.rows[0].gtfs_latest : null;
    checks.db = { ok: true };
  } catch (err) {
    checks.db = { ok: false, error: err && err.message ? err.message : String(err) };
  }

  // --- 直近パイプライン完了 ---
  const pipelineJob = jobMonitor.getJobStatus('scheduler.pipeline');
  const finishedAgeSec = pipelineJob ? ageSeconds(pipelineJob.lastFinishedAt, nowMs) : null;
  if (finishedAgeSec === null) {
    // まだ1周期も完了していない。起動直後は正常（起動猶予）だが、猶予を過ぎても
    // 1周期回っていなければスケジューラが動いていない兆候なので異常に倒す。
    const withinGrace = uptimeSec <= PIPELINE_STALE_SEC;
    checks.pipeline = {
      ok: withinGrace ? null : false,
      note: withinGrace
        ? 'まだ1周期も完了していません（起動直後）'
        : `起動から${uptimeSec}秒経っても1周期も完了していません`,
      consecutiveSkips: pipelineJob ? pipelineJob.consecutiveSkips : 0
    };
  } else {
    checks.pipeline = {
      ok: finishedAgeSec <= PIPELINE_STALE_SEC,
      lastFinishedAgeSec: finishedAgeSec,
      staleThresholdSec: PIPELINE_STALE_SEC,
      consecutiveSkips: pipelineJob.consecutiveSkips
    };
  }

  // --- GTFS鮮度（情報のみ）---
  const gtfsAgeSec = ageSeconds(gtfsLatest, nowMs);
  checks.gtfs = {
    lastFetchedAgeSec: gtfsAgeSec,
    stale: gtfsAgeSec === null ? null : gtfsAgeSec > GTFS_STALE_SEC,
    staleThresholdSec: GTFS_STALE_SEC
  };

  const healthy = checks.db.ok === true && checks.pipeline.ok !== false;
  const status = !healthy ? 'unhealthy' : (checks.pipeline.ok === null ? 'starting' : 'ok');
  return { status, healthy, uptimeSec, checks };
}

module.exports = { getHealth, PIPELINE_STALE_SEC, GTFS_STALE_SEC, DB_TIMEOUT_MS };
