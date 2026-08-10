// 乗り換え案内対応のリアルタイムルート検索サービス
//
// 判定の単位は常に「便（daily_trip）ごとの daily_trip_stop_times」であり、
// バス停マスタ（stops）側の seq_order は路線内の代表順序でしかないため使わない。
// 循環路線や同名停留所を複数回通る便で、出発地より手前の到着時刻を誤って
// 拾わないようにするため（要望書5.2）。
const { getArrivalsForAssignment } = require('./etaPredictor');
const { timeStrToMinutes } = require('../utils/time');

const DEFAULT_LIMIT = 3;

/**
 * バス停名の部分一致検索（全路線対応）
 * @param {boolean} distinct - true の場合は同名バス停を重複除去（フロントエンドのサジェスト用）
 */
async function searchStops(pool, routeId, query, distinct = false) {
  const normalizedRouteId = routeId ? require('./gtfsData').resolveRouteId(routeId) : null;

  let result;
  if (normalizedRouteId) {
    result = await pool.query(
      `SELECT id, direction_id, seq_order, name, lat, lon, route_id
       FROM stops
       WHERE route_id = $1 AND name ILIKE $2
       ORDER BY direction_id ASC, seq_order ASC`,
      [normalizedRouteId, `%${query}%`]
    );
  } else if (distinct) {
    result = await pool.query(
      `SELECT DISTINCT ON (name) id, direction_id, seq_order, name, lat, lon, route_id
       FROM stops
       WHERE name ILIKE $1
       ORDER BY name ASC, route_id ASC, direction_id ASC, seq_order ASC`,
      [`%${query}%`]
    );
  } else {
    result = await pool.query(
      `SELECT id, direction_id, seq_order, name, lat, lon, route_id
       FROM stops
       WHERE name ILIKE $1
       ORDER BY route_id ASC, direction_id ASC, seq_order ASC`,
      [`%${query}%`]
    );
  }
  return result.rows;
}

/**
 * 経路検索の候補選択用：バス停名でグルーピングした候補一覧を返す。
 * 停留所名・読み・利用路線・乗り場数を返す（要望書5.1・6.1）。
 * ここで返す `name` が、この機能内で「確定済み停留所識別子（stopKey）」として扱われる値になる。
 * 時刻表検索機能（gtfsTimetable.js）の GTFS ベースの stopKey とはデータ経路が別であり、無関係。
 */
async function searchStopCandidates(pool, query, limit = 20) {
  if (!query || !query.trim()) return [];

  const grouped = await pool.query(
    `SELECT name,
            (array_agg(name_kana ORDER BY name_kana NULLS LAST))[1] AS name_kana,
            COUNT(DISTINCT id) AS platform_count,
            array_agg(DISTINCT route_id) AS route_ids
     FROM stops
     WHERE name ILIKE $1
     GROUP BY name
     ORDER BY name ASC
     LIMIT $2`,
    [`%${query}%`, limit]
  );

  const allRouteIds = [...new Set(grouped.rows.flatMap((row) => row.route_ids))];
  const routeNameById = new Map();
  if (allRouteIds.length > 0) {
    const routesResult = await pool.query(
      `SELECT id, name, short_name FROM routes WHERE id = ANY($1::text[])`,
      [allRouteIds]
    );
    routesResult.rows.forEach((r) => routeNameById.set(r.id, r.short_name || r.name));
  }

  return grouped.rows.map((row) => ({
    stopKey: row.name,
    name: row.name,
    kana: row.name_kana || null,
    platformCount: Number(row.platform_count),
    routes: row.route_ids.map((id) => ({ id, name: routeNameById.get(id) || id }))
  }));
}

/**
 * 停留所名の自由文字列（候補未選択時）から、部分一致する停留所名の候補を返す。
 * 要望書5.1「候補を選ばずに検索した場合は名称検索を許可する」に対応。
 */
async function resolveStopNameCandidates(pool, text, limit = 5) {
  if (!text || !text.trim()) return [];
  const result = await pool.query(
    `SELECT DISTINCT name FROM stops WHERE name ILIKE $1 ORDER BY name ASC LIMIT $2`,
    [`%${text.trim()}%`, limit]
  );
  return result.rows.map((r) => r.name);
}

/**
 * 出発地名・目的地名の組について、便単位で有効な区間候補を探す。
 * routeId を指定するとその路線内のみに絞る（乗換の各区間で使用）。
 *
 * 各便について、出発地名の最初の出現を乗車地点、その後（seq_orderが大きい方）に
 * 最初に現れる目的地名の出現を降車地点として確定する。乗車・降車のいずれかが
 * 見つからない、または降車が乗車より前にしか無い便は候補から除外する。
 *
 * リアルタイム予測は乗車・降車それぞれ独立に「予測があれば予測時刻、無ければ定刻」を
 * 採用する。担当車両が付いている便でも、その便の予測が一部しか無いケース（要望書2.1）
 * で便ごと候補から消えないようにするため。
 */
async function findLegCandidates(pool, { fromName, toName, departureMinutes, serviceDate, routeId }) {
  const params = [fromName, toName, serviceDate];
  let routeFilter;
  if (routeId) {
    params.push(routeId);
    routeFilter = `AND d.route_id = $4`;
  } else {
    routeFilter = `AND d.route_id IN (
      SELECT DISTINCT s1.route_id FROM stops s1
      JOIN stops s2 ON s2.route_id = s1.route_id
      WHERE s1.name = $1 AND s2.name = $2
    )`;
  }

  const result = await pool.query(
    `SELECT d.id AS trip_id, d.route_id, d.headsign AS trip_headsign,
            r.name AS route_name, r.short_name AS route_short_name,
            dst.seq_order, dst.scheduled_time,
            s.id AS stop_id, s.name AS stop_name
     FROM daily_trips d
     JOIN routes r ON r.id = d.route_id
     JOIN daily_trip_stop_times dst ON dst.daily_trip_id = d.id
     JOIN stops s ON s.id = dst.stop_id
     WHERE d.service_date = $3
       AND s.name IN ($1, $2)
       AND dst.scheduled_time IS NOT NULL
       ${routeFilter}
     ORDER BY d.id ASC, dst.seq_order ASC`,
    params
  );

  const tripsById = new Map();
  for (const row of result.rows) {
    if (!tripsById.has(row.trip_id)) {
      tripsById.set(row.trip_id, {
        tripId: row.trip_id,
        routeId: row.route_id,
        routeName: row.route_name || row.route_short_name || row.route_id,
        headsign: row.trip_headsign,
        rows: []
      });
    }
    tripsById.get(row.trip_id).rows.push(row);
  }

  const rawCandidates = [];
  for (const trip of tripsById.values()) {
    const boardRow = trip.rows.find((r) => r.stop_name === fromName);
    if (!boardRow) continue;
    const alightRow = trip.rows.find((r) => r.stop_name === toName && r.seq_order > boardRow.seq_order);
    if (!alightRow) continue;

    const boardMinutes = timeStrToMinutes(boardRow.scheduled_time);
    if (Number.isNaN(boardMinutes) || boardMinutes < departureMinutes) continue;

    rawCandidates.push({ trip, boardRow, alightRow });
  }

  if (rawCandidates.length === 0) return [];

  // 担当車両が付いている便のリアルタイム予測をまとめて取得する
  const tripIds = rawCandidates.map((c) => c.trip.tripId);
  const assignmentResult = await pool.query(
    `SELECT daily_trip_id, id FROM trip_vehicle_assignments
     WHERE daily_trip_id = ANY($1::bigint[]) AND role = 'assigned' AND state = 'active'`,
    [tripIds]
  );
  const assignmentByTrip = new Map(assignmentResult.rows.map((r) => [r.daily_trip_id, r.id]));

  const predictionsByTrip = new Map();
  for (const [tripId, assignmentId] of assignmentByTrip) {
    const predictions = await getArrivalsForAssignment(pool, assignmentId);
    predictionsByTrip.set(tripId, predictions);
  }

  const candidates = [];
  for (const c of rawCandidates) {
    const predictions = predictionsByTrip.get(c.trip.tripId);
    const boardPrediction = predictions?.find((p) => p.stopId === c.boardRow.stop_id);
    const alightPrediction = predictions?.find((p) => p.stopId === c.alightRow.stop_id);

    const departureTime = boardPrediction ? boardPrediction.predictedTime : c.boardRow.scheduled_time;
    const arrivalTime = alightPrediction ? alightPrediction.predictedTime : c.alightRow.scheduled_time;
    const arrivalMinutes = timeStrToMinutes(arrivalTime);
    if (Number.isNaN(arrivalMinutes)) continue;

    // 表示する到着時刻がリアルタイム予測由来かどうかで判定する（到着時刻の信頼性を表すため）
    const realtime = !!alightPrediction;
    const delayMinutes = alightPrediction ? (alightPrediction.predictedDelayMinutes || 0) : 0;

    candidates.push({
      tripId: c.trip.tripId,
      routeId: c.trip.routeId,
      routeName: c.trip.routeName,
      headsign: c.trip.headsign || null,
      fromStop: fromName,
      toStop: toName,
      departureTime,
      arrivalTime,
      realtime,
      delayMinutes
    });
  }

  return candidates;
}

function durationBetween(departureTime, arrivalTime) {
  const departureMinutes = timeStrToMinutes(departureTime);
  const arrivalMinutes = timeStrToMinutes(arrivalTime);
  let duration = arrivalMinutes - departureMinutes;
  if (duration < 0) duration += 24 * 60;
  return duration;
}

function legToResponseLeg(leg) {
  return {
    routeId: leg.routeId,
    routeName: leg.routeName,
    headsign: leg.headsign,
    fromStop: leg.fromStop,
    toStop: leg.toStop,
    departureTime: leg.departureTime,
    arrivalTime: leg.arrivalTime,
    realtime: leg.realtime,
    delayMinutes: leg.delayMinutes
  };
}

function formatDirectRoute(leg) {
  return {
    type: 'direct',
    isRecommended: false,
    departureTime: leg.departureTime,
    arrivalTime: leg.arrivalTime,
    durationMinutes: durationBetween(leg.departureTime, leg.arrivalTime),
    realtime: leg.realtime,
    legs: [legToResponseLeg(leg)]
  };
}

function formatTransferRoute(firstLeg, secondLeg, transferStopName) {
  let transferWaitMinutes = timeStrToMinutes(secondLeg.departureTime) - timeStrToMinutes(firstLeg.arrivalTime);
  if (transferWaitMinutes < 0) transferWaitMinutes += 24 * 60;

  return {
    type: 'transfer',
    isRecommended: false,
    departureTime: firstLeg.departureTime,
    arrivalTime: secondLeg.arrivalTime,
    durationMinutes: durationBetween(firstLeg.departureTime, secondLeg.arrivalTime),
    realtime: firstLeg.realtime && secondLeg.realtime,
    transferStop: transferStopName,
    transferWaitMinutes,
    legs: [legToResponseLeg(firstLeg), legToResponseLeg(secondLeg)]
  };
}

/**
 * 直通候補を検索する（要望書5.2・5.3）。到着の早い順に最大 limit 件。
 */
async function searchDirectRoutes(pool, fromName, toName, departureMinutes, serviceDate, limit = DEFAULT_LIMIT) {
  if (fromName === toName) return [];
  const candidates = await findLegCandidates(pool, { fromName, toName, departureMinutes, serviceDate });
  candidates.sort((a, b) => timeStrToMinutes(a.arrivalTime) - timeStrToMinutes(b.arrivalTime));
  return candidates.slice(0, limit).map(formatDirectRoute);
}

/**
 * 乗換1回までの候補を検索する（直通が無い場合のみ呼ぶ想定、要望書5.2）。
 * 出発地側の路線・目的地側の路線の組み合わせごとに、同名の共通停留所を乗換地点として試す。
 */
async function searchTransferRoutes(pool, fromName, toName, departureMinutes, serviceDate, limit = DEFAULT_LIMIT) {
  if (fromName === toName) return [];

  const fromRoutesResult = await pool.query('SELECT DISTINCT route_id FROM stops WHERE name = $1', [fromName]);
  const toRoutesResult = await pool.query('SELECT DISTINCT route_id FROM stops WHERE name = $1', [toName]);
  const fromRoutes = fromRoutesResult.rows.map((r) => r.route_id);
  const toRoutes = toRoutesResult.rows.map((r) => r.route_id);
  if (fromRoutes.length === 0 || toRoutes.length === 0) return [];

  const transferOptions = [];
  for (const fromRoute of fromRoutes) {
    for (const toRoute of toRoutes) {
      if (fromRoute === toRoute) continue;
      const commonResult = await pool.query(
        `SELECT DISTINCT s1.name FROM stops s1
         JOIN stops s2 ON s2.name = s1.name AND s2.route_id = $2
         WHERE s1.route_id = $1 AND s1.name NOT IN ($3, $4)`,
        [fromRoute, toRoute, fromName, toName]
      );
      commonResult.rows.forEach((row) => transferOptions.push({ fromRoute, toRoute, transferName: row.name }));
    }
  }

  const results = [];
  const seen = new Set();
  for (const opt of transferOptions) {
    const firstLegs = await findLegCandidates(pool, {
      fromName, toName: opt.transferName, departureMinutes, serviceDate, routeId: opt.fromRoute
    });
    if (firstLegs.length === 0) continue;
    firstLegs.sort((a, b) => timeStrToMinutes(a.arrivalTime) - timeStrToMinutes(b.arrivalTime));
    const firstLeg = firstLegs[0];

    const secondLegs = await findLegCandidates(pool, {
      fromName: opt.transferName, toName, departureMinutes: timeStrToMinutes(firstLeg.arrivalTime),
      serviceDate, routeId: opt.toRoute
    });
    if (secondLegs.length === 0) continue;
    secondLegs.sort((a, b) => timeStrToMinutes(a.arrivalTime) - timeStrToMinutes(b.arrivalTime));
    const secondLeg = secondLegs[0];

    const dedupeKey = `${firstLeg.tripId}|${secondLeg.tripId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    results.push(formatTransferRoute(firstLeg, secondLeg, opt.transferName));
  }

  results.sort((a, b) => timeStrToMinutes(a.arrivalTime) - timeStrToMinutes(b.arrivalTime));
  return results.slice(0, limit);
}

/**
 * 経路検索のエントリポイント。直通を優先し、無ければ乗換1回までを探す（要望書5.2）。
 * fromNames/toNames は複数候補（自由文字列検索時のあいまい一致）を許容する。
 */
async function searchRoutes(pool, { fromNames, toNames, departureTime, serviceDate }) {
  const departureMinutes = timeStrToMinutes(departureTime);
  const pairs = [];
  for (const fromName of fromNames) {
    for (const toName of toNames) {
      if (fromName !== toName) pairs.push([fromName, toName]);
    }
  }

  let routes = [];
  for (const [fromName, toName] of pairs) {
    const direct = await searchDirectRoutes(pool, fromName, toName, departureMinutes, serviceDate, DEFAULT_LIMIT);
    routes.push(...direct);
  }
  routes.sort((a, b) => timeStrToMinutes(a.arrivalTime) - timeStrToMinutes(b.arrivalTime));
  routes = routes.slice(0, DEFAULT_LIMIT);

  if (routes.length === 0) {
    let transferRoutes = [];
    for (const [fromName, toName] of pairs) {
      const transfer = await searchTransferRoutes(pool, fromName, toName, departureMinutes, serviceDate, DEFAULT_LIMIT);
      transferRoutes.push(...transfer);
    }
    transferRoutes.sort((a, b) => timeStrToMinutes(a.arrivalTime) - timeStrToMinutes(b.arrivalTime));
    routes = transferRoutes.slice(0, DEFAULT_LIMIT);
  }

  if (routes.length > 0) routes[0].isRecommended = true;
  return routes;
}

module.exports = {
  searchStops,
  searchStopCandidates,
  resolveStopNameCandidates,
  searchDirectRoutes,
  searchTransferRoutes,
  searchRoutes
};
