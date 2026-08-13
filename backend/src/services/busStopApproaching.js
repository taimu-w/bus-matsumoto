// バス停検索機能（/busstop）専用：接近中のバス情報（補完仕様書 3.5）
//
// GTFSの時刻表（gtfsTimetable.js）とリアルタイム運行状況（DBのdaily_trips）は
// データ経路が独立している（README/CLAUDE.md参照）。ここでは便詳細ページの
// リアルタイム切替と同じ橋渡し（realtimeTripLookup.js）を使って、
// 「今日・このバス停を通る便のうち現在時刻±30分以内のもの」を一覧化し、
// 当日DB上で運行中の便があれば現在地・残り停留所数・予測到着時刻を重ねる。
//
// 標柱（platform）ごとの区別はDB側の stops テーブルが持たないため（CLAUDE.md既知の注意点）、
// バス停グループ名（＝GTFS stop_name。同一グループ内の標柱は仕様上すべて同名）での
// 名前一致だけを行う。一致しない場合は定刻表示のみ（soft-fail、仕様書5.2）。
const { getStopTimetable, todayString } = require('./gtfsTimetable');
const { findLiveAssignment, buildBusEntry } = require('./realtimeTripLookup');
const { qualifyRouteId } = require('./gtfsFeedManager');
const { nowInTokyo } = require('../utils/time');

const APPROACH_WINDOW_SECONDS = 30 * 60;

/**
 * @param {string} stopKey バス停検索のstopKey（/busstop/{stopKey}と同じ）
 * @param {{date?: string, platform?: string}} options
 * @returns {Promise<null|{stopId: string, stopName: string, approachingBuses: object[]}>}
 */
async function getApproachingBuses(stopKey, { date, platform } = {}) {
  const serviceDate = date && String(date).trim() ? date : todayString();
  const timetable = await getStopTimetable(stopKey, { date: serviceDate, platform });
  if (!timetable) return null;

  const approachingBuses = [];

  // 「現在接近中」は本日以外に意味を持たないため、他日指定時は空配列を返す。
  if (serviceDate === todayString()) {
    const t = nowInTokyo();
    const nowSeconds = t.hour * 3600 + t.minute * 60 + t.second;

    const departures = timetable.hours
      .flatMap((block) => block.departures)
      .filter((d) => d.seconds >= nowSeconds && d.seconds <= nowSeconds + APPROACH_WINDOW_SECONDS)
      .sort((a, b) => a.seconds - b.seconds);

    const built = [];
    for (const departure of departures) {
      const entry = await buildApproachingEntry(departure, timetable.stop.stopName);
      built.push({ entry, departureSeconds: departure.seconds });
    }

    // 一覧は「接近時間が速い順」に並べる。リアルタイム情報がある便は定刻+遅延分（delayMinutesは
    // computeDelayMinutes()により0以上のみ）を実質の到着予測とみなし、無い便は定刻のまま比較する。
    // predictedArrivalTimeの文字列同士を比較しないのは、minutesToTimeStr()が24時で巻き戻るため
    // 日付跨ぎの便で誤った順序になり得るため（定刻ベースのdepartureSecondsは巻き戻らない）。
    built.sort((a, b) => {
      const etaA = a.departureSeconds + (a.entry.hasRealtime ? (a.entry.delayMinutes || 0) * 60 : 0);
      const etaB = b.departureSeconds + (b.entry.hasRealtime ? (b.entry.delayMinutes || 0) * 60 : 0);
      return etaA - etaB;
    });

    approachingBuses.push(...built.map((b) => b.entry));
  }

  return {
    stopId: timetable.stop.stopKey,
    stopName: timetable.stop.stopName,
    approachingBuses
  };
}

async function buildApproachingEntry(departure, targetStopName) {
  const entry = {
    feedId: departure.feedId,
    routeId: departure.routeId,
    routeName: departure.routeName,
    routeColor: departure.routeColor,
    routeTextColor: departure.routeTextColor,
    tripId: departure.tripId,
    // 便詳細ページURL（/timetable/trips/{feedId}/{routeId}/{tripId}/{tripDepartureTime}）の組み立てに必要。
    // timetable.jsのtripUrl()と同じ形式（formatHhmm済み、例:"0805"）。
    tripDepartureTime: departure.tripDepartureTime,
    headsign: departure.headsign,
    scheduledArrivalTime: departure.time,
    hasRealtime: false,
    realtimeStatus: null,
    predictedArrivalTime: null,
    delayMinutes: null,
    currentStopName: null,
    remainingStops: null,
    vehicleId: null,
    lat: null,
    lng: null
  };

  try {
    const match = await findLiveAssignment(departure.feedId, departure.routeId, departure.tripId, departure.tripDepartureTime);
    if (!match) return entry;

    const bus = await buildBusEntry(match, qualifyRouteId(departure.routeId, departure.feedId), departure.routeName);
    const targetIndex = bus.stops.findIndex((s) => s.name === targetStopName);
    if (targetIndex === -1) return entry;

    let lastArrivedIndex = -1;
    bus.stops.forEach((s, i) => { if (s.status === '到着済') lastArrivedIndex = i; });
    const targetStop = bus.stops[targetIndex];

    entry.hasRealtime = true;
    entry.realtimeStatus = 'running';
    entry.predictedArrivalTime = targetStop.predictedTime || targetStop.scheduledTime || null;
    entry.delayMinutes = targetStop.predictedDelayMinutes ?? null;
    entry.currentStopName = lastArrivedIndex >= 0 ? bus.stops[lastArrivedIndex].name : null;
    entry.remainingStops = Math.max(targetIndex - lastArrivedIndex, 0);
    entry.vehicleId = match.car_id;
    entry.lat = bus.lat;
    entry.lng = bus.lng;
  } catch (err) {
    console.error('[busStopApproaching] リアルタイム突合エラー:', err);
  }

  return entry;
}

module.exports = { getApproachingBuses };
