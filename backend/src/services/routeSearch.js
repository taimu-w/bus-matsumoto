// 乗り換え案内対応のリアルタイムルート検索サービス
const { getArrivalsForAssignment } = require('./etaPredictor');
const { timeStrToMinutes, minutesToTimeStr, getServiceDateString } = require('../utils/time');

/**
 * バス停名の部分一致検索（全路線対応）
 * @param {boolean} distinct - true の場合は同名バス停を重複除去（フロントエンドのサジェスト用）
 */
async function searchStops(pool, routeId, query, distinct = false) {
  const normalizedRouteId = routeId ? require('./gtfsData').resolveRouteId(routeId) : null;
  
  let result;
  if (normalizedRouteId) {
    // 特定路線内で検索
    result = await pool.query(
      `SELECT id, direction_id, seq_order, name, lat, lon, route_id
       FROM stops
       WHERE route_id = $1 AND name ILIKE $2
       ORDER BY direction_id ASC, seq_order ASC`,
      [normalizedRouteId, `%${query}%`]
    );
  } else if (distinct) {
    // 全路線から検索（フロントエンド表示用：重複除去）
    result = await pool.query(
      `SELECT DISTINCT ON (name) id, direction_id, seq_order, name, lat, lon, route_id
       FROM stops
       WHERE name ILIKE $1
       ORDER BY name ASC, route_id ASC, direction_id ASC, seq_order ASC`,
      [`%${query}%`]
    );
  } else {
    // 全路線から検索（ルート検索用：全件取得）
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
 * 指定された路線・バス停名に合致する全 stop_id を取得（上り下り区別なし）
 */
async function getStopsByName(pool, routeId, stopName) {
  const result = await pool.query(
    `SELECT id, direction_id, seq_order, name, lat, lon FROM stops
     WHERE route_id = $1 AND name = $2
     ORDER BY direction_id ASC, seq_order ASC`,
    [routeId, stopName]
  );
  return result.rows;
}

/**
 * リアルタイム候補を取得
 * バス停名ベースで検索（上り下り区別なし）
 *
 * 対象は「担当車両が割り当てられている当日便」のみ。候補車両は内部処理だけで
 * 利用者向けには公開しない（仕様書 9.1・15）。
 */
async function getRealtimeCandidates(pool, routeId, boardStopName) {
  const normalizedRouteId = require('./gtfsData').resolveRouteId(routeId);
  const serviceDate = getServiceDateString();

  const trips = await pool.query(
    `SELECT d.id AS daily_trip_id, d.start_time, a.id AS assignment_id, a.delay_minutes, v.car_id
     FROM daily_trips d
     JOIN trip_vehicle_assignments a
       ON a.daily_trip_id = d.id AND a.role = 'assigned' AND a.state = 'active'
     JOIN vehicles v ON v.id = a.vehicle_id
     WHERE d.route_id = $1
       AND d.service_date = $2
       AND d.closed_at IS NULL
     ORDER BY d.start_at ASC`,
    [normalizedRouteId, serviceDate]
  );

  const candidates = [];

  for (const t of trips.rows) {
    // この便の経路上にある、乗車バス停名に合致する停留所の進捗を取る
    const boardStopResult = await pool.query(
      `SELECT s.id, s.seq_order, s.direction_id, p.status
       FROM trip_stop_progress p
       JOIN stops s ON s.id = p.stop_id
       WHERE p.assignment_id = $1 AND s.name = $2
       ORDER BY p.seq_order ASC`,
      [t.assignment_id, boardStopName]
    );

    if (boardStopResult.rows.length === 0) continue;

    // まだ到着・通過していないバス停のうち、最も早いものを選ぶ
    const bestBoardStop = boardStopResult.rows.find(
      (stop) => stop.status !== '通過' && stop.status !== '到着済'
    );
    if (!bestBoardStop) continue;

    const predictions = await getArrivalsForAssignment(pool, t.assignment_id);
    const boardPrediction = predictions.find((p) => p.stopId === bestBoardStop.id);
    if (!boardPrediction) continue;

    const delayMinutes = boardPrediction.predictedDelayMinutes || t.delay_minutes || 0;

    candidates.push({
      type: 'realtime',
      vehicleId: t.car_id,
      tripId: t.daily_trip_id,
      assignmentId: t.assignment_id,
      departureTime: t.start_time,
      predictedArrival: boardPrediction.predictedTime,
      delayMinutes: delayMinutes,
      isRealtime: true,
      directionId: bestBoardStop.direction_id
    });
  }

  return candidates;
}

/**
 * 時刻表候補を取得
 * バス停名ベースで検索（上り下り区別なし）
 */
async function getTimetableCandidates(pool, routeId, boardStopName, departureTime) {
  const normalizedRouteId = require('./gtfsData').resolveRouteId(routeId);
  const departureMinutes = timeStrToMinutes(departureTime);
  const serviceDate = getServiceDateString();

  // 当日便のうち、担当車両が付いていない便を時刻表候補とする。
  // 担当車両がいる便は getRealtimeCandidates 側で扱う。
  // 担当車両が不在になった便（仕様書 10.4）も、時刻表通りの情報としてここに残る。
  const trips = await pool.query(
    `SELECT DISTINCT d.id, d.start_time, d.direction_id, d.start_at
     FROM daily_trips d
     JOIN daily_trip_stop_times dst ON dst.daily_trip_id = d.id
     JOIN stops s ON s.id = dst.stop_id
     WHERE d.route_id = $1
       AND d.service_date = $2
       AND s.name = $3
       AND dst.scheduled_time IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM trip_vehicle_assignments a
         WHERE a.daily_trip_id = d.id AND a.role = 'assigned' AND a.state = 'active'
       )
     ORDER BY d.start_at ASC`,
    [normalizedRouteId, serviceDate, boardStopName]
  );

  const candidates = [];

  for (const trip of trips.rows) {
    // 乗車バス停の時刻を取得（同名バス停の中で最適なものを選ぶ）
    const stopTimes = await pool.query(
      `SELECT dst.scheduled_time, dst.seq_order
       FROM daily_trip_stop_times dst
       JOIN stops s ON s.id = dst.stop_id
       WHERE dst.daily_trip_id = $1 AND s.name = $2 AND dst.scheduled_time IS NOT NULL
       ORDER BY dst.seq_order ASC`,
      [trip.id, boardStopName]
    );

    if (stopTimes.rows.length === 0) continue;

    const scheduledTime = stopTimes.rows[0].scheduled_time;
    if (!scheduledTime) continue;

    const scheduledMinutes = timeStrToMinutes(scheduledTime);
    if (Number.isNaN(scheduledMinutes)) continue;

    // 出発時間以降の便のみ
    if (scheduledMinutes < departureMinutes) continue;

    candidates.push({
      type: 'timetable',
      tripId: trip.id,
      directionId: trip.direction_id,
      departureTime: trip.start_time,
      scheduledArrival: scheduledTime,
      delayMinutes: 0,
      isRealtime: false
    });
  }

  return candidates;
}

/**
 * 直接ルートの計算（上り下り区別なし）
 * 同名バス停は同一視し、最適な方向・停車位置を自動選択
 */
async function calculateDirectRoute(pool, routeId, fromStopName, toStopName, departureTime) {
  // 同名バス停を全方向から取得
  const fromStops = await getStopsByName(pool, routeId, fromStopName);
  const toStops = await getStopsByName(pool, routeId, toStopName);

  if (fromStops.length === 0 || toStops.length === 0) return null;

  const candidates = [];

  // 全ての方向の組み合わせを試す
  for (const fromStop of fromStops) {
    for (const toStop of toStops) {
      // 同じ方向で、乗車位置 < 降車位置 の場合のみ有効
      if (fromStop.direction_id !== toStop.direction_id) continue;
      if (fromStop.seq_order >= toStop.seq_order) continue;

      // リアルタイム候補を取得
      const realtimeCandidates = await getRealtimeCandidates(
        pool, routeId, fromStopName
      );

      // 時刻表候補を取得
      const timetableCandidates = await getTimetableCandidates(
        pool, routeId, fromStopName, departureTime
      );

      // 各候補の到着時刻を取得
      for (const candidate of [...realtimeCandidates, ...timetableCandidates]) {
        let arrivalTime;
        if (candidate.type === 'realtime') {
          arrivalTime = candidate.predictedArrival;
        } else {
          // 時刻表から到着時刻を取得（降車バス停名で検索）
          const stopTime = await pool.query(
            `SELECT dst.scheduled_time
             FROM daily_trip_stop_times dst
             JOIN stops s ON s.id = dst.stop_id
             WHERE dst.daily_trip_id = $1 AND s.name = $2 AND dst.scheduled_time IS NOT NULL
             ORDER BY dst.seq_order ASC
             LIMIT 1`,
            [candidate.tripId, toStopName]
          );
          arrivalTime = stopTime.rows[0]?.scheduled_time || null;
        }

        if (arrivalTime) {
          candidates.push({
            routeId: routeId,
            fromStop: fromStopName,
            toStop: toStopName,
            arrivalTime: arrivalTime,
            ...candidate,
            routeType: 'direct'
          });
        }
      }
    }
  }

  if (candidates.length > 0) {
    // 到着時刻でソート（最も早いものを優先）
    candidates.sort((a, b) => {
      const aTime = timeStrToMinutes(a.arrivalTime);
      const bTime = timeStrToMinutes(b.arrivalTime);
      return aTime - bTime;
    });
    return candidates[0];
  }

  return null;
}

/**
 * 乗り換えルートの詳細計算
 * バス停名ベースで乗り換えポイントを探索（上り下り区別なし）
 */
async function calculateTransferRouteDetail(pool, fromRouteId, toRouteId, fromStopName, toStopName, transferStopName, departureTime) {
  // 最初の路線の候補
  const firstLegCandidates = [];

  const realtimeCandidates = await getRealtimeCandidates(
    pool, fromRouteId, fromStopName
  );
  const timetableCandidates = await getTimetableCandidates(
    pool, fromRouteId, fromStopName, departureTime
  );
  firstLegCandidates.push(...realtimeCandidates, ...timetableCandidates);

  // 乗り換えポイントへの到着時刻を取得
  const firstLegRoutes = [];
  for (const candidate of firstLegCandidates) {
    let arrivalTime;
    if (candidate.type === 'realtime') {
      // 担当車両の割り当てに対する予測を取得
      const predictions = await getArrivalsForAssignment(pool, candidate.assignmentId);

      // 乗り換えバス停を名前ベースで検索
      const transferStopResult = await pool.query(
        `SELECT s.id FROM stops s
         WHERE s.route_id = $1 AND s.name = $2`,
        [fromRouteId, transferStopName]
      );
      if (transferStopResult.rows.length === 0) continue;
      const transferStopIds = new Set(transferStopResult.rows.map(r => r.id));
      const matchedPrediction = predictions.find(p => transferStopIds.has(p.stopId));
      arrivalTime = matchedPrediction?.predictedTime || null;
    } else {
      const stopTime = await pool.query(
        `SELECT dst.scheduled_time
         FROM daily_trip_stop_times dst
         JOIN stops s ON s.id = dst.stop_id
         WHERE dst.daily_trip_id = $1 AND s.name = $2 AND dst.scheduled_time IS NOT NULL
         ORDER BY dst.seq_order ASC
         LIMIT 1`,
        [candidate.tripId, transferStopName]
      );
      arrivalTime = stopTime.rows[0]?.scheduled_time || null;
    }

    if (arrivalTime) {
      firstLegRoutes.push({
        ...candidate,
        arrivalTime,
        transferStop: transferStopName
      });
    }
  }

  if (firstLegRoutes.length === 0) return null;

  // 到着時刻でソート
  firstLegRoutes.sort((a, b) => {
    const aTime = timeStrToMinutes(a.arrivalTime);
    const bTime = timeStrToMinutes(b.arrivalTime);
    return aTime - bTime;
  });

  // 2番目の路線の候補（乗り換え後）
  const transferArrivalMinutes = timeStrToMinutes(firstLegRoutes[0].arrivalTime);

  const secondLegCandidates = await getTimetableCandidates(
    pool, toRouteId, transferStopName,
    minutesToTimeStr(transferArrivalMinutes)
  );

  if (secondLegCandidates.length === 0) return null;

  // 到着時刻でソート
  secondLegCandidates.sort((a, b) => {
    const aTime = timeStrToMinutes(a.scheduledArrival);
    const bTime = timeStrToMinutes(b.scheduledArrival);
    return aTime - bTime;
  });

  // 最適な組み合わせを選択
  const bestFirstLeg = firstLegRoutes[0];
  const bestSecondLeg = secondLegCandidates[0];

  // 2番目の路線の到着時刻を取得
  // 同名バス停が複数ある場合、最も遅いseq_order（降車駅として適切）の時刻を採用
  const finalStopTime = await pool.query(
    `SELECT dst.scheduled_time
     FROM daily_trip_stop_times dst
     JOIN stops s ON s.id = dst.stop_id
     WHERE dst.daily_trip_id = $1 AND s.name = $2 AND dst.scheduled_time IS NOT NULL
     ORDER BY dst.seq_order DESC
     LIMIT 1`,
    [bestSecondLeg.tripId, toStopName]
  );

  return {
    type: 'transfer',
    fromStop: fromStopName,
    toStop: toStopName,
    transferStop: transferStopName,
    firstLeg: {
      routeId: fromRouteId,
      ...bestFirstLeg,
      arrivalTime: bestFirstLeg.arrivalTime
    },
    secondLeg: {
      routeId: toRouteId,
      ...bestSecondLeg,
      arrivalTime: finalStopTime.rows[0]?.scheduled_time || null
    },
    totalArrivalTime: finalStopTime.rows[0]?.scheduled_time || null
  };
}

/**
 * 乗り換えルートを計算
 * 全路線から検索し、直接ルート→乗り換えルートの順で最適なものを返す
 * バス停の上り下りは区別せず、同名バス停は同一視する
 */
async function calculateTransferRoute(pool, fromStopName, toStopName, departureTime) {
  // 全路線からバス停を検索（部分一致、重複なしで全件取得）
  const fromStops = await searchStops(pool, null, fromStopName, false);
  const toStops = await searchStops(pool, null, toStopName, false);
  
  if (fromStops.length === 0 || toStops.length === 0) {
    return null;
  }

  // 路線ごとにグループ化（同名バス停があれば最初の1件だけ保持）
  const fromStopsByRoute = new Map();
  const toStopsByRoute = new Map();
  
  fromStops.forEach(stop => {
    if (!fromStopsByRoute.has(stop.route_id)) {
      fromStopsByRoute.set(stop.route_id, stop.name);
    }
  });
  
  toStops.forEach(stop => {
    if (!toStopsByRoute.has(stop.route_id)) {
      toStopsByRoute.set(stop.route_id, stop.name);
    }
  });

  // 同一路線内の直接ルートを優先
  const directCandidates = [];
  for (const [routeId, fromName] of fromStopsByRoute) {
    const toName = toStopsByRoute.get(routeId);
    if (toName) {
      const directRoute = await calculateDirectRoute(pool, routeId, fromName, toName, departureTime);
      if (directRoute) {
        directCandidates.push(directRoute);
      }
    }
  }

  // 直接ルートがあれば最も早いものを返す
  if (directCandidates.length > 0) {
    directCandidates.sort((a, b) => {
      const aTime = timeStrToMinutes(a.arrivalTime);
      const bTime = timeStrToMinutes(b.arrivalTime);
      return aTime - bTime;
    });
    return directCandidates[0];
  }

  // 乗り換えが必要な場合
  const transferCandidates = [];
  for (const [fromRouteId, fromName] of fromStopsByRoute) {
    for (const [toRouteId, toName] of toStopsByRoute) {
      if (fromRouteId === toRouteId) continue;
      
      // 共通のバス停を探す（乗り換えポイント）
      // 名前ベースで路線間の共通バス停を検索
      const fromRouteStops = await pool.query(
        `SELECT DISTINCT name FROM stops WHERE route_id = $1`,
        [fromRouteId]
      );
      const toRouteStops = await pool.query(
        `SELECT DISTINCT name FROM stops WHERE route_id = $1`,
        [toRouteId]
      );
      
      const fromStopNames = new Set(fromRouteStops.rows.map(s => s.name));
      const commonStops = toRouteStops.rows.filter(s => fromStopNames.has(s.name));
      
      if (commonStops.length > 0) {
        // 各乗り換えポイントを試す
        for (const transferStop of commonStops) {
          const route = await calculateTransferRouteDetail(
            pool, fromRouteId, toRouteId, fromName, toName,
            transferStop.name, departureTime
          );
          if (route) transferCandidates.push(route);
        }
      }
    }
  }

  if (transferCandidates.length > 0) {
    // 最も早い到着予定のルートを返す
    transferCandidates.sort((a, b) => {
      const aTime = timeStrToMinutes(a.totalArrivalTime);
      const bTime = timeStrToMinutes(b.totalArrivalTime);
      return aTime - bTime;
    });
    return transferCandidates[0];
  }

  return null;
}

module.exports = {
  searchStops,
  getRealtimeCandidates,
  getTimetableCandidates,
  calculateTransferRoute
};