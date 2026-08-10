// 定期実行の管理。メインパイプラインと、独立した運行終了バッチの2本立て。
const { runPipeline } = require('./pipeline');
const { finishTrips } = require('../services/finishService');
const { purgeOldDailyTrips } = require('../services/dailyTripBuilder');
const { purgeOldGpsLogs } = require('../services/vehicleAssigner');
const { isNightTime } = require('../utils/time');

let pipelineTimer = null;
let finishTimer = null;
let cleanupTimer = null;
let pipelineRunning = false;
let finishRunning = false;
let cleanupRunning = false;

function start() {
  const pollSeconds = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10);

  pipelineTimer = setInterval(async () => {
    if (pipelineRunning) return; // 前回処理が長引いている場合は多重実行を防止（GASのLockService相当）
    pipelineRunning = true;
    try {
      await runPipeline();
    } finally {
      pipelineRunning = false;
    }
  }, pollSeconds * 1000);

  finishTimer = setInterval(async () => {
    if (finishRunning) return;
    finishRunning = true;
    try {
      if (isNightTime()) {
        console.log('[scheduler] 深夜帯のため finish 停止');
        return;
      }
      const result = await finishTrips();
      if (result.finished > 0) {
        console.log(`[scheduler] finish: ${result.finished} 件の割り当てを終了処理しました。`);
      }
    } catch (err) {
      console.error('[scheduler] finish実行エラー:', err);
    } finally {
      finishRunning = false;
    }
  }, 1 * 60 * 1000);

  // 保持期間を過ぎたデータの掃除（1時間ごと）。
  // 便起点方式では車両行を削除しなくなったため、GPSログの掃除が必要になる。
  cleanupTimer = setInterval(async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      await purgeOldGpsLogs();
      await purgeOldDailyTrips();
    } catch (err) {
      console.error('[scheduler] クリーンアップ実行エラー:', err);
    } finally {
      cleanupRunning = false;
    }
  }, 60 * 60 * 1000);

  console.log(
    `[scheduler] スケジューラを起動しました（メイン: ${pollSeconds}秒間隔 / 終了判定: 1分間隔 / 掃除: 1時間間隔）`
  );

  // 起動直後に一度実行しておく
  runPipeline();
}

function stop() {
  if (pipelineTimer) clearInterval(pipelineTimer);
  if (finishTimer) clearInterval(finishTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
}

module.exports = { start, stop };
