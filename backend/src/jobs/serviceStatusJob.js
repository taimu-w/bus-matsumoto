// アルピコ交通の運行状況ページを1時間ごとにスクレイピングして再取得するジョブ。
// メインのGPS運行パイプライン（jobs/scheduler.js）とは無関係な、独立したタイマー。
const { scrapeAndStore } = require('../services/serviceStatusScraper');

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
  const intervalMin = parseInt(process.env.SERVICE_STATUS_POLL_INTERVAL_MIN || '60', 10);
  timer = setInterval(runOnce, intervalMin * 60 * 1000);
  console.log(`[serviceStatusJob] 運行状況スクレイピングを開始しました（${intervalMin}分間隔）`);
  runOnce();
}

function stop() {
  if (timer) clearInterval(timer);
}

module.exports = { start, stop };
