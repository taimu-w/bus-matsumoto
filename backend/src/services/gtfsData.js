const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { getGtfsDir, unqualifyRouteId } = require('./gtfsFeedManager');

const GTFS_DIR = getGtfsDir(null);
const EXTERNAL_ROUTE_ID_ALIASES = {
  '01h9j06f82mw3wvnddsbs4z7fs': 'guruttomatsumotobus1:11'
};

// GTFSフィードIDのキャッシュ（1分間有効）
let gtfsFeedIdCache = {
  feeds: [],
  fetchedAt: 0
};
const GTFS_FEED_CACHE_TTL_MS = 60 * 1000;

/**
 * DBから有効なGTFSフィードID一覧を取得する（キャッシュ付き）。
 */
async function getActiveGtfsFeedIds() {
  const now = Date.now();
  if (gtfsFeedIdCache.feeds.length > 0 && now - gtfsFeedIdCache.fetchedAt < GTFS_FEED_CACHE_TTL_MS) {
    return gtfsFeedIdCache.feeds;
  }

  try {
    const res = await pool.query(
      `SELECT id FROM feeds WHERE feed_type = 'gtfs' AND enabled = TRUE ORDER BY id ASC`
    );
    gtfsFeedIdCache = { feeds: res.rows.map((r) => r.id), fetchedAt: now };
    return gtfsFeedIdCache.feeds;
  } catch (err) {
    console.error('[gtfsData] GTFSフィード一覧取得エラー:', err.message);
    // フォールバック: キャッシュ済みフィードを使う
    return gtfsFeedIdCache.feeds;
  }
}

/**
 * route_id を解決する。
 * 複数GTFSフィード対応のため、DB（routes/vehicles/stops等）のroute_idは
 * 「feedId:routeId」形式のプレフィックス付きで保存されている（seed.jsのqualifyRouteId参照）。
 * そのためここではプレフィックスを除去せず、DBの値とそのまま一致させる。
 * システム設定など、routeIdが省略可能なケースではデフォルト値（横田信大循環線）を使用
 */
function resolveRouteId(routeId) {
  if (!routeId) {
    return 'guruttomatsumotobus1:11';
  }
  return EXTERNAL_ROUTE_ID_ALIASES[routeId] || routeId;
}

/**
 * GTFSデータを読み込むためのヘルパー。
 * feedIdが指定された場合はそのフィードのディレクトリから読み込む。
 */
function getCsvDir(feedId) {
  return getGtfsDir(feedId);
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function readCsv(fileName, feedId) {
  const filePath = path.join(getCsvDir(feedId), fileName);
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (rows.length === 0) return [];

  const headers = parseCsvLine(rows[0]);
  return rows.slice(1).map((row) => {
    const values = parseCsvLine(row);
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });
    return record;
  });
}

function toClockTime(value) {
  if (!value) return null;
  const parts = String(value).split(':');
  if (parts.length < 2) return null;
  const [h, m] = parts;
  const hour = Number.parseInt(h, 10);
  const minute = Number.parseInt(m, 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 全フィードのroute catalogを取得する。
 * route_idはフィードIDプレフィックス付きで返す（グローバルで一意にするため）。
 */
async function loadRouteCatalogForAllFeeds() {
  const feedIds = await getActiveGtfsFeedIds();
  const allRoutes = [];

  for (const feedId of feedIds) {
    try {
      const routes = readCsv('routes.txt', feedId);
      const feedRoutes = routes
        .map((route) => ({
          routeId: route.route_id,
          qualifiedRouteId: `${feedId}:${route.route_id}`,
          routeName: route.route_long_name || route.route_short_name || route.route_id,
          routeShortName: route.route_short_name || '',
          routeColor: route.route_color || '',
          routeTextColor: route.route_text_color || '',
          feedId
        }))
        .filter((route) => route.routeId);
      allRoutes.push(...feedRoutes);
    } catch (err) {
      console.error(`[gtfsData] feed=${feedId} routes.txt読み込みエラー:`, err.message);
    }
  }

  // 既存の静的GTFSデータ（フィード未設定の場合）も読み込む
  try {
    if (fs.existsSync(path.join(GTFS_DIR, 'routes.txt'))) {
      const routes = readCsv('routes.txt', null);
      const staticRoutes = routes
        .map((route) => ({
          routeId: route.route_id,
          qualifiedRouteId: route.route_id,
          routeName: route.route_long_name || route.route_short_name || route.route_id,
          routeShortName: route.route_short_name || '',
          routeColor: route.route_color || '',
          routeTextColor: route.route_text_color || '',
          feedId: null
        }))
        .filter((route) => route.routeId);
      allRoutes.push(...staticRoutes);
    }
  } catch (err) {
    console.error('[gtfsData] 静的GTFS routes.txt読み込みエラー:', err.message);
  }

  return allRoutes;
}

/**
 * フィードIDを意識しない従来のloadRouteCatalog（後方互換）
 * DBのroutesテーブルから取得する方式に変更
 */
async function loadRouteCatalog() {
  try {
    const result = await pool.query(
      `SELECT id, name, short_name, color, text_color, feed_id
       FROM routes
       ORDER BY id ASC`
    );
    return result.rows.map((row) => ({
      routeId: row.id,
      routeName: row.name || row.id,
      routeShortName: row.short_name || '',
      routeColor: row.color || '',
      routeTextColor: row.text_color || '',
      feedId: row.feed_id || null
    }));
  } catch (err) {
    console.error('[gtfsData] loadRouteCatalog(DB) エラー:', err.message);
    return [];
  }
}

/**
 * 指定フィードのroute catalogを取得する。
 */
function loadRouteCatalogByFeed(feedId) {
  const routes = readCsv('routes.txt', feedId);
  return routes
    .map((route) => ({
      routeId: route.route_id,
      qualifiedRouteId: `${feedId}:${route.route_id}`,
      routeName: route.route_long_name || route.route_short_name || route.route_id,
      routeShortName: route.route_short_name || '',
      routeColor: route.route_color || '',
      routeTextColor: route.route_text_color || '',
      feedId
    }))
    .filter((route) => route.routeId);
}

/**
 * 指定路線のデータを読み込む。
 * routeIdは「feedId:routeId」形式または従来のrouteId。
 * feedId指定時はそのフィードディレクトリから読み込む。
 */
async function loadRouteData(routeId) {
  if (!routeId) {
    throw new Error('routeId is required for loadRouteData');
  }
  const normalizedRouteId = resolveRouteId(routeId);

  // routeIdにフィードプレフィックスが含まれる場合はそのフィードから読み込む
  let feedId = null;
  let originalRouteId = normalizedRouteId;
  if (typeof routeId === 'string' && routeId.includes(':')) {
    [feedId, originalRouteId] = routeId.split(':');
  }

  // フィードIDが特定できない場合は、DBのroutesテーブルからfeed_idを探す
  if (!feedId && normalizedRouteId) {
    try {
      const res = await pool.query('SELECT feed_id FROM routes WHERE id = $1', [normalizedRouteId]);
      feedId = res.rows[0]?.feed_id || null;
    } catch (err) {
      console.error('[gtfsData] routesテーブルfeed_id取得エラー:', err.message);
    }
  }

  const routeCatalog = feedId ? loadRouteCatalogByFeed(feedId) : await loadRouteCatalog();
  const route = routeCatalog.find((item) => item.routeId === originalRouteId) || routeCatalog[0];

  if (!route) {
    return { route: null, stops: [], timetable: [] };
  }

  const stopRows = readCsv('stops.txt', feedId);
  const stopById = new Map(
    stopRows.map((row) => [row.stop_id, { ...row, stopName: row.stop_name, lat: parseFloat(row.stop_lat), lon: parseFloat(row.stop_lon) }])
  );

  const tripRows = readCsv('trips.txt', feedId).filter((row) => row.route_id === route.routeId);
  const tripIds = new Set(tripRows.map((trip) => trip.trip_id));

  const stopTimeRows = readCsv('stop_times.txt', feedId).filter((row) => tripIds.has(row.trip_id));
  const stopSequenceMap = new Map();

  for (const row of stopTimeRows) {
    const seq = Number.parseInt(row.stop_sequence, 10);
    if (Number.isNaN(seq)) continue;
    if (!stopSequenceMap.has(row.stop_id) || seq < stopSequenceMap.get(row.stop_id)) {
      stopSequenceMap.set(row.stop_id, seq);
    }
  }

  const orderedStops = Array.from(stopSequenceMap.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([stopId, seq]) => {
      const stop = stopById.get(stopId);
      if (!stop) return null;
      return {
        stopId,
        seqOrder: seq - 1,
        name: stop.stopName,
        lat: stop.lat,
        lon: stop.lon
      };
    })
    .filter(Boolean);

  const timetable = tripRows
    .map((trip, tripIndex) => {
      const tripStopTimes = stopTimeRows
        .filter((row) => row.trip_id === trip.trip_id)
        .sort((a, b) => Number.parseInt(a.stop_sequence, 10) - Number.parseInt(b.stop_sequence, 10));

      const stops = tripStopTimes.map((row) => {
        const stop = stopById.get(row.stop_id);
        const isThrough = row.pickup_type === '1' || row.drop_off_type === '1';
        return {
          seqOrder: Number.parseInt(row.stop_sequence, 10) - 1,
          stopName: stop?.stop_name || row.stop_id,
          scheduledTime: isThrough ? null : toClockTime(row.departure_time || row.arrival_time),
          isThrough
        };
      });

      const firstStop = stops.find((stop) => stop.scheduledTime);
      return {
        tripIndex,
        routeId: route.routeId,
        routeName: route.routeName,
        firstStopTime: firstStop?.scheduledTime || null,
        stops
      };
    })
    .sort((a, b) => {
      const aMin = a.firstStopTime ? Number.parseInt(a.firstStopTime.split(':')[0], 10) * 60 + Number.parseInt(a.firstStopTime.split(':')[1], 10) : 1440;
      const bMin = b.firstStopTime ? Number.parseInt(b.firstStopTime.split(':')[0], 10) * 60 + Number.parseInt(b.firstStopTime.split(':')[1], 10) : 1440;
      return aMin - bMin;
    });

  return {
    route: route || null,
    stops: orderedStops,
    timetable
  };
}

module.exports = {
  resolveRouteId,
  loadRouteCatalog,
  loadRouteCatalogByFeed,
  loadRouteCatalogForAllFeeds,
  loadRouteData
};