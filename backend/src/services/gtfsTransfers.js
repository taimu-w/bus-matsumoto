// GTFS transfers.txt（任意ファイル）の min_transfer_time を、経路検索の乗換に必要な時間として引く。
//
// 経路検索（gtfsRouteSearch.js）はバス停グループ単位で探索するが、乗換時間の指定は
// 標柱（stop_id）単位なので、「降車した標柱 → 乗車する標柱」の組で引く。
// 指定がある組だけ、既定の乗換時間（同一バス停なら乗換余裕、徒歩乗継なら徒歩所要時間＋乗換余裕）を
// この値で置き換える。指定が無い組・transfers.txt を持たないフィードの挙動は一切変わらない。
//
// DB・ファイルI/Oを持たない純ロジック（CSVの行は gtfsTimetable.js が読んで渡す）。

const TRANSFER_TYPE_NOT_POSSIBLE = 3;

/** 空の索引。gtfsTimetable.js のインデックス（index.transfers）に1つだけ持つ。 */
function createTransferIndex() {
  return {
    // 降車標柱 → { minSeconds, byStop: 乗車標柱 → rule[] }（出発時刻指定の探索で引く向き）
    byFrom: new Map(),
    // 乗車標柱 → { minSeconds, byStop: 降車標柱 → rule[] }（到着時刻指定の探索で引く向き）
    byTo: new Map(),
    size: 0
  };
}

/**
 * transfers.txt の行を、標柱キー単位の規則に変換する。
 *
 * - min_transfer_time が空・不正な行は使わない（乗換時間の指定ではないため）。
 * - transfer_type が 3（乗換不可）以上（4・5＝乗ったままの乗継）の行は、乗換時間の指定ではないので使わない。
 * - from_stop_id / to_stop_id が駅（親停留所）を指す場合は、その配下の標柱すべてに展開する。
 * - from_route_id / to_route_id / from_trip_id / to_trip_id は、指定があればその便・路線どうしの
 *   乗換にだけ効く条件として保持する（lookupMinTransferSeconds が具体的なものを優先する）。
 *
 * @param {object[]} rows transfers.txt の行
 * @param {{feedId: string, makeKey: (feedId: string, id: string) => string,
 *          childStopIdsByParent?: Map<string, string[]>}} options
 */
function parseTransferRules(rows, { feedId, makeKey, childStopIdsByParent = new Map() }) {
  const rules = [];
  const keyOrNull = (value) => {
    const id = String(value || '').trim();
    return id ? makeKey(feedId, id) : null;
  };
  const expand = (stopId) => {
    const children = childStopIdsByParent.get(stopId);
    return children && children.length > 0 ? children : [stopId];
  };

  for (const row of rows || []) {
    const transferType = Number.parseInt(row.transfer_type || '0', 10) || 0;
    if (transferType >= TRANSFER_TYPE_NOT_POSSIBLE) continue;

    const rawSeconds = String(row.min_transfer_time ?? '').trim();
    if (!/^\d+$/.test(rawSeconds)) continue;
    const seconds = Number.parseInt(rawSeconds, 10);

    const fromStopId = String(row.from_stop_id || '').trim();
    const toStopId = String(row.to_stop_id || '').trim();
    if (!fromStopId || !toStopId) continue;

    const conditions = {
      fromRouteKey: keyOrNull(row.from_route_id),
      toRouteKey: keyOrNull(row.to_route_id),
      fromTripKey: keyOrNull(row.from_trip_id),
      toTripKey: keyOrNull(row.to_trip_id)
    };
    for (const from of expand(fromStopId)) {
      for (const to of expand(toStopId)) {
        rules.push({
          fromStopKey: makeKey(feedId, from),
          toStopKey: makeKey(feedId, to),
          ...conditions,
          seconds
        });
      }
    }
  }
  return rules;
}

function addToSide(sideMap, outerKey, innerKey, rule) {
  let entry = sideMap.get(outerKey);
  if (!entry) {
    entry = { minSeconds: rule.seconds, byStop: new Map() };
    sideMap.set(outerKey, entry);
  }
  entry.minSeconds = Math.min(entry.minSeconds, rule.seconds);
  if (!entry.byStop.has(innerKey)) entry.byStop.set(innerKey, []);
  entry.byStop.get(innerKey).push(rule);
}

/** parseTransferRules() の結果を索引へ追加する（フィードごとに呼ぶ）。 */
function addTransferRules(transferIndex, rules) {
  for (const rule of rules) {
    addToSide(transferIndex.byFrom, rule.fromStopKey, rule.toStopKey, rule);
    addToSide(transferIndex.byTo, rule.toStopKey, rule.fromStopKey, rule);
    transferIndex.size += 1;
  }
}

/**
 * 条件に合う規則のうち最も具体的なもの（便指定 > 路線指定 > 標柱のみ）の秒数を返す。
 * 同じ具体度なら先に書かれた行を採る。
 *
 * @param {object[]|undefined} rules 標柱の組（降車→乗車）に一致する規則
 * @param {{tripKey?: string, routeKey?: string}} fromTrip 降りる便
 * @param {{tripKey?: string, routeKey?: string}} toTrip 乗る便
 */
function selectSeconds(rules, fromTrip, toTrip) {
  if (!rules || rules.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const rule of rules) {
    if (rule.fromTripKey && rule.fromTripKey !== fromTrip.tripKey) continue;
    if (rule.toTripKey && rule.toTripKey !== toTrip.tripKey) continue;
    if (rule.fromRouteKey && rule.fromRouteKey !== fromTrip.routeKey) continue;
    if (rule.toRouteKey && rule.toRouteKey !== toTrip.routeKey) continue;
    const score =
      (rule.fromTripKey ? 4 : 0) + (rule.toTripKey ? 4 : 0) +
      (rule.fromRouteKey ? 1 : 0) + (rule.toRouteKey ? 1 : 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best ? best.seconds : null;
}

/**
 * 降車標柱 → 乗車標柱の乗換に指定された最低乗換時間（秒）。指定が無ければ null。
 *
 * @param {ReturnType<typeof createTransferIndex>|undefined} transferIndex
 * @param {string} fromStopKey 降りた標柱
 * @param {string} toStopKey 乗る標柱
 * @param {{tripKey?: string, routeKey?: string}} [fromTrip]
 * @param {{tripKey?: string, routeKey?: string}} [toTrip]
 */
function lookupMinTransferSeconds(transferIndex, fromStopKey, toStopKey, fromTrip = {}, toTrip = {}) {
  if (!transferIndex || transferIndex.size === 0) return null;
  const entry = transferIndex.byFrom.get(fromStopKey);
  if (!entry) return null;
  return selectSeconds(entry.byStop.get(toStopKey), fromTrip, toTrip);
}

module.exports = {
  createTransferIndex,
  parseTransferRules,
  addTransferRules,
  lookupMinTransferSeconds
};
