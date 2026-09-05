// 便起点方式のメイン処理チェーン。
//
// 旧方式（GPS → 営業開始 → 出発 → 時刻表照合）から、
// GTFS便を先に生成して始発時刻に車両を割り当てる方式へ変更した。
// 各ステップは前段の結果（DBの状態）を前提にしているため、順序を変えると壊れる。
const { isNightTime } = require('../utils/time');
const { fetchLocation } = require('../services/locationFetcher');
const { sortCarId } = require('../services/vehicleAssigner');
const { ensureDailyTrips } = require('../services/dailyTripBuilder');
const { assignPendingTrips, reassignOrphanTrips, countDuePendingTrips } = require('../services/tripAssignment');
const { pass } = require('../services/passDetection');
const { delayCalc } = require('../services/delayCalc');
const { updateAllGtfsFeeds } = require('../services/gtfsFeedManager');
const { computeAndStoreAllArrivals } = require('../services/etaPredictor');
const { refreshRuntimeSettingsCache, getRuntimeSetting } = require('../services/runtimeSettings');
const { refreshDirectionRulesCache } = require('../services/directionRules');
const jobMonitor = require('../services/jobMonitor');

async function runPipeline() {
  // 管理画面から編集可能な運用設定（判定半径・タイムアウト等）と方向マッピングを最新化する。
  // 以降のステップ（locationFetcher.js・tripAssignment.js・passDetection.js等）はここで
  // 読み込んだ値を同期的に参照するため、各ステップの実行前に一度だけ読み込めば良い。
  await refreshRuntimeSettingsCache();
  await refreshDirectionRulesCache();

  // 深夜帯はGPSの取り込み（②）以降の運行処理を止める。①当日便の生成だけは止めない
  // （深夜帯にスキップすると当日便が未生成のまま始発時刻を過ぎてしまうため）。
  //
  // ただし「始発時刻が来ているのにまだ割り当て判定を受けていない便」がある間は止めない。
  // 車両割り当て（④）はGPS取り込み（②③）の結果を前提にしているので、深夜帯だからと
  // 一律に抜けると、その時間帯にかかる便の割り当てが**黙って**行われないまま
  // pending → 運行日終了で消えてしまう。既定値（深夜帯 23:00〜05:00・最早便 5:40発・
  // 最終停車 22:45）ではこの条件に当てはまる便は存在せず、挙動は従来と同じ。
  // NIGHT_END を早朝便の始発より後ろへ動かした場合などに効く安全弁である。
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
      const duePending = await countDuePendingTrips();
      if (duePending === 0) {
        console.log('[pipeline] 深夜帯のため運行処理をスキップします（当日便の生成のみ実施）。');
        return;
      }
      console.warn(
        `[pipeline] 深夜帯ですが、始発時刻が到来した未割り当ての便が ${duePending} 件あるため運行処理を継続します。` +
        `（深夜帯の設定 NIGHT_START/NIGHT_END が運行時間帯に食い込んでいる可能性があります）`
      );
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
