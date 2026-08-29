// 便起点方式のメイン処理チェーン。
//
// 旧方式（GPS → 営業開始 → 出発 → 時刻表照合）から、
// GTFS便を先に生成して始発時刻に車両を割り当てる方式へ変更した。
// 各ステップは前段の結果（DBの状態）を前提にしているため、順序を変えると壊れる。
const { isNightTime } = require('../utils/time');
const { fetchLocation } = require('../services/locationFetcher');
const { sortCarId } = require('../services/vehicleAssigner');
const { ensureDailyTrips } = require('../services/dailyTripBuilder');
const { assignPendingTrips, reassignOrphanTrips } = require('../services/tripAssignment');
const { pass } = require('../services/passDetection');
const { delayCalc } = require('../services/delayCalc');
const { updateAllGtfsFeeds } = require('../services/gtfsFeedManager');
const { computeAndStoreAllArrivals } = require('../services/etaPredictor');
const { refreshRuntimeSettingsCache, getRuntimeSetting } = require('../services/runtimeSettings');
const jobMonitor = require('../services/jobMonitor');

async function runPipeline() {
  // 管理画面から編集可能な運用設定（判定半径・タイムアウト等）を最新化する。
  // 以降のステップ（tripAssignment.js・passDetection.js等）はここで読み込んだ値を
  // 同期的に参照するため、各ステップの実行前に一度だけ読み込めば良い。
  await refreshRuntimeSettingsCache();

  // 深夜帯はGPSの取り込みと運行処理を止めるが、当日便の生成と車両割り当ては止めない。
  // 最も早い便は5:40発で、深夜帯が明ける前に始発時刻が来るため
  // （深夜帯にスキップすると当日便が未生成のまま始発時刻を過ぎてしまう）。
  const night = isNightTime(getRuntimeSetting('NIGHT_START'), getRuntimeSetting('NIGHT_END'));

  try {
    // GTFSフィードを定期的に更新（失敗してもパイプライン全体は継続）
    try {
      await jobMonitor.track('pipeline.gtfsUpdate', updateAllGtfsFeeds);
    } catch (err) {
      console.error('[pipeline] GTFSフィード更新エラー（継続）:', err.message);
    }

    // ① 当日の運行便を生成（生成済みなら即リターン）
    await jobMonitor.track('pipeline.ensureDailyTrips', ensureDailyTrips);

    if (night) {
      console.log('[pipeline] 深夜帯のため運行処理をスキップします（当日便の生成のみ実施）。');
      return;
    }

    await jobMonitor.track('pipeline.fetchLocation', fetchLocation);             // ② 位置情報の取得
    await jobMonitor.track('pipeline.sortCarId', sortCarId);                     // ③ 車両別ログへの振り分け・車両の登録
    await jobMonitor.track('pipeline.assignPendingTrips', assignPendingTrips);   // ④ 始発時刻が来た便への担当・候補の割り当て
    await jobMonitor.track('pipeline.reassignOrphanTrips', reassignOrphanTrips); // ⑤ 担当車両が終了した便の再割り当て
    await jobMonitor.track('pipeline.pass', pass);                               // ⑥ 通過判定・欠落補完（担当・候補すべて）
    await jobMonitor.track('pipeline.delayCalc', delayCalc);                     // ⑦ 遅延計算（担当・候補すべて）

    // ⑧ 全active割り当てのETAを一括計算しtrip_arrival_predictionsへ保存
    //    （APIはここから読むだけ。詳細は docs/eta-prediction-algorithm.md）
    await jobMonitor.track('pipeline.computeArrivals', computeAndStoreAllArrivals);
  } catch (err) {
    console.error('[pipeline] 実行エラー:', err);
  }
}

module.exports = { runPipeline };
