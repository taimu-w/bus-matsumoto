// GASの ReNewLocation -> SortCarID -> StartBusiness -> departure -> planmaking
// -> specialbus -> pass -> delay という連鎖実行を、同じ順序でそのまま再現する。
const { isNightTime } = require('../utils/time');
const { fetchLocation } = require('../services/locationFetcher');
const { sortCarId } = require('../services/vehicleAssigner');
const { startBusiness } = require('../services/businessStart');
const { departure } = require('../services/departure');
const { planMaking } = require('../services/planMaking');
const { specialBus } = require('../services/specialBus');
const { pass } = require('../services/passDetection');
const { delayCalc } = require('../services/delayCalc');

async function runPipeline() {
  if (isNightTime()) {
    console.log('[pipeline] 深夜帯のため処理を停止します。');
    return;
  }

  try {
    await fetchLocation();
    await sortCarId();
    await startBusiness();
    await departure();
    await planMaking();
    await specialBus();
    await pass();
    await delayCalc();
  } catch (err) {
    console.error('[pipeline] 実行エラー:', err);
  }
}

module.exports = { runPipeline };
