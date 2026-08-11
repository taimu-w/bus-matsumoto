// 運賃データ（GTFSの fare_attributes.txt / fare_rules.txt）のインデックスと照会。
// 経路検索の運賃表示（経路検索機能_改善仕様書 4章）専用。
//
// なぜ独立モジュールなのか:
//   運賃ファイルは任意ファイル（持たないフィードがあり得る）であり、
//   時刻表検索のインデックス（gtfsTimetable.js）とはライフサイクルこそ揃えるが、
//   「無ければ運賃不明として機能を成立させる」という失敗の扱いが違う。
//   時刻表検索・バス停検索の挙動へ一切影響を与えないよう、読み込みも索引も分けている。
//
// GTFS-JPの運賃データの形:
//   fare_attributes.txt : fare_id, price, currency_type, payment_method, transfers
//   fare_rules.txt      : fare_id, route_id, origin_id, destination_id (, contains_id)
//   origin_id / destination_id は stops.txt の zone_id を指す
//   （松本市のフィードでは zone_id = stop_id だが、仕様どおり zone_id 経由で引く）。
const fs = require('fs');
const path = require('path');
const { getGtfsDir } = require('./gtfsFeedManager');
const { readCsvIfExists } = require('../utils/csv');

// 時刻表インデックスと同じ再構築間隔。GTFS更新時は invalidateFareIndex() で即時無効化される。
const INDEX_TTL_MS = 30 * 60 * 1000;

let cachedIndex = null;
let buildingPromise = null;

/**
 * 1フィードぶんの運賃データを読み込む。ファイルが無い場合は null を返す（エラーにしない）。
 */
function loadFeedFares(feedId) {
  const dir = getGtfsDir(feedId);
  if (!fs.existsSync(path.join(dir, 'fare_attributes.txt'))) return null;

  const fareById = new Map();
  for (const row of readCsvIfExists('fare_attributes.txt', feedId)) {
    const fareId = (row.fare_id || '').trim();
    if (!fareId) continue;
    const price = Number.parseInt(row.price, 10);
    if (!Number.isFinite(price)) continue;
    fareById.set(fareId, {
      fareId,
      price,
      currency: (row.currency_type || 'JPY').trim() || 'JPY',
      paymentMethod: Number.parseInt(row.payment_method || '0', 10) || 0,
      // 空文字は「乗継回数無制限」を意味するGTFS仕様。今回の表示では使わないが保持しておく。
      transfers: (row.transfers || '').trim()
    });
  }
  if (fareById.size === 0) return null;

  // route_id ごとにルールをまとめる。route_id が空のルールは全路線共通（キーは空文字）。
  const rulesByRoute = new Map();
  let ruleCount = 0;
  for (const row of readCsvIfExists('fare_rules.txt', feedId)) {
    const fareId = (row.fare_id || '').trim();
    if (!fareId || !fareById.has(fareId)) continue;
    const routeId = (row.route_id || '').trim();
    const rule = {
      fareId,
      originId: (row.origin_id || '').trim(),
      destinationId: (row.destination_id || '').trim(),
      containsId: (row.contains_id || '').trim()
    };
    if (!rulesByRoute.has(routeId)) rulesByRoute.set(routeId, []);
    rulesByRoute.get(routeId).push(rule);
    ruleCount += 1;
  }

  // stop_id → zone_id
  const zoneByStopId = new Map();
  for (const row of readCsvIfExists('stops.txt', feedId)) {
    const stopId = (row.stop_id || '').trim();
    if (!stopId) continue;
    const zoneId = (row.zone_id || '').trim();
    if (zoneId) zoneByStopId.set(stopId, zoneId);
  }

  return { feedId, fareById, rulesByRoute, zoneByStopId, ruleCount };
}

async function buildIndex() {
  const startedAt = Date.now();
  // 有効フィードの一覧は時刻表インデックスと同じ判定を使う（DBが落ちていてもディスクから推定される）。
  const { getIndex: getTimetableIndex } = require('./gtfsTimetable');
  let feedIds = [];
  try {
    const timetableIndex = await getTimetableIndex();
    feedIds = timetableIndex.feedIds.slice();
  } catch (err) {
    console.warn('[gtfsFare] フィード一覧の取得に失敗したため運賃を無効にします:', err.message);
  }

  const byFeed = new Map();
  for (const feedId of feedIds) {
    try {
      const loaded = loadFeedFares(feedId);
      if (loaded) byFeed.set(feedId, loaded);
    } catch (err) {
      console.error(`[gtfsFare] feed=${feedId} の運賃読み込みに失敗（このフィードは運賃不明として継続）:`, err.message);
    }
  }

  const totalRules = Array.from(byFeed.values()).reduce((sum, f) => sum + f.ruleCount, 0);
  console.log(
    `[gtfsFare] 運賃インデックス構築完了: ${byFeed.size}フィード / 運賃ルール${totalRules}件 (${Date.now() - startedAt}ms)`
  );
  return { builtAt: Date.now(), byFeed };
}

async function getFareIndex() {
  if (cachedIndex && Date.now() - cachedIndex.builtAt < INDEX_TTL_MS) return cachedIndex;
  if (buildingPromise) return buildingPromise;

  buildingPromise = buildIndex()
    .then((index) => {
      cachedIndex = index;
      return index;
    })
    .finally(() => {
      buildingPromise = null;
    });

  return buildingPromise;
}

/** GTFS更新後に作り直させる（gtfsFeedManager から呼ばれる）。 */
function invalidateFareIndex() {
  cachedIndex = null;
}

/**
 * ルールの限定度。より限定的なルールを優先して採用する（仕様書 4.3）。
 *  3: 出発ゾーン・到着ゾーンの両方を指定
 *  2: どちらか一方だけ指定
 *  1: どちらも指定なし（路線単位の均一運賃など）
 */
function ruleSpecificity(rule) {
  const hasOrigin = Boolean(rule.originId);
  const hasDestination = Boolean(rule.destinationId);
  if (hasOrigin && hasDestination) return 3;
  if (hasOrigin || hasDestination) return 2;
  return 1;
}

/**
 * 1区間ぶんの運賃を求める。
 *
 * @param {object} index getFareIndex() の戻り値
 * @param {string} feedId
 * @param {string} routeId GTFS内のroute_id（feedIdプレフィックスを付けない生のID）
 * @param {string} boardStopId 乗車する標柱のstop_id
 * @param {string} alightStopId 降車する標柱のstop_id
 * @returns {null|{price:number, currency:string, fareId:string, specificity:number}}
 *          該当ルールが無ければ null（＝運賃不明。推測はしない）
 */
function lookupFare(index, feedId, routeId, boardStopId, alightStopId) {
  const feed = index && index.byFeed.get(feedId);
  if (!feed) return null;

  const originZone = feed.zoneByStopId.get(boardStopId) || '';
  const destinationZone = feed.zoneByStopId.get(alightStopId) || '';

  const candidates = [
    ...(feed.rulesByRoute.get(routeId) || []),
    ...(feed.rulesByRoute.get('') || []) // route_id 未指定＝全路線共通
  ];

  let best = null;
  for (const rule of candidates) {
    // 空欄は「何にでも一致する」（GTFS仕様）。
    if (rule.originId && rule.originId !== originZone) continue;
    if (rule.destinationId && rule.destinationId !== destinationZone) continue;

    const fare = feed.fareById.get(rule.fareId);
    if (!fare) continue;

    const specificity = ruleSpecificity(rule);
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity && fare.price < best.price)
    ) {
      best = { price: fare.price, currency: fare.currency, fareId: fare.fareId, specificity };
    }
  }

  return best;
}

/** そのフィードの運賃データが使えるか。 */
function hasFareData(index, feedId) {
  return Boolean(index && index.byFeed.has(feedId));
}

module.exports = {
  getFareIndex,
  invalidateFareIndex,
  lookupFare,
  hasFareData
};
