// 経路検索（乗換案内）エンジン。経路検索機能_改善仕様書 5章の実装。
//
// 【設計の要点】
// 探索の土台は時刻表検索と同じGTFSインメモリインデックス（gtfsTimetable.js）である。
// 旧実装はDBの daily_trips / stops を見ていたため、
//   ・当日ぶんの便しか無く日付を選べない
//   ・GTFSのstop_id・zone_idが無く、運賃も /busstop へのリンクも作れない
//   ・バス停名の完全一致でしかつながらず、経路が見つからないことが多い
// という構造的な限界があった（仕様書1章）。
//
// リアルタイム（遅延・予測・車両位置）は探索結果が確定したあとに
// realtimeTripLookup.js 経由で重ねる。重ね合わせに失敗しても定刻で成立させる。
// これはバス停検索の「接近中のバス」（busStopApproaching.js）と同じ方針。
const {
  getIndex,
  getActiveServices,
  resolveGroup,
  searchStops,
  resolveHeadsign,
  formatHhmm,
  todayString,
  describeDateValidity
} = require('./gtfsTimetable');
const { expandFrequencies } = require('./gtfsFrequencies');
const { getFareIndex, lookupFare } = require('./gtfsFare');
const { haversineDistanceMeters } = require('../utils/geo');
const { findLiveAssignment, buildBusEntry } = require('./realtimeTripLookup');
const { getSuspendedRouteIdSet } = require('./realtimeSuspension');
const { qualifyRouteId } = require('./gtfsFeedManager');
const { nowInTokyo } = require('../utils/time');
const touristSpots = require('./touristSpots');

const DAY_SECONDS = 86400;

// --- 探索パラメータ ---
// 徒歩で乗り継げるとみなす距離。同名バス停でしか乗り換えられなかった旧実装に対し、
// 「道路の向かい側の別名バス停」などをつなぐための最重要パラメータ（仕様書7章）。
const WALK_RADIUS_METERS = 400;
const WALK_RADIUS_RELAXED_METERS = 800;
const WALK_SPEED_METERS_PER_MIN = 80;
const MIN_WALK_SECONDS = 60;
// 同一バス停での乗り継ぎに必要な最低の余裕時間
const MIN_TRANSFER_SECONDS = 60;
// ラウンド数 = 乗車回数。3なら乗換2回まで。
const MAX_ROUNDS = 3;
const MAX_ROUNDS_RELAXED = 4;
// 基準時刻から何秒先までの発車を探索対象にするか
const SEARCH_WINDOW_SECONDS = 6 * 3600;
const SEARCH_WINDOW_RELAXED_SECONDS = 30 * 3600;
// 複数候補を得るための再探索回数の上限
const MAX_ITERATIONS = 12;
// 「次の運行日」を何日先まで探すか
const NEXT_SERVICE_DAY_LOOKAHEAD = 7;
// あいまい一致（自由文字列）のときに候補とみなすバス停の数
const FUZZY_CANDIDATE_LIMIT = 3;
// 1経路あたりの徒歩の合計上限（これを超える案は、他に候補があれば出さない）
const MAX_TOTAL_WALK_MINUTES = 25;

// --- 詳細設定（利用者が指定できる探索条件）---
// いずれも「未指定＝これまでどおり」に落ちるようにしてある。
// 詳細設定は探索条件を**絞る方向にだけ**効かせる（段階的フォールバックが緩めた条件も、
// 利用者が明示した上限は超えない。「直通のみ」で探したのに乗換つきの案が出る、を防ぐため）。
const MAX_TRANSFERS_LIMIT = MAX_ROUNDS_RELAXED - 1;
const TRANSFER_MARGIN_MIN_MINUTES = 1;
const TRANSFER_MARGIN_MAX_MINUTES = 15;

// 観光スポット起点/終点の経路検索用（観光スポット情報_仕様書）。
// 検索半径は表示半径（touristSpots.js の近接表示半径）と揃えて500m程度。
const SPOT_LINK_RADIUS_METERS = 500;
const SPOT_LINK_RADIUS_RELAXED_METERS = 1200; // 半径内に1件もバス停が無い場合のフォールバック
const SPOT_LINK_STOP_LIMIT = 5; // 経路検索の対象バス停数の上限（RAPTORの負荷が半径内バス停数倍に膨らまないよう抑える）

// おすすめ判定の重み（仕様書 5.4）。乗換1回あたり5分、徒歩1秒あたり0.5秒ぶんの不利。
const TRANSFER_PENALTY_SECONDS = 300;
const WALK_PENALTY_RATIO = 0.5;

/* ==========================================================
 * 詳細設定（探索条件の絞り込み）
 * ========================================================== */

/**
 * 詳細設定を正規化する。**未指定・不正値は必ず既定（＝従来の挙動）へ落とす。**
 * 旧クライアント・既存のURL・お気に入りが何も付けずに叩いても挙動が変わらないようにするため。
 *
 * @param {object} options searchJourneys() のオプション（クエリ文字列由来の文字列も受ける）
 * @returns {{maxTransfers:number|null, allowWalkTransfer:boolean, minTransferSeconds:number, isDefault:boolean}}
 */
function normalizeSearchPreferences(options = {}) {
  // 乗換回数の上限。null＝指定なし（段階的フォールバックのラウンド数に任せる＝従来どおり）。
  let maxTransfers = null;
  const rawMaxTransfers = options.maxTransfers;
  if (rawMaxTransfers !== null && rawMaxTransfers !== undefined && String(rawMaxTransfers).trim() !== '') {
    const parsed = Number.parseInt(rawMaxTransfers, 10);
    if (Number.isFinite(parsed)) maxTransfers = Math.min(Math.max(parsed, 0), MAX_TRANSFERS_LIMIT);
  }

  // 徒歩での乗り継ぎを使うか。既定は使う。明示的に否定されたときだけ false。
  const rawAllowWalk = options.allowWalkTransfer;
  const allowWalkTransfer = !(
    rawAllowWalk === false || rawAllowWalk === 0 || rawAllowWalk === 'false' || rawAllowWalk === '0'
  );

  // 乗り換えに要求する最低の余裕時間（分）。未指定なら従来の MIN_TRANSFER_SECONDS。
  let minTransferSeconds = MIN_TRANSFER_SECONDS;
  const parsedMargin = Number.parseInt(options.minTransferMinutes, 10);
  if (Number.isFinite(parsedMargin)) {
    minTransferSeconds =
      Math.min(Math.max(parsedMargin, TRANSFER_MARGIN_MIN_MINUTES), TRANSFER_MARGIN_MAX_MINUTES) * 60;
  }

  return {
    maxTransfers,
    allowWalkTransfer,
    minTransferSeconds,
    isDefault:
      maxTransfers === null && allowWalkTransfer && minTransferSeconds === MIN_TRANSFER_SECONDS
  };
}

// 「詳細設定なし」の条件。0件のときに「設定が原因か」を切り分ける再探索で使う。
const DEFAULT_PREFERENCES = normalizeSearchPreferences({});

/** レスポンスに載せる形（画面が現在の条件を復元・表示するのに使う）。 */
function serializePreferences(preferences) {
  return {
    maxTransfers: preferences.maxTransfers,
    allowWalkTransfer: preferences.allowWalkTransfer,
    minTransferMinutes: Math.round(preferences.minTransferSeconds / 60),
    isDefault: preferences.isDefault
  };
}

/* ==========================================================
 * 探索用インデックス（GTFSインデックスから派生。builtAtが変われば作り直す）
 * ========================================================== */

let searchIndexCache = null;

// 徒歩接続を使わない探索用の空テーブル
const EMPTY_FOOTPATHS = new Map();

/**
 * 便の frequencies から「始発時刻のずれ（秒）」の一覧を求める。
 * frequencies を持たない便は [0]（＝実便そのもの1本）。
 */
function tripInstanceOffsets(trip) {
  if (!trip.frequencies || trip.frequencies.length === 0 || !Number.isFinite(trip.firstDepartureSeconds)) {
    return [0];
  }
  const instances = expandFrequencies(trip.frequencies, trip.firstDepartureSeconds);
  if (instances.length === 0) return [0];
  return instances.map((instance) => instance.startSeconds - trip.firstDepartureSeconds);
}

/**
 * バス停グループごとの「乗車できる発車」一覧を作る。
 * 1度作れば日付に依存しない（運行日の絞り込みは探索時に activeTripKeys で行う）。
 */
function buildBoardingsByGroup(index) {
  const boardingsByGroup = new Map();

  for (const [tripKey, stopTimes] of index.stopTimesByTrip.entries()) {
    const trip = index.trips.get(tripKey);
    if (!trip) continue;
    const offsets = tripInstanceOffsets(trip);

    for (const stopTime of stopTimes) {
      if (stopTime.pickupType === 1) continue; // 乗車できない停車
      if (!Number.isFinite(stopTime.departureSeconds)) continue;
      const stop = index.stops.get(stopTime.stopKey);
      if (!stop || !stop.groupKey) continue;

      if (!boardingsByGroup.has(stop.groupKey)) boardingsByGroup.set(stop.groupKey, []);
      const list = boardingsByGroup.get(stop.groupKey);
      for (const offset of offsets) {
        list.push({
          tripKey,
          tripIndex: stopTime.tripIndex,
          offsetSeconds: offset,
          departureSeconds: stopTime.departureSeconds + offset
        });
      }
    }
  }

  for (const list of boardingsByGroup.values()) {
    list.sort((a, b) => a.departureSeconds - b.departureSeconds);
  }
  return boardingsByGroup;
}

/**
 * バス停グループごとの「降車できる到着」一覧を作る（到着時刻指定＝逆向き探索用）。
 * buildBoardingsByGroup と対になるインデックスで、乗車可否ではなく降車可否で絞り、
 * 到着時刻（arrival_time が無ければ departure_time）で並べる。
 *
 * 絞り込み条件は runRaptor の降車判定（scanTrip）とまったく同じにしてある。
 * ここがずれると「出発時刻指定では出るのに到着時刻指定では出ない区間」が生まれる。
 */
function buildAlightingsByGroup(index) {
  const alightingsByGroup = new Map();

  for (const [tripKey, stopTimes] of index.stopTimesByTrip.entries()) {
    const trip = index.trips.get(tripKey);
    if (!trip) continue;
    const offsets = tripInstanceOffsets(trip);

    for (const stopTime of stopTimes) {
      if (stopTime.dropOffType === 1) continue; // 降車できない停車
      const arrivalRaw = Number.isFinite(stopTime.arrivalSeconds)
        ? stopTime.arrivalSeconds
        : stopTime.departureSeconds;
      if (!Number.isFinite(arrivalRaw)) continue;
      const stop = index.stops.get(stopTime.stopKey);
      if (!stop || !stop.groupKey) continue;

      if (!alightingsByGroup.has(stop.groupKey)) alightingsByGroup.set(stop.groupKey, []);
      const list = alightingsByGroup.get(stop.groupKey);
      for (const offset of offsets) {
        list.push({
          tripKey,
          tripIndex: stopTime.tripIndex,
          offsetSeconds: offset,
          arrivalSeconds: arrivalRaw + offset
        });
      }
    }
  }

  for (const list of alightingsByGroup.values()) {
    list.sort((a, b) => a.arrivalSeconds - b.arrivalSeconds);
  }
  return alightingsByGroup;
}

/**
 * 降車インデックスは到着時刻指定の検索でしか使わないため、初回に使うまで作らない。
 * （出発時刻指定だけを使っている利用者に、余分な構築コストとメモリを負わせない）
 */
function getAlightingsByGroup(searchIndex) {
  if (!searchIndex.alightingsByGroup) {
    const startedAt = Date.now();
    searchIndex.alightingsByGroup = buildAlightingsByGroup(searchIndex.index);
    console.log(
      `[gtfsRouteSearch] 到着時刻指定用インデックス構築完了: バス停${searchIndex.alightingsByGroup.size}件 ` +
      `(${Date.now() - startedAt}ms)`
    );
  }
  return searchIndex.alightingsByGroup;
}

/**
 * 徒歩接続表。全バス停の総当たりだと重いので、緯度経度のグリッドで近傍だけ比較する。
 * 半径ごとにキャッシュする（通常400m / フォールバック800m）。
 */
function buildFootpaths(index, radiusMeters) {
  const groups = Array.from(index.groups.values()).filter(
    (group) => Number.isFinite(group.lat) && Number.isFinite(group.lon)
  );

  // 1セルがおよそ radius 以上になるようにする（緯度1度≒111km）
  const cellSize = Math.max(radiusMeters / 111000, 0.002);
  const cells = new Map();
  const cellKey = (lat, lon) => `${Math.floor(lat / cellSize)}:${Math.floor(lon / cellSize)}`;
  for (const group of groups) {
    const key = cellKey(group.lat, group.lon);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(group);
  }

  const footpaths = new Map();
  for (const group of groups) {
    const baseLat = Math.floor(group.lat / cellSize);
    const baseLon = Math.floor(group.lon / cellSize);
    const neighbors = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const bucket = cells.get(`${baseLat + dy}:${baseLon + dx}`);
        if (bucket) neighbors.push(...bucket);
      }
    }

    const links = [];
    for (const other of neighbors) {
      if (other.groupKey === group.groupKey) continue;
      const distance = haversineDistanceMeters(group.lat, group.lon, other.lat, other.lon);
      if (distance > radiusMeters) continue;
      links.push({
        groupKey: other.groupKey,
        distanceMeters: Math.round(distance),
        walkSeconds: Math.max(
          MIN_WALK_SECONDS,
          Math.round((distance / WALK_SPEED_METERS_PER_MIN) * 60)
        )
      });
    }
    if (links.length > 0) {
      links.sort((a, b) => a.walkSeconds - b.walkSeconds);
      footpaths.set(group.groupKey, links);
    }
  }
  return footpaths;
}

/**
 * 探索用インデックスを取得する。GTFSインデックスが作り直されたら（builtAtが変化）
 * 派生データもすべて破棄する。
 */
async function getSearchIndex() {
  const index = await getIndex();
  if (searchIndexCache && searchIndexCache.builtAt === index.builtAt) return searchIndexCache;

  const startedAt = Date.now();
  const boardingsByGroup = buildBoardingsByGroup(index);
  searchIndexCache = {
    builtAt: index.builtAt,
    index,
    boardingsByGroup,
    // 到着時刻指定の検索で初めて使うときに構築する（getAlightingsByGroup）
    alightingsByGroup: null,
    footpathsByRadius: new Map(),
    // 日付ごとの「その日運行する便」の集合（最大8日ぶんを保持）
    activeTripsByDate: new Map()
  };
  console.log(
    `[gtfsRouteSearch] 探索インデックス構築完了: バス停${boardingsByGroup.size}件 (${Date.now() - startedAt}ms)`
  );
  return searchIndexCache;
}

function getFootpaths(searchIndex, radiusMeters) {
  // 半径0＝徒歩接続を使わない探索（「歩かない経路」を必ず候補に残すために使う）
  if (!radiusMeters) return EMPTY_FOOTPATHS;
  if (!searchIndex.footpathsByRadius.has(radiusMeters)) {
    const startedAt = Date.now();
    searchIndex.footpathsByRadius.set(radiusMeters, buildFootpaths(searchIndex.index, radiusMeters));
    console.log(`[gtfsRouteSearch] 徒歩接続表を構築: ${radiusMeters}m (${Date.now() - startedAt}ms)`);
  }
  return searchIndex.footpathsByRadius.get(radiusMeters);
}

/** その日に運行する便（tripKey）の集合。 */
function getActiveTripKeys(searchIndex, dateStr) {
  const cached = searchIndex.activeTripsByDate.get(dateStr);
  if (cached) return cached;

  const index = searchIndex.index;
  const activeServices = getActiveServices(index, dateStr);
  const activeTripKeys = new Set();
  for (const trip of index.trips.values()) {
    const feedServices = activeServices.get(trip.feedId);
    if (feedServices && feedServices.has(trip.serviceId)) activeTripKeys.add(trip.tripKey);
  }

  if (searchIndex.activeTripsByDate.size >= 8) {
    // 単純なFIFOで古い日付を捨てる
    const oldest = searchIndex.activeTripsByDate.keys().next().value;
    searchIndex.activeTripsByDate.delete(oldest);
  }
  searchIndex.activeTripsByDate.set(dateStr, activeTripKeys);
  return activeTripKeys;
}

/* ==========================================================
 * 日付ユーティリティ
 * ========================================================== */

function shiftDate(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map((v) => Number.parseInt(v, 10));
  const base = new Date(Date.UTC(y, m - 1, d));
  const shifted = new Date(base.getTime() + days * DAY_SECONDS * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate()
  ).padStart(2, '0')}`;
}

/** "HH:MM" → 0時起点の秒。不正なら NaN。 */
function parseTimeToSeconds(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return NaN;
  return Number.parseInt(m[1], 10) * 3600 + Number.parseInt(m[2], 10) * 60;
}

/**
 * 秒（検索日の0時起点。翌日にまたがると86400以上になる）を表示用に整える。
 */
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const normalized = ((seconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const h = Math.floor(normalized / 3600);
  const m = Math.floor((normalized % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function dayOffsetOf(seconds) {
  return Number.isFinite(seconds) ? Math.floor(seconds / DAY_SECONDS) : 0;
}

/**
 * "HH:MM"形式の予測時刻（日付情報を持たない）を、基準となる定刻の秒（日跨ぎ込み）に
 * 最も近い日でそろえた秒数にする。深夜便の日跨ぎで半日以上ずれるのを防ぐ。
 */
function alignPredictedSeconds(predictedTime, scheduleSeconds) {
  const raw = parseTimeToSeconds(predictedTime);
  if (!Number.isFinite(raw) || !Number.isFinite(scheduleSeconds)) return null;
  const base = Math.floor(scheduleSeconds / DAY_SECONDS) * DAY_SECONDS;
  let candidate = base + raw;
  if (candidate - scheduleSeconds > DAY_SECONDS / 2) candidate -= DAY_SECONDS;
  else if (scheduleSeconds - candidate > DAY_SECONDS / 2) candidate += DAY_SECONDS;
  return candidate;
}

/* ==========================================================
 * RAPTOR（ラウンド型）探索
 * ========================================================== */

/**
 * 1回ぶんの探索を行い、乗換回数ごとの最良経路（パレート最適解）を返す。
 *
 * @param {object} ctx { searchIndex, footpaths, activeTripsByShift, maxRounds, windowSeconds }
 * @param {Map<string, number>} originTimes 出発地グループ → 出発可能時刻（秒）
 * @param {Set<string>} destinationKeys 目的地グループの集合
 * @returns {Array<{arrivalSeconds:number, round:number, destinationKey:string, labels:Array}>}
 */
function runRaptor(ctx, originTimes, destinationKeys) {
  const {
    searchIndex,
    footpaths,
    activeTripsByShift,
    maxRounds,
    windowSeconds,
    // 詳細設定で伸ばせる乗換余裕。未指定なら従来の既定値。
    minTransferSeconds = MIN_TRANSFER_SECONDS
  } = ctx;
  const index = searchIndex.index;
  const boardingsByGroup = searchIndex.boardingsByGroup;

  const earliestOrigin = Math.min(...originTimes.values());
  const searchLimitSeconds = earliestOrigin + windowSeconds;

  // τ[k][groupKey]。ラウンドごとに保持する（経路復元に必要）。
  const arrivalByRound = [new Map()];
  const labelByRound = [new Map()];
  // 全ラウンド通しての最良到着時刻（枝刈り用）
  const best = new Map();
  let bestDestination = Number.POSITIVE_INFINITY;

  const improve = (round, groupKey, seconds, label) => {
    if (seconds >= (best.get(groupKey) ?? Number.POSITIVE_INFINITY)) return false;
    if (seconds > bestDestination) return false; // 目的地により早く着ける経路が既にある
    best.set(groupKey, seconds);
    arrivalByRound[round].set(groupKey, seconds);
    labelByRound[round].set(groupKey, label);
    if (destinationKeys.has(groupKey) && seconds < bestDestination) bestDestination = seconds;
    return true;
  };

  let marked = new Set();
  for (const [groupKey, seconds] of originTimes.entries()) {
    if (improve(0, groupKey, seconds, null)) marked.add(groupKey);
  }
  // 出発地からの徒歩接続（ラウンド0）
  relaxFootpaths(0, marked);

  function relaxFootpaths(round, markedSet) {
    const added = [];
    // 徒歩の連鎖（A→徒歩→B→徒歩→C）を禁止するため、
    // relax 開始時点の状態を固定してから走査する。連鎖を許すと
    // 「4分歩いて5分歩いて…」という現実的でない経路が最速解になってしまう。
    const targets = [];
    for (const groupKey of markedSet) {
      const label = labelByRound[round].get(groupKey);
      if (label && label.type === 'walk') continue;
      const arrival = arrivalByRound[round].get(groupKey);
      if (arrival === undefined) continue;
      targets.push({ groupKey, arrival });
    }

    for (const { groupKey, arrival } of targets) {
      for (const link of footpaths.get(groupKey) || []) {
        const seconds = arrival + link.walkSeconds;
        if (seconds > searchLimitSeconds) continue;
        const label = {
          type: 'walk',
          round,
          fromRound: round,
          fromGroupKey: groupKey,
          walkSeconds: link.walkSeconds,
          distanceMeters: link.distanceMeters,
          departureSeconds: arrival,
          arrivalSeconds: seconds
        };
        if (improve(round, link.groupKey, seconds, label)) added.push(link.groupKey);
      }
    }
    for (const groupKey of added) markedSet.add(groupKey);
  }

  const results = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    arrivalByRound[round] = new Map();
    labelByRound[round] = new Map();
    const nextMarked = new Set();
    // 同じ便インスタンスを何度も走査しない。
    // 停車時刻は固定なので、最初に走査した時点で以降の到着時刻は最適になっている。
    const scanned = new Set();

    for (const groupKey of marked) {
      const readySeconds = arrivalByRound[round - 1].get(groupKey);
      if (readySeconds === undefined) continue;
      // 最初の乗車には乗換余裕を課さない
      const departAfter = round === 1 ? readySeconds : readySeconds + minTransferSeconds;
      const boardings = boardingsByGroup.get(groupKey);
      if (!boardings) continue;

      for (const shift of activeTripsByShift) {
        const shiftedFrom = departAfter - shift.offsetSeconds;
        const shiftedTo = Math.min(searchLimitSeconds, bestDestination) - shift.offsetSeconds;
        if (shiftedTo < shiftedFrom) continue;

        let i = lowerBound(boardings, shiftedFrom);
        for (; i < boardings.length; i += 1) {
          const boarding = boardings[i];
          if (boarding.departureSeconds > shiftedTo) break;
          if (!shift.activeTripKeys.has(boarding.tripKey)) continue;

          const instanceKey = `${boarding.tripKey}|${boarding.offsetSeconds}|${shift.offsetSeconds}`;
          if (scanned.has(instanceKey)) continue;
          scanned.add(instanceKey);

          scanTrip(round, groupKey, boarding, shift, nextMarked);
        }
      }
    }

    relaxFootpaths(round, nextMarked);

    // このラウンド（＝乗車round回、乗換round-1回）で目的地に到達できたか
    for (const destinationKey of destinationKeys) {
      const arrival = arrivalByRound[round].get(destinationKey);
      if (arrival === undefined) continue;
      const labels = reconstruct(destinationKey, round);
      if (labels && labels.some((label) => label.type === 'bus')) {
        results.push({ arrivalSeconds: arrival, round, destinationKey, labels });
      }
    }

    if (nextMarked.size === 0) break;
    marked = nextMarked;
  }

  function scanTrip(round, boardGroupKey, boarding, shift, nextMarked) {
    const stopTimes = index.stopTimesByTrip.get(boarding.tripKey);
    if (!stopTimes) return;
    const totalOffset = boarding.offsetSeconds + shift.offsetSeconds;

    for (let j = boarding.tripIndex + 1; j < stopTimes.length; j += 1) {
      const stopTime = stopTimes[j];
      if (stopTime.dropOffType === 1) continue; // 降車できない停車
      const arrivalRaw = Number.isFinite(stopTime.arrivalSeconds)
        ? stopTime.arrivalSeconds
        : stopTime.departureSeconds;
      if (!Number.isFinite(arrivalRaw)) continue;
      const stop = index.stops.get(stopTime.stopKey);
      if (!stop || !stop.groupKey) continue;

      const arrival = arrivalRaw + totalOffset;
      const label = {
        type: 'bus',
        round,
        fromRound: round - 1,
        fromGroupKey: boardGroupKey,
        tripKey: boarding.tripKey,
        // 時刻計算に使う総オフセット（frequencies由来のずれ＋日跨ぎのずれ）
        offsetSeconds: totalOffset,
        // 便詳細URLの始発時刻に使う、frequencies由来のずれだけのオフセット
        tripOffsetSeconds: boarding.offsetSeconds,
        boardIndex: boarding.tripIndex,
        alightIndex: j,
        departureSeconds: boarding.departureSeconds + shift.offsetSeconds,
        arrivalSeconds: arrival
      };
      if (improve(round, stop.groupKey, arrival, label)) nextMarked.add(stop.groupKey);
    }
  }

  function reconstruct(destinationKey, round) {
    const labels = [];
    let currentKey = destinationKey;
    let currentRound = round;
    // 経路長は最大でも（ラウンド数×2）程度。異常時に無限ループしないよう上限を設ける。
    for (let guard = 0; guard < 32; guard += 1) {
      const label = labelByRound[currentRound]?.get(currentKey);
      if (!label) return labels.length > 0 ? labels.reverse() : null;
      labels.push({ ...label, toGroupKey: currentKey });
      currentKey = label.fromGroupKey;
      currentRound = label.fromRound;
    }
    return null;
  }

  return results;
}

/** 発車時刻でソート済みの配列から、seconds 以上の最初の位置を返す。 */
function lowerBound(boardings, seconds) {
  let low = 0;
  let high = boardings.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (boardings[mid].departureSeconds < seconds) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** 到着時刻でソート済みの配列から、seconds を超える最初の位置を返す（逆向き探索用）。 */
function upperBoundByArrival(alightings, seconds) {
  let low = 0;
  let high = alightings.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (alightings[mid].arrivalSeconds <= seconds) low = mid + 1;
    else high = mid;
  }
  return low;
}

/* ==========================================================
 * 逆向きRAPTOR（到着時刻指定）
 * ========================================================== */

/**
 * 「◯時までに着きたい」ための逆向き探索。runRaptor を時間軸で反転させたもので、
 * τ[k][stop] は「あと k 回バスに乗れば目的地に間に合う、そのバス停の最遅出発時刻」。
 * 各ラウンドでは「そのバス停に τ までに到着する便」を探し、便を遡って
 * より手前のバス停の最遅出発時刻を更新する。
 *
 * runRaptor との対応（この対称性を崩すと、出発時刻指定では出るのに
 * 到着時刻指定では出ない区間が生まれるので注意）:
 *   最早到着の最小化   ⇔ 最遅出発の最大化
 *   乗車（pickup可）    ⇔ 降車（drop_off可）から遡る
 *   乗換余裕はラウンド1（＝最初の乗車）で免除 ⇔ ラウンド1（＝最後の降車）で免除
 *   基準時刻＋探索窓で打ち切り ⇔ 基準時刻−探索窓で打ち切り
 *
 * @param {object} ctx buildContext() の戻り値
 * @param {Map<string, number>} destinationTimes 目的地グループ → 到着期限（秒）
 * @param {Set<string>} originKeys 出発地グループの集合
 * @returns {Array<{departureSeconds:number, round:number, originKey:string, labels:Array}>}
 */
function runRaptorReverse(ctx, destinationTimes, originKeys) {
  const {
    searchIndex,
    footpaths,
    activeTripsByShift,
    maxRounds,
    windowSeconds,
    minTransferSeconds = MIN_TRANSFER_SECONDS
  } = ctx;
  const index = searchIndex.index;
  const alightingsByGroup = getAlightingsByGroup(searchIndex);

  const latestTarget = Math.max(...destinationTimes.values());
  const searchFloorSeconds = latestTarget - windowSeconds;

  // τ[k][groupKey]（最遅出発時刻）。ラウンドごとに保持する（経路復元に必要）。
  const departureByRound = [new Map()];
  const labelByRound = [new Map()];
  // 全ラウンド通しての最良（＝最も遅い）出発時刻（枝刈り用）
  const best = new Map();
  let bestOrigin = Number.NEGATIVE_INFINITY;

  const improve = (round, groupKey, seconds, label) => {
    if (seconds <= (best.get(groupKey) ?? Number.NEGATIVE_INFINITY)) return false;
    if (seconds < bestOrigin) return false; // 出発地をより遅く出られる経路が既にある
    best.set(groupKey, seconds);
    departureByRound[round].set(groupKey, seconds);
    labelByRound[round].set(groupKey, label);
    if (originKeys.has(groupKey) && seconds > bestOrigin) bestOrigin = seconds;
    return true;
  };

  let marked = new Set();
  for (const [groupKey, seconds] of destinationTimes.entries()) {
    if (improve(0, groupKey, seconds, null)) marked.add(groupKey);
  }
  // 目的地への徒歩接続（ラウンド0）
  relaxFootpaths(0, marked);

  function relaxFootpaths(round, markedSet) {
    const added = [];
    // 徒歩の連鎖の禁止も順向きと同じ（relax 開始時点の状態を固定してから走査する）
    const targets = [];
    for (const groupKey of markedSet) {
      const label = labelByRound[round].get(groupKey);
      if (label && label.type === 'walk') continue;
      const departure = departureByRound[round].get(groupKey);
      if (departure === undefined) continue;
      targets.push({ groupKey, departure });
    }

    for (const { groupKey, departure } of targets) {
      for (const link of footpaths.get(groupKey) || []) {
        // link.groupKey から groupKey へ歩く（徒歩接続は距離が対称なので同じ表を使える）
        const seconds = departure - link.walkSeconds;
        if (seconds < searchFloorSeconds) continue;
        const label = {
          type: 'walk',
          round,
          toRound: round,
          toGroupKey: groupKey,
          walkSeconds: link.walkSeconds,
          distanceMeters: link.distanceMeters,
          departureSeconds: seconds,
          arrivalSeconds: departure
        };
        if (improve(round, link.groupKey, seconds, label)) added.push(link.groupKey);
      }
    }
    for (const groupKey of added) markedSet.add(groupKey);
  }

  const results = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    departureByRound[round] = new Map();
    labelByRound[round] = new Map();
    const nextMarked = new Set();
    const scanned = new Set();

    for (const groupKey of marked) {
      const readySeconds = departureByRound[round - 1].get(groupKey);
      if (readySeconds === undefined) continue;
      // ラウンド1＝最後の降車（目的地に着くだけ）なので乗換余裕は要らない
      const arriveBefore = round === 1 ? readySeconds : readySeconds - minTransferSeconds;
      const alightings = alightingsByGroup.get(groupKey);
      if (!alightings) continue;

      for (const shift of activeTripsByShift) {
        const shiftedTo = arriveBefore - shift.offsetSeconds;
        const shiftedFrom = Math.max(searchFloorSeconds, bestOrigin) - shift.offsetSeconds;
        if (shiftedTo < shiftedFrom) continue;

        // 到着時刻が遅い側から見ていく（早い便ほど出発も早くなり、有用性が下がる）
        let i = upperBoundByArrival(alightings, shiftedTo) - 1;
        for (; i >= 0; i -= 1) {
          const alighting = alightings[i];
          if (alighting.arrivalSeconds < shiftedFrom) break;
          if (!shift.activeTripKeys.has(alighting.tripKey)) continue;

          const instanceKey = `${alighting.tripKey}|${alighting.offsetSeconds}|${shift.offsetSeconds}`;
          if (scanned.has(instanceKey)) continue;
          scanned.add(instanceKey);

          scanTripBackward(round, groupKey, alighting, shift, nextMarked);
        }
      }
    }

    relaxFootpaths(round, nextMarked);

    // このラウンド（＝乗車round回、乗換round-1回）で出発地から間に合うか
    for (const originKey of originKeys) {
      const departure = departureByRound[round].get(originKey);
      if (departure === undefined) continue;
      const labels = reconstructForward(originKey, round);
      if (labels && labels.some((label) => label.type === 'bus')) {
        results.push({ departureSeconds: departure, round, originKey, labels });
      }
    }

    if (nextMarked.size === 0) break;
    marked = nextMarked;
  }

  function scanTripBackward(round, alightGroupKey, alighting, shift, nextMarked) {
    const stopTimes = index.stopTimesByTrip.get(alighting.tripKey);
    if (!stopTimes) return;
    const totalOffset = alighting.offsetSeconds + shift.offsetSeconds;

    for (let j = alighting.tripIndex - 1; j >= 0; j -= 1) {
      const stopTime = stopTimes[j];
      if (stopTime.pickupType === 1) continue; // 乗車できない停車
      if (!Number.isFinite(stopTime.departureSeconds)) continue;
      const stop = index.stops.get(stopTime.stopKey);
      if (!stop || !stop.groupKey) continue;

      const departure = stopTime.departureSeconds + totalOffset;
      const label = {
        type: 'bus',
        round,
        toRound: round - 1,
        toGroupKey: alightGroupKey,
        tripKey: alighting.tripKey,
        offsetSeconds: totalOffset,
        tripOffsetSeconds: alighting.offsetSeconds,
        boardIndex: j,
        alightIndex: alighting.tripIndex,
        departureSeconds: departure,
        arrivalSeconds: alighting.arrivalSeconds + shift.offsetSeconds
      };
      if (improve(round, stop.groupKey, departure, label)) nextMarked.add(stop.groupKey);
    }
  }

  /** 出発地から目的地へ向かってラベルをたどる（逆向き探索のラベルは「次の一手」を指している）。 */
  function reconstructForward(originKey, round) {
    const labels = [];
    let currentKey = originKey;
    let currentRound = round;
    for (let guard = 0; guard < 32; guard += 1) {
      const label = labelByRound[currentRound]?.get(currentKey);
      if (!label) return labels.length > 0 ? labels : null;
      labels.push({ ...label, fromGroupKey: currentKey });
      currentKey = label.toGroupKey;
      currentRound = label.toRound;
    }
    return null;
  }

  return results;
}

/**
 * 逆向き探索の徒歩区間は「次のバスにぎりぎり間に合う最遅の時刻」で組み立てられている。
 * バスを降りたあとの徒歩は、実際には降車直後に歩き始めるので、
 * 直前のバスの到着時刻へ寄せ直す（そうしないと「降車後しばらく待ってから歩く」表示になる）。
 * 先頭の徒歩（出発地→最初のバス停）は最遅のままにする。到着時刻指定では
 * 「家をいつ出ればよいか」がそのまま答えになるため。
 */
function normalizeReverseLabels(labels) {
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label.type !== 'walk') continue;
    const previous = labels[i - 1];
    if (!previous || previous.type !== 'bus') continue;
    label.departureSeconds = previous.arrivalSeconds;
    label.arrivalSeconds = previous.arrivalSeconds + label.walkSeconds;
  }
  return labels;
}

/* ==========================================================
 * 経路の組み立て（labels → APIレスポンス）
 * ========================================================== */

/**
 * 循環路線などで同じ「バス停グループ」（＝表示名。実体は複数標柱の統合）を
 * 1便の中で複数回通る場合、この便の中でstopTimeが何回目の通過か（0始まり）を
 * 求める。DB側は標柱・通過回数を持たずバス停名でしか突き合わせられないため
 * （busStopApproaching.jsと同じ制約）、リアルタイム重ね合わせ時に
 * 「同名バス停の何回目の通過に対応する定刻か」を一致させるために使う（attachRealtime参照）。
 *
 * ⚠️ groupKey（統合後のバス停）単位で数えること。生のGTFS stop_id単位で数えると、
 * 往路・復路で道路の反対側など別の標柱（＝別stop_id、同名で統合されグループは同じ）を
 * 1回ずつ通る一般的なケースを「どちらも0回目」と誤判定し、DB側の名前一致と噛み合わなくなる
 * （実データで確認済みの不具合。gtfsTimetable.jsのgetStopTimetable()と同じロジックにすること）。
 */
function computeStopVisitIndex(index, stopTimes, stopTime) {
  const targetGroupKey = index.stops.get(stopTime.stopKey)?.groupKey;
  return stopTimes.filter((st) => {
    const stStop = index.stops.get(st.stopKey);
    return stStop && stStop.groupKey === targetGroupKey && st.sequence <= stopTime.sequence;
  }).length - 1;
}

function serializeStopRef(index, stop, groupKey) {
  const group = groupKey ? index.groups.get(groupKey) : null;
  // 通過するバス停は、そのバス停の全乗り場ではなく実際に通る乗り場単独のページへ遷移させる。
  const platformQuery = stop ? `?platform=${encodeURIComponent(`${stop.feedId}_${stop.stopId}`)}` : '';
  return {
    stopKey: groupKey || null,
    stopId: stop ? stop.stopId : null,
    feedId: stop ? stop.feedId : null,
    name: group ? group.name : stop ? stop.name : '',
    platformCode: stop ? stop.platformCode || '' : '',
    lat: stop ? stop.lat : group ? group.lat : null,
    lon: stop ? stop.lon : group ? group.lon : null,
    busstopUrl: groupKey ? `/busstop/${encodeURIComponent(groupKey)}${platformQuery}` : null
  };
}

/**
 * ラベル列を1つの経路オブジェクトへ変換する（リアルタイム・運賃は後段で付ける）。
 */
function buildJourney(index, labels) {
  const legs = [];

  for (const label of labels) {
    if (label.type === 'walk') {
      legs.push({
        type: 'walk',
        fromStop: serializeStopRef(index, null, label.fromGroupKey),
        toStop: serializeStopRef(index, null, label.toGroupKey),
        walkMinutes: Math.max(1, Math.round(label.walkSeconds / 60)),
        distanceMeters: label.distanceMeters,
        departureSeconds: label.departureSeconds,
        arrivalSeconds: label.arrivalSeconds,
        departureTime: formatTime(label.departureSeconds),
        arrivalTime: formatTime(label.arrivalSeconds),
        departureDayOffset: dayOffsetOf(label.departureSeconds),
        arrivalDayOffset: dayOffsetOf(label.arrivalSeconds)
      });
      continue;
    }

    const trip = index.trips.get(label.tripKey);
    const stopTimes = index.stopTimesByTrip.get(label.tripKey) || [];
    const route = trip ? index.routes.get(trip.routeKey) : null;
    const boardStopTime = stopTimes[label.boardIndex];
    const alightStopTime = stopTimes[label.alightIndex];
    if (!trip || !boardStopTime || !alightStopTime) continue;

    const boardStop = index.stops.get(boardStopTime.stopKey);
    const alightStop = index.stops.get(alightStopTime.stopKey);

    const stops = [];
    for (let i = label.boardIndex; i <= label.alightIndex; i += 1) {
      const stopTime = stopTimes[i];
      const stop = index.stops.get(stopTime.stopKey);
      const arrivalSeconds = Number.isFinite(stopTime.arrivalSeconds)
        ? stopTime.arrivalSeconds + label.offsetSeconds
        : null;
      const departureSeconds = Number.isFinite(stopTime.departureSeconds)
        ? stopTime.departureSeconds + label.offsetSeconds
        : null;
      stops.push({
        ...serializeStopRef(index, stop, stop ? stop.groupKey : null),
        sequence: stopTime.sequence,
        stopVisitIndex: computeStopVisitIndex(index, stopTimes, stopTime),
        arrivalSeconds,
        departureSeconds,
        arrivalTime: formatTime(arrivalSeconds),
        departureTime: formatTime(departureSeconds),
        dayOffset: dayOffsetOf(departureSeconds ?? arrivalSeconds),
        isBoard: i === label.boardIndex,
        isAlight: i === label.alightIndex,
        // 乗車も降車もできない停車（経由地）
        isThrough: stopTime.pickupType === 1 && stopTime.dropOffType === 1,
        // リアルタイム重ね合わせで埋める
        predictedTime: null,
        status: null,
        delayMinutes: null
      });
    }

    legs.push({
      type: 'bus',
      feedId: trip.feedId,
      routeId: trip.routeId,
      routeName: route ? route.name : trip.routeId,
      routeShortName: route ? route.shortName : '',
      routeColor: route ? route.color : '',
      routeTextColor: route ? route.textColor : '',
      agencyName: route ? route.agencyName : '',
      tripId: trip.tripId,
      // 便詳細ページのURL用。実便の始発時刻（frequencies由来のずれのみ反映。
      // 日跨ぎのずれは「その便のダイヤ上の始発時刻」ではないので足さない）。
      tripDepartureTime: formatHhmm(
        (Number.isFinite(trip.firstDepartureSeconds) ? trip.firstDepartureSeconds : 0) +
          (label.tripOffsetSeconds || 0)
      ),
      headsign: resolveHeadsign(boardStopTime, trip),
      directionId: trip.directionId,
      fromStop: {
        ...serializeStopRef(index, boardStop, boardStop ? boardStop.groupKey : null),
        stopVisitIndex: computeStopVisitIndex(index, stopTimes, boardStopTime)
      },
      toStop: {
        ...serializeStopRef(index, alightStop, alightStop ? alightStop.groupKey : null),
        stopVisitIndex: computeStopVisitIndex(index, stopTimes, alightStopTime)
      },
      departureSeconds: label.departureSeconds,
      arrivalSeconds: label.arrivalSeconds,
      departureTime: formatTime(label.departureSeconds),
      arrivalTime: formatTime(label.arrivalSeconds),
      scheduledDepartureTime: formatTime(label.departureSeconds),
      scheduledArrivalTime: formatTime(label.arrivalSeconds),
      departureDayOffset: dayOffsetOf(label.departureSeconds),
      arrivalDayOffset: dayOffsetOf(label.arrivalSeconds),
      rideMinutes: Math.max(1, Math.round((label.arrivalSeconds - label.departureSeconds) / 60)),
      stopCount: label.alightIndex - label.boardIndex,
      stops,
      fare: null,
      realtime: null
    });
  }

  if (legs.length === 0) return null;

  const busLegs = legs.filter((leg) => leg.type === 'bus');
  if (busLegs.length === 0) return null;

  const departureSeconds = legs[0].departureSeconds;
  const arrivalSeconds = legs[legs.length - 1].arrivalSeconds;
  const walkSeconds = legs
    .filter((leg) => leg.type === 'walk')
    .reduce((sum, leg) => sum + (leg.arrivalSeconds - leg.departureSeconds), 0);

  return {
    departureSeconds,
    arrivalSeconds,
    departureTime: formatTime(departureSeconds),
    arrivalTime: formatTime(arrivalSeconds),
    departureDayOffset: dayOffsetOf(departureSeconds),
    arrivalDayOffset: dayOffsetOf(arrivalSeconds),
    durationMinutes: Math.max(1, Math.round((arrivalSeconds - departureSeconds) / 60)),
    transferCount: busLegs.length - 1,
    walkMinutes: Math.round(walkSeconds / 60),
    isRecommended: false,
    realtime: false,
    transferAtRisk: false,
    fare: null,
    legs
  };
}

/** 同一の便構成の経路を重複とみなすためのキー。 */
function journeyKey(journey) {
  return journey.legs
    .map((leg) =>
      leg.type === 'bus'
        ? `B:${leg.feedId}:${leg.tripId}:${leg.departureSeconds}:${leg.fromStop.stopKey}>${leg.toStop.stopKey}`
        : `W:${leg.fromStop.stopKey}>${leg.toStop.stopKey}`
    )
    .join('|');
}

/* ==========================================================
 * 運賃・リアルタイムの付与
 * ========================================================== */

function attachFares(fareIndex, journeys) {
  for (const journey of journeys) {
    let total = 0;
    let unknownCount = 0;
    let busLegCount = 0;

    for (const leg of journey.legs) {
      if (leg.type !== 'bus') continue;
      busLegCount += 1;
      const fare = lookupFare(fareIndex, leg.feedId, leg.routeId, leg.fromStop.stopId, leg.toStop.stopId);
      if (fare) {
        leg.fare = { price: fare.price, currency: fare.currency, fareId: fare.fareId };
        total += fare.price;
      } else {
        leg.fare = null;
        unknownCount += 1;
      }
    }

    journey.fare = {
      total: unknownCount === busLegCount ? null : total,
      currency: 'JPY',
      // 一部の区間だけ運賃が引けなかった（合計は判明ぶんのみ）
      partial: unknownCount > 0 && unknownCount < busLegCount,
      unknown: unknownCount === busLegCount
    };
  }
}

/**
 * 予測が重なったバス便どうしの乗り換えが、実際に間に合うかを検証する。
 * 定刻上は間に合う乗換でも、前区間が遅延して到着予測が乗換先の予測発車時刻を
 * 超えてしまう場合は、その乗換に「間に合わない可能性」の警告を付ける。
 * 経路自体は残す（soft-fail方針を踏襲）が、呼び出し側でおすすめ選定・並び替えに使う。
 */
function flagTransferRisks(journey, minTransferSeconds = MIN_TRANSFER_SECONDS) {
  const legs = journey.legs;
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (leg.type !== 'bus' || !leg.realtime) continue;

    const next = legs[i + 1];
    if (!next) continue;
    const walkLeg = next.type === 'walk' ? next : null;
    const nextBusLeg = walkLeg ? legs[i + 2] : next;
    if (!nextBusLeg || nextBusLeg.type !== 'bus') continue;

    // 前区間の実際の到着予測。これが無ければ、この乗換は定刻どおり成立している
    // （＝チェックする材料が無い）ので何もしない。
    const arrivalRt = alignPredictedSeconds(leg.realtime.predictedArrivalTime, leg.arrivalSeconds);
    if (arrivalRt === null) continue;

    // 乗換先の便はまだ運行を始めていないことが多い（始発時刻前は割り当てが無くリアルタイム情報が取れない）。
    // その場合は定刻発車を見込む。実際に何分遅れて出るかは分からないため、
    // 「間に合わない」方向にのみ安全側で判定する。
    const departureRt = nextBusLeg.realtime
      ? alignPredictedSeconds(nextBusLeg.realtime.predictedDepartureTime, nextBusLeg.departureSeconds)
      : null;
    const effectiveDeparture = departureRt !== null ? departureRt : nextBusLeg.departureSeconds;

    // 徒歩を挟む乗換は徒歩所要時間そのものが必要な間隔。同一停留所なら探索時と同じ乗換余裕。
    const requiredGapSeconds = walkLeg ? walkLeg.arrivalSeconds - walkLeg.departureSeconds : minTransferSeconds;

    if (arrivalRt + requiredGapSeconds > effectiveDeparture) {
      nextBusLeg.transferRisk = {
        atStopName: leg.toStop.name,
        shortByMinutes: Math.max(1, Math.ceil((arrivalRt + requiredGapSeconds - effectiveDeparture) / 60))
      };
      journey.transferAtRisk = true;
    }
  }
}

/**
 * 当日の運行実績・予測を重ねる。失敗しても定刻表示のまま成立させる（soft-fail）。
 */
async function attachRealtime(journeys, minTransferSeconds = MIN_TRANSFER_SECONDS) {
  // 同じ便を何度も引かないためのリクエスト内キャッシュ
  const busEntryCache = new Map();

  // 管理画面「リアルタイム休止」で表示を止めている路線の集合（docs/realtime-suspension.md）。
  // findLiveAssignment() 自体も休止路線には null を返すが、ここで先に判定して
  // 「定刻を表示している理由」を経路・区間に添えられるようにする（画面の注記用）。
  const suspendedRouteIds = await getSuspendedRouteIdSet();

  for (const journey of journeys) {
    for (let legIndex = 0; legIndex < journey.legs.length; legIndex += 1) {
      const leg = journey.legs[legIndex];
      if (leg.type !== 'bus') continue;

      if (suspendedRouteIds.has(qualifyRouteId(leg.routeId, leg.feedId))) {
        leg.realtimeSuspended = true;
        journey.realtimeSuspended = true;
        continue; // リアルタイムは重ねず定刻のまま成立させる
      }

      // 翌日・前日ぶんにずらして拾った便は「今日のリアルタイム」ではない
      // （当日の daily_trips を引く realtimeTripLookup とは別の日の便になってしまう）
      if (leg.departureDayOffset !== 0) continue;

      try {
        const cacheKey = `${leg.feedId}|${leg.routeId}|${leg.tripId}|${leg.tripDepartureTime}`;
        if (!busEntryCache.has(cacheKey)) {
          const match = await findLiveAssignment(leg.feedId, leg.routeId, leg.tripId, leg.tripDepartureTime);
          const entry = match
            ? await buildBusEntry(match, qualifyRouteId(leg.routeId, leg.feedId), leg.routeName)
            : null;
          busEntryCache.set(cacheKey, entry ? { match, entry } : null);
        }
        const cached = busEntryCache.get(cacheKey);
        if (!cached) continue;

        const { match, entry } = cached;
        // DB側の stops は標柱を持たないため、バス停名でしか突き合わせられない
        // （busStopApproaching.js と同じ制約）。同名バス停ごとに一致候補を全件保持し、
        // 循環路線などで1便の中に同名バス停が複数回登場する場合は
        // stopVisitIndex（この便の中で何回目の通過か）が一致するものを選ぶ。
        // 最初の1件だけを採用すると、2回目の通過（区間の乗車・降車）に
        // 1回目（既に通過済み）の定刻・進捗を誤って重ねてしまう。
        const byName = new Map();
        entry.stops.forEach((stop, i) => {
          if (!byName.has(stop.name)) byName.set(stop.name, []);
          byName.get(stop.name).push({ stop, index: i });
        });
        const pickOccurrence = (name, visitIndex) => {
          const candidates = byName.get(name);
          if (!candidates || candidates.length === 0) return null;
          const idx = Number.isInteger(visitIndex) ? visitIndex : 0;
          return candidates[Math.min(idx, candidates.length - 1)];
        };

        let lastArrivedIndex = -1;
        entry.stops.forEach((stop, i) => {
          if (stop.status === '到着済') lastArrivedIndex = i;
        });

        for (const stop of leg.stops) {
          const matched = pickOccurrence(stop.name, stop.stopVisitIndex);
          if (!matched) continue;
          stop.predictedTime = matched.stop.predictedTime || matched.stop.scheduledTime || null;
          stop.status = matched.stop.status || null;
          stop.delayMinutes = matched.stop.predictedDelayMinutes ?? null;
          if (matched.stop.status === '到着済' && matched.stop.actualTime) {
            stop.actualTime = matched.stop.actualTime;
          }
        }

        const boardMatch = pickOccurrence(leg.fromStop.name, leg.fromStop.stopVisitIndex);
        const alightMatch = pickOccurrence(leg.toStop.name, leg.toStop.stopVisitIndex);
        leg.realtime = {
          hasRealtime: true,
          vehicleId: match.car_id,
          delayMinutes: match.delay_minutes ?? null,
          lat: entry.lat,
          lng: entry.lng,
          currentStopName: lastArrivedIndex >= 0 ? entry.stops[lastArrivedIndex].name : null,
          predictedDepartureTime: boardMatch ? boardMatch.stop.predictedTime : null,
          predictedArrivalTime: alightMatch ? alightMatch.stop.predictedTime : null,
          predictedArrivalDelayMinutes: alightMatch ? alightMatch.stop.predictedDelayMinutes : null,
          // 乗車バス停を既に発車済みかどうか（「もう行ってしまった便」を示すため）
          departed: Boolean(boardMatch && boardMatch.index <= lastArrivedIndex)
        };
        if (leg.realtime.predictedDepartureTime) leg.departureTime = leg.realtime.predictedDepartureTime;
        if (leg.realtime.predictedArrivalTime) {
          leg.arrivalTime = leg.realtime.predictedArrivalTime;

          // 直後が徒歩区間なら、その発・着時刻もこの便の実際の到着に合わせてずらす。
          // ここを更新しないと、徒歩区間は定刻の到着時刻を起点にしたままになり、
          // 遅延で繰り下がった着時刻より前に徒歩の発時刻が来る（＝着＜発の矛盾表示）になる。
          const nextLeg = journey.legs[legIndex + 1];
          if (nextLeg && nextLeg.type === 'walk') {
            const arrivalRt = alignPredictedSeconds(leg.realtime.predictedArrivalTime, leg.arrivalSeconds);
            const deltaSeconds = arrivalRt === null ? 0 : arrivalRt - nextLeg.departureSeconds;
            if (deltaSeconds !== 0) {
              nextLeg.departureSeconds += deltaSeconds;
              nextLeg.arrivalSeconds += deltaSeconds;
              nextLeg.departureTime = formatTime(nextLeg.departureSeconds);
              nextLeg.arrivalTime = formatTime(nextLeg.arrivalSeconds);
              nextLeg.departureDayOffset = dayOffsetOf(nextLeg.departureSeconds);
              nextLeg.arrivalDayOffset = dayOffsetOf(nextLeg.arrivalSeconds);
            }
          }
        }
        journey.realtime = true;
      } catch (err) {
        console.error('[gtfsRouteSearch] リアルタイム重ね合わせエラー（定刻表示で継続）:', err.message);
      }
    }

    // 区間の表示時刻が予測に置き換わったら、カード上部の出発・到着時刻も合わせる。
    // 各区間のarrivalSeconds/departureSeconds自体（rideMinutes等の計算元）は定刻のまま
    // 保持するが（乗車時間の目安が予測のブレで揺れないようにするため）、カード上部の
    // 所要時間はここで表示中の出発・到着時刻から改めて計算し直す。そうしないと、
    // 上に出ている時刻の差分と「◯分」の表示が食い違って見える。
    if (journey.realtime) {
      const firstLeg = journey.legs[0];
      const lastLeg = journey.legs[journey.legs.length - 1];
      journey.departureTime = firstLeg.departureTime;
      journey.arrivalTime = lastLeg.arrivalTime;

      const effectiveDepartureSeconds =
        firstLeg.type === 'bus' && firstLeg.realtime && firstLeg.realtime.predictedDepartureTime
          ? alignPredictedSeconds(firstLeg.realtime.predictedDepartureTime, firstLeg.departureSeconds) ??
            firstLeg.departureSeconds
          : firstLeg.departureSeconds;
      const effectiveArrivalSeconds =
        lastLeg.type === 'bus' && lastLeg.realtime && lastLeg.realtime.predictedArrivalTime
          ? alignPredictedSeconds(lastLeg.realtime.predictedArrivalTime, lastLeg.arrivalSeconds) ??
            lastLeg.arrivalSeconds
          : lastLeg.arrivalSeconds; // 徒歩区間ならこの時点で既に上の伝播でずらし済み
      journey.durationMinutes = Math.max(1, Math.round((effectiveArrivalSeconds - effectiveDepartureSeconds) / 60));

      journey.delayMinutes = journey.legs
        .filter((leg) => leg.type === 'bus' && leg.realtime)
        .reduce((max, leg) => Math.max(max, leg.realtime.predictedArrivalDelayMinutes || 0), 0);

      flagTransferRisks(journey, minTransferSeconds);
    }
  }
}

/* ==========================================================
 * 探索の実行（複数候補・段階的フォールバック）
 * ========================================================== */

/**
 * 指定条件で経路候補を集める。基準時刻を1分ずつずらしながら再探索し、
 * 乗換回数ごとの最良解をまとめて集める（仕様書 5.4）。
 *
 * @param {Map<string, number>} baseTimes 出発時刻指定なら出発地→出発可能時刻、
 *                                        到着時刻指定なら目的地→到着期限
 * @param {Set<string>} targetKeys 出発時刻指定なら目的地、到着時刻指定なら出発地
 * @param {'departure'|'arrival'} timeMode
 */
function collectJourneys(ctx, baseTimes, targetKeys, limit, timeMode = 'departure') {
  const index = ctx.searchIndex.index;
  const reverse = timeMode === 'arrival';
  const journeys = [];
  const seen = new Set();
  let times = baseTimes;

  for (let iteration = 0; iteration < MAX_ITERATIONS && journeys.length < limit; iteration += 1) {
    const results = reverse ? runRaptorReverse(ctx, times, targetKeys) : runRaptor(ctx, times, targetKeys);
    if (results.length === 0) break;

    // 出発時刻指定なら「最も早い出発」、到着時刻指定なら「最も遅い到着」を次回の基準にする
    let pivot = reverse ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (const result of results) {
      const journey = buildJourney(index, reverse ? normalizeReverseLabels(result.labels) : result.labels);
      if (!journey) continue;
      const key = journeyKey(journey);
      if (seen.has(key)) continue;
      seen.add(key);
      journeys.push(journey);
      pivot = reverse
        ? Math.max(pivot, journey.arrivalSeconds)
        : Math.min(pivot, journey.departureSeconds);
    }

    if (!Number.isFinite(pivot)) break;
    // 次の探索は「最初の便の1分後以降」／「最後の便の1分前まで」。次発・次々発（前便・前々便）が並ぶようにする。
    const nextPivot = reverse ? pivot - 60 : pivot + 60;
    times = new Map();
    for (const [groupKey, seconds] of baseTimes.entries()) {
      times.set(groupKey, reverse ? Math.min(seconds, nextPivot) : Math.max(seconds, nextPivot));
    }
  }

  return journeys;
}

/** 同じ便構成の経路を除きつつ2つの結果を結合する。 */
function mergeJourneys(base, extra) {
  const seen = new Set(base.map(journeyKey));
  const merged = base.slice();
  for (const journey of extra) {
    const key = journeyKey(journey);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(journey);
  }
  return merged;
}

/**
 * 並べ替える（歩きすぎる経路は、他に候補があるなら除く）。
 * 出発時刻指定は「早く着く順」、到着時刻指定は「遅く出発できる順」＝指定時刻に近い便から。
 */
function sortJourneys(journeys, timeMode = 'departure') {
  const walkable = journeys.filter((journey) => journey.walkMinutes <= MAX_TOTAL_WALK_MINUTES);
  if (walkable.length > 0) journeys = walkable;

  if (timeMode === 'arrival') {
    journeys.sort(
      (a, b) =>
        b.departureSeconds - a.departureSeconds ||
        a.transferCount - b.transferCount ||
        a.arrivalSeconds - b.arrivalSeconds
    );
    return journeys;
  }

  journeys.sort(
    (a, b) =>
      a.arrivalSeconds - b.arrivalSeconds ||
      a.transferCount - b.transferCount ||
      b.departureSeconds - a.departureSeconds
  );
  return journeys;
}

/**
 * 最もスコアの良い経路に「おすすめ」を付ける。
 * リアルタイム反映後に乗換が間に合わない可能性が判明した経路は、
 * 他に間に合う候補がある限りおすすめから外す（間に合わない案を積極的に薦めない）。
 *
 * 到着時刻指定では「早く着く」ことに価値は無い（指定時刻までに着けばよい）ので、
 * 評価軸を「出発時刻の遅さ」に置き換える。乗換・徒歩の不利は同じ重みのまま。
 */
function pickRecommended(journeys, timeMode = 'departure') {
  const feasible = journeys.filter((journey) => !journey.transferAtRisk);
  const pool = feasible.length > 0 ? feasible : journeys;

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const journey of pool) {
    const base = timeMode === 'arrival' ? -journey.departureSeconds : journey.arrivalSeconds;
    const score =
      base +
      journey.transferCount * TRANSFER_PENALTY_SECONDS +
      journey.walkMinutes * 60 * WALK_PENALTY_RATIO;
    if (score < bestScore) {
      bestScore = score;
      best = journey;
    }
  }
  if (best) best.isRecommended = true;
}

/**
 * 探索コンテキスト（運行日・徒歩半径・ラウンド数・探索窓）を組み立てる。
 * 前日サービスの24時超え便・翌日サービスの便も取り込む（仕様書 5.2）。
 */
function buildContext(searchIndex, dateStr, { radiusMeters, maxRounds, windowSeconds, minTransferSeconds }) {
  return {
    searchIndex,
    footpaths: getFootpaths(searchIndex, radiusMeters),
    activeTripsByShift: [
      { offsetSeconds: -DAY_SECONDS, activeTripKeys: getActiveTripKeys(searchIndex, shiftDate(dateStr, -1)) },
      { offsetSeconds: 0, activeTripKeys: getActiveTripKeys(searchIndex, dateStr) },
      { offsetSeconds: DAY_SECONDS, activeTripKeys: getActiveTripKeys(searchIndex, shiftDate(dateStr, 1)) }
    ],
    maxRounds,
    windowSeconds,
    // 詳細設定の「乗り換えの余裕時間」。省略時は従来の既定値。
    minTransferSeconds: Number.isFinite(minTransferSeconds) ? minTransferSeconds : MIN_TRANSFER_SECONDS
  };
}

// 段階的フォールバックの定義（仕様書7章）
const RELAXATION_STEPS = [
  { key: 'normal', radiusMeters: WALK_RADIUS_METERS, maxRounds: MAX_ROUNDS, windowSeconds: SEARCH_WINDOW_SECONDS },
  { key: 'wide-window', radiusMeters: WALK_RADIUS_METERS, maxRounds: MAX_ROUNDS, windowSeconds: SEARCH_WINDOW_RELAXED_SECONDS },
  { key: 'walk-transfer', radiusMeters: WALK_RADIUS_RELAXED_METERS, maxRounds: MAX_ROUNDS_RELAXED, windowSeconds: SEARCH_WINDOW_RELAXED_SECONDS }
];

const RELAXATION_NOTES = {
  normal: null,
  'wide-window': '指定時刻からしばらく後に出発する便を含みます。',
  'walk-transfer': '徒歩での乗り継ぎ（最大800m）を含む経路です。'
};

// 到着時刻指定のときの文言。探索窓の緩和は「指定時刻のかなり前に出発する便」を意味する。
const RELAXATION_NOTES_ARRIVAL = {
  normal: null,
  'wide-window': '指定時刻よりかなり早く出発する便を含みます。',
  'walk-transfer': '徒歩での乗り継ぎ（最大800m）を含む経路です。'
};

/**
 * 段階的フォールバックの1段階に詳細設定を反映する。
 * 段階が進むと条件が緩む（徒歩800m・乗換3回まで）が、利用者が明示した上限は超えさせない。
 * 「直通のみ」で検索したのにフォールバックで乗換つきの案が出てしまう、という事故を防ぐため。
 */
function applyPreferencesToStep(step, preferences) {
  return {
    ...step,
    radiusMeters: preferences.allowWalkTransfer ? step.radiusMeters : 0,
    maxRounds:
      preferences.maxTransfers === null
        ? step.maxRounds
        : Math.min(step.maxRounds, preferences.maxTransfers + 1),
    minTransferSeconds: preferences.minTransferSeconds
  };
}

/**
 * 段階的フォールバック（仕様書7章）を回して経路候補を集める。
 * 最初に1件以上見つかった段階で打ち切り、その段階のキーを relaxation として返す。
 *
 * @returns {{journeys:Array, relaxation:string, ctx:object|null}}
 */
function runRelaxationSearch({ searchIndex, dateStr, searchTimes, searchTargets, bufferLimit, timeMode, preferences }) {
  let journeys = [];
  let relaxation = 'normal';
  let ctx = null;
  // 詳細設定で条件を絞ると、段階が違っても同じ探索条件になることがある
  //（例：徒歩なし＋乗換0回では段階2と段階3が一致する）。同じ探索を繰り返さない。
  const attempted = new Set();

  for (const step of RELAXATION_STEPS) {
    const effective = applyPreferencesToStep(step, preferences);
    const attemptKey = `${effective.radiusMeters}|${effective.maxRounds}|${effective.windowSeconds}|${effective.minTransferSeconds}`;
    if (attempted.has(attemptKey)) continue;
    attempted.add(attemptKey);

    ctx = buildContext(searchIndex, dateStr, effective);
    journeys = collectJourneys(ctx, searchTimes, searchTargets, bufferLimit, timeMode);

    // 徒歩接続を使うと「1駅手前で降りて歩く」方が最速になり、
    // バスだけで完結する案が枝刈りで消えることがある。
    // 利用者はふつう歩かない案も知りたいので、徒歩なしの探索結果も必ず混ぜる。
    // （徒歩を使わない設定のときは、まったく同じ探索の繰り返しになるので行わない）
    if (effective.radiusMeters > 0) {
      const walkFreeCtx = buildContext(searchIndex, dateStr, { ...effective, radiusMeters: 0 });
      journeys = mergeJourneys(
        journeys,
        collectJourneys(walkFreeCtx, searchTimes, searchTargets, bufferLimit, timeMode)
      );
    }

    if (journeys.length > 0) {
      relaxation = step.key;
      break;
    }
  }

  return { journeys, relaxation, ctx };
}

/* ==========================================================
 * 出発地・目的地の解決
 * ========================================================== */

/**
 * 指定座標から半径内にあるバス停グループを近い順に最大limit件返す（GTFSインデックスのみ、DB不使用）。
 * 呼び出し側で徒歩距離の表示にも使えるよう、距離（distanceMeters）も添えて返す。
 */
function findNearbyStopGroupsWithinRadius(index, lat, lon, radiusMeters, limit) {
  const candidates = [];
  for (const group of index.groups.values()) {
    if (!Number.isFinite(group.lat) || !Number.isFinite(group.lon)) continue;
    const distanceMeters = haversineDistanceMeters(lat, lon, group.lat, group.lon);
    if (distanceMeters > radiusMeters) continue;
    candidates.push({ group, distanceMeters });
  }
  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return candidates.slice(0, limit);
}

/**
 * stopKey / 自由文字列 / 観光スポットIDのいずれかからバス停グループ（複数可）を解決する。
 * stopKeyで解決できない場合は名称検索の上位候補を使う（仕様書 3.2）。
 * spotIdが渡された場合、観光スポットは tourist_spots テーブルから単発で読む
 * （探索本体はGTFSインデックスのみを見るという原則の、realtimeTripLookupと同種の例外。
 *  観光スポット情報_仕様書：バス停との関連付けは参照時に近接検索で解決する）。
 *
 * fuzzyは「自由文字列をバス停名にあいまい一致させた」ことだけを表す。観光スポット経由の
 * 解決はスポット自体が確定済み（spotIdは候補から選んだ結果）なので、あいまい一致とは別種
 * ——ここでfuzzy:trueにすると「候補から選ぶとより正確になります」という文言が誤って出る
 * （フロント側はresult.fuzzyだけを見てこのメッセージを出すため）。false固定とする。
 */
async function resolveEndpoint(index, { stopKey, text, spotId }) {
  if (spotId) {
    const spot = await touristSpots.getSpotById(spotId);
    if (!spot) {
      return { groups: [], fuzzy: false, query: '', spotNotFound: true };
    }
    let candidates = findNearbyStopGroupsWithinRadius(index, spot.lat, spot.lng, SPOT_LINK_RADIUS_METERS, SPOT_LINK_STOP_LIMIT);
    if (candidates.length === 0) {
      // 半径内に1件も無い場合は、表示用フォールバック方針（段階的に条件を緩める）を踏襲し、
      // より広い半径で再試行してから諦める。
      candidates = findNearbyStopGroupsWithinRadius(index, spot.lat, spot.lng, SPOT_LINK_RADIUS_RELAXED_METERS, SPOT_LINK_STOP_LIMIT);
    }
    if (candidates.length === 0) {
      return { groups: [], fuzzy: false, query: spot.name, viaSpot: spot, spotHasNoNearbyStops: true };
    }
    const groups = candidates.map((c) => c.group);
    // 実際に採用されたバス停の徒歩距離を表示できるよう、groupKeyごとの距離を持ち回す。
    const distanceByGroupKey = new Map(candidates.map((c) => [c.group.groupKey, c.distanceMeters]));
    return { groups, fuzzy: false, query: spot.name, viaSpot: spot, distanceByGroupKey };
  }

  if (stopKey) {
    const group = resolveGroup(index, stopKey);
    if (group) return { groups: [group], fuzzy: false, query: stopKey };
  }
  const query = String(text || stopKey || '').trim();
  if (!query) return { groups: [], fuzzy: false, query: '' };

  const candidates = await searchStops(query, FUZZY_CANDIDATE_LIMIT);
  const groups = candidates.map((candidate) => index.groups.get(candidate.stopKey)).filter(Boolean);
  return { groups, fuzzy: true, query };
}

/** 観光スポット⇔実際に採用されたバス停の徒歩距離・目安分数（観光スポット情報_仕様書）。 */
function buildSpotWalkInfo(endpoint, actualGroupKey) {
  if (!endpoint.viaSpot || !endpoint.distanceByGroupKey) return null;
  const distanceMeters = endpoint.distanceByGroupKey.get(actualGroupKey);
  if (!Number.isFinite(distanceMeters)) return null;
  return {
    distanceMeters: Math.round(distanceMeters),
    walkMinutes: Math.max(1, Math.round(distanceMeters / WALK_SPEED_METERS_PER_MIN))
  };
}

/** 観光スポットを徒歩レグの端点として表現する疑似バス停参照（stopKeyは持たない）。 */
function serializeSpotRef(spot) {
  return {
    stopKey: null,
    stopId: null,
    feedId: null,
    name: spot.name,
    platformCode: '',
    lat: spot.lat,
    lon: spot.lng,
    busstopUrl: null,
    spotId: spot.spotId
  };
}

/**
 * 観光スポット起点/終点の経路に、スポット⇔実際に採用されたバス停間の徒歩レグを
 * 先頭/末尾へ組み込む（観光スポット情報_仕様書）。従来は注記文言だけで案内していたが、
 * 経路そのものの一部として表示するため legs 配列・所要時間・徒歩分数を更新する。
 */
function attachSpotWalkLegs(ranked, origin, destination) {
  for (const journey of ranked) {
    if (origin.viaSpot) {
      const firstLeg = journey.legs[0];
      const info = buildSpotWalkInfo(origin, firstLeg.fromStop.stopKey);
      if (info) {
        const arrivalSeconds = journey.departureSeconds;
        const departureSeconds = arrivalSeconds - info.walkMinutes * 60;
        journey.legs.unshift({
          type: 'walk',
          fromStop: serializeSpotRef(origin.viaSpot),
          toStop: firstLeg.fromStop,
          walkMinutes: info.walkMinutes,
          distanceMeters: info.distanceMeters,
          departureSeconds,
          arrivalSeconds,
          departureTime: formatTime(departureSeconds),
          arrivalTime: formatTime(arrivalSeconds),
          departureDayOffset: dayOffsetOf(departureSeconds),
          arrivalDayOffset: dayOffsetOf(arrivalSeconds)
        });
        journey.departureSeconds = departureSeconds;
        journey.departureTime = formatTime(departureSeconds);
        journey.departureDayOffset = dayOffsetOf(departureSeconds);
        journey.walkMinutes += info.walkMinutes;
        journey.durationMinutes = Math.max(1, Math.round((journey.arrivalSeconds - departureSeconds) / 60));
      }
    }

    if (destination.viaSpot) {
      const lastLeg = journey.legs[journey.legs.length - 1];
      const info = buildSpotWalkInfo(destination, lastLeg.toStop.stopKey);
      if (info) {
        const departureSeconds = journey.arrivalSeconds;
        const arrivalSeconds = departureSeconds + info.walkMinutes * 60;
        journey.legs.push({
          type: 'walk',
          fromStop: lastLeg.toStop,
          toStop: serializeSpotRef(destination.viaSpot),
          walkMinutes: info.walkMinutes,
          distanceMeters: info.distanceMeters,
          departureSeconds,
          arrivalSeconds,
          departureTime: formatTime(departureSeconds),
          arrivalTime: formatTime(arrivalSeconds),
          departureDayOffset: dayOffsetOf(departureSeconds),
          arrivalDayOffset: dayOffsetOf(arrivalSeconds)
        });
        journey.arrivalSeconds = arrivalSeconds;
        journey.arrivalTime = formatTime(arrivalSeconds);
        journey.arrivalDayOffset = dayOffsetOf(arrivalSeconds);
        journey.walkMinutes += info.walkMinutes;
        journey.durationMinutes = Math.max(1, Math.round((arrivalSeconds - journey.departureSeconds) / 60));
      }
    }
  }
}

function serializeEndpoint(group) {
  return {
    stopKey: group.groupKey,
    name: group.name,
    kana: group.hiragana || null,
    romaji: group.romaji || null,
    lat: group.lat,
    lon: group.lon,
    busstopUrl: `/busstop/${encodeURIComponent(group.groupKey)}`
  };
}

/**
 * そのバス停グループがその日に1本でも発着するか（見つからない理由の切り分け用）。
 */
function hasAnyServiceOnDate(ctx, groupKey) {
  const boardings = ctx.searchIndex.boardingsByGroup.get(groupKey);
  if (!boardings) return false;
  for (const shift of ctx.activeTripsByShift) {
    if (shift.offsetSeconds !== 0) continue;
    for (const boarding of boardings) {
      if (shift.activeTripKeys.has(boarding.tripKey)) return true;
    }
  }
  return false;
}

/** 指定グループの近傍（walk半径内）で、その日に発着のあるバス停を挙げる。 */
function nearbyAlternatives(ctx, groupKey, limit = 3) {
  const index = ctx.searchIndex.index;
  const links = getFootpaths(ctx.searchIndex, WALK_RADIUS_RELAXED_METERS).get(groupKey) || [];
  const alternatives = [];
  for (const link of links) {
    if (!hasAnyServiceOnDate(ctx, link.groupKey)) continue;
    const group = index.groups.get(link.groupKey);
    if (!group) continue;
    alternatives.push({ ...serializeEndpoint(group), distanceMeters: link.distanceMeters, walkMinutes: Math.max(1, Math.round(link.walkSeconds / 60)) });
    if (alternatives.length >= limit) break;
  }
  return alternatives;
}

/* ==========================================================
 * 公開API
 * ========================================================== */

/**
 * 経路検索の本体。
 *
 * @param {object} options
 * @param {string} [options.fromStopKey] 出発地のstopKey（バス停検索・時刻表検索と共通）
 * @param {string} [options.from] 出発地の自由文字列
 * @param {number|string} [options.fromSpotId] 観光スポットIDを起点にする場合（優先度: spotId > stopKey > text）
 * @param {string} [options.toStopKey]
 * @param {string} [options.to]
 * @param {number|string} [options.toSpotId]
 * @param {string} [options.date] YYYY-MM-DD（既定: 本日）
 * @param {string} [options.time] HH:MM（既定: 本日なら現在時刻、他日なら05:00）
 * @param {'departure'|'arrival'} [options.timeMode] time の意味（既定: departure＝この時刻以降に出発）
 * @param {number} [options.limit] 返す経路数（既定5）
 * @param {number|string} [options.maxTransfers] 詳細設定：乗換回数の上限（0＝乗り換えなし。既定: 指定なし）
 * @param {boolean|string} [options.allowWalkTransfer] 詳細設定：徒歩での乗り継ぎを使うか（既定: true）
 * @param {number|string} [options.minTransferMinutes] 詳細設定：乗り換えの余裕時間（分。既定: 1）
 */
async function searchJourneys(options = {}) {
  const searchIndex = await getSearchIndex();
  const index = searchIndex.index;
  const today = todayString();
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(options.date || '')) ? options.date : today;
  const isToday = dateStr === today;
  const limit = Math.min(Math.max(Number.parseInt(options.limit || '5', 10) || 5, 1), 10);
  // 未指定・不正値は従来どおりの出発時刻指定として扱う（旧クライアントとの互換）
  const timeMode = options.timeMode === 'arrival' ? 'arrival' : 'departure';
  // 詳細設定（乗換回数の上限・徒歩での乗り継ぎ・乗換余裕）。未指定なら従来どおりの条件。
  const preferences = normalizeSearchPreferences(options);

  let baseSeconds = parseTimeToSeconds(options.time);
  if (!Number.isFinite(baseSeconds)) {
    if (timeMode === 'arrival') {
      // 到着時刻の既定値。始発時刻（05:00）を到着期限にすると何も見つからないため、
      // 本日は「1時間後までに到着」、他日は正午を既定とする。
      if (isToday) {
        const t = nowInTokyo();
        baseSeconds = t.hour * 3600 + t.minute * 60 + 3600;
      } else {
        baseSeconds = 12 * 3600;
      }
    } else if (isToday) {
      const t = nowInTokyo();
      baseSeconds = t.hour * 3600 + t.minute * 60;
    } else {
      baseSeconds = 5 * 3600;
    }
  }
  const baseTime = formatTime(baseSeconds);

  const origin = await resolveEndpoint(index, { stopKey: options.fromStopKey, text: options.from, spotId: options.fromSpotId });
  const destination = await resolveEndpoint(index, { stopKey: options.toStopKey, text: options.to, spotId: options.toSpotId });

  // preferences は成否にかかわらず必ず返す（画面が現在の詳細設定を復元・表示するのに使う）
  // gtfsValidity: 選択された日付が現在のGTFSデータの有効期間外なら、画面で
  // 「ダイヤが変更される可能性がある」旨を注意喚起する（成否にかかわらず返す）。
  const common = {
    date: dateStr,
    baseTime,
    isToday,
    timeMode,
    preferences: serializePreferences(preferences),
    gtfsValidity: describeDateValidity(index, dateStr)
  };

  if (origin.groups.length === 0 || destination.groups.length === 0) {
    const missingSide = origin.groups.length === 0 ? origin : destination;
    if (missingSide.spotNotFound) {
      return {
        found: false,
        ...common,
        reason: 'spot-not-found',
        message: '指定の観光スポットが見つかりませんでした。'
      };
    }
    if (missingSide.spotHasNoNearbyStops) {
      return {
        found: false,
        ...common,
        reason: 'spot-no-nearby-stop',
        message: `「${missingSide.viaSpot.name}」の近くに徒歩圏内のバス停が見つかりませんでした。`
      };
    }
    const missing = missingSide.query;
    const suggestions = missing ? await searchStops(missing, 5) : [];
    return {
      found: false,
      ...common,
      reason: 'stop-not-found',
      message: `「${missing}」に一致するバス停が見つかりませんでした。`,
      suggestions
    };
  }

  const originKeys = new Set(origin.groups.map((group) => group.groupKey));
  const destinationKeys = new Set(destination.groups.map((group) => group.groupKey));
  // 同一バス停を指しているものは目的地から外す（同名統合された大きなバス停の内側移動を防ぐ）
  for (const key of originKeys) destinationKeys.delete(key);

  if (destinationKeys.size === 0) {
    return {
      found: false,
      ...common,
      from: serializeEndpoint(origin.groups[0]),
      to: serializeEndpoint(destination.groups[0]),
      reason: 'same-stop',
      message: '出発地と目的地が同じバス停です。目的地を変更してください。'
    };
  }

  // 探索の基準時刻。出発時刻指定は出発地に、到着時刻指定は目的地に置く。
  // 観光スポットを目的地にした場合は「スポットに指定時刻までに着く」必要があるため、
  // バス停ごとにスポットまでの徒歩時間を差し引いた時刻を到着期限にする。
  const searchTimes = new Map();
  if (timeMode === 'arrival') {
    for (const key of destinationKeys) {
      const spotWalk = buildSpotWalkInfo(destination, key);
      searchTimes.set(key, baseSeconds - (spotWalk ? spotWalk.walkMinutes * 60 : 0));
    }
  } else {
    for (const key of originKeys) searchTimes.set(key, baseSeconds);
  }
  const searchTargets = timeMode === 'arrival' ? originKeys : destinationKeys;

  // 表示件数より少し多めに集めておく。リアルタイム反映後に「間に合わない乗換」が
  // 判明した案を後段で押し下げても、代わりに出せる候補が残るようにするため。
  const bufferLimit = Math.min(limit + 3, 10);

  // 段階的フォールバック（仕様書7章）
  const searchArgs = { searchIndex, dateStr, searchTimes, searchTargets, bufferLimit, timeMode };
  const { journeys, relaxation, ctx } = runRelaxationSearch({ ...searchArgs, preferences });

  if (journeys.length === 0) {
    // 詳細設定が原因で0件になったのかを切り分ける。設定を外せば見つかるなら、
    // 「日付・時刻を変えてください」ではなく「設定を外して検索」を案内する方が正しい。
    if (!preferences.isDefault) {
      const withoutPreferences = runRelaxationSearch({ ...searchArgs, preferences: DEFAULT_PREFERENCES });
      if (withoutPreferences.journeys.length > 0) {
        return {
          found: false,
          ...common,
          from: serializeEndpoint(origin.groups[0]),
          to: serializeEndpoint(destination.groups[0]),
          reason: 'no-route-with-conditions',
          message: '詳細設定の条件に合う経路が見つかりませんでした。',
          // 設定を外せば経路があると分かっているので、画面に解除の導線を出させる
          canRelaxPreferences: true
        };
      }
    }
    return buildNotFoundResponse({
      searchIndex,
      ctx,
      common,
      origin,
      destination,
      originKeys,
      destinationKeys,
      dateStr,
      baseSeconds,
      limit,
      timeMode,
      preferences
    });
  }

  const sorted = sortJourneys(journeys, timeMode).slice(0, bufferLimit);
  const fareIndex = await getFareIndex();
  attachFares(fareIndex, sorted);
  if (isToday) await attachRealtime(sorted, preferences.minTransferSeconds);

  // リアルタイム反映で「乗換が間に合わない可能性」が判明した案は、
  // 他に間に合う候補があれば後ろへ回してから表示件数まで切り詰める。
  const feasible = sorted.filter((journey) => !journey.transferAtRisk);
  const risky = sorted.filter((journey) => journey.transferAtRisk);
  const ranked = (feasible.length > 0 ? feasible.concat(risky) : risky).slice(0, limit);
  pickRecommended(ranked, timeMode);

  // 徒歩だけで行ける距離かどうかの補足（「そもそも歩いた方が早い」ケースの案内）
  const walkableHint = findWalkableHint(searchIndex, originKeys, destinationKeys);

  // あいまい一致では候補が複数あるため、実際に採用された経路の端点を正とする。
  // 「候補の1件目」を表示してしまうと、経路の乗車バス停と食い違う。
  const representative = ranked.find((journey) => journey.isRecommended) || ranked[0];
  const actualFromKey = representative.legs[0].fromStop.stopKey;
  const actualToKey = representative.legs[representative.legs.length - 1].toStop.stopKey;

  // スポット起点/終点の場合、スポット⇔バス停の徒歩レグを経路自体に組み込む。
  // actualFromKey/actualToKeyは組み込み前（=実際に乗降するバス停）を指すのでこの後に呼ぶ。
  attachSpotWalkLegs(ranked, origin, destination);

  return {
    found: true,
    ...common,
    from: serializeEndpoint(index.groups.get(actualFromKey) || origin.groups[0]),
    to: serializeEndpoint(index.groups.get(actualToKey) || destination.groups[0]),
    // 観光スポットを起点/終点にした場合の元スポット情報（観光スポット情報_仕様書）。
    // 「〈松本城〉から徒歩○分の△△バス停発」のような注記に使う。
    viaSpotFrom: origin.viaSpot
      ? { spotId: origin.viaSpot.spotId, name: origin.viaSpot.name, ...buildSpotWalkInfo(origin, actualFromKey) }
      : null,
    viaSpotTo: destination.viaSpot
      ? { spotId: destination.viaSpot.spotId, name: destination.viaSpot.name, ...buildSpotWalkInfo(destination, actualToKey) }
      : null,
    fuzzy: origin.fuzzy || destination.fuzzy,
    fuzzyFrom: origin.fuzzy ? origin.groups.map(serializeEndpoint) : null,
    fuzzyTo: destination.fuzzy ? destination.groups.map(serializeEndpoint) : null,
    relaxation,
    relaxationNote: buildRelaxationNote(ranked, relaxation, timeMode),
    walkableHint,
    journeys: ranked
  };
}

/**
 * 結果に添える注記。日跨ぎ（翌日の便・前日の便）を拾った場合はそれを優先して伝える。
 * 到着時刻指定では、指定時刻より前にこの日の便が無いと前日の深夜便になり得る。
 */
function buildRelaxationNote(journeys, relaxation, timeMode) {
  if (journeys.some((journey) => journey.departureDayOffset > 0)) {
    return '指定時刻以降にこの日の便が無いため、翌日の便を表示しています。';
  }
  if (journeys.some((journey) => journey.departureDayOffset < 0)) {
    return '指定時刻までに間に合う便がこの日に無いため、前日の深夜便を表示しています。';
  }
  const notes = timeMode === 'arrival' ? RELAXATION_NOTES_ARRIVAL : RELAXATION_NOTES;
  return notes[relaxation] || null;
}

function findWalkableHint(searchIndex, originKeys, destinationKeys) {
  const footpaths = getFootpaths(searchIndex, WALK_RADIUS_RELAXED_METERS);
  for (const originKey of originKeys) {
    for (const link of footpaths.get(originKey) || []) {
      if (destinationKeys.has(link.groupKey)) {
        return {
          walkMinutes: Math.max(1, Math.round(link.walkSeconds / 60)),
          distanceMeters: link.distanceMeters
        };
      }
    }
  }
  return null;
}

/**
 * どうしても見つからなかった場合の応答。
 * 「次に運行がある日」を7日先まで探し、利用者が次に取れる行動を必ず示す（仕様書 6.6）。
 */
function buildNotFoundResponse({ searchIndex, ctx, common, origin, destination, originKeys, destinationKeys, dateStr, baseSeconds, limit, timeMode = 'departure', preferences = DEFAULT_PREFERENCES }) {
  const base = {
    found: false,
    ...common,
    from: serializeEndpoint(origin.groups[0]),
    to: serializeEndpoint(destination.groups[0])
  };

  // 出発地・目的地に、その日そもそも便が無いケース
  const originHasService = Array.from(originKeys).some((key) => hasAnyServiceOnDate(ctx, key));
  const destinationHasService = Array.from(destinationKeys).some((key) => hasAnyServiceOnDate(ctx, key));
  if (!originHasService || !destinationHasService) {
    const targetKey = !originHasService ? origin.groups[0].groupKey : destination.groups[0].groupKey;
    const label = !originHasService ? '出発地' : '目的地';
    return {
      ...base,
      reason: 'no-service-at-stop',
      // 日付は画面側が「8月11日（火）」形式で別に表示するため、文言には入れない
      message: `この日は${label}のバス停に発着する便がありません。`,
      alternatives: nearbyAlternatives(ctx, targetKey)
    };
  }

  // その日の始発から順向きに探し直す（時刻の指定だけが原因のケースの切り分けに使う）。
  // 到着時刻指定では「その日の最も早い到着」を、出発時刻指定では「その日の始発」を案内する。
  // 案内する「始発」「次の運行日」も詳細設定を満たすものでなければ意味が無いので、
  // ここでも同じ条件（最も緩い段階に詳細設定を反映したもの）で探す。
  const findFirstJourneysOfDay = (targetDate) => {
    const earlyCtx = buildContext(searchIndex, targetDate, applyPreferencesToStep(RELAXATION_STEPS[2], preferences));
    const earlyTimes = new Map();
    for (const key of originKeys) earlyTimes.set(key, 0);
    return collectJourneys(earlyCtx, earlyTimes, destinationKeys, 1);
  };
  const earliestArrivalOf = (journeys) => Math.min(...journeys.map((journey) => journey.arrivalSeconds));

  if (timeMode === 'arrival') {
    // 指定した到着時刻が早すぎたケース
    const earlyJourneys = findFirstJourneysOfDay(dateStr);
    if (earlyJourneys.length > 0 && earliestArrivalOf(earlyJourneys) > baseSeconds) {
      return {
        ...base,
        reason: 'before-first-bus',
        message: `${common.baseTime} までにこの区間へ到着する便はありません。`,
        // label は画面側が日付表記を組み立てられるよう kind で渡す
        suggestion: {
          kind: 'first-arrival',
          date: dateStr,
          time: formatTime(earliestArrivalOf(earlyJourneys)),
          timeMode
        }
      };
    }
  } else if (baseSeconds > 4 * 3600) {
    // 同じ日の始発から探し直す（時刻が遅すぎただけのケース）
    const earlyJourneys = findFirstJourneysOfDay(dateStr);
    if (earlyJourneys.length > 0) {
      return {
        ...base,
        reason: 'after-last-bus',
        message: `${common.baseTime} 以降にこの区間を結ぶ便はありません。`,
        // label は画面側が日付表記を組み立てられるよう kind で渡す
        suggestion: {
          kind: 'first-bus',
          date: dateStr,
          time: formatTime(earlyJourneys[0].departureSeconds),
          timeMode
        }
      };
    }
  }

  // 翌日以降で最初に成立する日を探す
  for (let i = 1; i <= NEXT_SERVICE_DAY_LOOKAHEAD; i += 1) {
    const candidateDate = shiftDate(dateStr, i);
    const candidateJourneys = findFirstJourneysOfDay(candidateDate);
    if (candidateJourneys.length > 0) {
      return {
        ...base,
        reason: 'no-service-on-date',
        message: 'この日はこの区間を結ぶ便がありません。',
        suggestion: {
          kind: 'next-service-day',
          date: candidateDate,
          // 到着時刻指定のときは、そのままフォームの到着時刻に入れられる値を返す
          time: formatTime(
            timeMode === 'arrival'
              ? earliestArrivalOf(candidateJourneys)
              : candidateJourneys[0].departureSeconds
          ),
          timeMode
        }
      };
    }
  }

  return {
    ...base,
    reason: 'no-route',
    message: 'この区間を結ぶ経路が見つかりませんでした。バス停を選び直してみてください。',
    alternatives: nearbyAlternatives(ctx, destination.groups[0].groupKey)
  };
}

/**
 * 出発地・目的地の候補検索。時刻表検索・バス停検索とまったく同じ検索
 * （漢字・ひらがな・カタカナ・ローマ字対応）を経路検索でも使う（仕様書 3.1）。
 */
async function searchRouteSearchStops(query, limit = 20) {
  const stops = await searchStops(query, limit);
  return stops.map((stop) => ({
    stopKey: stop.stopKey,
    name: stop.stopName,
    kana: stop.nameHiragana,
    romaji: stop.nameRomaji,
    platformCount: stop.platformCount,
    lat: stop.lat,
    lon: stop.lon,
    routes: stop.routes
  }));
}

module.exports = {
  searchJourneys,
  searchRouteSearchStops,
  // 調査・将来の再利用向け
  getSearchIndex
};
