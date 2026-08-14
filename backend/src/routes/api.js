const fs = require('fs');
const express = require('express');
const pool = require('../config/db');
const { resolveRouteId } = require('../services/gtfsData');
const { getArrivalsForAssignment, describeSource, SOURCE_INFO } = require('../services/etaPredictor');
const { getAccuracyReport } = require('../services/predictionAccuracy');
const { searchStops } = require('../services/routeSearch');
const { searchJourneys, searchRouteSearchStops } = require('../services/gtfsRouteSearch');
const { getServiceDateString } = require('../utils/time');
const { getActiveServiceIds } = require('../services/gtfsCalendar');
const { getCachedServiceStatus } = require('../services/serviceStatusScraper');
const {
  searchStops: searchTimetableStops,
  listStopsForMap,
  searchNearbyStops,
  getStopTimetable,
  getTripDetail
} = require('../services/gtfsTimetable');
const {
  unqualifyRouteId,
  qualifyRouteId,
  getGtfsDir,
  downloadAndExtractGtfsFeed,
  MANAGED_GTFS_FILES
} = require('../services/gtfsFeedManager');
const {
  findLiveAssignment,
  buildBusEntry,
  startTimeToUrlHhmm
} = require('../services/realtimeTripLookup');
const { getApproachingBuses } = require('../services/busStopApproaching');
const { invalidateHolidayCache } = require('../services/holidayCalendar');
const visitorTracker = require('../services/visitorTracker');
const jobMonitor = require('../services/jobMonitor');
const apiMetrics = require('../services/apiMetrics');
const { getEnabledGtfsFeeds, getEnabledLocationFeeds } = require('../config/feeds');

const router = express.Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// 運用監視のしきい値（ASSIGN_RADIUS_METERS等と同じ流儀で環境変数上書き可・既定値付き）
const STALE_GPS_MIN = parseFloat(process.env.ADMIN_STALE_GPS_MIN || '5');
const DELAY_ALERT_MIN = parseFloat(process.env.ADMIN_DELAY_ALERT_MIN || '5');
const SEVERE_DELAY_MIN = parseFloat(process.env.ADMIN_SEVERE_DELAY_MIN || '15');
const UNASSIGNED_OVERDUE_MIN = parseFloat(process.env.ADMIN_UNASSIGNED_OVERDUE_MIN || '5');
const ETA_STALE_MIN = parseFloat(process.env.ADMIN_ETA_STALE_MIN || '10');

// フロントエンドがX-Client-Idヘッダーを付けて叩くAPIリクエストを閲覧数としてカウントする
// （サーバー負荷判定・管理画面の閲覧数表示に使用。ヘッダーが無いリクエストは対象外）。
router.use((req, res, next) => {
  const clientId = req.headers['x-client-id'];
  if (typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 100) {
    visitorTracker.recordVisit(clientId);
  }
  next();
});

// API稼働監視（管理画面向け）: 応答時間・エラー率・アクセス数・失敗したエンドポイントを記録する。
// req.route.path はExpressがルートをマッチさせた後でないと入らないが、resの'finish'イベントは
// レスポンス送出後に発火するため、マウント位置に関わらずこの時点では必ず取得できる。
router.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const pattern = req.route ? `${req.baseUrl}${req.route.path}` : `${req.method} (unmatched)`;
    apiMetrics.recordRequest(req.method, pattern, res.statusCode, Date.now() - startedAt);
  });
  next();
});

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

// GET /api/server-load -> 現在のサイト閲覧数とサーバー負荷状況
// 公開API（利用者向け画面が自動更新の自動OFF判定に使う）。集計値のみで個人情報は含まない。
router.get('/server-load', (req, res) => {
  res.json(visitorTracker.getServerLoadStatus());
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

// 外部ID ⇔ GTFS route_id の対応表の取得・編集API（GET/PUT /admin/route-mappings）は、
// 対応を config/routeExternalIdMapping.js へ移したため削除した。
// 保存できるのに反映されないUIを残さないための措置である（仕様書 3.2.1 / 6）。
//
// 路線データ編集（バス停座標・時刻表の直接編集。GET/PUT /admin/route-data）も削除した。
// バス停座標・時刻表はGTFSフィード由来のマスタなので、変更はGTFSフィード側の更新で行う。

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

// GET /api/admin/holidays -> 祝日カレンダー一覧（ETA統計の曜日区分に使用）
router.get('/admin/holidays', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS date, name
       FROM holidays ORDER BY holiday_date ASC`
    );
    res.json({ holidays: result.rows });
  } catch (err) {
    console.error('[api] /admin/holidays 取得エラー:', err);
    res.status(500).json({ error: '祝日カレンダーの取得に失敗しました。' });
  }
});

// POST /api/admin/holidays -> 祝日を追加（既存日は名称を上書き）
router.post('/admin/holidays', requireAdminAuth, async (req, res) => {
  const { date, name } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '日付はYYYY-MM-DD形式で指定してください。' });
  }

  try {
    await pool.query(
      `INSERT INTO holidays (holiday_date, name) VALUES ($1, $2)
       ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name`,
      [date, name || null]
    );
    invalidateHolidayCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/holidays 追加エラー:', err);
    res.status(500).json({ error: '祝日の追加に失敗しました。' });
  }
});

// DELETE /api/admin/holidays/:date -> 祝日を削除
router.delete('/admin/holidays/:date', requireAdminAuth, async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '日付はYYYY-MM-DD形式で指定してください。' });
  }

  try {
    await pool.query('DELETE FROM holidays WHERE holiday_date = $1', [date]);
    invalidateHolidayCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/holidays 削除エラー:', err);
    res.status(500).json({ error: '祝日の削除に失敗しました。' });
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

// ==========================================================
// 経路検索機能（GTFSインデックス直読み。DBの stops/daily_trips は探索に使わない）
// 経路検索機能_改善仕様書 8章。
//   stopKey は時刻表検索・バス停検索とまったく同じ識別子であり、
//   結果から /busstop/{stopKey} や /timetable/trips/... へそのまま遷移できる。
// ==========================================================

// GET /api/route-search/stops?q=... -> 出発地・目的地の候補
// 漢字・ひらがな・カタカナ・ローマ字（大文字小文字/全半角不問）に対応する。
router.get('/route-search/stops', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json({ stops: [] });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '20', 10) || 20, 1), 50);
    const stops = await searchRouteSearchStops(query, limit);
    res.json({ stops });
  } catch (err) {
    console.error('[api] /route-search/stops エラー:', err);
    res.status(500).json({ error: '停留所候補の取得に失敗しました。' });
  }
});

// GET /api/route-search -> 経路検索（乗換2回まで・徒歩接続あり・任意日付・運賃つき）
// クエリ: fromStopKey|from / toStopKey|to / date=YYYY-MM-DD / time=HH:MM / limit
//   departureTime は旧APIの名前。time の別名として受け付ける。
router.get('/route-search', async (req, res) => {
  try {
    const result = await searchJourneys({
      fromStopKey: req.query.fromStopKey || null,
      from: req.query.from || null,
      toStopKey: req.query.toStopKey || null,
      to: req.query.to || null,
      date: req.query.date || null,
      time: req.query.time || req.query.departureTime || null,
      limit: req.query.limit
    });

    if (result.found) {
      console.log(
        `[api] 経路検索: ${result.from.name} → ${result.to.name} ` +
        `(${result.date} ${result.baseTime}) → ${result.journeys.length}件 / ${result.relaxation}`
      );
    } else {
      console.log(`[api] 経路検索: 見つからず (${result.reason})`);
    }
    res.json(result);
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

// ==========================================================
// 運行監視系の管理API（運行ダッシュボード・便の割当監視・通過判定・異常アラート・
// GTFS/位置情報フィード監視・API稼働監視・ジョブ監視）。
// いずれもDBスキーマ追加なし。既存テーブルからのライブ読み取りか、
// jobMonitor/apiMetrics（プロセスメモリ上のトラッカー、visitorTracker.jsと同じ流儀）を使う。
// ==========================================================

function parseServiceDateParam(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : getServiceDateString();
}

// 正常終了とみなす end_reason（緑色表示用。unassignedの赤系と区別するため）
const SUCCESS_END_REASONS = new Set(['最終バス停到着済', '終了エリア到達']);

// GET /api/admin/dashboard-summary -> 運行ダッシュボード
router.get('/admin/dashboard-summary', requireAdminAuth, async (req, res) => {
  try {
    const serviceDate = getServiceDateString();

    const [activeVehiclesRes, unassignedRes, delayedRes, staleGpsRes] = await Promise.all([
      pool.query(`SELECT count(*)::int AS count FROM vehicles WHERE status = 'active'`),
      pool.query(
        `SELECT count(*)::int AS count
         FROM daily_trips
         WHERE service_date = $1 AND assignment_state = 'unassigned' AND closed_at IS NULL`,
        [serviceDate]
      ),
      pool.query(
        `SELECT count(*)::int AS count
         FROM trip_vehicle_assignments a
         JOIN daily_trips d ON d.id = a.daily_trip_id
         WHERE a.role = 'assigned' AND a.state = 'active'
           AND a.delay_minutes >= $1
           AND d.service_date = $2`,
        [DELAY_ALERT_MIN, serviceDate]
      ),
      pool.query(
        `SELECT count(*)::int AS count
         FROM vehicles
         WHERE status = 'active'
           AND (last_gps_at IS NULL OR last_gps_at < now() - make_interval(secs => $1::double precision * 60))`,
        [STALE_GPS_MIN]
      )
    ]);

    const enabledGtfsFeeds = getEnabledGtfsFeeds();
    const feedIds = enabledGtfsFeeds.map((f) => f.id);
    const feedRowsRes = feedIds.length > 0
      ? await pool.query(
          `SELECT id, last_fetched_at, last_status, last_error FROM feeds WHERE id = ANY($1::text[])`,
          [feedIds]
        )
      : { rows: [] };
    const feedRowById = new Map(feedRowsRes.rows.map((r) => [r.id, r]));
    const gtfsFeeds = enabledGtfsFeeds.map((f) => {
      const row = feedRowById.get(f.id);
      return {
        id: f.id,
        name: f.name,
        lastFetchedAt: row ? row.last_fetched_at : null,
        lastStatus: row ? row.last_status : null,
        lastError: row ? row.last_error : null
      };
    });

    res.json({
      activeVehicles: activeVehiclesRes.rows[0].count,
      unassignedTripsCount: unassignedRes.rows[0].count,
      delayedTripsCount: delayedRes.rows[0].count,
      staleGpsVehicleCount: staleGpsRes.rows[0].count,
      gtfsFeeds,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[api] /admin/dashboard-summary エラー:', err);
    res.status(500).json({ error: '運行ダッシュボードの取得に失敗しました。' });
  }
});

// GET /api/admin/assignment-monitor?date=YYYY-MM-DD -> 便ごとの担当・候補・割当時刻・距離・未割当理由
router.get('/admin/assignment-monitor', requireAdminAuth, async (req, res) => {
  try {
    const serviceDate = parseServiceDateParam(req.query.date);

    const tripsRes = await pool.query(
      `SELECT id, route_id, direction_id, start_time, headsign, assignment_state, closed_at
       FROM daily_trips
       WHERE service_date = $1
       ORDER BY start_at ASC, id ASC`,
      [serviceDate]
    );

    const tripIds = tripsRes.rows.map((t) => t.id);
    if (tripIds.length === 0) return res.json({ date: serviceDate, trips: [] });

    const assignmentsRes = await pool.query(
      `SELECT a.daily_trip_id, a.role, a.state, a.distance_meters, a.became_assigned_at, a.end_reason,
              v.id AS vehicle_id, v.car_id
       FROM trip_vehicle_assignments a
       JOIN vehicles v ON v.id = a.vehicle_id
       WHERE a.daily_trip_id = ANY($1::bigint[])
       ORDER BY a.daily_trip_id ASC, a.distance_meters ASC`,
      [tripIds]
    );

    const byTrip = new Map();
    for (const row of assignmentsRes.rows) {
      const list = byTrip.get(row.daily_trip_id) || [];
      list.push(row);
      byTrip.set(row.daily_trip_id, list);
    }

    const trips = tripsRes.rows.map((trip) => {
      const rows = byTrip.get(trip.id) || [];
      const assignedRow = rows.find((r) => r.role === 'assigned' && r.state === 'active');
      const candidateRows = rows.filter((r) => r.role === 'candidate' && r.state === 'active');

      let reason = null;
      let outcome = 'pending';

      if (trip.assignment_state === 'pending') {
        outcome = 'pending';
      } else if (assignedRow) {
        outcome = 'assigned';
      } else if (rows.length === 0) {
        reason = '候補なし';
        outcome = 'unassigned';
      } else {
        const assignedRoleRows = rows.filter((r) => r.role === 'assigned');
        assignedRoleRows.sort((a, b) => {
          const at = a.became_assigned_at ? new Date(a.became_assigned_at).getTime() : -Infinity;
          const bt = b.became_assigned_at ? new Date(b.became_assigned_at).getTime() : -Infinity;
          return bt - at;
        });
        const lastAssignedRow = assignedRoleRows[0];
        reason = (lastAssignedRow && lastAssignedRow.end_reason) || '候補が同時刻帯の別便の担当';
        outcome = trip.closed_at && SUCCESS_END_REASONS.has(reason) ? 'success' : 'unassigned';
      }

      return {
        tripId: trip.id,
        routeId: trip.route_id,
        directionId: trip.direction_id,
        startTime: trip.start_time,
        headsign: trip.headsign || null,
        assignmentState: trip.assignment_state,
        closedAt: trip.closed_at,
        outcome,
        assigned: assignedRow
          ? {
              vehicleId: assignedRow.vehicle_id,
              carId: assignedRow.car_id,
              distanceMeters: assignedRow.distance_meters,
              becameAssignedAt: assignedRow.became_assigned_at
            }
          : null,
        candidates: candidateRows.map((r) => ({
          vehicleId: r.vehicle_id,
          carId: r.car_id,
          distanceMeters: r.distance_meters
        })),
        reason
      };
    });

    res.json({ date: serviceDate, trips });
  } catch (err) {
    console.error('[api] /admin/assignment-monitor エラー:', err);
    res.status(500).json({ error: '便の割当監視データの取得に失敗しました。' });
  }
});

// GET /api/admin/pass-status?date=YYYY-MM-DD -> 通過判定の現在状態スナップショット（履歴ではない）
router.get('/admin/pass-status', requireAdminAuth, async (req, res) => {
  try {
    const serviceDate = parseServiceDateParam(req.query.date);

    const result = await pool.query(
      `SELECT d.id AS trip_id, d.start_time, d.headsign, a.id AS assignment_id, a.role, v.car_id,
              s.name AS stop_name, p.seq_order, p.status, p.actual_time, p.delay_minutes
       FROM trip_stop_progress p
       JOIN trip_vehicle_assignments a ON a.id = p.assignment_id
       JOIN daily_trips d ON d.id = a.daily_trip_id
       JOIN stops s ON s.id = p.stop_id
       JOIN vehicles v ON v.id = a.vehicle_id
       WHERE a.state = 'active' AND d.service_date = $1 AND d.closed_at IS NULL
       ORDER BY d.start_at ASC, a.id ASC, p.seq_order ASC`,
      [serviceDate]
    );

    const rows = result.rows.map((row) => ({
      tripId: row.trip_id,
      startTime: row.start_time,
      headsign: row.headsign || null,
      assignmentId: row.assignment_id,
      role: row.role,
      carId: row.car_id,
      stopName: row.stop_name,
      seqOrder: row.seq_order,
      status: row.status,
      actualTime: row.actual_time,
      delayMinutes: row.delay_minutes
    }));

    res.json({ date: serviceDate, rows });
  } catch (err) {
    console.error('[api] /admin/pass-status エラー:', err);
    res.status(500).json({ error: '通過判定データの取得に失敗しました。' });
  }
});

// GET /api/admin/alerts -> 異常アラート（GPS途絶・未割当便・大幅遅延・予測計算失敗・GTFS取得失敗）
router.get('/admin/alerts', requireAdminAuth, async (req, res) => {
  try {
    const serviceDate = getServiceDateString();
    const alerts = [];

    const staleGpsRes = await pool.query(
      `SELECT id AS vehicle_id, car_id, route_id, last_gps_at
       FROM vehicles
       WHERE status = 'active'
         AND (last_gps_at IS NULL OR last_gps_at < now() - make_interval(secs => $1::double precision * 60))
       ORDER BY last_gps_at ASC NULLS FIRST`,
      [STALE_GPS_MIN]
    );
    for (const row of staleGpsRes.rows) {
      alerts.push({
        type: 'staleGps',
        severity: 'warning',
        vehicleId: row.vehicle_id,
        carId: row.car_id,
        routeId: row.route_id,
        lastGpsAt: row.last_gps_at
      });
    }

    const unassignedRes = await pool.query(
      `SELECT id AS trip_id, route_id, start_time, headsign, start_at
       FROM daily_trips
       WHERE assignment_state = 'unassigned' AND closed_at IS NULL
         AND service_date = $2
         AND start_at < now() - make_interval(secs => $1::double precision * 60)
       ORDER BY start_at ASC`,
      [UNASSIGNED_OVERDUE_MIN, serviceDate]
    );
    for (const row of unassignedRes.rows) {
      alerts.push({
        type: 'unassignedTrip',
        severity: 'warning',
        tripId: row.trip_id,
        routeId: row.route_id,
        startTime: row.start_time,
        headsign: row.headsign || null,
        minutesOverdue: Math.round((Date.now() - new Date(row.start_at).getTime()) / 60000)
      });
    }

    const severeDelayRes = await pool.query(
      `SELECT a.id AS assignment_id, a.daily_trip_id, a.delay_minutes, v.car_id, d.start_time, d.headsign
       FROM trip_vehicle_assignments a
       JOIN daily_trips d ON d.id = a.daily_trip_id
       JOIN vehicles v ON v.id = a.vehicle_id
       WHERE a.role = 'assigned' AND a.state = 'active'
         AND a.delay_minutes >= $1
         AND d.service_date = $2
       ORDER BY a.delay_minutes DESC`,
      [SEVERE_DELAY_MIN, serviceDate]
    );
    for (const row of severeDelayRes.rows) {
      alerts.push({
        type: 'severeDelay',
        severity: 'critical',
        assignmentId: row.assignment_id,
        tripId: row.daily_trip_id,
        carId: row.car_id,
        startTime: row.start_time,
        headsign: row.headsign || null,
        delayMinutes: row.delay_minutes
      });
    }

    const etaFailureRes = await pool.query(
      `SELECT a.id AS assignment_id, a.daily_trip_id, v.car_id, d.start_time,
              MAX(tap.computed_at) AS last_computed_at
       FROM trip_vehicle_assignments a
       JOIN daily_trips d ON d.id = a.daily_trip_id
       JOIN vehicles v ON v.id = a.vehicle_id
       LEFT JOIN trip_arrival_predictions tap ON tap.assignment_id = a.id
       WHERE a.role = 'assigned' AND a.state = 'active' AND d.service_date = $2
       GROUP BY a.id, a.daily_trip_id, v.car_id, d.start_time
       HAVING MAX(tap.computed_at) IS NULL
          OR MAX(tap.computed_at) < now() - make_interval(secs => $1::double precision * 60)`,
      [ETA_STALE_MIN, serviceDate]
    );
    for (const row of etaFailureRes.rows) {
      alerts.push({
        type: 'etaComputeFailure',
        severity: 'warning',
        assignmentId: row.assignment_id,
        tripId: row.daily_trip_id,
        carId: row.car_id,
        startTime: row.start_time,
        lastComputedAt: row.last_computed_at
      });
    }

    const enabledGtfsFeedIds = getEnabledGtfsFeeds().map((f) => f.id);
    const gtfsFailureRes = enabledGtfsFeedIds.length > 0
      ? await pool.query(
          `SELECT id, name, last_fetched_at, last_error
           FROM feeds
           WHERE feed_type = 'gtfs' AND last_status = 'error' AND id = ANY($1::text[])`,
          [enabledGtfsFeedIds]
        )
      : { rows: [] };
    for (const row of gtfsFailureRes.rows) {
      alerts.push({
        type: 'gtfsFetchFailure',
        severity: 'critical',
        feedId: row.id,
        feedName: row.name,
        lastFetchedAt: row.last_fetched_at,
        lastError: row.last_error
      });
    }

    const counts = alerts.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] || 0) + 1;
      return acc;
    }, {});

    alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));

    res.json({ alerts, counts, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[api] /admin/alerts エラー:', err);
    res.status(500).json({ error: '異常アラートの取得に失敗しました。' });
  }
});

// GET /api/admin/gtfs-feeds -> GTFSフィード監視（最終取得時刻・ファイル件数・エラー内容）
router.get('/admin/gtfs-feeds', requireAdminAuth, async (req, res) => {
  try {
    const feeds = getEnabledGtfsFeeds();
    const ids = feeds.map((f) => f.id);
    const rowsRes = ids.length > 0
      ? await pool.query(`SELECT id, last_fetched_at, last_status, last_error FROM feeds WHERE id = ANY($1::text[])`, [ids])
      : { rows: [] };
    const rowById = new Map(rowsRes.rows.map((r) => [r.id, r]));
    const jobStatus = jobMonitor.getJobStatus('pipeline.gtfsUpdate');

    const result = feeds.map((f) => {
      const row = rowById.get(f.id);
      let fileCount = 0;
      try {
        const names = fs.readdirSync(getGtfsDir(f.id));
        fileCount = names.filter((name) => MANAGED_GTFS_FILES.includes(name)).length;
      } catch (e) {
        fileCount = 0;
      }
      return {
        id: f.id,
        name: f.name,
        lastFetchedAt: row ? row.last_fetched_at : null,
        lastStatus: row ? row.last_status : null,
        lastError: row ? row.last_error : null,
        fileCount
      };
    });

    res.json({
      feeds: result,
      lastJobRun: jobStatus
        ? { lastFinishedAt: jobStatus.lastFinishedAt, lastDurationMs: jobStatus.lastDurationMs, lastMeta: jobStatus.lastMeta }
        : null
    });
  } catch (err) {
    console.error('[api] /admin/gtfs-feeds エラー:', err);
    res.status(500).json({ error: 'GTFSフィード監視データの取得に失敗しました。' });
  }
});

// POST /api/admin/gtfs-feeds/:feedId/refetch -> 手動再取得
router.post('/admin/gtfs-feeds/:feedId/refetch', requireAdminAuth, async (req, res) => {
  const feed = getEnabledGtfsFeeds().find((f) => f.id === req.params.feedId);
  if (!feed) {
    return res.status(404).json({ error: '指定のGTFSフィードが見つかりません。' });
  }

  const client = await pool.connect();
  try {
    const success = await jobMonitor.track('pipeline.gtfsManualRefetch', () =>
      downloadAndExtractGtfsFeed(client, feed)
    );

    if (success) {
      try {
        const seed = require('../db/seed');
        await seed();
        require('../services/dailyTripBuilder').invalidateDailyTripCache();
        require('../services/gtfsTimetable').invalidateTimetableIndex();
        require('../services/gtfsFare').invalidateFareIndex();
      } catch (postErr) {
        console.error('[api] /admin/gtfs-feeds/:feedId/refetch 事後処理エラー:', postErr.message);
      }
    }

    const row = await pool.query(
      `SELECT last_fetched_at, last_status, last_error FROM feeds WHERE id = $1`,
      [feed.id]
    );
    let fileCount = 0;
    try {
      const names = fs.readdirSync(getGtfsDir(feed.id));
      fileCount = names.filter((name) => MANAGED_GTFS_FILES.includes(name)).length;
    } catch (e) {
      fileCount = 0;
    }

    res.json({
      success,
      feed: {
        id: feed.id,
        name: feed.name,
        lastFetchedAt: row.rows[0] ? row.rows[0].last_fetched_at : null,
        lastStatus: row.rows[0] ? row.rows[0].last_status : null,
        lastError: row.rows[0] ? row.rows[0].last_error : null,
        fileCount
      }
    });
  } catch (err) {
    console.error('[api] /admin/gtfs-feeds/:feedId/refetch エラー:', err);
    res.status(500).json({ error: 'GTFSフィードの再取得に失敗しました。' });
  } finally {
    client.release();
  }
});

// GET /api/admin/location-feeds -> 位置情報フィード監視（最終受信時刻・受信件数・形式異常）
router.get('/admin/location-feeds', requireAdminAuth, async (req, res) => {
  try {
    const feeds = getEnabledLocationFeeds();
    const ids = feeds.map((f) => f.id);
    const rowsRes = ids.length > 0
      ? await pool.query(`SELECT id, last_fetched_at, last_status, last_error FROM feeds WHERE id = ANY($1::text[])`, [ids])
      : { rows: [] };
    const rowById = new Map(rowsRes.rows.map((r) => [r.id, r]));
    const jobStatus = jobMonitor.getJobStatus('pipeline.fetchLocation');

    const lastFeedResults = new Map();
    if (jobStatus && jobStatus.lastMeta && Array.isArray(jobStatus.lastMeta.feeds)) {
      for (const f of jobStatus.lastMeta.feeds) {
        if (f && f.feedId) lastFeedResults.set(f.feedId, f);
      }
    }

    const result = feeds.map((f) => {
      const row = rowById.get(f.id);
      return {
        id: f.id,
        name: f.name,
        lastFetchedAt: row ? row.last_fetched_at : null,
        lastStatus: row ? row.last_status : null,
        lastError: row ? row.last_error : null,
        lastRunCounts: lastFeedResults.get(f.id) || null
      };
    });

    res.json({
      feeds: result,
      lastJobRun: jobStatus ? { lastFinishedAt: jobStatus.lastFinishedAt, lastDurationMs: jobStatus.lastDurationMs } : null
    });
  } catch (err) {
    console.error('[api] /admin/location-feeds エラー:', err);
    res.status(500).json({ error: '位置情報フィード監視データの取得に失敗しました。' });
  }
});

// GET /api/admin/api-stats -> API稼働監視（応答時間・エラー率・アクセス数・失敗したエンドポイント）
router.get('/admin/api-stats', requireAdminAuth, (req, res) => {
  res.json(apiMetrics.getStats());
});

// GET /api/admin/job-monitor -> ジョブ監視（各パイプライン工程の最終成功時刻・所要時間・失敗履歴）
router.get('/admin/job-monitor', requireAdminAuth, (req, res) => {
  res.json({ jobs: jobMonitor.getJobsStatus() });
});

// ==========================================================
// ETA予測の根拠表示・精度監視・運行実績ダウンロード
// いずれも既存のETA計算(etaPredictor.js)・パイプラインには書き込みを行わない、
// 読み取り専用の追加API。予測精度監視はtrip_arrival_prediction_log（追記専用の
// 履歴テーブル）を参照する。
// ==========================================================

// GET /api/admin/eta-basis?date=YYYY-MM-DD
// -> 稼働中の便・停留所ごとに、ETA予測が何を根拠にしたか（時刻表／過去統計／
//    直近走行ペースのどれを使ったか）を表示する。
router.get('/admin/eta-basis', requireAdminAuth, async (req, res) => {
  try {
    const serviceDate = parseServiceDateParam(req.query.date);

    const result = await pool.query(
      `SELECT d.id AS trip_id, d.start_time, d.headsign, a.id AS assignment_id, a.role, v.car_id,
              s.name AS stop_name, p.seq_order, p.status, p.scheduled_time, p.actual_time, p.delay_minutes,
              tap.predicted_time, tap.predicted_delay_minutes, tap.source, tap.computed_at
       FROM trip_stop_progress p
       JOIN trip_vehicle_assignments a ON a.id = p.assignment_id
       JOIN daily_trips d ON d.id = a.daily_trip_id
       JOIN stops s ON s.id = p.stop_id
       JOIN vehicles v ON v.id = a.vehicle_id
       LEFT JOIN trip_arrival_predictions tap ON tap.assignment_id = a.id AND tap.stop_id = p.stop_id
       WHERE a.state = 'active' AND d.service_date = $1 AND d.closed_at IS NULL
       ORDER BY d.start_at ASC, a.id ASC, p.seq_order ASC`,
      [serviceDate]
    );

    const rows = result.rows.map((row) => {
      const info = describeSource(row.source);
      return {
        tripId: row.trip_id,
        startTime: row.start_time,
        headsign: row.headsign || null,
        assignmentId: row.assignment_id,
        role: row.role,
        carId: row.car_id,
        stopName: row.stop_name,
        seqOrder: row.seq_order,
        status: row.status,
        scheduledTime: row.scheduled_time,
        actualTime: row.actual_time,
        predictedTime: row.predicted_time,
        predictedDelayMinutes: row.predicted_delay_minutes,
        source: row.source,
        basisCategory: info.category,
        basisLabel: info.label,
        computedAt: row.computed_at
      };
    });

    res.json({ date: serviceDate, sourceLegend: SOURCE_INFO, rows });
  } catch (err) {
    console.error('[api] /admin/eta-basis エラー:', err);
    res.status(500).json({ error: 'ETA予測根拠データの取得に失敗しました。' });
  }
});

// GET /api/admin/prediction-accuracy?days=7&routeId=...&thresholdMinutes=3&leadBucket=...&stopsBeforeBucket=...
// -> 予測（何分前・何停留所前時点の予測か）と実績の誤差を、路線・停留所・時間帯・曜日別に集計する。
// 誤差許容分数(thresholdMinutes)やリードタイム/停留所数での絞り込みは管理画面から指定できる。
router.get('/admin/prediction-accuracy', requireAdminAuth, async (req, res) => {
  try {
    const report = await getAccuracyReport({
      days: req.query.days,
      routeId: req.query.routeId || null,
      thresholdMinutes: req.query.thresholdMinutes,
      leadBucket: req.query.leadBucket || null,
      stopsBeforeBucket: req.query.stopsBeforeBucket || null
    });
    res.json(report);
  } catch (err) {
    console.error('[api] /admin/prediction-accuracy エラー:', err);
    res.status(500).json({ error: 'ETA予測精度データの取得に失敗しました。' });
  }
});

// GET /api/admin/operation-records/export?from=YYYY-MM-DD&to=YYYY-MM-DD&routeId=...
// -> 運行実績（completed_trips/completed_trip_stop_times）をCSVでダウンロードする。
router.get('/admin/operation-records/export', requireAdminAuth, async (req, res) => {
  try {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : getServiceDateString();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : to;

    const params = [from, to];
    let routeFilter = '';
    if (req.query.routeId) {
      params.push(req.query.routeId);
      routeFilter = `AND ct.route_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT ct.id AS completed_trip_id, ct.route_id, r.name AS route_name, ct.car_id, ct.start_time,
              ct.is_official, ct.day_of_week, ct.day_type, ct.finish_reason, ct.finished_at,
              cts.seq_order, s.name AS stop_name, cts.scheduled_time, cts.actual_time, cts.delay_minutes
       FROM completed_trips ct
       JOIN routes r ON r.id = ct.route_id
       LEFT JOIN completed_trip_stop_times cts ON cts.completed_trip_id = ct.id
       LEFT JOIN stops s ON s.id = cts.stop_id
       WHERE (ct.finished_at AT TIME ZONE 'Asia/Tokyo')::date BETWEEN $1::date AND $2::date
         ${routeFilter}
       ORDER BY ct.finished_at ASC, ct.id ASC, cts.seq_order ASC
       LIMIT 200000`,
      params
    );

    const header = ['完了トリップID', '路線ID', '路線名', '車両ID', '便始発時刻', '実績種別', '曜日番号', '曜日区分', '終了理由', '終了確定日時(JST)', '停留所順', '停留所名', '定刻', '実績時刻', '遅延分'];
    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.map(csvEscape).join(',')];
    for (const row of result.rows) {
      lines.push([
        row.completed_trip_id,
        row.route_id,
        row.route_name,
        row.car_id,
        row.start_time,
        row.is_official ? '正式' : '参考（候補車両）',
        row.day_of_week,
        row.day_type,
        row.finish_reason,
        row.finished_at ? new Date(row.finished_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '',
        row.seq_order,
        row.stop_name,
        row.scheduled_time,
        row.actual_time,
        row.delay_minutes
      ].map(csvEscape).join(','));
    }
    const csv = '﻿' + lines.join('\r\n'); // ExcelでのUTF-8誤認識を防ぐBOM付き

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="operation-records_${from}_${to}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[api] /admin/operation-records/export エラー:', err);
    res.status(500).json({ error: '運行実績のダウンロードに失敗しました。' });
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

// ==========================================================
// バス停検索機能（補完仕様書）。内部実装は時刻表検索と統一し、
// エンドポイント名のみ /api/busstop/... に分ける（補完仕様書 10.2）。
//   /api/busstop/search                  バス停名検索（/timetable/stops/search の別名）
//   /api/busstop/nearby                  現在地から近いバス停（新規。検索画面・経路検索画面の入力補助）
//   /api/busstop/{stopKey}/approaching   接近中のバス情報（新規）
// バス停詳細そのものは新規エンドポイントを作らず、既存の
// /api/timetable/stops/{stopKey} をフロントから直接利用する。
// ==========================================================

// GET /api/busstop/search?q=...&limit=... -> /api/timetable/stops/search と同一データ
router.get('/busstop/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json({ stops: [] });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '20', 10) || 20, 1), 50);
    const stops = await searchTimetableStops(query, limit);
    res.json({ stops });
  } catch (err) {
    console.error('[api] /busstop/search エラー:', err);
    res.status(500).json({ error: 'バス停検索に失敗しました。' });
  }
});

// GET /api/busstop/nearby?lat=...&lon=...&limit=... -> 現在地から近い順のバス停（既定5件）。
// バス停検索・経路検索画面で、入力欄への自動フォーカスの代わりに提示する候補として使う。
router.get('/busstop/nearby', async (req, res) => {
  try {
    const lat = Number.parseFloat(req.query.lat);
    const lon = Number.parseFloat(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: '緯度・経度を指定してください。' });
    }
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '5', 10) || 5, 1), 20);
    const stops = await searchNearbyStops(lat, lon, limit);
    res.json({ stops });
  } catch (err) {
    console.error('[api] /busstop/nearby エラー:', err);
    res.status(500).json({ error: '近くのバス停の取得に失敗しました。' });
  }
});

// GET /api/busstop/:stopKey/approaching -> 現在時刻±30分以内に到着予定の便一覧（補完仕様書 3.5）
// クエリ: date=YYYY-MM-DD（省略時は本日） / platform=標柱のstop_id（省略時は全標柱）
router.get('/busstop/:stopKey/approaching', async (req, res) => {
  try {
    const data = await getApproachingBuses(req.params.stopKey, {
      date: req.query.date,
      platform: req.query.platform
    });
    if (!data) return res.status(404).json({ error: '指定のバス停が見つかりませんでした。' });
    res.json(data);
  } catch (err) {
    console.error('[api] /busstop/:stopKey/approaching エラー:', err);
    res.status(500).json({ error: '接近中のバス情報の取得に失敗しました。' });
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
