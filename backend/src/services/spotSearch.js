// スポット検索（docs/spot-search.md / frontend/spotsearch.js）
//
// 「簡易的な路線・バス停検索」。利用者が地名（観光スポット・その他のスポット）やバス停・路線を
// 1つ入力すると、
//   - 観光スポット／その他のスポットなら、そのスポット情報
//   - あわせて、その付近のバス停と、それらを通る路線
// を返す。路線名クリックでリアルタイム時刻表（#/realtime/{feedId}/{routeId}）、
// バス停名タップでバス停ページ（/busstop/{stopKey}）へ遷移する。
//
// リアルタイム運行状況・経路検索とは探索のデータ経路が独立しており、
// GTFSインメモリインデックス（gtfsTimetable.js）と tourist_spots テーブルだけを見る。
// バス停との関連付けは保存時ではなく参照時に緯度経度の近接検索で都度解決する
// （観光スポット情報機能と同じ方針）。

const pool = require('../config/db');
const { normalizeSearchText } = require('../utils/kana');
const gtfsTimetable = require('./gtfsTimetable');
const touristSpots = require('./touristSpots');

// 付近のバス停を探す既定の半径・件数（観光スポット情報機能の findNearbySpots と同じ初期値）。
const DEFAULT_NEARBY_RADIUS_METERS = 500;
const DEFAULT_NEARBY_LIMIT = 8;
const MAX_NEARBY_RADIUS_METERS = 3000;
const MAX_NEARBY_LIMIT = 20;
// searchNearbyStops は「近い順に N 件」で半径を取らないため、半径内を取りこぼさないよう
// 多めに取ってから距離でフィルタする（市内の 500m 圏に 80 停留所は入らない）。
const NEARBY_SCAN_LIMIT = 80;

// 検索回数集計（spot_search_counts）の保持日数。tourist_spot_link_clicks と揃える
// （1年ルックバックが常に成立するよう13か月弱）。scheduler.js の1時間掃除から呼ばれる。
const SEARCH_COUNT_RETENTION_DAYS = 400;
// 観光スポットに解決しなかった検索（バス停・地名）の集計に使う spot_id。
// tourist_spots.id は管理画面で指定する空でない文字列なので、空文字とは衝突しない。
const UNRESOLVED_SPOT_ID = '';
const UNRESOLVED_SPOT_NAME = '(スポット未確定)';

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * 正規化済みクエリ nq に対する name の一致スコア（純粋関数・テスト対象）。
 *   3=完全一致 / 2=前方一致 / 1=部分一致 / 0=不一致
 */
function scoreNameMatch(name, nq) {
  const n = normalizeSearchText(name);
  if (!n || !nq) return 0;
  if (n === nq) return 3;
  if (n.startsWith(nq)) return 2;
  if (n.includes(nq)) return 1;
  return 0;
}

/** 複数バス停から集めた路線を feedId:routeId で重複排除し、略称→名称の五十音順に並べる（純粋関数）。 */
function dedupeRoutes(routes) {
  const seen = new Map();
  for (const route of routes || []) {
    const key = `${route.feedId}:${route.routeId}`;
    if (!seen.has(key)) seen.set(key, route);
  }
  return Array.from(seen.values()).sort((a, b) =>
    String(a.shortName || a.name).localeCompare(String(b.shortName || b.name), 'ja'));
}

/** routes テーブルの id 集合（"feedId:routeId"）。リアルタイム時刻表が引けない路線を結果から落とすため。 */
async function getDbRouteIdSet() {
  const { rows } = await pool.query('SELECT id FROM routes');
  return new Set(rows.map((row) => row.id));
}

/** qualified route id（"feedId:routeId"）を分解する。app.js の routeHref() と同じ規約（先頭の ':' で分割）。 */
function splitRouteId(qualifiedId, feedIdColumn) {
  const sep = String(qualifiedId).indexOf(':');
  if (sep < 0) return { feedId: feedIdColumn || '', routeId: qualifiedId };
  return { feedId: qualifiedId.slice(0, sep), routeId: qualifiedId.slice(sep + 1) };
}

/**
 * 路線名・略称の部分一致検索（漢字・かな。routes テーブルにローマ字は無いため正規化テキストの一致のみ）。
 * 返す路線は必ず routes テーブルに実在するので、#/realtime/{feedId}/{routeId} が確実に開ける。
 */
async function searchRoutes(query, limit = 6) {
  const nq = normalizeSearchText(query);
  if (!nq) return [];
  const { rows } = await pool.query(
    'SELECT id, name, short_name, color, text_color, feed_id FROM routes'
  );
  const scored = [];
  for (const row of rows) {
    const score = Math.max(scoreNameMatch(row.name, nq), scoreNameMatch(row.short_name, nq));
    if (score <= 0) continue;
    const { feedId, routeId } = splitRouteId(row.id, row.feed_id);
    scored.push({
      score,
      route: {
        qualifiedId: row.id,
        feedId,
        routeId,
        name: row.name,
        shortName: row.short_name || '',
        color: row.color || '',
        textColor: row.text_color || ''
      }
    });
  }
  scored.sort((a, b) => b.score - a.score || a.route.name.localeCompare(b.route.name, 'ja'));
  return scored.slice(0, limit).map((entry) => entry.route);
}

/**
 * 入力候補（インクリメンタルサジェスト）。バス停・観光スポット・路線を混ぜて返す。
 * バス停・観光スポットは時刻表検索／経路検索とまったく同じ検索体験（漢字・かな・ローマ字・1文字）。
 */
async function suggest(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return { stops: [], spots: [], routes: [] };
  const lim = clampInt(limit, 1, 20, 8);
  const [stops, spots, routes] = await Promise.all([
    gtfsTimetable.searchStops(q, lim),
    touristSpots.searchTouristSpots(q, Math.max(4, Math.ceil(lim / 2))),
    searchRoutes(q, 6)
  ]);
  return { stops, spots, routes };
}

/** 自由文字列から、バス停／観光スポット／路線の中で最も一致度の高い1件を選ぶ。 */
async function chooseFreeTextTarget(query) {
  const nq = normalizeSearchText(query);
  if (!nq) return null;
  const [stops, spots, routes] = await Promise.all([
    gtfsTimetable.searchStops(query, 5),
    touristSpots.searchTouristSpots(query, 5),
    searchRoutes(query, 5)
  ]);

  const candidates = [
    ...stops.map((stop) => ({
      kind: 'stop',
      stop,
      // order: 同スコアならバス停 > 観光スポット > 路線（バス停検索が主目的のため）
      order: 1,
      score: Math.max(
        scoreNameMatch(stop.stopName, nq),
        scoreNameMatch(stop.nameHiragana, nq),
        scoreNameMatch(stop.nameRomaji, nq)
      )
    })),
    ...spots.map((spot) => ({
      kind: 'spot',
      spotId: spot.spotId,
      order: 2,
      // 別称（からす城・国宝など）でしか一致しないスポットは name/kana/romaji のスコアが0になるため、
      // searchTouristSpots が返した一致度（matchScore: 2=前方一致・1=部分一致）も候補スコアに含める。
      score: Math.max(
        scoreNameMatch(spot.name, nq),
        scoreNameMatch(spot.kana, nq),
        scoreNameMatch(spot.romaji, nq),
        spot.matchScore || 0
      )
    })),
    ...routes.map((route) => ({
      kind: 'route',
      route,
      order: 3,
      score: Math.max(scoreNameMatch(route.name, nq), scoreNameMatch(route.shortName, nq))
    }))
  ].filter((candidate) => candidate.score > 0);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0];
}

/** バス停サマリーを結果表示用に整形し、リアルタイム時刻表が引けない路線を落とす。 */
function shapeStop(summary, dbRouteIds, extra = {}) {
  return {
    stopKey: summary.stopKey,
    stopName: summary.stopName,
    nameHiragana: summary.nameHiragana || null,
    nameRomaji: summary.nameRomaji || null,
    distanceMeters: summary.distanceMeters ?? null,
    walkMinutes: summary.walkMinutes ?? null,
    routes: (summary.routes || [])
      .filter((route) => dbRouteIds.has(`${route.feedId}:${route.routeId}`))
      .map((route) => ({
        feedId: route.feedId,
        routeId: route.routeId,
        name: route.name,
        shortName: route.shortName,
        color: route.color,
        textColor: route.textColor
      })),
    ...extra
  };
}

/**
 * スポット検索の実行。spotId / stopKey / q のいずれかで対象を解決し、
 * スポット情報＋付近のバス停＋周辺を通る路線を返す。対象が確定したら検索回数を +1 する。
 */
async function search({ spotId, stopKey, q, radiusMeters, limit } = {}) {
  const radius = clampInt(radiusMeters, 100, MAX_NEARBY_RADIUS_METERS, DEFAULT_NEARBY_RADIUS_METERS);
  const stopLimit = clampInt(limit, 1, MAX_NEARBY_LIMIT, DEFAULT_NEARBY_LIMIT);
  const query = String(q || '').trim();

  let origin = null; // { lat, lon, name }
  let spot = null; // touristSpots.serializeRow か null
  let primarySummary = null; // gtfsTimetable のバス停サマリー（対象がバス停のとき）
  let resolvedFrom = null; // 'spot' | 'stop' | 'route' | 'fuzzy-spot' | 'fuzzy-stop'
  let countSpotId = UNRESOLVED_SPOT_ID;
  let countSpotName = UNRESOLVED_SPOT_NAME;

  if (spotId) {
    spot = await touristSpots.getSpotById(spotId);
    if (!spot) return notFound('spot-not-found', query);
    origin = { lat: spot.lat, lon: spot.lng, name: spot.name };
    resolvedFrom = 'spot';
    countSpotId = spot.spotId;
    countSpotName = spot.name;
  } else if (stopKey) {
    const summaries = await gtfsTimetable.getStopSummariesByKeys([String(stopKey)]);
    if (summaries.length === 0) return notFound('stop-not-found', query);
    primarySummary = summaries[0];
    origin = { lat: primarySummary.lat, lon: primarySummary.lon, name: primarySummary.stopName };
    resolvedFrom = 'stop';
  } else if (query) {
    const chosen = await chooseFreeTextTarget(query);
    if (!chosen) {
      const [stops, spots] = await Promise.all([
        gtfsTimetable.searchStops(query, 5),
        touristSpots.searchTouristSpots(query, 5)
      ]);
      return { found: false, reason: 'not-found', query, suggestions: { stops, spots } };
    }
    if (chosen.kind === 'route') {
      // 路線に解決したときはリアルタイム時刻表へ誘導する（付近のバス停は出さない）。
      return { found: true, resolvedFrom: 'route', query, route: chosen.route };
    }
    if (chosen.kind === 'spot') {
      spot = await touristSpots.getSpotById(chosen.spotId);
      if (!spot) return notFound('spot-not-found', query);
      origin = { lat: spot.lat, lon: spot.lng, name: spot.name };
      resolvedFrom = 'fuzzy-spot';
      countSpotId = spot.spotId;
      countSpotName = spot.name;
    } else {
      primarySummary = chosen.stop;
      origin = { lat: primarySummary.lat, lon: primarySummary.lon, name: primarySummary.stopName };
      resolvedFrom = 'fuzzy-stop';
    }
  } else {
    return { found: false, reason: 'no-query' };
  }

  const dbRouteIds = await getDbRouteIdSet();

  const nearbyRaw = Number.isFinite(origin.lat) && Number.isFinite(origin.lon)
    ? await gtfsTimetable.searchNearbyStops(origin.lat, origin.lon, NEARBY_SCAN_LIMIT)
    : [];
  const nearbyStops = nearbyRaw
    .filter((summary) => summary.distanceMeters <= radius)
    .filter((summary) => !primarySummary || summary.stopKey !== primarySummary.stopKey)
    .slice(0, stopLimit)
    .map((summary) => shapeStop(summary, dbRouteIds));

  const primaryStop = primarySummary
    ? shapeStop(primarySummary, dbRouteIds, { distanceMeters: 0, walkMinutes: 0, isPrimary: true })
    : null;

  const routes = dedupeRoutes(
    [...(primaryStop ? primaryStop.routes : []), ...nearbyStops.flatMap((s) => s.routes)]
  );

  await recordSpotSearch(countSpotId, countSpotName);

  return {
    found: true,
    resolvedFrom,
    query,
    radiusMeters: radius,
    origin,
    spot,
    primaryStop,
    nearbyStops,
    routes
  };
}

function notFound(reason, query) {
  return { found: false, reason, query };
}

// ==========================================================
// 検索回数の計測（spot_search_counts、docs/spot-search.md）
// 「観光スポットの掲載が有用かどうか」を、リンクのタップ回数と並べて管理者が判断するための集計。
// tourist_spot_link_clicks と同じく Asia/Tokyo 基準の日別カウントで、生ログは持たない。
// 二重カウントの厳密な排除はしない（掲載の有用性の目安のため。リンクタップ計測と同じ方針）。
// ==========================================================

/** スポット検索の結果表示を1回記録する（当日行を +1）。spot_id='' は観光スポット以外に解決した検索。 */
async function recordSpotSearch(spotId, spotName) {
  const id = (spotId == null ? '' : String(spotId).trim()) || UNRESOLVED_SPOT_ID;
  const name = spotName || (id === UNRESOLVED_SPOT_ID ? UNRESOLVED_SPOT_NAME : '');
  await pool.query(
    `INSERT INTO spot_search_counts (spot_id, spot_name, search_date, search_count)
     VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Tokyo')::date, 1)
     ON CONFLICT (spot_id, search_date) DO UPDATE
       SET search_count = spot_search_counts.search_count + 1,
           spot_name    = EXCLUDED.spot_name,
           updated_at   = now()`,
    [id, name]
  );
}

/** 指定期間の検索回数をスポットごとに合計する（内部ヘルパー）。 */
async function aggregateSearchCounts(from, to) {
  const { rows } = await pool.query(
    `SELECT spot_id,
            SUM(search_count)::int AS searches,
            (ARRAY_AGG(spot_name ORDER BY search_date DESC))[1] AS snapshot_name
       FROM spot_search_counts
      WHERE search_date BETWEEN $1::date AND $2::date
      GROUP BY spot_id`,
    [from, to]
  );
  const bySpotId = new Map();
  let unresolvedSearches = 0;
  for (const row of rows) {
    if (row.spot_id === UNRESOLVED_SPOT_ID) {
      unresolvedSearches = row.searches;
      continue;
    }
    bySpotId.set(row.spot_id, { searches: row.searches, snapshotName: row.snapshot_name });
  }
  const resolvedSearches = Array.from(bySpotId.values()).reduce((sum, v) => sum + v.searches, 0);
  return { bySpotId, unresolvedSearches, resolvedSearches };
}

/**
 * 管理画面「観光スポットの検索・アクセス数」用。指定期間の
 * スポット検索回数（spot_search_counts）と公式サイトリンクのタップ回数
 * （touristSpots.getLinkClickStats）を1つの表へマージして返す。
 * clicks + searches の降順→名称昇順。
 */
async function getSpotEngagementStats({ from, to }) {
  const [clickStats, searchAgg] = await Promise.all([
    touristSpots.getLinkClickStats({ from, to }),
    aggregateSearchCounts(from, to)
  ]);

  const rowsBySpotId = new Map();
  for (const row of clickStats.rows) {
    rowsBySpotId.set(row.spotId, { ...row, searches: 0 });
  }
  for (const [spotId, agg] of searchAgg.bySpotId) {
    const existing = rowsBySpotId.get(spotId);
    if (existing) {
      existing.searches = agg.searches;
    } else {
      // 検索はされたが、タップ集計にもスポット一覧にも無い（＝掲載終了スポット）
      rowsBySpotId.set(spotId, {
        spotId,
        name: agg.snapshotName,
        url: null,
        listed: false,
        clicks: 0,
        searches: agg.searches
      });
    }
  }

  const rows = Array.from(rowsBySpotId.values()).sort((a, b) =>
    (b.searches + b.clicks) - (a.searches + a.clicks)
    || String(a.name).localeCompare(String(b.name), 'ja'));

  return {
    from,
    to,
    totalClicks: clickStats.totalClicks,
    resolvedSearches: searchAgg.resolvedSearches,
    unresolvedSearches: searchAgg.unresolvedSearches,
    totalSearches: searchAgg.resolvedSearches + searchAgg.unresolvedSearches,
    rows
  };
}

/** 保持期間（既定 SEARCH_COUNT_RETENTION_DAYS 日）を過ぎた検索回数集計を掃除する（scheduler.js の1時間掃除から）。 */
async function purgeOldSpotSearchCounts(retentionDays = SEARCH_COUNT_RETENTION_DAYS) {
  const result = await pool.query(
    `DELETE FROM spot_search_counts
      WHERE search_date < ((now() AT TIME ZONE 'Asia/Tokyo')::date - $1::int)`,
    [retentionDays]
  );
  return result.rowCount;
}

module.exports = {
  suggest,
  search,
  searchRoutes,
  recordSpotSearch,
  getSpotEngagementStats,
  purgeOldSpotSearchCounts,
  // 純粋関数（テスト・再利用向け）
  scoreNameMatch,
  dedupeRoutes,
  SEARCH_COUNT_RETENTION_DAYS
};
