// 定期実行の管理。メインパイプラインと、独立した運行終了バッチの2本立て。
const { runPipeline } = require('./pipeline');
const { finishTrips, purgeOldCompletedTrips } = require('../services/finishService');
const { purgeOldDailyTrips } = require('../services/dailyTripBuilder');
const { purgeOldGpsLogs } = require('../services/vehicleAssigner');
const { isNightTime } = require('../utils/time');
const { getRuntimeSetting } = require('../services/runtimeSettings');
const jobMonitor = require('../services/jobMonitor');

let pipelineTimer = null;
let finishTimer = null;
let cleanupTimer = null;
let pipelineRunning = false;
let finishRunning = false;
let cleanupRunning = false;

function start() {
  // 管理画面から変更しても、setIntervalの間隔はこの起動時点の値で固定されるため、
  // 反映には再起動が必要（config/runtimeSettingsCatalog.jsのrequiresRestart）。
  const pollSeconds = getRuntimeSetting('POLL_INTERVAL_SECONDS');

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
      if (isNightTime(getRuntimeSetting('NIGHT_START'), getRuntimeSetting('NIGHT_END'))) {
        console.log('[scheduler] 深夜帯のため finish 停止');
        return;
      }
      const result = await jobMonitor.track('scheduler.finishTrips', finishTrips);
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
      await jobMonitor.track('scheduler.cleanup', async () => {
        await purgeOldGpsLogs();
        await purgeOldDailyTrips();
        await purgeOldCompletedTrips();
      });
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
