// GASのトリガー構成（メインチェーンを短間隔で実行 / finish()を独立して10分おきに実行）を再現する。
const { runPipeline } = require('./pipeline');
const { finishTrips } = require('../services/finishService');
const { isNightTime } = require('../utils/time');

let pipelineTimer = null;
let finishTimer = null;
let pipelineRunning = false;
let finishRunning = false;

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
        console.log(`[scheduler] finish: ${result.finished} 件の運行を終了処理しました。`);
      }
    } catch (err) {
      console.error('[scheduler] finish実行エラー:', err);
    } finally {
      finishRunning = false;
    }
  }, 1* 60 * 1000);

  console.log(`[scheduler] スケジューラを起動しました（メイン: ${pollSeconds}秒間隔 / 終了判定: 10分間隔）`);

  // 起動直後に一度実行しておく
  runPipeline();
}

function stop() {
  if (pipelineTimer) clearInterval(pipelineTimer);
  if (finishTimer) clearInterval(finishTimer);
}

module.exports = { start, stop };
