// アルピコ交通の運行状況ページを1時間ごとにスクレイピングして再取得するジョブ。
// メインのGPS運行パイプライン（jobs/scheduler.js）とは無関係な、独立したタイマー。
const { scrapeAndStore } = require('../services/serviceStatusScraper');
const { getRuntimeSetting } = require('../services/runtimeSettings');

let timer = null;
let running = false;

async function runOnce() {
  if (running) return;
  running = true;
  try {
    await scrapeAndStore();
    console.log('[serviceStatusJob] アルピコ運行状況を更新しました。');
  } catch (err) {
    console.error('[serviceStatusJob] スクレイピングに失敗しました:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  // 管理画面から変更しても、setIntervalの間隔はこの起動時点の値で固定されるため、
  // 反映には再起動が必要（config/runtimeSettingsCatalog.jsのrequiresRestart）。
  const intervalMin = getRuntimeSetting('SERVICE_STATUS_POLL_INTERVAL_MIN');
  timer = setInterval(runOnce, intervalMin * 60 * 1000);
  console.log(`[serviceStatusJob] 運行状況スクレイピングを開始しました（${intervalMin}分間隔）`);
  runOnce();
}

function stop() {
  if (timer) clearInterval(timer);
}

module.exports = { start, stop };
