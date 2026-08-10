const express = require('express');
const pool = require('../config/db');
const { resolveRouteId } = require('../services/gtfsData');
const { getArrivalsForAssignment } = require('../services/etaPredictor');
const { searchStops, getRealtimeCandidates, getTimetableCandidates, calculateTransferRoute } = require('../services/routeSearch');
const { formatNowNoFormat, getServiceDateString } = require('../utils/time');
const { getActiveServiceIds } = require('../services/gtfsCalendar');
const { getCachedServiceStatus } = require('../services/serviceStatusScraper');
const {
  searchStops: searchTimetableStops,
  listStopsForMap,
  getStopTimetable,
  getTripDetail
} = require('../services/gtfsTimetable');
const { unqualifyRouteId, qualifyRouteId } = require('../services/gtfsFeedManager');
const {
  findLiveAssignment,
  buildBusEntry,
  startTimeToUrlHhmm
} = require('../services/realtimeTripLookup');

const router = express.Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function serializeSettings(settings) {
  return {
    notice1: settings.notice1 || '',
    notice2: settings.notice2 || '',
    importantNotice: settings.important_notice || '',
    routeName: settings.route_name || '',
    operatorName: settings.operator_name || ''
  };
}

async function loadSystemSettings(routeId) {
  const normalizedRouteId = resolveRouteId(routeId);
  const result = await pool.query('SELECT key, value FROM system_settings');
  const settings = {};
  for (const row of result.rows) settings[row.key] = row.value;
  const serialized = serializeSettings(settings);
  serialized.routeId = normalizedRouteId;
  // settings の route_name は全路線共通のデフォルトとして使い、
  // 実際の路線名は routes テーブルから取得する
  const routeRes = await pool.query('SELECT name FROM routes WHERE id = $1', [normalizedRouteId]);
  serialized.routeName = routeRes.rows.length > 0 ? routeRes.rows[0].name : (serialized.routeName || '横田信大循環線');
  return serialized;
}

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: '管理画面へのログインが必要です。' });
  }

  let decoded;
  try {
    decoded = Buffer.from(authHeader.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  } catch (err) {
    return res.status(401).json({ error: '認証情報を解釈できませんでした。' });
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return res.status(401).json({ error: '認証情報が不正です。' });
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '認証に失敗しました。' });
  }

  return next();
}

async function readAdminRouteData(routeId) {
  const normalizedRouteId = resolveRouteId(routeId);
  const stopsRes = await pool.query(
    `SELECT id, direction_id, seq_order, name, lat, lon
     FROM stops
     WHERE route_id = $1
     ORDER BY direction_id ASC, seq_order ASC`,
    [normalizedRouteId]
  );

  const tripsRes = await pool.query(
    `SELECT id, trip_index, first_stop_time, direction_id, headsign
     FROM schedule_trips
     WHERE route_id = $1
     ORDER BY direction_id ASC, trip_index ASC`,
    [normalizedRouteId]
  );

  const stopTimesRes = await pool.query(
    `SELECT st.trip_id, s.id AS stop_id, s.name AS stop_name, s.seq_order, st.scheduled_time
     FROM schedule_stop_times st
     JOIN stops s ON s.id = st.stop_id
     JOIN schedule_trips stp ON stp.id = st.trip_id
     WHERE stp.route_id = $1
     ORDER BY st.trip_id ASC, s.seq_order ASC`,
    [normalizedRouteId]
  );

  const timetable = tripsRes.rows.map((trip) => ({
    tripId: trip.id,
    tripIndex: trip.trip_index,
    directionId: trip.direction_id,
    firstStopTime: trip.first_stop_time,
    headsign: trip.headsign || null,
    stops: []
  }));

  const timetableByTrip = new Map(timetable.map((trip) => [trip.tripId, trip]));
  for (const row of stopTimesRes.rows) {
    const trip = timetableByTrip.get(row.trip_id);
    if (!trip) continue;
    trip.stops.push({
      stopId: row.stop_id,
      stopName: row.stop_name,
      seqOrder: row.seq_order,
      scheduledTime: row.scheduled_time
    });
  }

  return {
    routeId: normalizedRouteId,
    stops: stopsRes.rows.map((row) => ({
      id: row.id,
      directionId: row.direction_id,
      seqOrder: row.seq_order,
      name: row.name,
      lat: row.lat,
      lon: row.lon
    })),
    timetable
  };
}

// GET /api/routes -> 利用可能な路線一覧（GTFSのroute.txt由来）
router.get('/routes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, short_name, color, text_color
       FROM routes
       ORDER BY id ASC`
    );
    res.json({ routes: result.rows });
  } catch (err) {
    console.error('[api] /routes エラー:', err);
    res.status(500).json({ error: '路線一覧の取得に失敗しました。' });
  }
});

// GET /api/settings -> お知らせ・重要なお知らせ（GASの「設定 システム」シート相当）
router.get('/settings', async (req, res) => {
  try {
    const routeId = resolveRouteId(req.query.routeId);
    const settings = await loadSystemSettings(routeId);
    res.json(settings);
  } catch (err) {
    console.error('[api] /settings エラー:', err);
    res.status(500).json({ error: 'システム設定の取得に失敗しました。' });
  }
});

// GET /api/admin/settings -> 管理画面用に認証付きで設定を取得
router.get('/admin/settings', requireAdminAuth, async (req, res) => {
  try {
    const routeId = resolveRouteId(req.query.routeId);
    const settings = await loadSystemSettings(routeId);
    res.json(settings);
  } catch (err) {
    console.error('[api] /admin/settings エラー:', err);
    res.status(500).json({ error: '管理設定の取得に失敗しました。' });
  }
});

// GET /api/admin/route-mappings -> 外部IDとGTFS路線IDの対応表を取得
// direction_id の対応設定は管理画面から廃止し、config/directionMapping.js へ移した（仕様書 6.1）。
router.get('/admin/route-mappings', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id AS route_id, r.name AS route_name, rei.external_id
       FROM route_external_ids rei
       JOIN routes r ON r.id = rei.route_id
       ORDER BY r.id ASC, rei.external_id ASC`
    );
    res.json({ mappings: result.rows.map((row) => ({ routeId: row.route_id, routeName: row.route_name, externalId: row.external_id })) });
  } catch (err) {
    console.error('[api] /admin/route-mappings 取得エラー:', err);
    res.status(500).json({ error: '外部ID対応表の取得に失敗しました。' });
  }
});

// PUT /api/admin/route-mappings -> 外部IDとGTFS路線IDの対応表を更新
router.put('/admin/route-mappings', requireAdminAuth, async (req, res) => {
  const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
  try {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM route_external_ids');
    for (const item of mappings) {
      const routeId = resolveRouteId(item.routeId);
      const externalId = String(item.externalId || '').trim();
      if (!routeId || !externalId) continue;
      // route_external_ids には UNIQUE (external_id) があるため、ON CONFLICT の対象は
      // (route_id, external_id) ではなく (external_id) にする必要がある。
      // 同じ外部IDを2つの路線に指定した入力でも500にせず、後に指定した方を採用する。
      await pool.query(
        `INSERT INTO route_external_ids (route_id, external_id, feed_id)
         VALUES ($1, $2, (SELECT feed_id FROM routes WHERE id = $1))
         ON CONFLICT (external_id) DO UPDATE
           SET route_id = EXCLUDED.route_id,
               feed_id = EXCLUDED.feed_id`,
        [routeId, externalId]
      );
    }
    await pool.query('COMMIT');
    const result = await pool.query(
      `SELECT r.id AS route_id, r.name AS route_name, rei.external_id
       FROM route_external_ids rei
       JOIN routes r ON r.id = rei.route_id
       ORDER BY r.id ASC, rei.external_id ASC`
    );
    res.json({ mappings: result.rows.map((row) => ({ routeId: row.route_id, routeName: row.route_name, externalId: row.external_id })) });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => undefined);
    console.error('[api] /admin/route-mappings 更新エラー:', err);
    res.status(500).json({ error: '外部ID対応表の更新に失敗しました。' });
  }
});

// GET /api/admin/route-data -> 路線データを管理画面へ返す
router.get('/admin/route-data', requireAdminAuth, async (req, res) => {
  try {
    const routeId = resolveRouteId(req.query.routeId);
    const data = await readAdminRouteData(routeId);
    res.json(data);
  } catch (err) {
    console.error('[api] /admin/route-data 取得エラー:', err);
    res.status(500).json({ error: '路線データの取得に失敗しました。' });
  }
});

// PUT /api/admin/route-data -> バス停座標・時刻表を更新
router.put('/api/admin/route-data', requireAdminAuth, async (req, res) => {
  const { routeId, stopEdits = [], timetableEdits = [] } = req.body || {};
  try {
    await pool.query('BEGIN');
    const normalizedRouteId = resolveRouteId(routeId);

    for (const edit of stopEdits) {
      const lat = Number(edit.lat ?? edit.value?.lat ?? NaN);
      const lon = Number(edit.lon ?? edit.value?.lon ?? NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      await pool.query(
        `UPDATE stops
         SET lat = $1, lon = $2
         WHERE id = $3 AND route_id = $4`,
        [lat, lon, Number(edit.id), normalizedRouteId]
      );
    }

    for (const edit of timetableEdits) {
      await pool.query(
        `UPDATE schedule_stop_times st
         SET scheduled_time = $1
         FROM schedule_trips stp
         WHERE st.trip_id = stp.id
           AND stp.route_id = $2
           AND st.stop_id = $3
           AND st.trip_id = $4`,
        [edit.scheduledTime || null, normalizedRouteId, Number(edit.stopId), Number(edit.tripId)]
      );
    }

    await pool.query(
      `UPDATE schedule_trips stp
       SET first_stop_time = (
         SELECT st.scheduled_time
         FROM schedule_stop_times st
         JOIN stops s ON s.id = st.stop_id
         WHERE st.trip_id = stp.id AND st.scheduled_time IS NOT NULL
         ORDER BY s.seq_order ASC
         LIMIT 1
       )
       WHERE stp.route_id = $1`,
      [normalizedRouteId]
    );

    await pool.query('COMMIT');
    const data = await readAdminRouteData(normalizedRouteId);
    res.json(data);
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => undefined);
    console.error('[api] /admin/route-data 更新エラー:', err);
    res.status(500).json({ error: '路線データの更新に失敗しました。' });
  }
});

// PUT /api/admin/settings -> 管理画面から配信お知らせを更新
router.put('/admin/settings', requireAdminAuth, async (req, res) => {
  const { notice1, notice2, importantNotice, routeName, operatorName } = req.body || {};

  try {
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['notice1', notice1 ?? '']
    );
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['notice2', notice2 ?? '']
    );
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['important_notice', importantNotice ?? '']
    );
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['route_name', routeName ?? '']
    );
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['operator_name', operatorName ?? '']
    );
    await pool.query('COMMIT');

    const settings = await loadSystemSettings();
    res.json(settings);
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => undefined);
    console.error('[api] /admin/settings 更新エラー:', err);
    res.status(500).json({ error: '管理設定の更新に失敗しました。' });
  }
});

// GET /api/stops -> 全バス停マスタ（時刻表画面・地図表示用）
router.get('/stops', async (req, res) => {
  try {
    const routeId = resolveRouteId(req.query.routeId);
    const result = await pool.query(
      `SELECT id, direction_id, seq_order, name, name_kana, name_en, lat, lon, notice, timetable_link
       FROM stops
       WHERE route_id = $1
       ORDER BY direction_id ASC, seq_order ASC`,
      [routeId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[api] /stops エラー:', err);
    res.status(500).json({ error: 'バス停情報の取得に失敗しました。' });
  }
});

// GET /api/timetable -> 本日運行対象の便の時刻表（非リアルタイム表示・バス停詳細用）
// 当日便(daily_trips)を参照するため、frequencies.txt 由来の仮想便も自然に含まれる。
router.get('/timetable', async (req, res) => {
  try {
    const routeId = resolveRouteId(req.query.routeId);
    const serviceDate = getServiceDateString();

    const trips = await pool.query(
      `SELECT id, start_time, direction_id, headsign, origin
       FROM daily_trips
       WHERE route_id = $1 AND service_date = $2
       ORDER BY direction_id ASC, start_at ASC, id ASC`,
      [routeId, serviceDate]
    );

    // 当日便がまだ生成されていない場合のフォールバック（起動直後など）
    if (trips.rows.length === 0) {
      return res.json(await readTimetableFromSchedule(routeId));
    }

    const times = await pool.query(
      `SELECT dst.daily_trip_id, dst.seq_order, s.name AS stop_name, dst.scheduled_time, dst.is_through
       FROM daily_trip_stop_times dst
       JOIN stops s ON s.id = dst.stop_id
       JOIN daily_trips d ON d.id = dst.daily_trip_id
       WHERE d.route_id = $1 AND d.service_date = $2
       ORDER BY dst.daily_trip_id ASC, dst.seq_order ASC`,
      [routeId, serviceDate]
    );

    const byTrip = new Map();
    for (const [index, t] of trips.rows.entries()) {
      byTrip.set(t.id, {
        tripIndex: index,
        tripId: t.id,
        directionId: t.direction_id,
        headsign: t.headsign || null,
        startTime: t.start_time,
        stops: []
      });
    }

    for (const r of times.rows) {
      const entry = byTrip.get(r.daily_trip_id);
      if (entry) {
        entry.stops.push({
          seqOrder: r.seq_order,
          stopName: r.stop_name,
          scheduledTime: r.is_through ? null : r.scheduled_time
        });
      }
    }

    res.json(Array.from(byTrip.values()));
  } catch (err) {
    console.error('[api] /timetable エラー:', err);
    res.status(500).json({ error: '時刻表の取得に失敗しました。' });
  }
});

/**
 * 当日便が未生成の場合に、静的な時刻表(schedule_trips)から直接組み立てるフォールバック。
 */
async function readTimetableFromSchedule(routeId) {
  let activeServiceIds = [];
  try {
    activeServiceIds = await getActiveServiceIds(new Date());
  } catch (err) {
    console.error('[api] /timetable GTFSカレンダー読み込みエラー:', err);
  }

  if (activeServiceIds.length === 0) {
    const allServices = await pool.query(
      `SELECT DISTINCT service_id FROM schedule_trips WHERE route_id = $1`,
      [routeId]
    );
    activeServiceIds = allServices.rows.map((r) => r.service_id);
  }

  const trips = await pool.query(
    `SELECT id, trip_index, first_stop_time, direction_id, headsign
     FROM schedule_trips
     WHERE route_id = $1 AND service_id = ANY($2::text[])
     ORDER BY direction_id ASC, trip_index ASC`,
    [routeId, activeServiceIds]
  );
  const times = await pool.query(
    `SELECT st.trip_id, s.seq_order, s.name AS stop_name, st.scheduled_time, st.is_through
     FROM schedule_stop_times st
     JOIN stops s ON s.id = st.stop_id
     JOIN schedule_trips stp ON stp.id = st.trip_id
     WHERE stp.route_id = $1 AND stp.service_id = ANY($2::text[])
     ORDER BY st.trip_id ASC, s.seq_order ASC`,
    [routeId, activeServiceIds]
  );

  const byTrip = new Map();
  for (const t of trips.rows) {
    byTrip.set(t.id, {
      tripIndex: t.trip_index,
      tripId: t.id,
      directionId: t.direction_id,
      headsign: t.headsign || null,
      startTime: t.first_stop_time,
      stops: []
    });
  }
  for (const r of times.rows) {
    const entry = byTrip.get(r.trip_id);
    if (entry) {
      entry.stops.push({
        seqOrder: r.seq_order,
        stopName: r.stop_name,
        scheduledTime: r.is_through ? null : r.scheduled_time
      });
    }
  }
  return Array.from(byTrip.values());
}

// GET /api/buses -> 当日便のリアルタイム運行状況
// 表示対象は「担当車両が割り当てられている便」のみ。候補車両は内部処理だけで、
// 利用者には公開しない（仕様書 9.1・15）。
// マップ用の拡張(allGps=true): 担当便を持たない車両もGPS座標だけ返す
router.get('/buses', async (req, res) => {
  try {
    const routeId = resolveRouteId(req.query.routeId);
    const settings = await loadSystemSettings(routeId);
    const includeAllGps = req.query.allGps === 'true';
    const serviceDate = getServiceDateString();

    const trips = await pool.query(
      `SELECT d.id AS daily_trip_id, d.start_time, d.headsign, d.direction_id, d.origin,
              a.id AS assignment_id, a.delay_minutes,
              v.id AS vehicle_id, v.car_id,
              st.gtfs_trip_id, r.feed_id
       FROM daily_trips d
       JOIN trip_vehicle_assignments a
         ON a.daily_trip_id = d.id AND a.role = 'assigned' AND a.state = 'active'
       JOIN vehicles v ON v.id = a.vehicle_id
       JOIN schedule_trips st ON st.id = d.schedule_trip_id
       LEFT JOIN routes r ON r.id = d.route_id
       WHERE d.route_id = $1
         AND d.service_date = $2
         AND d.closed_at IS NULL
       ORDER BY d.start_at ASC, d.id ASC`,
      [routeId, serviceDate]
    );
    console.log(`[api /buses] routeId=${routeId}, allGps=${includeAllGps}, trips=${trips.rows.length}`);

    const buses = [];

    for (const t of trips.rows) {
      const entry = await buildBusEntry(t, routeId, settings.routeName || '横田信大循環線');
      // 便詳細ページ（/timetable/trips/{gtfs_id}/{route_id}/{trip_id}/{departure_time}）への
      // 遷移URLをフロントで組み立てるためのGTFS識別子
      entry.feedId = t.feed_id || null;
      entry.gtfsRouteId = t.feed_id ? unqualifyRouteId(routeId, t.feed_id) : null;
      entry.gtfsTripId = t.gtfs_trip_id || null;
      entry.departureUrlTime = startTimeToUrlHhmm(t.start_time);
      buses.push(entry);
    }

    // マップ・管理用途: 便に紐づいていない車両も位置だけ返す
    if (includeAllGps) {
      const assignedVehicleIds = trips.rows.map((t) => t.vehicle_id);
      const others = await pool.query(
        `SELECT DISTINCT ON (v.id) v.id, v.car_id, g.lat, g.lon
         FROM vehicles v
         JOIN vehicle_gps_log g ON g.vehicle_id = v.id
         WHERE v.route_id = $1
           AND v.status = 'active'
           AND NOT (v.id = ANY($2::int[]))
         ORDER BY v.id, g.gps_time_ts DESC, g.id DESC`,
        [routeId, assignedVehicleIds]
      );
      for (const o of others.rows) {
        buses.push({
          id: o.car_id,
          tripId: null,
          startTime: null,
          routeId,
          routeName: settings.routeName || '横田信大循環線',
          headsign: null,
          isRealtime: false,
          delayMinutes: 0,
          lat: o.lat,
          lng: o.lon,
          stops: []
        });
      }
    }

    res.json({ buses });
  } catch (err) {
    console.error('[api] /buses エラー:', err);
    res.status(500).json({ error: '運行情報の取得に失敗しました。' });
  }
});

// GET /api/buses-for-map -> マップ用バス位置情報（シンプル版）
// 利用者向け表示は担当車両のみとする方針に合わせ、担当便を持つ車両に限定する。
//
// routeIdは任意。省略時（および routeId=all）は全路線の走行中バスを返す。
// バスマップは「いま走っているバスを地図上で俯瞰する」画面なので、
// 既定を1路線に絞ると（その路線がたまたま運行していないとき）0台になってしまう。
// そのため resolveRouteId() のデフォルト路線フォールバックはここでは使わない。
router.get('/buses-for-map', async (req, res) => {
  try {
    const rawRouteId = req.query.routeId;
    const routeId = !rawRouteId || rawRouteId === 'all' ? null : resolveRouteId(rawRouteId);
    const serviceDate = getServiceDateString();
    const result = await pool.query(
      // 路線名・路線色は「便の路線」（daily_trips.route_id）を正とする。
      // vehicles.route_id を使うと、routesに無いIDだったときINNER JOINで丸ごと消えてしまう。
      `SELECT DISTINCT ON (v.id)
              v.id AS vehicle_id, v.car_id, vgl.lat, vgl.lon, vgl.gps_time_ts,
              d.id AS daily_trip_id, d.route_id, d.headsign, d.start_time,
              a.id AS assignment_id, a.delay_minutes,
              r.name AS route_name, r.color AS route_color, r.text_color AS route_text_color, r.feed_id,
              st.gtfs_trip_id
       FROM daily_trips d
       INNER JOIN trip_vehicle_assignments a
         ON a.daily_trip_id = d.id AND a.role = 'assigned' AND a.state = 'active'
       INNER JOIN vehicles v ON v.id = a.vehicle_id
       INNER JOIN vehicle_gps_log vgl ON vgl.vehicle_id = v.id
       LEFT JOIN routes r ON r.id = d.route_id
       LEFT JOIN schedule_trips st ON st.id = d.schedule_trip_id
       WHERE d.service_date = $1
         AND d.closed_at IS NULL
         AND ($2::text IS NULL OR d.route_id = $2)
       ORDER BY v.id, vgl.gps_time_ts DESC, vgl.id DESC`,
      [serviceDate, routeId]
    );

    const rows = result.rows.filter((row) => row.lat !== null && row.lon !== null);

    // その地点（直近到着済みの停留所。まだ到着が無ければ始発停留所）のstop_headsignを
    // 一括取得する。バスマップでは車両IDの代わりにこれを表示する。
    const assignmentIds = rows.map((row) => row.assignment_id);
    const headsignByAssignment = new Map();
    if (assignmentIds.length > 0) {
      const arrivedRes = await pool.query(
        `SELECT DISTINCT ON (p.assignment_id) p.assignment_id, dts.stop_headsign
         FROM trip_stop_progress p
         JOIN trip_vehicle_assignments a2 ON a2.id = p.assignment_id
         JOIN daily_trip_stop_times dts ON dts.daily_trip_id = a2.daily_trip_id AND dts.stop_id = p.stop_id
         WHERE p.assignment_id = ANY($1::bigint[]) AND p.status = '到着済'
         ORDER BY p.assignment_id, p.seq_order DESC`,
        [assignmentIds]
      );
      for (const r of arrivedRes.rows) headsignByAssignment.set(r.assignment_id, r.stop_headsign);

      const missingIds = assignmentIds.filter((id) => !headsignByAssignment.has(id));
      if (missingIds.length > 0) {
        const firstStopRes = await pool.query(
          `SELECT DISTINCT ON (a2.id) a2.id AS assignment_id, dts.stop_headsign
           FROM trip_vehicle_assignments a2
           JOIN daily_trip_stop_times dts ON dts.daily_trip_id = a2.daily_trip_id
           WHERE a2.id = ANY($1::bigint[])
           ORDER BY a2.id, dts.seq_order ASC`,
          [missingIds]
        );
        for (const r of firstStopRes.rows) headsignByAssignment.set(r.assignment_id, r.stop_headsign);
      }
    }

    const buses = rows.map((row) => ({
      id: row.car_id,
      vehicleId: row.vehicle_id,
      tripId: row.daily_trip_id,
      lat: Number(row.lat),
      lng: Number(row.lon),
      routeId: row.route_id,
      routeName: row.route_name || '不明な路線',
      routeColor: row.route_color || null,
      routeTextColor: row.route_text_color || null,
      headsign: row.headsign || null,
      currentHeadsign: headsignByAssignment.get(row.assignment_id) || row.headsign || null,
      startTime: row.start_time || null,
      delayMinutes: row.delay_minutes,
      gpsTime: row.gps_time_ts,
      feedId: row.feed_id || null,
      gtfsRouteId: row.feed_id ? unqualifyRouteId(row.route_id, row.feed_id) : null,
      gtfsTripId: row.gtfs_trip_id || null,
      departureUrlTime: startTimeToUrlHhmm(row.start_time)
    }));

    res.json({ buses });
  } catch (err) {
    console.error('[api] /buses-for-map エラー:', err);
    res.status(500).json({ error: 'マップ用バス情報の取得に失敗しました。' });
  }
});

// GET /api/route-search -> ルート検索（乗り換え案内対応）
router.get('/route-search', async (req, res) => {
  try {
    const routeId = req.query.routeId ? resolveRouteId(req.query.routeId) : null;
    const fromStop = req.query.from;
    const toStop = req.query.to;
    const departureTime = req.query.departureTime || formatNowNoFormat();

    if (!fromStop || !toStop) {
      return res.status(400).json({ error: '出発地と目的地を指定してください。' });
    }

    console.log(`ルート検索: ${fromStop} → ${toStop}, routeId=${routeId || '全路線'}`);

    const result = await calculateTransferRoute(pool, fromStop, toStop, departureTime);
    
    if (!result) {
      console.log(`ルート検索結果: 見つからず`);
      return res.json({ 
        found: false, 
        message: 'ルートが見つかりませんでした。バス停名を確認してください。' 
      });
    }

    console.log(`ルート検索結果: ${result.type}`, result);
    res.json({ found: true, route: result });
  } catch (err) {
    console.error('[api] /route-search エラー:', err);
    res.status(500).json({ error: 'ルート検索に失敗しました。' });
  }
});

// GET /api/admin/bus-positions -> 直近3分以内のバス位置情報（住所付き）
router.get('/admin/bus-positions', requireAdminAuth, async (req, res) => {
  try {
    const now = new Date();
    const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000);

    // vehicle_positions_raw から直近3分以内のデータを取得
    const result = await pool.query(
      `SELECT DISTINCT ON (vpr.car_id) 
              vpr.id, vpr.route_id, vpr.car_id, vpr.received_time, 
              vpr.gps_time, vpr.gps_time_ts, vpr.lat, vpr.lon, vpr.direction_id,
              r.name AS route_name
       FROM vehicle_positions_raw vpr
       LEFT JOIN routes r ON r.id = vpr.route_id
       WHERE vpr.gps_time_ts >= $1 AND vpr.gps_time_ts <= $2
       ORDER BY vpr.car_id ASC, vpr.gps_time_ts DESC`,
      [threeMinutesAgo.toISOString(), now.toISOString()]
    );

    const positions = [];

    for (const row of result.rows) {
      // Yahoo!リバースジオコーダで住所を特定
      let address = '';
      try {
        const yahooClientId = process.env.YAHOO_CLIENT_ID;
        if (yahooClientId) {
          const fetch = require('cross-fetch');
          const yahooUrl = `https://map.yahooapis.jp/geoapi/V1/reverseGeoCoder?lat=${row.lat}&lon=${row.lon}&appid=${yahooClientId}&output=json`;
          const yahooRes = await fetch(yahooUrl);
          const yahooJson = await yahooRes.json();
          
          if (yahooJson.Feature && yahooJson.Feature.length > 0) {
            address = yahooJson.Feature[0].Property.Address || '';
            // 長野県と郵便番号を除去
            address = address.replace(/長野県/g, '');
            address = address.replace(/〒?\d{3}-\d{4}/g, '').trim();
          } else {
            address = '地点特定不可';
          }
        }
      } catch (e) {
        address = '住所取得エラー';
        console.warn(`車両ID ${row.car_id} の住所取得に失敗: ${e.message}`);
      }

      // 100ms待機（APIレート制限対策）
      await new Promise(resolve => setTimeout(resolve, 100));

      positions.push({
        id: row.id,
        routeId: row.route_id,
        routeName: row.route_name || row.route_id,
        carId: row.car_id,
        receivedTime: row.received_time,
        gpsTime: row.gps_time,
        gpsTimeTs: row.gps_time_ts,
        lat: parseFloat(row.lat),
        lon: parseFloat(row.lon),
        directionId: row.direction_id,
        address: address
      });
    }

    res.json({ 
      positions,
      count: positions.length,
      fetchedAt: now.toISOString()
    });
  } catch (err) {
    console.error('[api] /admin/bus-positions エラー:', err);
    res.status(500).json({ error: 'バス位置情報の取得に失敗しました。' });
  }
});

// GET /api/stops/search -> バス停名の部分一致検索（全路線対応）
router.get('/stops/search', async (req, res) => {
  try {
    // routeId が指定されていない場合は全路線から検索
    const routeId = req.query.routeId ? resolveRouteId(req.query.routeId) : null;
    const query = req.query.q;
    
    if (!query || query.length < 1) {
      return res.json({ stops: [] });
    }

    // フロントエンドのサジェスト表示用は重複除去（distinct=true）
    // ルート検索API（/api/route-search）内では全件取得（distinct=false）
    const distinct = !routeId; // 全路線検索時のみ重複除去
    const stops = await searchStops(pool, routeId, query, distinct);
    res.json({ stops });
  } catch (err) {
    console.error('[api] /stops/search エラー:', err);
    res.status(500).json({ error: 'バス停検索に失敗しました。' });
  }
});

// ==========================================================
// 時刻表検索機能（GTFSインデックス直読み。DBの stops/schedule_* は使わない）
// URL設計は仕様書 3.2 に対応する:
//   /timetable                                                    検索画面
//   /timetable/stops/{stop_id}                                    バス停詳細（全乗り場）
//   /timetable/stops/{stop_id}?platform={platform_stop_id}        バス停詳細（乗り場別）
//   /timetable/trips/{gtfs_id}/{route_id}/{trip_id}/{departure_time}  便詳細
// ==========================================================

// GET /api/timetable/stops/search?q=... -> バス停名のインクリメンタル検索
// 漢字・ひらがな・カタカナ・ローマ字（大文字小文字/全半角不問）に対応する。
router.get('/timetable/stops/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json({ stops: [] });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '20', 10) || 20, 1), 50);
    const stops = await searchTimetableStops(query, limit);
    res.json({ stops });
  } catch (err) {
    console.error('[api] /timetable/stops/search エラー:', err);
    res.status(500).json({ error: 'バス停検索に失敗しました。' });
  }
});

// GET /api/timetable/stops/map -> バス停マップ用の全バス停一覧（同名で標柱違いは代表点1件に統合済み）
// :stopKey にマッチしてしまわないよう、必ず :stopKey ルートより手前に置くこと。
router.get('/timetable/stops/map', async (req, res) => {
  try {
    const stops = await listStopsForMap();
    res.json({ stops });
  } catch (err) {
    console.error('[api] /timetable/stops/map エラー:', err);
    res.status(500).json({ error: 'バス停一覧の取得に失敗しました。' });
  }
});

// GET /api/timetable/stops/:stopKey -> バス停の時刻表（標柱一覧・凡例つき）
// クエリ: date=YYYY-MM-DD（省略時は本日） / platform=標柱のstop_id（省略時は全乗り場統合）
router.get('/timetable/stops/:stopKey', async (req, res) => {
  try {
    const data = await getStopTimetable(req.params.stopKey, {
      date: req.query.date,
      platform: req.query.platform
    });
    if (!data) return res.status(404).json({ error: '指定のバス停が見つかりませんでした。' });
    res.json(data);
  } catch (err) {
    console.error('[api] /timetable/stops/:stopKey エラー:', err);
    res.status(500).json({ error: 'バス停時刻表の取得に失敗しました。' });
  }
});

// GET /api/timetable/trips/:feedId/:routeId/:tripId/:departureTime -> 便の通過時刻一覧
// クエリ: stop=閲覧元の標柱stop_id（該当行をハイライトするために使う）
router.get('/timetable/trips/:feedId/:routeId/:tripId/:departureTime', async (req, res) => {
  try {
    const data = await getTripDetail(
      req.params.feedId,
      req.params.routeId,
      req.params.tripId,
      req.params.departureTime,
      { stopId: req.query.stop || null }
    );
    if (!data) return res.status(404).json({ error: '指定の便が見つかりませんでした。' });
    res.json(data);
  } catch (err) {
    console.error('[api] /timetable/trips エラー:', err);
    res.status(500).json({ error: '便情報の取得に失敗しました。' });
  }
});

// GET /api/timetable/trips/:feedId/:routeId/:tripId/:departureTime/realtime
//   -> 便詳細ページの「リアルタイム表示に切替」用。当日この便を担当している車両が
//      居れば available:true とその運行状況（/api/buses の1件と同じ形）を返す。
//      居なければ available:false（=まだ／もう現在リアルタイム運行していない）。
router.get('/timetable/trips/:feedId/:routeId/:tripId/:departureTime/realtime', async (req, res) => {
  try {
    const { feedId, routeId, tripId, departureTime } = req.params;
    const match = await findLiveAssignment(feedId, routeId, tripId, departureTime);
    if (!match) return res.json({ available: false });

    // 路線名・色は便詳細ページの静的データ（/api/timetable/trips/...）側が既に持っているため、
    // ここでは重複取得しない。停車進捗・遅延・車両位置だけを返す。
    const bus = await buildBusEntry(match, qualifyRouteId(routeId, feedId), null);
    bus.feedId = feedId;
    bus.gtfsRouteId = routeId;
    res.json({ available: true, bus });
  } catch (err) {
    console.error('[api] /timetable/trips/.../realtime エラー:', err);
    res.status(500).json({ error: '便のリアルタイム情報の取得に失敗しました。' });
  }
});

// GET /api/service-status -> アルピコ交通の運行状況（1時間ごとにスクレイピングしてキャッシュ済み）
router.get('/service-status', async (req, res) => {
  try {
    const status = await getCachedServiceStatus();
    res.json(status);
  } catch (err) {
    console.error('[api] /service-status エラー:', err);
    res.status(500).json({ error: '運行状況の取得に失敗しました。' });
  }
});

module.exports = router;
