const fs = require('fs');
const express = require('express');
const pool = require('../config/db');
const { resolveRouteId } = require('../services/gtfsData');
const { getAccuracyReport } = require('../services/predictionAccuracy');
const { getDelayMesh } = require('../services/delayMesh');
const { searchStops } = require('../services/routeSearch');
const { searchJourneys, searchRouteSearchStops } = require('../services/gtfsRouteSearch');
const { getServiceDateString, computeDelayMinutes, computeSignedDelayMinutes } = require('../utils/time');
const { getActiveServiceIds } = require('../services/gtfsCalendar');
const { getCachedServiceStatus } = require('../services/serviceStatusScraper');
const {
  searchStops: searchTimetableStops,
  listStopsForMap,
  searchNearbyStops,
  getStopSummariesByKeys,
  getStopTimetable,
  getTripDetail,
  resolvePlatformRef,
  resolvePlatformByFeedStop
} = require('../services/gtfsTimetable');
const {
  unqualifyRouteId,
  qualifyRouteId,
  getGtfsDir,
  downloadAndExtractGtfsFeed,
  commitFeedFingerprint,
  MANAGED_GTFS_FILES
} = require('../services/gtfsFeedManager');
const {
  findLiveAssignment,
  buildBusEntry,
  buildBusEntriesBatch,
  getAssignmentDetailForAdmin,
  getStopArrivalDetailForAdmin,
  getGpsOutageDetailForAdmin,
  startTimeToUrlHhmm
} = require('../services/realtimeTripLookup');
const { getApproachingBuses } = require('../services/busStopApproaching');
const { getOperationHistoryByCarIds } = require('../services/vehicleOperationHistory');
const { listLinkableTrips, linkVehicleToTrip, unlinkAssignment } = require('../services/manualAssignment');
const { SUCCESS_END_REASONS } = require('../services/finishService');
const touristSpots = require('../services/touristSpots');
const spotSearch = require('../services/spotSearch');
const busstopNotices = require('../services/busstopNotices');
const { invalidateHolidayCache } = require('../services/holidayCalendar');
const { invalidateRouteExternalIdCache } = require('../services/routeExternalIdMapping');
const { loadAbbreviations, invalidateDisplayAbbreviationsCache } = require('../services/displayAbbreviations');
const { invalidateDirectionRulesCache } = require('../services/directionRules');
const {
  getRealtimeSuspension,
  getSuspendedRouteIdSet,
  invalidateRealtimeSuspensionCache
} = require('../services/realtimeSuspension');
const { normalizeDirectionRuleInput } = require('../config/directionMapping');
const visitorTracker = require('../services/visitorTracker');
const jobMonitor = require('../services/jobMonitor');
const apiMetrics = require('../services/apiMetrics');
const { getEnabledGtfsFeeds, getEnabledLocationFeeds } = require('../config/feeds');
const {
  getRuntimeSetting,
  getRuntimeSettingSource,
  refreshRuntimeSettingsCache
} = require('../services/runtimeSettings');
const { SETTINGS_CATALOG, SETTINGS_BY_KEY, validateSettingValue } = require('../config/runtimeSettingsCatalog');
const adminAuth = require('../services/adminAuth');
const securityConfig = require('../config/security');
const {
  createRateLimiter,
  getClientKey,
  getAdminAuthBlock,
  recordAdminAuthFailure,
  clearAdminAuthFailures
} = require('../middleware/rateLimit');

const router = express.Router();

// 高コスト・集計値を増やす公開エンドポイント向けのレートリミッタ
// （docs/system-review-2026-09.md S-3）。ホットパス（/api/buses など20秒ポーリングされる
// エンドポイント）には掛けない——利用者の画面が止まるリスクの方が大きいため。
const routeSearchRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: securityConfig.ROUTE_SEARCH_RATE_LIMIT_PER_MIN,
  scope: '/api/route-search',
  message: '経路検索のリクエストが多すぎます。しばらく待ってからお試しください。'
});
const countRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: securityConfig.COUNT_RATE_LIMIT_PER_MIN,
  scope: '集計カウント系API',
  message: 'リクエストが多すぎます。しばらく待ってからお試しください。'
});

// 運用監視のしきい値（ASSIGN_RADIUS_METERS等と同じ流儀で環境変数上書き可・既定値付き）。
// 2026-08-21以降は管理画面「運用パラメータ設定」からも編集できる
// （config/runtimeSettingsCatalog.js・services/runtimeSettings.js参照）。
function staleGpsMin() { return getRuntimeSetting('ADMIN_STALE_GPS_MIN'); }
function severeDelayMin() { return getRuntimeSetting('ADMIN_SEVERE_DELAY_MIN'); }
function unassignedOverdueMin() { return getRuntimeSetting('ADMIN_UNASSIGNED_OVERDUE_MIN'); }
function etaStaleMin() { return getRuntimeSetting('ADMIN_ETA_STALE_MIN'); }

// 異常アラートの確認済み管理用の安定キー。同じ異常インスタンスなら常に同じ値になり、
// 対象エンティティのIDだけでなく変化しうる値（例: 最終GPS時刻）も含めることで、
// 一度解消してから再発した異常には別のキーが振られ、改めて表示される。
function buildAlertKey(type, ...parts) {
  return [type, ...parts.map((p) => (p === null || p === undefined ? '' : String(p instanceof Date ? p.toISOString() : p)))].join(':');
}

// フロントエンドがX-Client-Idヘッダーを付けて叩くAPIリクエストを閲覧数としてカウントする
// （サーバー負荷判定・管理画面の閲覧数表示に使用。ヘッダーが無いリクエストは対象外）。
// クライアントIPも渡すのは、1つのIPからX-Client-Idを無数に振って閲覧数を水増しできないよう
// visitorTracker側でIPごとの上限を掛けるため（docs/system-review-2026-09.md S-3）。
router.use((req, res, next) => {
  const clientId = req.headers['x-client-id'];
  if (typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 100) {
    visitorTracker.recordVisit(clientId, getClientKey(req));
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

// 通常のお知らせは system_settings の key='notices' に JSON 配列（最大3件）で保存する。
// 各要素: { title, body, imageUrl, startDate, endDate }。
//   - body     … リンク記法対応の本文（app.js の linkifyNotice と同じ）。ただの文章も可
//   - imageUrl … https:// の画像URL、または ""
//   - startDate/endDate … "YYYY-MM-DD" または ""（無期限）
// 重要なお知らせは key='important_notice' に JSON オブジェクト { body, imageUrl, startDate, endDate }。
// 未設定なら ""。旧形式（プレーンテキスト）は migrate.js が変換するが、ここでも後方互換で解釈する。
const MAX_NOTICES = 3;

function isHttpsUrl(value) {
  return typeof value === 'string' && /^https:\/\/\S+$/.test(value.trim());
}

function parseNoticesJson(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[api] system_settings.notices のJSON解釈に失敗しました。空として扱います。');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, MAX_NOTICES).map((n) => ({
    title: typeof n?.title === 'string' ? n.title : '',
    body: typeof n?.body === 'string' ? n.body : '',
    imageUrl: typeof n?.imageUrl === 'string' ? n.imageUrl : '',
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(n?.startDate) ? n.startDate : '',
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(n?.endDate) ? n.endDate : ''
  }));
}

// 重要なお知らせ（JSONオブジェクト or 旧形式のプレーンテキスト）を { body, imageUrl, startDate, endDate } へ正規化する。
function parseImportantNotice(raw) {
  const empty = { body: '', imageUrl: '', startDate: '', endDate: '' };
  if (!raw) return empty;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return {
      body: typeof parsed.body === 'string' ? parsed.body : '',
      imageUrl: typeof parsed.imageUrl === 'string' ? parsed.imageUrl : '',
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.startDate) ? parsed.startDate : '',
      endDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.endDate) ? parsed.endDate : ''
    };
  }
  // 旧形式: プレーンテキストの本文
  return { ...empty, body: String(raw) };
}

// 配信期間（startDate〜endDate、両端含む・未指定は無期限）で today に配信中かどうか。
function isWithinPeriod(n, todayStr) {
  if (n.startDate && todayStr < n.startDate) return false;
  if (n.endDate && todayStr > n.endDate) return false;
  return true;
}

// 今日配信中で、かつ中身（題名・本文・画像のいずれか）があるお知らせだけに絞る。
function filterActiveNotices(notices, todayStr) {
  return notices.filter((n) => {
    if (!n.title && !n.body.trim() && !n.imageUrl) return false;
    return isWithinPeriod(n, todayStr);
  });
}

function isImportantNoticeActive(n, todayStr) {
  if (!n.body.trim() && !n.imageUrl) return false;
  return isWithinPeriod(n, todayStr);
}

function serializeSettings(settings, { includeExpiredNotices = false } = {}) {
  const notices = parseNoticesJson(settings.notices);
  const important = parseImportantNotice(settings.important_notice);
  const today = getServiceDateString();
  return {
    notices: includeExpiredNotices ? notices : filterActiveNotices(notices, today),
    importantNotice: includeExpiredNotices || isImportantNoticeActive(important, today)
      ? important
      : { body: '', imageUrl: '', startDate: '', endDate: '' },
    routeName: settings.route_name || '',
    operatorName: settings.operator_name || ''
  };
}

async function loadSystemSettings(routeId, options = {}) {
  const normalizedRouteId = resolveRouteId(routeId);
  const result = await pool.query('SELECT key, value FROM system_settings');
  const settings = {};
  for (const row of result.rows) settings[row.key] = row.value;
  const serialized = serializeSettings(settings, options);
  serialized.routeId = normalizedRouteId;
  // settings の route_name は全路線共通のデフォルトとして使い、
  // 実際の路線名は routes テーブルから取得する
  const routeRes = await pool.query('SELECT name FROM routes WHERE id = $1', [normalizedRouteId]);
  serialized.routeName = routeRes.rows.length > 0 ? routeRes.rows[0].name : (serialized.routeName || '横田信大循環線');
  return serialized;
}

// リクエストが管理者として認証済みかだけを判定する（例外・レスポンス・副作用なし）。
// requireAdminAuth の判定本体であり、公開エンドポイントで「管理画面からのリクエストか」を
// 副作用なく確かめたいとき（/api/buses-for-map のリアルタイム休止バイパス等）にも使う。
//
// 経路は2つ。判定ロジックの本体は services/adminAuth.js にある。
//   1. サーバー側セッション（httpOnly Cookie）… 管理画面のログイン後はこちら
//   2. Basic認証ヘッダー … curl・監視ツール等の従来経路。消すと黙って壊れるため残してある
function isAuthenticatedAdmin(req) {
  const sessionToken = adminAuth.readSessionToken(req);
  if (sessionToken && adminAuth.verifySessionToken(sessionToken) && adminAuth.isSameOriginRequest(req)) {
    return true;
  }

  const credentials = adminAuth.parseBasicAuthHeader(req.headers.authorization);
  if (!credentials) return false;
  return adminAuth.verifyCredentials(credentials.username, credentials.password);
}

function requireAdminAuth(req, res, next) {
  const block = getAdminAuthBlock(req);
  if (block) {
    res.setHeader('Retry-After', String(block.retryAfterSeconds));
    return res.status(429).json({
      error: `ログイン試行が多すぎます。${Math.ceil(block.retryAfterSeconds / 60)}分ほど待ってからやり直してください。`,
      retryAfterSeconds: block.retryAfterSeconds
    });
  }

  if (!isAuthenticatedAdmin(req)) {
    // 総当たりとして数えるのは「資格情報を提示したうえで外した」ときだけ。
    // 期限切れセッションのポーリングや未ログインの素のアクセスは数えない
    // （数えると、セッション切れの管理画面が自分自身をロックアウトしてしまう）。
    if (adminAuth.hasPresentedCredentials(req)) recordAdminAuthFailure(req);
    return res.status(401).json({ error: '管理画面へのログインが必要です。' });
  }

  clearAdminAuthFailures(req);
  return next();
}

// ==========================================================
// 管理画面のセッション（docs/system-review-2026-09.md S-2）。
// 資格情報を受け取るのはログインの1回だけで、以後はhttpOnly・SameSite=Strictの
// ランダムトークンで認証する。ブラウザ側（localStorage）には何も保存しない。
// セッションはプロセス内メモリなので、サーバー再起動で全て失効する＝再ログインが要る。
// ==========================================================

// POST /api/admin/session -> ログイン。成功したらSet-Cookieでセッションを渡す。
router.post('/admin/session', (req, res) => {
  const block = getAdminAuthBlock(req);
  if (block) {
    res.setHeader('Retry-After', String(block.retryAfterSeconds));
    return res.status(429).json({
      error: `ログイン試行が多すぎます。${Math.ceil(block.retryAfterSeconds / 60)}分ほど待ってからやり直してください。`,
      retryAfterSeconds: block.retryAfterSeconds
    });
  }

  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password || !adminAuth.verifyCredentials(username, password)) {
    recordAdminAuthFailure(req);
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います。' });
  }

  clearAdminAuthFailures(req);
  const { token, expiresAt } = adminAuth.createSession();
  res.setHeader('Set-Cookie', adminAuth.buildSessionCookie(token, req));
  return res.json({ ok: true, expiresAt: new Date(expiresAt).toISOString() });
});

// GET /api/admin/session -> セッションが生きているかの確認（管理画面の再訪問時に使う）
router.get('/admin/session', requireAdminAuth, (req, res) => {
  const expiresAt = adminAuth.getSessionExpiry(adminAuth.readSessionToken(req));
  res.json({ ok: true, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
});

// DELETE /api/admin/session -> ログアウト。サーバー側のセッションを破棄しCookieも消す。
// 認証を要求しない（既に失効したセッションでも「消す」操作は通したいため）。
router.delete('/admin/session', (req, res) => {
  const token = adminAuth.readSessionToken(req);
  if (token) adminAuth.destroySession(token);
  res.setHeader('Set-Cookie', adminAuth.buildClearedSessionCookie(req));
  res.json({ ok: true });
});

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

// GET /api/display-abbreviations -> 表示テキスト（系統名・行き先）の略称辞書
// 公開API（バスマップ・バス停時刻表・接近中のバスパネルが直接読む。認証不要）。
// original文字数の降順（フロントエンドでの部分文字列置換の優先順位に使う）。
router.get('/display-abbreviations', async (req, res) => {
  try {
    const abbreviations = await loadAbbreviations();
    res.json({ abbreviations });
  } catch (err) {
    console.error('[api] /display-abbreviations エラー:', err);
    res.status(500).json({ error: '表示略称の取得に失敗しました。' });
  }
});

// GET /api/settings -> お知らせ・重要なお知らせ（GASの「設定 システム」シート相当）
// お知らせは全路線共通のため、routeIdは省略可能（ホーム画面のloadNotices()は付けずに呼ぶ）。
// routeId省略時はresolveRouteId()がnullを返し、loadSystemSettings()内のroutes参照だけが
// 該当なしになる（route_nameの表示はsystem_settingsの値へフォールバックする＝挙動は変わらない）。
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
    const settings = await loadSystemSettings(routeId, { includeExpiredNotices: true });
    res.json(settings);
  } catch (err) {
    console.error('[api] /admin/settings エラー:', err);
    res.status(500).json({ error: '管理設定の取得に失敗しました。' });
  }
});

// 外部ID ⇔ GTFS route_id の対応表の取得・編集API（route_external_ids）。
//
// 路線名によるあいまいな解決はしない（「ケ/ヶ」等の表記ゆれ1文字で対応が黙って欠落する
// 事故が過去にあったため）。保存時にroutesテーブルへの実在チェックを行い、
// 存在しないroute_idは拒否する（管理画面での入力ミスをその場で弾く）。
// 対応するGTFS路線がまだ無い外部IDは、route_idを空にして備考に理由を書けば登録できる
// （旧route_external_idsテーブル削除時に失われかけた「路線未対応の外部ID」の記録を、
// 再び行として保持できるようにするため）。詳細はdocs/外部IDマッピングのコード化_仕様書.md参照。
//
// 路線データ編集（バス停座標・時刻表の直接編集。GET/PUT /admin/route-data）は削除済みのまま。
// バス停座標・時刻表はGTFSフィード由来のマスタなので、変更はGTFSフィード側の更新で行う。

// GET /api/admin/route-mappings -> 外部ID⇔route_id 対応表の一覧
router.get('/admin/route-mappings', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.external_id, m.route_id, m.note, m.updated_at, r.name AS route_name
       FROM route_external_ids m
       LEFT JOIN routes r ON r.id = m.route_id
       ORDER BY m.route_id ASC NULLS LAST, m.external_id ASC`
    );
    res.json({
      mappings: result.rows.map((row) => ({
        externalId: row.external_id,
        routeId: row.route_id,
        routeName: row.route_name,
        note: row.note,
        updatedAt: row.updated_at
      }))
    });
  } catch (err) {
    console.error('[api] /admin/route-mappings 取得エラー:', err);
    res.status(500).json({ error: '外部IDマッピングの取得に失敗しました。' });
  }
});

// POST /api/admin/route-mappings -> 追加・更新（external_idキーのUPSERT）
router.post('/admin/route-mappings', requireAdminAuth, async (req, res) => {
  const { externalId, routeId, note } = req.body || {};
  const trimmedExternalId = typeof externalId === 'string' ? externalId.trim() : '';
  const trimmedRouteId = typeof routeId === 'string' ? routeId.trim() : '';
  const trimmedNote = typeof note === 'string' ? note.trim() : '';

  if (!trimmedExternalId) {
    return res.status(400).json({ error: '外部IDを入力してください。' });
  }
  if (!trimmedRouteId && !trimmedNote) {
    return res.status(400).json({ error: '対応する路線がまだ無い場合は、備考に理由を入力してください。' });
  }

  try {
    if (trimmedRouteId) {
      const routeCheck = await pool.query('SELECT 1 FROM routes WHERE id = $1', [trimmedRouteId]);
      if (routeCheck.rows.length === 0) {
        return res.status(400).json({
          error: `指定の路線ID「${trimmedRouteId}」は現在のGTFSデータに存在しません。候補一覧から選択してください。`
        });
      }
    }

    await pool.query(
      `INSERT INTO route_external_ids (external_id, route_id, note, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (external_id) DO UPDATE
         SET route_id = EXCLUDED.route_id, note = EXCLUDED.note, updated_at = now()`,
      [trimmedExternalId, trimmedRouteId || null, trimmedNote || null]
    );
    invalidateRouteExternalIdCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/route-mappings 保存エラー:', err);
    res.status(500).json({ error: '外部IDマッピングの保存に失敗しました。' });
  }
});

// DELETE /api/admin/route-mappings/:externalId -> 1件削除
router.delete('/admin/route-mappings/:externalId', requireAdminAuth, async (req, res) => {
  const { externalId } = req.params;
  try {
    await pool.query('DELETE FROM route_external_ids WHERE external_id = $1', [externalId]);
    invalidateRouteExternalIdCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/route-mappings 削除エラー:', err);
    res.status(500).json({ error: '外部IDマッピングの削除に失敗しました。' });
  }
});

// 表示略称辞書（系統名・行き先の一部文字列 -> 略称）の管理画面用CRUD。
// 一覧は /api/display-abbreviations と同じテーブルを参照するが、
// こちらは認証必須かつ updated_at も返す。

// GET /api/admin/display-abbreviations -> 略称辞書の一覧
router.get('/admin/display-abbreviations', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT original, abbreviation, updated_at
       FROM display_abbreviations
       ORDER BY original ASC`
    );
    res.json({
      abbreviations: result.rows.map((row) => ({
        original: row.original,
        abbreviation: row.abbreviation,
        updatedAt: row.updated_at
      }))
    });
  } catch (err) {
    console.error('[api] /admin/display-abbreviations 取得エラー:', err);
    res.status(500).json({ error: '表示略称の取得に失敗しました。' });
  }
});

// POST /api/admin/display-abbreviations -> 追加・更新（originalキーのUPSERT）
router.post('/admin/display-abbreviations', requireAdminAuth, async (req, res) => {
  const { original, abbreviation } = req.body || {};
  const trimmedOriginal = typeof original === 'string' ? original.trim() : '';
  const trimmedAbbreviation = typeof abbreviation === 'string' ? abbreviation.trim() : '';

  if (!trimmedOriginal) {
    return res.status(400).json({ error: '元テキストを入力してください。' });
  }
  if (!trimmedAbbreviation) {
    return res.status(400).json({ error: '略称を入力してください。' });
  }

  try {
    await pool.query(
      `INSERT INTO display_abbreviations (original, abbreviation, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (original) DO UPDATE
         SET abbreviation = EXCLUDED.abbreviation, updated_at = now()`,
      [trimmedOriginal, trimmedAbbreviation]
    );
    invalidateDisplayAbbreviationsCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/display-abbreviations 保存エラー:', err);
    res.status(500).json({ error: '表示略称の保存に失敗しました。' });
  }
});

// DELETE /api/admin/display-abbreviations/:original -> 1件削除
router.delete('/admin/display-abbreviations/:original', requireAdminAuth, async (req, res) => {
  const { original } = req.params;
  try {
    await pool.query('DELETE FROM display_abbreviations WHERE original = $1', [original]);
    invalidateDisplayAbbreviationsCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/display-abbreviations 削除エラー:', err);
    res.status(500).json({ error: '表示略称の削除に失敗しました。' });
  }
});

// 方向マッピング（位置情報CSVの方向列の値 ⇔ GTFS direction_id）の取得・編集API
// （route_direction_rules）。
//
// 行が無い路線は既定で mode:'ignore'（方向で候補車両を絞り込まない）。方向で絞りたい
// 路線にだけ mode:'map' の行を追加し、CSV方向値→direction_id の変換表とフォールバック値を
// 設定する。route_id は routes テーブルへの実在チェックあり（管理画面は /api/routes の
// 候補一覧から選ばせる）。入力の検証・正規化は config/directionMapping.js が担う。

// GET /api/admin/direction-rules -> 方向マッピングの一覧＋未設定路線の既定
router.get('/admin/direction-rules', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.route_id, d.mode, d.value_map, d.fallback, d.note, d.updated_at, r.name AS route_name
       FROM route_direction_rules d
       LEFT JOIN routes r ON r.id = d.route_id
       ORDER BY d.route_id ASC`
    );
    res.json({
      default: { mode: 'ignore' },
      rules: result.rows.map((row) => ({
        routeId: row.route_id,
        routeName: row.route_name || null,
        mode: row.mode,
        valueMap: row.value_map || {},
        fallback: row.fallback === undefined ? null : row.fallback,
        note: row.note || '',
        updatedAt: row.updated_at
      }))
    });
  } catch (err) {
    console.error('[api] /admin/direction-rules 取得エラー:', err);
    res.status(500).json({ error: '方向マッピングの取得に失敗しました。' });
  }
});

// POST /api/admin/direction-rules -> 追加・更新（route_idキーのUPSERT）
router.post('/admin/direction-rules', requireAdminAuth, async (req, res) => {
  const { routeId, mode, valueMap, fallback, note } = req.body || {};
  const trimmedRouteId = typeof routeId === 'string' ? routeId.trim() : '';
  const trimmedNote = typeof note === 'string' ? note.trim() : '';

  if (!trimmedRouteId) {
    return res.status(400).json({ error: '路線を選択してください。' });
  }

  const normalized = normalizeDirectionRuleInput({ mode, valueMap, fallback });
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }
  const { rule } = normalized;

  try {
    const routeCheck = await pool.query('SELECT 1 FROM routes WHERE id = $1', [trimmedRouteId]);
    if (routeCheck.rows.length === 0) {
      return res.status(400).json({
        error: `指定の路線ID「${trimmedRouteId}」は現在のGTFSデータに存在しません。候補一覧から選択してください。`
      });
    }

    await pool.query(
      `INSERT INTO route_direction_rules (route_id, mode, value_map, fallback, note, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, now())
       ON CONFLICT (route_id) DO UPDATE
         SET mode = EXCLUDED.mode,
             value_map = EXCLUDED.value_map,
             fallback = EXCLUDED.fallback,
             note = EXCLUDED.note,
             updated_at = now()`,
      [trimmedRouteId, rule.mode, JSON.stringify(rule.map || {}), rule.fallback ?? null, trimmedNote || null]
    );
    invalidateDirectionRulesCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/direction-rules 保存エラー:', err);
    res.status(500).json({ error: '方向マッピングの保存に失敗しました。' });
  }
});

// DELETE /api/admin/direction-rules/:routeId -> 1件削除（既定の ignore に戻る）
router.delete('/admin/direction-rules/:routeId', requireAdminAuth, async (req, res) => {
  const { routeId } = req.params;
  try {
    await pool.query('DELETE FROM route_direction_rules WHERE route_id = $1', [routeId]);
    invalidateDirectionRulesCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/direction-rules 削除エラー:', err);
    res.status(500).json({ error: '方向マッピングの削除に失敗しました。' });
  }
});

// ==========================================================
// リアルタイム休止（route_realtime_suspensions）。管理画面「リアルタイム休止」で編集する。
//
// 突発的な運休・輸送障害でGPS由来のリアルタイム情報が実態と食い違うとき、その路線の
// リアルタイム表示だけを利用者向け画面から一時的に取りやめる。行があれば休止中、削除で再開。
// 時刻表（定刻）ベースの表示・経路探索は影響を受けない。管理画面の運行監視も対象外。
// 反映はサービス層（services/realtimeSuspension.js）のキャッシュ破棄で即時。詳細は
// docs/realtime-suspension.md。路線は /api/routes の候補一覧から選ばせ、保存時に実在チェックする。
// ==========================================================

// GET /api/admin/realtime-suspensions -> 現在休止中の路線一覧
router.get('/admin/realtime-suspensions', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.route_id, s.reason, s.note, s.suspended_at, s.updated_at, r.name AS route_name
       FROM route_realtime_suspensions s
       LEFT JOIN routes r ON r.id = s.route_id
       ORDER BY s.suspended_at DESC, s.route_id ASC`
    );
    res.json({
      suspensions: result.rows.map((row) => ({
        routeId: row.route_id,
        routeName: row.route_name || null,
        reason: row.reason || '',
        note: row.note || '',
        suspendedAt: row.suspended_at,
        updatedAt: row.updated_at
      }))
    });
  } catch (err) {
    console.error('[api] /admin/realtime-suspensions 取得エラー:', err);
    res.status(500).json({ error: 'リアルタイム休止設定の取得に失敗しました。' });
  }
});

// POST /api/admin/realtime-suspensions -> 休止の追加・更新（route_idキーのUPSERT）
router.post('/admin/realtime-suspensions', requireAdminAuth, async (req, res) => {
  const { routeId, reason, note } = req.body || {};
  const trimmedRouteId = typeof routeId === 'string' ? routeId.trim() : '';
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  const trimmedNote = typeof note === 'string' ? note.trim() : '';

  if (!trimmedRouteId) {
    return res.status(400).json({ error: '路線を選択してください。' });
  }
  if (trimmedReason.length > 200) {
    return res.status(400).json({ error: '休止理由は200文字以内で入力してください。' });
  }
  if (trimmedNote.length > 2000) {
    return res.status(400).json({ error: 'メモは2000文字以内で入力してください。' });
  }

  try {
    const routeCheck = await pool.query('SELECT 1 FROM routes WHERE id = $1', [trimmedRouteId]);
    if (routeCheck.rows.length === 0) {
      return res.status(400).json({
        error: `指定の路線ID「${trimmedRouteId}」は現在のGTFSデータに存在しません。候補一覧から選択してください。`
      });
    }

    await pool.query(
      `INSERT INTO route_realtime_suspensions (route_id, reason, note, suspended_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (route_id) DO UPDATE
         SET reason = EXCLUDED.reason, note = EXCLUDED.note, updated_at = now()`,
      [trimmedRouteId, trimmedReason || null, trimmedNote || null]
    );
    invalidateRealtimeSuspensionCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/realtime-suspensions 保存エラー:', err);
    res.status(500).json({ error: 'リアルタイム休止設定の保存に失敗しました。' });
  }
});

// DELETE /api/admin/realtime-suspensions/:routeId -> 1件削除（＝その路線のリアルタイム表示を再開）
router.delete('/admin/realtime-suspensions/:routeId', requireAdminAuth, async (req, res) => {
  const { routeId } = req.params;
  try {
    await pool.query('DELETE FROM route_realtime_suspensions WHERE route_id = $1', [routeId]);
    invalidateRealtimeSuspensionCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/realtime-suspensions 削除エラー:', err);
    res.status(500).json({ error: 'リアルタイム休止の解除に失敗しました。' });
  }
});

// ==========================================================
// 車両名・メモ管理（車両ID＝car_id ⇔ 名前・メモ）。
// vehicles は路線ごとに行が分かれ運行終了で行が増えるため、キーは car_id。
// 運行ダッシュボードの便詳細セクションで、名前を持つ車両を名前表示・
// 名前タップでメモ表示に使う。
// ==========================================================

// GET /api/admin/vehicle-labels -> 名前・メモの一覧＋現在観測されている車両ID一覧
router.get('/admin/vehicle-labels', requireAdminAuth, async (req, res) => {
  try {
    const [labelsRes, knownRes] = await Promise.all([
      pool.query(
        `SELECT vl.car_id, vl.name, vl.memo, vl.updated_at
         FROM vehicle_labels vl
         ORDER BY vl.name ASC NULLS LAST, vl.car_id ASC`
      ),
      pool.query(
        `SELECT v.car_id,
                MAX(v.last_gps_at) AS last_gps_at,
                array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL) AS route_names
         FROM vehicles v
         LEFT JOIN routes r ON r.id = v.route_id
         GROUP BY v.car_id
         ORDER BY MAX(v.last_gps_at) DESC NULLS LAST, v.car_id ASC`
      )
    ]);
    res.json({
      labels: labelsRes.rows.map((row) => ({
        carId: row.car_id,
        name: row.name,
        memo: row.memo,
        updatedAt: row.updated_at
      })),
      knownVehicles: knownRes.rows.map((row) => ({
        carId: row.car_id,
        lastGpsAt: row.last_gps_at,
        routeNames: row.route_names || []
      }))
    });
  } catch (err) {
    console.error('[api] /admin/vehicle-labels 取得エラー:', err);
    res.status(500).json({ error: '車両名・メモの取得に失敗しました。' });
  }
});

// PUT /api/admin/vehicle-labels/:carId -> 追加・更新（car_idキーのUPSERT）。
// 名前・メモともに空なら行ごと削除する（＝名前なし車両に戻す）。
router.put('/admin/vehicle-labels/:carId', requireAdminAuth, async (req, res) => {
  const carId = typeof req.params.carId === 'string' ? req.params.carId.trim() : '';
  const { name, memo } = req.body || {};
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedMemo = typeof memo === 'string' ? memo.trim() : '';

  if (!carId) {
    return res.status(400).json({ error: '車両IDが不正です。' });
  }
  if (trimmedName.length > 100) {
    return res.status(400).json({ error: '名前は100文字以内で入力してください。' });
  }
  if (trimmedMemo.length > 2000) {
    return res.status(400).json({ error: 'メモは2000文字以内で入力してください。' });
  }

  try {
    if (!trimmedName && !trimmedMemo) {
      await pool.query('DELETE FROM vehicle_labels WHERE car_id = $1', [carId]);
      return res.json({ ok: true, deleted: true });
    }
    await pool.query(
      `INSERT INTO vehicle_labels (car_id, name, memo, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (car_id) DO UPDATE
         SET name = EXCLUDED.name, memo = EXCLUDED.memo, updated_at = now()`,
      [carId, trimmedName || null, trimmedMemo || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/vehicle-labels 保存エラー:', err);
    res.status(500).json({ error: '車両名・メモの保存に失敗しました。' });
  }
});

// DELETE /api/admin/vehicle-labels/:carId -> 1件削除
router.delete('/admin/vehicle-labels/:carId', requireAdminAuth, async (req, res) => {
  const carId = typeof req.params.carId === 'string' ? req.params.carId.trim() : '';
  try {
    await pool.query('DELETE FROM vehicle_labels WHERE car_id = $1', [carId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/vehicle-labels 削除エラー:', err);
    res.status(500).json({ error: '車両名・メモの削除に失敗しました。' });
  }
});

// ==========================================================
// 車両運用状況（車両ID＝car_id ごとの「直近の運行履歴」）。
// 便のクローズ時に vehicle_operation_history へ car_id × 曜日区分で直近1件だけ記録される
// （services/vehicleOperationHistory.js・finishService.closeDailyTrip）。
// completed_trips と違い保持期間の影響を受けないため、たまにしか走らない車両の
// 運用状況も確認できる。車両名（vehicle_labels）があれば名前を優先表示する。
// ==========================================================

// GET /api/admin/vehicle-operation-history/:carId -> 1台ぶんの直近運行履歴（平日1件・土休日1件）。
// 運行ダッシュボードで車両名/車両IDをタップしたときの詳細展開に使う（車両名・メモも併せて返す）。
router.get('/admin/vehicle-operation-history/:carId', requireAdminAuth, async (req, res) => {
  const carId = typeof req.params.carId === 'string' ? req.params.carId.trim() : '';
  if (!carId) return res.status(400).json({ error: '車両IDが不正です。' });
  try {
    const [historyMap, labelRes] = await Promise.all([
      getOperationHistoryByCarIds(pool, [carId]),
      pool.query('SELECT name, memo FROM vehicle_labels WHERE car_id = $1', [carId])
    ]);
    const label = labelRes.rows[0] || {};
    res.json({
      carId,
      carName: label.name || null,
      carMemo: label.memo || null,
      history: historyMap.get(carId) || { weekday: [], weekendHoliday: [] }
    });
  } catch (err) {
    console.error('[api] /admin/vehicle-operation-history/:carId エラー:', err);
    res.status(500).json({ error: '車両の運行履歴の取得に失敗しました。' });
  }
});

// GET /api/admin/vehicle-operation-status -> 管理画面「車両運用状況」。
// 運行履歴のある車両、および名前を登録済みの車両ごとに、直近の平日・土休日運行履歴を返す。
router.get('/admin/vehicle-operation-status', requireAdminAuth, async (req, res) => {
  try {
    const carsRes = await pool.query(
      `SELECT c.car_id, vl.name
       FROM (
         SELECT car_id FROM vehicle_operation_history
         UNION
         SELECT car_id FROM vehicle_labels
       ) c
       LEFT JOIN vehicle_labels vl ON vl.car_id = c.car_id
       ORDER BY vl.name ASC NULLS LAST, c.car_id ASC`
    );
    const carIds = carsRes.rows.map((row) => row.car_id);
    const historyMap = await getOperationHistoryByCarIds(pool, carIds);
    res.json({
      vehicles: carsRes.rows.map((row) => ({
        carId: row.car_id,
        name: row.name || null,
        history: historyMap.get(row.car_id) || { weekday: [], weekendHoliday: [] }
      }))
    });
  } catch (err) {
    console.error('[api] /admin/vehicle-operation-status エラー:', err);
    res.status(500).json({ error: '車両運用状況の取得に失敗しました。' });
  }
});

// 運用パラメータ設定（判定半径・タイムアウト・しきい値など）の取得・編集API。
//
// これまで環境変数（.env）でしか調整できなかった値、および一部コードに直書きされていた値
// （GPS_STALE_TIMEOUT_MIN。finishService.jsに直書きされていた「GPS 3分途絶」判定）を、
// 管理画面から編集できるようにしたもの。定義一覧はconfig/runtimeSettingsCatalog.js、
// 値の解決はservices/runtimeSettings.jsを参照。上書き値はsystem_settingsテーブルに
// 保存する（お知らせ設定と同じテーブルだが、キー名の名前空間が異なるため衝突しない）。
//
// 管理画面で一切編集しなければ、これまでどおり環境変数（未設定ならコード既定値）だけで
// 動く＝既存の挙動と完全に同じ。反映タイミングは項目により異なる（catalogのrequiresRestart参照）。

// GET /api/admin/runtime-settings -> 定義一覧＋現在の実効値・値の出所（既定値/環境変数/上書き）
router.get('/admin/runtime-settings', requireAdminAuth, async (req, res) => {
  try {
    await refreshRuntimeSettingsCache(true);
    const settings = SETTINGS_CATALOG.map((def) => ({
      key: def.key,
      group: def.group,
      groupLabel: def.groupLabel,
      label: def.label,
      description: def.description,
      type: def.type,
      unit: def.unit || null,
      default: def.default,
      min: def.min ?? null,
      max: def.max ?? null,
      requiresRestart: !!def.requiresRestart,
      value: getRuntimeSetting(def.key),
      source: getRuntimeSettingSource(def.key)
    }));
    res.json({ settings });
  } catch (err) {
    console.error('[api] /admin/runtime-settings 取得エラー:', err);
    res.status(500).json({ error: '運用パラメータ設定の取得に失敗しました。' });
  }
});

// PUT /api/admin/runtime-settings/:key -> 上書き値を保存（値の型・範囲はcatalog定義で検証）
router.put('/admin/runtime-settings/:key', requireAdminAuth, async (req, res) => {
  const { key } = req.params;
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) {
    return res.status(404).json({ error: `未知の設定キーです: ${key}` });
  }

  const rawValue = typeof req.body?.value === 'string' ? req.body.value.trim() : '';
  if (!rawValue) {
    return res.status(400).json({ error: '値を入力してください。既定値に戻す場合は削除操作を使ってください。' });
  }
  const validationError = validateSettingValue(def, rawValue);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, rawValue]
    );
    await refreshRuntimeSettingsCache(true);
    res.json({ ok: true, key, value: getRuntimeSetting(key), source: getRuntimeSettingSource(key) });
  } catch (err) {
    console.error('[api] /admin/runtime-settings 更新エラー:', err);
    res.status(500).json({ error: '運用パラメータ設定の更新に失敗しました。' });
  }
});

// DELETE /api/admin/runtime-settings/:key -> 上書きを解除し、既定値（環境変数 or コード既定値）へ戻す
router.delete('/admin/runtime-settings/:key', requireAdminAuth, async (req, res) => {
  const { key } = req.params;
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) {
    return res.status(404).json({ error: `未知の設定キーです: ${key}` });
  }

  try {
    await pool.query('DELETE FROM system_settings WHERE key = $1', [key]);
    await refreshRuntimeSettingsCache(true);
    res.json({ ok: true, key, value: getRuntimeSetting(key), source: getRuntimeSettingSource(key) });
  } catch (err) {
    console.error('[api] /admin/runtime-settings 削除エラー:', err);
    res.status(500).json({ error: '運用パラメータ設定のリセットに失敗しました。' });
  }
});

// PUT /api/admin/settings -> 管理画面から配信お知らせを更新
router.put('/admin/settings', requireAdminAuth, async (req, res) => {
  const { notices, importantNotice, routeName, operatorName } = req.body || {};

  // 通常のお知らせ: 配列（最大3件）。題名・本文・画像がすべて空の要素は捨てる。
  // 日付は "YYYY-MM-DD" か空のみ許可。画像URLは https:// のみ許可。
  const rawNotices = Array.isArray(notices) ? notices : [];
  const normalizedNotices = [];
  for (const n of rawNotices) {
    const title = typeof n?.title === 'string' ? n.title.trim() : '';
    const body = typeof n?.body === 'string' ? n.body : '';
    const imageUrl = typeof n?.imageUrl === 'string' ? n.imageUrl.trim() : '';
    if (!title && !body.trim() && !imageUrl) continue;
    if (imageUrl && !isHttpsUrl(imageUrl)) {
      return res.status(400).json({ error: 'お知らせの画像URLは https:// で始まる正しいURLを入力してください。' });
    }
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(n?.startDate) ? n.startDate : '';
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(n?.endDate) ? n.endDate : '';
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ error: '配信期間の開始日が終了日より後になっているお知らせがあります。' });
    }
    normalizedNotices.push({ title, body, imageUrl, startDate, endDate });
  }
  if (normalizedNotices.length > MAX_NOTICES) {
    return res.status(400).json({ error: `通常のお知らせは最大${MAX_NOTICES}件までです。` });
  }

  // 重要なお知らせ: オブジェクト { body, imageUrl, startDate, endDate }（旧形式の文字列も受け付ける）。
  const rawImportant = importantNotice;
  const important = (rawImportant && typeof rawImportant === 'object' && !Array.isArray(rawImportant))
    ? {
        body: typeof rawImportant.body === 'string' ? rawImportant.body : '',
        imageUrl: typeof rawImportant.imageUrl === 'string' ? rawImportant.imageUrl.trim() : '',
        startDate: /^\d{4}-\d{2}-\d{2}$/.test(rawImportant.startDate) ? rawImportant.startDate : '',
        endDate: /^\d{4}-\d{2}-\d{2}$/.test(rawImportant.endDate) ? rawImportant.endDate : ''
      }
    : { body: typeof rawImportant === 'string' ? rawImportant : '', imageUrl: '', startDate: '', endDate: '' };
  if (important.imageUrl && !isHttpsUrl(important.imageUrl)) {
    return res.status(400).json({ error: '重要なお知らせの画像URLは https:// で始まる正しいURLを入力してください。' });
  }
  if (important.startDate && important.endDate && important.startDate > important.endDate) {
    return res.status(400).json({ error: '重要なお知らせの配信期間の開始日が終了日より後になっています。' });
  }
  // 中身が空なら "" で保存する（後方互換・パースの簡単さのため）。
  const importantValue = (important.body.trim() || important.imageUrl) ? JSON.stringify(important) : '';

  const settingsToSave = [
    ['notices', JSON.stringify(normalizedNotices)],
    ['important_notice', importantValue],
    ['route_name', routeName ?? ''],
    ['operator_name', operatorName ?? '']
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of settingsToSave) {
      await client.query(
        `INSERT INTO system_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    }
    await client.query('COMMIT');

    const settings = await loadSystemSettings(undefined, { includeExpiredNotices: true });
    res.json(settings);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[api] /admin/settings 更新エラー:', err);
    res.status(500).json({ error: '管理設定の更新に失敗しました。' });
  } finally {
    client.release();
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

// GET /api/admin/tourist-spots -> 観光スポット一覧（全件、簡易UI用）
router.get('/admin/tourist-spots', requireAdminAuth, async (req, res) => {
  try {
    const spots = await touristSpots.listTouristSpots();
    res.json({ spots });
  } catch (err) {
    console.error('[api] /admin/tourist-spots 取得エラー:', err);
    res.status(500).json({ error: '観光スポット一覧の取得に失敗しました。' });
  }
});

// GET /api/admin/tourist-spots/link-clicks?from=YYYY-MM-DD&to=YYYY-MM-DD
// -> 管理画面「観光スポットの検索・アクセス数」用。スポット検索の検索回数（spot_search_counts）と
//    公式サイトリンクのタップ回数（tourist_spot_link_clicks）をスポットごとに期間集計してマージする
//    （掲載の有用性判断用。docs/tourist-spots.md / docs/spot-search.md）。
//    期間は最大1年（366日）。未指定なら直近30日。
router.get('/admin/tourist-spots/link-clicks', requireAdminAuth, async (req, res) => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : getServiceDateString();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')
    ? req.query.from
    : new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);

  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
  if (!Number.isFinite(spanDays) || spanDays < 0) {
    return res.status(400).json({ error: '開始日は終了日以前の日付を指定してください。' });
  }
  if (spanDays > touristSpots.LINK_CLICK_MAX_RANGE_DAYS - 1) {
    return res.status(400).json({ error: '期間は最大1年（366日）です。' });
  }

  try {
    const stats = await spotSearch.getSpotEngagementStats({ from, to });
    res.json(stats);
  } catch (err) {
    console.error('[api] /admin/tourist-spots/link-clicks エラー:', err);
    res.status(500).json({ error: 'アクセス数の集計に失敗しました。' });
  }
});

// PUT /api/admin/tourist-spots -> テキスト一括登録（全件洗い替え／UPSERT、観光スポット情報_仕様書）
router.put('/admin/tourist-spots', requireAdminAuth, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, errors: [{ line: 0, reason: 'テキストを入力してください。' }] });
  }
  try {
    const result = await touristSpots.replaceAllTouristSpots(text);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[api] /admin/tourist-spots 一括更新エラー:', err);
    res.status(500).json({ error: '観光スポット情報の更新に失敗しました。' });
  }
});

// DELETE /api/admin/tourist-spots/:id -> 1件削除
router.delete('/admin/tourist-spots/:id', requireAdminAuth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: '不正なIDです。' });
  try {
    await touristSpots.deleteSpot(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/tourist-spots/:id 削除エラー:', err);
    res.status(500).json({ error: '削除に失敗しました。' });
  }
});

// ==========================================================
// バス停お知らせ配信（docs/busstop-notices.md）。
// バス停詳細ページの「このバス停でできること」の下に出す。
//   scope='platform' … 乗り場（のりば）単位。乗り場別表示のときだけ出す。
//                       stopKey + platform を resolvePlatformRef() で正規の feed_id + stop_id へ落として保存する。
//   scope='stop'     … バス停単位。表示モードによらず常に出す。stopKey（統合バス停キー）で突合する。
// ==========================================================

// GET /api/admin/busstop-notices -> 全件（無効も含む。管理画面一覧用）
router.get('/admin/busstop-notices', requireAdminAuth, async (req, res) => {
  try {
    const notices = await busstopNotices.listAll();
    res.json({ notices });
  } catch (err) {
    console.error('[api] /admin/busstop-notices 取得エラー:', err);
    res.status(500).json({ error: 'バス停お知らせの取得に失敗しました。' });
  }
});

// POST /api/admin/busstop-notices -> 新規作成。
// body: { scope: 'stop'|'platform', stopKey, platform, title, imageUrl, body, enabled }
router.post('/admin/busstop-notices', requireAdminAuth, async (req, res) => {
  const { scope, stopKey, platform } = req.body || {};
  const scope_ = scope === 'stop' ? 'stop' : scope === 'platform' ? 'platform' : '';
  if (!scope_) return res.status(400).json({ error: '配信範囲（バス停単位／乗り場単位）を選択してください。' });
  if (typeof stopKey !== 'string' || !stopKey.trim()) {
    return res.status(400).json({ error: 'バス停を選択してください。' });
  }
  try {
    const ref = await resolvePlatformRef(stopKey.trim(), typeof platform === 'string' ? platform.trim() : '');
    if (!ref) return res.status(400).json({ error: '指定のバス停が見つかりませんでした。' });

    let target;
    if (scope_ === 'platform') {
      if (!ref.platform) {
        return res.status(400).json({ error: 'この停留所は乗り場が複数あります。お知らせを出す乗り場を選択してください。' });
      }
      target = { ...ref.platform, stopKey: ref.stopKey, stopName: ref.stopName };
    } else {
      target = { stopKey: ref.stopKey, stopName: ref.stopName };
    }

    const result = await busstopNotices.createNotice(scope_, target, req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, notice: result.notice });
  } catch (err) {
    console.error('[api] /admin/busstop-notices 作成エラー:', err);
    res.status(500).json({ error: 'バス停お知らせの保存に失敗しました。' });
  }
});

// PUT /api/admin/busstop-notices/:id -> 内容の更新（配信範囲・対象のバス停/乗り場は変えない）
router.put('/admin/busstop-notices/:id', requireAdminAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '不正なIDです。' });
  try {
    const result = await busstopNotices.updateNotice(id, req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, notice: result.notice });
  } catch (err) {
    console.error('[api] /admin/busstop-notices/:id 更新エラー:', err);
    res.status(500).json({ error: 'バス停お知らせの更新に失敗しました。' });
  }
});

// PATCH /api/admin/busstop-notices/:id -> 有効/無効の切り替え
router.patch('/admin/busstop-notices/:id', requireAdminAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '不正なIDです。' });
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled（真偽値）を指定してください。' });
  }
  try {
    const updated = await busstopNotices.setNoticeEnabled(id, req.body.enabled);
    if (!updated) return res.status(404).json({ error: '指定のお知らせが見つかりませんでした。' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/busstop-notices/:id 切替エラー:', err);
    res.status(500).json({ error: 'バス停お知らせの更新に失敗しました。' });
  }
});

// DELETE /api/admin/busstop-notices/:id -> 1件削除
router.delete('/admin/busstop-notices/:id', requireAdminAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '不正なIDです。' });
  try {
    await busstopNotices.deleteNotice(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/busstop-notices/:id 削除エラー:', err);
    res.status(500).json({ error: 'バス停お知らせの削除に失敗しました。' });
  }
});

// GET /api/stops -> 全バス停マスタ（時刻表画面・地図表示用）
router.get('/stops', async (req, res) => {
  try {
    const routeId = resolveRouteId(req.query.routeId);
    if (!routeId) {
      return res.status(400).json({ error: 'routeIdを指定してください。' });
    }
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
    if (!routeId) {
      return res.status(400).json({ error: 'routeIdを指定してください。' });
    }
    const serviceDate = getServiceDateString();

    const trips = await pool.query(
      `SELECT d.id, d.start_time, d.direction_id, d.headsign, d.origin,
              st.gtfs_trip_id, r.feed_id
       FROM daily_trips d
       JOIN schedule_trips st ON st.id = d.schedule_trip_id
       LEFT JOIN routes r ON r.id = d.route_id
       WHERE d.route_id = $1 AND d.service_date = $2
       ORDER BY d.direction_id ASC, d.start_at ASC, d.id ASC`,
      [routeId, serviceDate]
    );

    // 当日便がまだ生成されていない場合のフォールバック（起動直後など）
    if (trips.rows.length === 0) {
      return res.json(await readTimetableFromSchedule(routeId));
    }

    const times = await pool.query(
      `SELECT dst.daily_trip_id, dst.seq_order, s.id AS stop_id, s.gtfs_stop_id, s.name AS stop_name, dst.scheduled_time,
              dst.is_through, dst.no_pickup, dst.no_drop_off, dst.stop_headsign
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
        // 「リアルタイム非対応」便から便詳細ページ（時刻表表示）へ遷移するためのGTFS識別子
        feedId: t.feed_id || null,
        gtfsRouteId: t.feed_id ? unqualifyRouteId(routeId, t.feed_id) : null,
        gtfsTripId: t.gtfs_trip_id || null,
        departureUrlTime: startTimeToUrlHhmm(t.start_time),
        stops: []
      });
    }

    for (const r of times.rows) {
      const entry = byTrip.get(r.daily_trip_id);
      if (entry) {
        entry.stops.push({
          seqOrder: r.seq_order,
          stopId: r.stop_id,
          // 標柱単位で識別されたバス停詳細ページへの橋渡し（/api/busstop/resolve-by-feed-stop）に使う
          // 生のGTFS stop_id。feedIdは便（trip）単位のentry.feedIdと組み合わせて使う。
          gtfsStopId: r.gtfs_stop_id,
          stopName: r.stop_name,
          // GTFSのstop_times.txtに載る行には必ず実時刻があるため、is_through（真の通過）
          // でも時刻を隠さない。表示上どう扱うかはフロント側の判断に委ねる。
          scheduledTime: r.scheduled_time,
          isThrough: r.is_through,
          noPickup: r.no_pickup,
          noDropOff: r.no_drop_off,
          stopHeadsign: r.stop_headsign
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
    `SELECT st.id, st.trip_index, st.first_stop_time, st.direction_id, st.headsign,
            st.gtfs_trip_id, r.feed_id
     FROM schedule_trips st
     LEFT JOIN routes r ON r.id = st.route_id
     WHERE st.route_id = $1 AND st.service_id = ANY($2::text[])
     ORDER BY st.direction_id ASC, st.trip_index ASC`,
    [routeId, activeServiceIds]
  );
  // 順序はst.stop_sequence（便自身の中での0始まりの連番）を使う。s.seq_orderは
  // 路線内の表示順専用（service_idグループ横断の共有値）であり、枝分かれ・逆回りの
  // ある便ではこの便自身の実際の停車順と一致しないため使わない。
  const times = await pool.query(
    `SELECT st.trip_id, st.stop_sequence AS seq_order, s.id AS stop_id, s.gtfs_stop_id, s.name AS stop_name, st.scheduled_time,
            st.is_through, st.no_pickup, st.no_drop_off, st.stop_headsign
     FROM schedule_stop_times st
     JOIN stops s ON s.id = st.stop_id
     JOIN schedule_trips stp ON stp.id = st.trip_id
     WHERE stp.route_id = $1 AND stp.service_id = ANY($2::text[])
     ORDER BY st.trip_id ASC, st.stop_sequence ASC`,
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
      feedId: t.feed_id || null,
      gtfsRouteId: t.feed_id ? unqualifyRouteId(routeId, t.feed_id) : null,
      gtfsTripId: t.gtfs_trip_id || null,
      departureUrlTime: startTimeToUrlHhmm(t.first_stop_time),
      stops: []
    });
  }
  for (const r of times.rows) {
    const entry = byTrip.get(r.trip_id);
    if (entry) {
      entry.stops.push({
        seqOrder: r.seq_order,
        stopId: r.stop_id,
        gtfsStopId: r.gtfs_stop_id,
        stopName: r.stop_name,
        scheduledTime: r.scheduled_time,
        isThrough: r.is_through,
        noPickup: r.no_pickup,
        noDropOff: r.no_drop_off,
        stopHeadsign: r.stop_headsign
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
    if (!routeId) {
      return res.status(400).json({ error: 'routeIdを指定してください。' });
    }

    // 管理画面「リアルタイム休止」でこの路線のリアルタイム表示を止めている場合は、
    // 担当車両の有無にかかわらずバスを返さない（利用者向けリアルタイム運行状況画面用。
    // 時刻表は /api/timetable が別途返すため、画面下の「時刻表（参考）」は通常どおり出る）。
    const suspension = await getRealtimeSuspension(routeId);
    if (suspension) {
      return res.json({ buses: [], realtimeSuspended: true, suspensionReason: suspension.reason || '' });
    }

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

    const routeName = settings.routeName || '横田信大循環線';
    const busEntries = await buildBusEntriesBatch(trips.rows, routeId, routeName);
    const buses = trips.rows.map((t, i) => {
      const entry = busEntries[i];
      // 便詳細ページ（/timetable/trips/{gtfs_id}/{route_id}/{trip_id}/{departure_time}）への
      // 遷移URLをフロントで組み立てるためのGTFS識別子
      entry.feedId = t.feed_id || null;
      entry.gtfsRouteId = t.feed_id ? unqualifyRouteId(routeId, t.feed_id) : null;
      entry.gtfsTripId = t.gtfs_trip_id || null;
      entry.departureUrlTime = startTimeToUrlHhmm(t.start_time);
      return entry;
    });

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

    // 管理画面「リアルタイム休止」で表示を止めている路線は、利用者向けバスマップから除外する。
    // 管理画面（運行ダッシュボードの地図）は api() が Basic 認証ヘッダーを送るため、
    // isAuthenticatedAdmin(req) が真＝運行監視用途とみなして除外せず全路線を返す。
    const suspendedRouteIdSet = await getSuspendedRouteIdSet();
    const suspendedRouteIds = [...suspendedRouteIdSet];
    const hideSuspended = suspendedRouteIdSet.size > 0 && !isAuthenticatedAdmin(req);

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

    const rows = result.rows.filter((row) =>
      row.lat !== null && row.lon !== null &&
      !(hideSuspended && suspendedRouteIdSet.has(row.route_id))
    );

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
      assignmentId: row.assignment_id,
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

    // 現在リアルタイム休止中の路線ID一覧（除外の有無にかかわらず添える）。
    // 公開バスマップが「この路線は運行情報を休止中」の注記を出すために使う。
    res.json({ buses, suspendedRouteIds });
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
// 観光スポット候補（観光スポット情報_仕様書）も同じレスポンスに混ぜて返す。
// stops配列の形は変更しないため既存挙動には影響しない。
router.get('/route-search/stops', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json({ stops: [], spots: [] });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '20', 10) || 20, 1), 50);
    const stopLimit = Math.max(limit - 3, 4);
    const spotLimit = Math.max(limit - stopLimit, 2);
    const [stops, spots] = await Promise.all([
      searchRouteSearchStops(query, stopLimit),
      touristSpots.searchTouristSpots(query, spotLimit)
    ]);
    res.json({ stops, spots });
  } catch (err) {
    console.error('[api] /route-search/stops エラー:', err);
    res.status(500).json({ error: '停留所候補の取得に失敗しました。' });
  }
});

// GET /api/route-search -> 経路検索（乗換2回まで・徒歩接続あり・任意日付・運賃つき）
// クエリ: fromStopKey|from / toStopKey|to / date=YYYY-MM-DD / time=HH:MM / timeMode / limit
//   departureTime は旧APIの名前。time の別名として受け付ける。
//   timeMode=arrival なら time を「到着時刻」として逆向きに探索する（未指定なら従来どおり出発時刻）。
//   arrivalTime を渡した場合も到着時刻指定として扱う。
//   fromSpotId|toSpotId は観光スポットIDを起点/終点にする場合（観光スポット情報_仕様書）。
//   maxTransfers / allowWalkTransfer / minTransferMinutes は詳細設定。
//   いずれも未指定なら従来どおりの条件（乗換2回まで・徒歩接続あり・乗換余裕1分）で検索する。
// RAPTOR探索＋段階的フォールバックはDBを見ない代わりにCPUを使う。任意の日付・時刻で
// 叩けるため、少数のクライアントがCPUを専有できないようレートリミットを掛けている（S-3）。
// 入力候補（/route-search/stops）はキーストロークごとに飛ぶので対象外。
router.get('/route-search', routeSearchRateLimit, async (req, res) => {
  try {
    const isArrival = req.query.timeMode === 'arrival' || Boolean(req.query.arrivalTime);
    const result = await searchJourneys({
      fromStopKey: req.query.fromStopKey || null,
      from: req.query.from || null,
      fromSpotId: req.query.fromSpotId || null,
      toStopKey: req.query.toStopKey || null,
      to: req.query.to || null,
      toSpotId: req.query.toSpotId || null,
      date: req.query.date || null,
      time: req.query.arrivalTime || req.query.time || req.query.departureTime || null,
      timeMode: isArrival ? 'arrival' : 'departure',
      // 詳細設定（未指定・不正値はサービス側で既定＝従来の条件に落ちる）
      maxTransfers: req.query.maxTransfers,
      allowWalkTransfer: req.query.allowWalkTransfer,
      minTransferMinutes: req.query.minTransferMinutes,
      limit: req.query.limit
    });

    // 詳細設定を付けた検索だけログに条件を添える（既定の検索のログ形式は変えない）
    const prefs = result.preferences;
    const prefsLog = prefs && !prefs.isDefault
      ? ` / 詳細設定: 乗換${prefs.maxTransfers === null ? '指定なし' : `${prefs.maxTransfers}回まで`}` +
        `・徒歩乗継${prefs.allowWalkTransfer ? 'あり' : 'なし'}・余裕${prefs.minTransferMinutes}分`
      : '';

    if (result.found) {
      console.log(
        `[api] 経路検索: ${result.from.name} → ${result.to.name} ` +
        `(${result.date} ${result.baseTime}${result.timeMode === 'arrival' ? '着' : '発'}) ` +
        `→ ${result.journeys.length}件 / ${result.relaxation}${prefsLog}`
      );
    } else {
      console.log(`[api] 経路検索: 見つからず (${result.reason})${prefsLog}`);
    }
    res.json(result);
  } catch (err) {
    console.error('[api] /route-search エラー:', err);
    res.status(500).json({ error: 'ルート検索に失敗しました。' });
  }
});

// ==========================================================
// スポット検索（docs/spot-search.md / services/spotSearch.js / frontend/spotsearch.js）。
// 地名（観光スポット・その他のスポット）・バス停・路線を1つ入力すると、
// スポット情報＋付近のバス停＋周辺を通る路線を返す簡易的な路線・バス停検索。
// ==========================================================

// GET /api/spot-search/suggest?q=...&limit=... -> 入力候補（バス停・観光スポット・路線を混ぜて返す）
router.get('/spot-search/suggest', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json({ stops: [], spots: [], routes: [] });
    const result = await spotSearch.suggest(query, req.query.limit);
    res.json(result);
  } catch (err) {
    console.error('[api] /spot-search/suggest エラー:', err);
    res.status(500).json({ error: 'スポット候補の取得に失敗しました。' });
  }
});

// GET /api/spot-search?spotId=... | stopKey=... | q=... -> スポット検索の実行。
// 対象が観光スポット／その他のスポットに確定したら検索回数を +1 する（spot_search_counts）。
// 対象が路線に解決した場合は found:true・resolvedFrom:'route' を返し、フロントがリアルタイム時刻表へ遷移する。
// 検索回数（spot_search_counts）を増やす副作用があるため、無認証で水増しされないよう
// レートリミットを掛けている（S-3）。入力候補（/spot-search/suggest）はカウントしないので対象外。
router.get('/spot-search', countRateLimit, async (req, res) => {
  try {
    const result = await spotSearch.search({
      spotId: req.query.spotId || null,
      stopKey: req.query.stopKey || null,
      q: req.query.q || null,
      radiusMeters: req.query.radius,
      limit: req.query.limit
    });
    res.json(result);
  } catch (err) {
    console.error('[api] /spot-search エラー:', err);
    res.status(500).json({ error: 'スポット検索に失敗しました。' });
  }
});

// GET /api/admin/vehicle-positions-map -> 運行ダッシュボード（地図）の「全車両（直近3分）」モード用。
// /api/buses-for-map（担当車両のみ）と異なり、便に割り当てられていない・候補にすらなっていない
// 車両も含め、直近3分以内にGPSを受信した全車両を1台につき最新の1件だけ返す。
// レスポンス形状は/api/buses-for-mapのバス1件分と揃えてあり、フロント側のマーカー描画を共用する。
router.get('/admin/vehicle-positions-map', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (vpr.car_id)
              vpr.car_id, vpr.route_id, vpr.lat, vpr.lon, vpr.gps_time, vpr.gps_time_ts,
              r.name AS route_name, r.color AS route_color, r.text_color AS route_text_color,
              v.id AS vehicle_id,
              (SELECT a.id FROM trip_vehicle_assignments a
               WHERE a.vehicle_id = v.id AND a.state = 'active'
               ORDER BY (a.role = 'assigned') DESC, a.id DESC
               LIMIT 1) AS assignment_id
       FROM vehicle_positions_raw vpr
       LEFT JOIN routes r ON r.id = vpr.route_id
       LEFT JOIN vehicles v ON v.car_id = vpr.car_id AND v.route_id = vpr.route_id
       WHERE vpr.gps_time_ts >= now() - interval '3 minutes'
       ORDER BY vpr.car_id, vpr.gps_time_ts DESC, vpr.id DESC`
    );

    const vehicles = result.rows.map((row) => ({
      id: row.car_id,
      vehicleId: row.vehicle_id,
      assignmentId: row.assignment_id,
      lat: Number(row.lat),
      lng: Number(row.lon),
      routeId: row.route_id,
      routeName: row.route_name || row.route_id || '路線未確定',
      routeColor: row.route_color || null,
      routeTextColor: row.route_text_color || null,
      headsign: null,
      currentHeadsign: null,
      delayMinutes: null,
      gpsTime: row.gps_time,
      gpsTimeTs: row.gps_time_ts
    }));

    res.json({ vehicles });
  } catch (err) {
    console.error('[api] /admin/vehicle-positions-map エラー:', err);
    res.status(500).json({ error: '全車両位置情報の取得に失敗しました。' });
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


// GET /api/admin/assignments/:assignmentId -> 運行ダッシュボード（地図）でバスアイコンを
// タップしたときの詳細（リアルタイム時刻表・地図に重ねる停車バス停・位置履歴）。
router.get('/admin/assignments/:assignmentId', requireAdminAuth, async (req, res) => {
  try {
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isInteger(assignmentId)) {
      return res.status(400).json({ error: '不正な assignmentId です。' });
    }
    const detail = await getAssignmentDetailForAdmin(assignmentId);
    if (!detail) return res.status(404).json({ error: '指定の割り当てが見つかりませんでした。' });
    res.json(detail);
  } catch (err) {
    console.error('[api] /admin/assignments/:assignmentId エラー:', err);
    res.status(500).json({ error: '便の詳細情報の取得に失敗しました。' });
  }
});

// GET /api/admin/gps-outage/:assignmentId -> 異常アラート「GPS途絶で便打ち切り」(gpsLostTrip)の
// 「地図で検証」用。運行ダッシュボードの詳細（停車バス停・位置履歴・リアルタイム時刻表）に、
// 途絶の一覧（途絶/復旧の時刻・地点、継続分数）と「途絶時点で時刻表のどこまで進んでいたか」を
// 添えて返す。走行経路はGPS_LOG_RETENTION_HOURS（既定48時間）を過ぎると空になる。
router.get('/admin/gps-outage/:assignmentId', requireAdminAuth, async (req, res) => {
  try {
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isInteger(assignmentId)) {
      return res.status(400).json({ error: '不正な assignmentId です。' });
    }
    const detail = await getGpsOutageDetailForAdmin(assignmentId);
    if (!detail) return res.status(404).json({ error: '指定の割り当てが見つかりませんでした。' });
    res.json(detail);
  } catch (err) {
    console.error('[api] /admin/gps-outage/:assignmentId エラー:', err);
    res.status(500).json({ error: 'GPS途絶の詳細情報の取得に失敗しました。' });
  }
});

const ACTUAL_TIME_PATTERN = /^([0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/;

// GET /api/admin/assignments/:assignmentId/stops/:stopId -> 運行ダッシュボードのバス停別詳細モーダル。
// 到着済なら「判定方法（付近経由／ベクトル判定／手動 等）と根拠（内積・線分距離・前後GPS点 等）」＋
// 遅れ分数＋ETA予測の推移、未到着なら「ETA予測根拠（source・ペース補正の内訳）」＋ETA予測の推移を返す。
router.get('/admin/assignments/:assignmentId/stops/:stopId', requireAdminAuth, async (req, res) => {
  try {
    const assignmentId = Number(req.params.assignmentId);
    const stopId = Number(req.params.stopId);
    if (!Number.isInteger(assignmentId) || !Number.isInteger(stopId)) {
      return res.status(400).json({ error: '不正なパラメータです。' });
    }
    const detail = await getStopArrivalDetailForAdmin(assignmentId, stopId);
    if (!detail) return res.status(404).json({ error: '指定のバス停が見つかりませんでした。' });
    res.json(detail);
  } catch (err) {
    console.error('[api] GET /admin/assignments/:assignmentId/stops/:stopId エラー:', err);
    res.status(500).json({ error: 'バス停の詳細情報の取得に失敗しました。' });
  }
});

// PUT /api/admin/assignments/:assignmentId/stops/:stopId -> 到着判定時刻の手動編集。
// - actualTime が H:mm: そのバス停を '到着済' に手動確定する（未到着のバス停への手動確定も可）。
//   passDetection.js は status IN ('到着済','付近') を新規の付近入り候補から除外するため、
//   ここで確定させた行は次回パイプライン実行で上書きされない。
// - actualTime が空: そのバス停を「未到着」に差し戻す（到着判定・実績時刻・遅れ・判定根拠を消去）。
//   誤判定の取り消し用。trip_gps_matches は消さない（消すと直近48hの生GPSが即再判定を誘発する）。
//   前後が到着済で1停留所だけ空くと、次回パイプラインの線形補間で再び埋まり得る（仕様）。
router.put('/admin/assignments/:assignmentId/stops/:stopId', requireAdminAuth, async (req, res) => {
  try {
    const assignmentId = Number(req.params.assignmentId);
    const stopId = Number(req.params.stopId);
    if (!Number.isInteger(assignmentId) || !Number.isInteger(stopId)) {
      return res.status(400).json({ error: '不正なパラメータです。' });
    }
    const actualTime = String(req.body?.actualTime || '').trim();
    const isRevert = actualTime === '';
    if (!isRevert && !ACTUAL_TIME_PATTERN.test(actualTime)) {
      return res.status(400).json({ error: '到着判定時刻は H:mm 形式（例: 8:05）で入力してください。空で保存すると未到着に戻します。' });
    }

    // scheduled_time / seq_order に加え、差し戻し後のステータス決定用に is_through を引く。
    const progressRes = await pool.query(
      `SELECT p.scheduled_time, p.seq_order, COALESCE(dtst.is_through, FALSE) AS is_through
       FROM trip_stop_progress p
       JOIN trip_vehicle_assignments a ON a.id = p.assignment_id
       LEFT JOIN daily_trip_stop_times dtst
         ON dtst.daily_trip_id = a.daily_trip_id AND dtst.stop_id = p.stop_id
       WHERE p.assignment_id = $1 AND p.stop_id = $2`,
      [assignmentId, stopId]
    );
    const progress = progressRes.rows[0];
    if (!progress) return res.status(404).json({ error: '指定のバス停が見つかりませんでした。' });

    const delayMinutes = isRevert ? null : computeDelayMinutes(progress.scheduled_time, actualTime);
    // 0に丸める前の符号付きの値も残す（負＝手動確定した時刻が定刻より早い）。
    const signedDelayMinutes = isRevert ? null : computeSignedDelayMinutes(progress.scheduled_time, actualTime);

    if (isRevert) {
      // 未到着へ差し戻し。真の通過バス停は '通過'、それ以外は '' に戻す。
      const revertStatus = progress.is_through ? '通過' : '';
      await pool.query(
        `UPDATE trip_stop_progress
         SET status = $3, actual_time = NULL, delay_minutes = NULL, signed_delay_minutes = NULL, interpolated = FALSE,
             arrival_method = NULL, arrival_evidence = NULL,
             nearby_min_distance_meters = NULL, nearby_min_distance_gps_time = NULL, nearby_min_distance_gps_time_ts = NULL
         WHERE assignment_id = $1 AND stop_id = $2`,
        [assignmentId, stopId, revertStatus]
      );
      // last_arrived_seq は前進のみの GREATEST では戻せないため、残った到着済から引き直す。
      await pool.query(
        `UPDATE trip_vehicle_assignments a
         SET last_arrived_seq = COALESCE(
               (SELECT MAX(seq_order) FROM trip_stop_progress WHERE assignment_id = a.id AND status = '到着済'), -1)
         WHERE a.id = $1`,
        [assignmentId]
      );
    } else {
      await pool.query(
        `UPDATE trip_stop_progress
         SET status = '到着済', actual_time = $1, delay_minutes = $2, signed_delay_minutes = $3, interpolated = FALSE,
             arrival_method = 'manual',
             arrival_evidence = jsonb_build_object('note', '管理画面で手動確定', 'editedAt', now()),
             nearby_min_distance_meters = NULL, nearby_min_distance_gps_time = NULL, nearby_min_distance_gps_time_ts = NULL
         WHERE assignment_id = $4 AND stop_id = $5`,
        [actualTime, delayMinutes, signedDelayMinutes, assignmentId, stopId]
      );
      await pool.query(
        `UPDATE trip_vehicle_assignments SET last_arrived_seq = GREATEST(last_arrived_seq, $1) WHERE id = $2`,
        [progress.seq_order, assignmentId]
      );
    }

    // 便レベルのdelay_minutesを、delayCalc.jsと同じ規則（seq_order昇順で最後にnon-nullな値）で再計算する。
    // 差し戻しで到着済が1つも残らない場合は 0（列の既定値）に戻す。
    const latestRes = await pool.query(
      `SELECT delay_minutes, signed_delay_minutes FROM trip_stop_progress
       WHERE assignment_id = $1 AND delay_minutes IS NOT NULL
       ORDER BY seq_order DESC LIMIT 1`,
      [assignmentId]
    );
    await pool.query(
      `UPDATE trip_vehicle_assignments SET delay_minutes = $1, signed_delay_minutes = $2 WHERE id = $3`,
      [
        latestRes.rows[0] ? latestRes.rows[0].delay_minutes : 0,
        latestRes.rows[0] ? latestRes.rows[0].signed_delay_minutes ?? null : null,
        assignmentId
      ]
    );

    if (isRevert) {
      res.json({ ok: true, stopId, reverted: true });
    } else {
      res.json({ ok: true, stopId, actualTime, delayMinutes, signedDelayMinutes, reverted: false });
    }
  } catch (err) {
    console.error('[api] PUT /admin/assignments/:assignmentId/stops/:stopId エラー:', err);
    res.status(500).json({ error: '到着判定時刻の更新に失敗しました。' });
  }
});

// GET /api/admin/daily-trips?routeId=...&date=YYYY-MM-DD -> 運行ダッシュボードで
// 車両アイコンを便に手動で紐づける際の候補一覧（その路線・その日のまだクローズしていない便）。
router.get('/admin/daily-trips', requireAdminAuth, async (req, res) => {
  try {
    const routeId = String(req.query.routeId || '').trim();
    if (!routeId) return res.status(400).json({ error: 'routeId を指定してください。' });
    const serviceDate = parseServiceDateParam(req.query.date);
    const trips = await listLinkableTrips(routeId, serviceDate);
    res.json({ trips });
  } catch (err) {
    console.error('[api] /admin/daily-trips エラー:', err);
    res.status(500).json({ error: '便一覧の取得に失敗しました。' });
  }
});

// POST /api/admin/assignments -> 運行ダッシュボードで、便に割り当てられていない車両アイコンを
// タップして選んだ便に手動で紐づける。
router.post('/admin/assignments', requireAdminAuth, async (req, res) => {
  try {
    const vehicleId = Number(req.body?.vehicleId);
    const dailyTripId = Number(req.body?.dailyTripId);
    if (!Number.isInteger(vehicleId) || !Number.isInteger(dailyTripId)) {
      return res.status(400).json({ error: '不正なパラメータです。' });
    }
    const result = await linkVehicleToTrip(vehicleId, dailyTripId);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, assignmentId: result.assignmentId });
  } catch (err) {
    console.error('[api] POST /admin/assignments エラー:', err);
    res.status(500).json({ error: '車両の紐づけに失敗しました。' });
  }
});

// DELETE /api/admin/assignments/:assignmentId -> 運行ダッシュボードで、紐づけ済みの
// 車両アイコンをタップして紐づけを解除する。便のクローズ・再割り当ては既存の
// 自動割り当てパイプライン（次回ポーリング、最大60秒）に委ねる。
router.delete('/admin/assignments/:assignmentId', requireAdminAuth, async (req, res) => {
  try {
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isInteger(assignmentId)) {
      return res.status(400).json({ error: '不正な assignmentId です。' });
    }
    const result = await unlinkAssignment(assignmentId);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] DELETE /admin/assignments/:assignmentId エラー:', err);
    res.status(500).json({ error: '紐づけの解除に失敗しました。' });
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

// GET /api/admin/alerts -> 異常アラート（GPS途絶・GPS途絶で便打ち切り・未割当便・大幅遅延・予測計算失敗・GTFS取得失敗）
router.get('/admin/alerts', requireAdminAuth, async (req, res) => {
  try {
    const serviceDate = getServiceDateString();
    const alerts = [];

    // GPS途絶アラートは「本日（サービス日, JST）に一度でもGPSを受信した車両」に限定する。
    // 前日以前が最終受信の車両や一度も受信していない車両は当日の運行監視の対象外。
    // assignment_id は「地図で検証」用。その車両の本日の担当割り当てのうち、
    // 稼働中（state='active'）を最優先、無ければGPS途絶で打ち切られたもの（end_reason='GPS更新停止'）を
    // 直近順で1件。どちらも無ければ null（＝検証ボタンを出さない）。
    const staleGpsRes = await pool.query(
      `SELECT v.id AS vehicle_id, v.car_id, v.route_id, v.last_gps_at,
              (SELECT a.id
               FROM trip_vehicle_assignments a
               JOIN daily_trips d ON d.id = a.daily_trip_id
               WHERE a.vehicle_id = v.id
                 AND a.role = 'assigned'
                 AND d.service_date = $2::date
                 AND (a.state = 'active' OR a.end_reason = 'GPS更新停止')
               ORDER BY (a.state = 'active') DESC, a.became_assigned_at DESC NULLS LAST, a.id DESC
               LIMIT 1) AS assignment_id
       FROM vehicles v
       WHERE v.status = 'active'
         AND v.last_gps_at IS NOT NULL
         AND (v.last_gps_at AT TIME ZONE 'Asia/Tokyo')::date = $2::date
         AND v.last_gps_at < now() - make_interval(secs => $1::double precision * 60)
       ORDER BY v.last_gps_at ASC`,
      [staleGpsMin(), serviceDate]
    );
    for (const row of staleGpsRes.rows) {
      alerts.push({
        type: 'staleGps',
        severity: 'warning',
        vehicleId: row.vehicle_id,
        carId: row.car_id,
        routeId: row.route_id,
        lastGpsAt: row.last_gps_at,
        assignmentId: row.assignment_id || null,
        key: buildAlertKey('staleGps', row.vehicle_id, row.last_gps_at)
      });
    }

    // GPS途絶で打ち切られた便（trip_vehicle_assignments.end_reason='GPS更新停止'）。
    // 車両単位のstaleGpsは6分の途絶タイムアウトでvehicles.status='inactive'になった時点で
    // 消えてしまう（＝実質1〜2分しか出ない）ため、こちらは「割り当てが打ち切られた」事実を
    // アンカーにして、復旧後（何分後にどこで復旧したか）も含めて地図で検証できるようにする。
    // 便のデータはDAILY_TRIP_RETENTION_DAYS（既定7日）残る。
    const gpsLostTripRes = await pool.query(
      `SELECT a.id AS assignment_id, a.vehicle_id, a.daily_trip_id, a.ended_at,
              d.route_id, d.start_time, d.headsign,
              v.car_id, v.last_gps_at
       FROM trip_vehicle_assignments a
       JOIN daily_trips d ON d.id = a.daily_trip_id
       JOIN vehicles v ON v.id = a.vehicle_id
       WHERE a.role = 'assigned' AND a.state = 'ended' AND a.end_reason = 'GPS更新停止'
         AND d.service_date = $1::date
       ORDER BY a.ended_at DESC`,
      [serviceDate]
    );
    for (const row of gpsLostTripRes.rows) {
      alerts.push({
        type: 'gpsLostTrip',
        severity: 'warning',
        assignmentId: row.assignment_id,
        vehicleId: row.vehicle_id,
        tripId: row.daily_trip_id,
        carId: row.car_id,
        routeId: row.route_id,
        startTime: row.start_time,
        headsign: row.headsign || null,
        endedAt: row.ended_at,
        lastGpsAt: row.last_gps_at,
        key: buildAlertKey('gpsLostTrip', row.assignment_id, row.ended_at)
      });
    }

    const unassignedRes = await pool.query(
      `SELECT id AS trip_id, route_id, start_time, headsign, start_at
       FROM daily_trips
       WHERE assignment_state = 'unassigned' AND closed_at IS NULL
         AND service_date = $2
         AND start_at < now() - make_interval(secs => $1::double precision * 60)
       ORDER BY start_at ASC`,
      [unassignedOverdueMin(), serviceDate]
    );
    for (const row of unassignedRes.rows) {
      alerts.push({
        type: 'unassignedTrip',
        severity: 'warning',
        tripId: row.trip_id,
        routeId: row.route_id,
        startTime: row.start_time,
        headsign: row.headsign || null,
        minutesOverdue: Math.round((Date.now() - new Date(row.start_at).getTime()) / 60000),
        key: buildAlertKey('unassignedTrip', row.trip_id)
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
      [severeDelayMin(), serviceDate]
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
        delayMinutes: row.delay_minutes,
        key: buildAlertKey('severeDelay', row.assignment_id)
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
      [etaStaleMin(), serviceDate]
    );
    for (const row of etaFailureRes.rows) {
      alerts.push({
        type: 'etaComputeFailure',
        severity: 'warning',
        assignmentId: row.assignment_id,
        tripId: row.daily_trip_id,
        carId: row.car_id,
        startTime: row.start_time,
        lastComputedAt: row.last_computed_at,
        key: buildAlertKey('etaComputeFailure', row.assignment_id)
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
        lastError: row.last_error,
        key: buildAlertKey('gtfsFetchFailure', row.id)
      });
    }

    // パイプライン／終了バッチ／掃除バッチが多重実行ガードでスキップされ続けている
    // （＝前回の処理が長引いて戻ってこない）場合の異常アラート（D-1）。
    // DBは見ず、jobMonitorのプロセス内カウンタ（scheduler.jsのrecordSkip呼び出し）を参照するだけ。
    const SKIP_ALERT_JOBS = [
      { name: 'scheduler.pipeline', label: 'メインパイプライン' },
      { name: 'scheduler.finishTrips', label: '運行終了バッチ' },
      { name: 'scheduler.cleanup', label: 'データ掃除バッチ' }
    ];
    for (const job of SKIP_ALERT_JOBS) {
      const status = jobMonitor.getJobStatus(job.name);
      if (status && status.consecutiveSkips >= jobMonitor.SKIP_ALERT_THRESHOLD) {
        alerts.push({
          type: 'pipelineSkipped',
          severity: 'critical',
          job: job.name,
          jobLabel: job.label,
          consecutiveSkips: status.consecutiveSkips,
          lastSkippedAt: status.lastSkippedAt,
          key: buildAlertKey('pipelineSkipped', job.name, status.skipStreakStartedAt)
        });
      }
    }

    // 現存する異常のキー以外の確認済み記録はガベージコレクトする。
    // これにより、いったん解消してから再発した異常は改めて表示される。
    const liveKeys = alerts.map((a) => a.key);
    if (liveKeys.length > 0) {
      await pool.query(
        `DELETE FROM admin_alert_acknowledgements WHERE NOT (alert_key = ANY($1::text[]))`,
        [liveKeys]
      );
    } else {
      await pool.query(`DELETE FROM admin_alert_acknowledgements`);
    }

    const ackRes = await pool.query(
      `SELECT alert_key FROM admin_alert_acknowledgements WHERE alert_key = ANY($1::text[])`,
      [liveKeys]
    );
    const ackedKeys = new Set(ackRes.rows.map((r) => r.alert_key));
    const visibleAlerts = alerts.filter((a) => !ackedKeys.has(a.key));

    const counts = visibleAlerts.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] || 0) + 1;
      return acc;
    }, {});

    visibleAlerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));

    res.json({ alerts: visibleAlerts, counts, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[api] /admin/alerts エラー:', err);
    res.status(500).json({ error: '異常アラートの取得に失敗しました。' });
  }
});

// POST /api/admin/alerts/ack -> 異常アラートを確認済みにする（同じ異常が解消・再発するまで再表示しない）
router.post('/admin/alerts/ack', requireAdminAuth, async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'keyは必須です。' });
    }
    await pool.query(
      `INSERT INTO admin_alert_acknowledgements (alert_key) VALUES ($1)
       ON CONFLICT (alert_key) DO NOTHING`,
      [key]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /admin/alerts/ack エラー:', err);
    res.status(500).json({ error: 'アラートの確認処理に失敗しました。' });
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
    // 手動再取得は「とにかく取り直したい」操作なので、内容不変でも必ず展開・再投入する
    // （force）。毎時のパイプライン側だけが内容不変のスキップ判定を使う。
    const result = await jobMonitor.track('pipeline.gtfsManualRefetch', () =>
      downloadAndExtractGtfsFeed(client, feed, { force: true })
    );
    const success = result.ok;

    if (success) {
      try {
        const seed = require('../db/seed');
        await seed();
        require('../services/dailyTripBuilder').invalidateDailyTripCache();
        require('../services/gtfsTimetable').invalidateTimetableIndex();
        require('../services/gtfsFare').invalidateFareIndex();
        // 指紋の確定はseed()成功後（失敗した回の指紋を残すと毎時の更新が
        // 「内容不変」と誤判定してDBが古いまま固定される）。
        if (result.fingerprint) {
          await commitFeedFingerprint(pool, feed.id, result.fingerprint);
        }
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
// ETA予測の精度監視・運行実績ダウンロード
// いずれも既存のETA計算(etaPredictor.js)・パイプラインには書き込みを行わない、
// 読み取り専用の追加API。予測精度監視はtrip_arrival_prediction_log（追記専用の
// 履歴テーブル）を参照する。
// ==========================================================

// GET /api/admin/eta-route-overview?date=YYYY-MM-DD
// -> 管理画面「当日の状況」の路線別サマリ。路線ごとに、稼働中の担当車両数と、
//    現在ETA計算に使われているペース補正（liveFactor／今日の前便実績／周辺道路実績／
//    それらを統合したcombinedPaceFactor）・平均予測遅延を集計する。
//    「今日この路線がどの程度の遅れを見込んで計算されているか」を俯瞰するためのもの。
router.get('/admin/eta-route-overview', requireAdminAuth, async (req, res) => {
  try {
    const serviceDate = parseServiceDateParam(req.query.date);

    const result = await pool.query(
      `SELECT r.id AS route_id, r.name AS route_name, r.short_name, r.color, r.text_color,
              COUNT(DISTINCT a.id) AS active_assignments,
              COUNT(*) FILTER (WHERE tap.combined_pace_factor IS NOT NULL) AS pace_sample_count,
              AVG(tap.live_factor) FILTER (WHERE tap.combined_pace_factor IS NOT NULL) AS avg_live_factor,
              AVG(tap.combined_pace_factor) FILTER (WHERE tap.combined_pace_factor IS NOT NULL) AS avg_combined_pace_factor,
              COUNT(*) FILTER (WHERE tap.today_previous_trip_factor IS NOT NULL) AS today_previous_trip_usage_count,
              AVG(tap.today_previous_trip_factor) FILTER (WHERE tap.today_previous_trip_factor IS NOT NULL) AS avg_today_previous_trip_factor,
              COUNT(*) FILTER (WHERE tap.nearby_factor IS NOT NULL) AS nearby_usage_count,
              AVG(tap.nearby_factor) FILTER (WHERE tap.nearby_factor IS NOT NULL) AS avg_nearby_factor,
              AVG(tap.predicted_delay_minutes) AS avg_predicted_delay_minutes,
              MAX(tap.predicted_delay_minutes) AS max_predicted_delay_minutes
       FROM trip_vehicle_assignments a
       JOIN daily_trips d ON d.id = a.daily_trip_id
       JOIN routes r ON r.id = d.route_id
       LEFT JOIN trip_arrival_predictions tap ON tap.assignment_id = a.id
       WHERE a.role = 'assigned' AND a.state = 'active' AND d.service_date = $1 AND d.closed_at IS NULL
       GROUP BY r.id, r.name, r.short_name, r.color, r.text_color
       ORDER BY r.id ASC`,
      [serviceDate]
    );

    const num = (v) => (v === null ? null : Number(v));
    const routes = result.rows.map((row) => ({
      routeId: row.route_id,
      routeName: row.route_name,
      shortName: row.short_name,
      color: row.color,
      textColor: row.text_color,
      activeAssignments: Number(row.active_assignments),
      paceSampleCount: Number(row.pace_sample_count),
      avgLiveFactor: num(row.avg_live_factor),
      avgCombinedPaceFactor: num(row.avg_combined_pace_factor),
      todayPreviousTripUsageCount: Number(row.today_previous_trip_usage_count),
      avgTodayPreviousTripFactor: num(row.avg_today_previous_trip_factor),
      nearbyUsageCount: Number(row.nearby_usage_count),
      avgNearbyFactor: num(row.avg_nearby_factor),
      avgPredictedDelayMinutes: num(row.avg_predicted_delay_minutes),
      maxPredictedDelayMinutes: row.max_predicted_delay_minutes === null ? null : Number(row.max_predicted_delay_minutes)
    }));

    res.json({ date: serviceDate, routes });
  } catch (err) {
    console.error('[api] /admin/eta-route-overview エラー:', err);
    res.status(500).json({ error: '路線別ETA状況の取得に失敗しました。' });
  }
});

// GET /api/admin/delay-mesh?cellMeters=300
// -> 管理画面「当日の状況」の地図メッシュ表示。対象区間を限定せず、直近の区間実績
//    （ETA予測の「周辺道路実績」と同じデータソース）を格子(メッシュ)に集約し、
//    セルごとの平均ペース比率（1.0=定刻通り、大きいほど遅い）を返す。
router.get('/admin/delay-mesh', requireAdminAuth, async (req, res) => {
  try {
    const mesh = await getDelayMesh(pool, { cellMeters: req.query.cellMeters });
    res.json(mesh);
  } catch (err) {
    console.error('[api] /admin/delay-mesh エラー:', err);
    res.status(500).json({ error: '遅延メッシュデータの取得に失敗しました。' });
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
              cts.seq_order, s.name AS stop_name, cts.scheduled_time, cts.actual_time,
              cts.delay_minutes, cts.signed_delay_minutes
       FROM completed_trips ct
       JOIN routes r ON r.id = ct.route_id
       LEFT JOIN completed_trip_stop_times cts ON cts.completed_trip_id = ct.id
       LEFT JOIN stops s ON s.id = cts.stop_id
       WHERE (ct.finished_at AT TIME ZONE 'Asia/Tokyo')::date BETWEEN $1::date AND $2::date
         ${routeFilter}
       ORDER BY ct.finished_at ASC, ct.id ASC, cts.seq_order ASC
       LIMIT 200001`,
      params
    );

    // 上限+1件だけ取得して打ち切りの有無を判定する（実際に出力するのは既存どおり上限まで）。
    const EXPORT_ROW_LIMIT = 200000;
    const truncated = result.rows.length > EXPORT_ROW_LIMIT;
    if (truncated) result.rows.length = EXPORT_ROW_LIMIT;

    // 「遅延分」は0以上に丸めた値（公開画面と同じ）。「遅延分(符号付き)」は負なら早発・早着。
    // 符号付き列の導入前に確定した実績は空欄になる。
    const header = ['完了トリップID', '路線ID', '路線名', '車両ID', '便始発時刻', '実績種別', '曜日番号', '曜日区分', '終了理由', '終了確定日時(JST)', '停留所順', '停留所名', '定刻', '実績時刻', '遅延分', '遅延分(符号付き)'];
    // CSV数式インジェクション(CSV Formula Injection)対策。
    // Excel/LibreOffice等は `=` `+` `-` `@` や制御文字(TAB/CR)で始まるセルを数式として
    // 解釈・実行しうる。この表にはバス停名・行先・終了理由などGTFS由来の外部文字列が
    // そのまま入るため、該当するセルはシングルクォートを前置して無害化する。
    // ただし「遅延分(符号付き)」のような純粋な数値（先頭の `-` が負号のもの）まで
    // 前置するとExcel上で文字列になり集計できなくなるため、数値だけは対象外にする。
    // 単体の `\r` も行区切りとして誤解釈されうるので引用符で囲む対象に含める。
    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      let s = String(v);
      const isPlainNumber = /^-?\d+(\.\d+)?$/.test(s);
      if (!isPlainNumber && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
        row.delay_minutes,
        row.signed_delay_minutes
      ].map(csvEscape).join(','));
    }
    // 打ち切りが起きたことを黙って伝えない: プログラムからはヘッダーで、
    // 人が開いたときはファイル末尾の注記行で気づけるようにする。
    if (truncated) {
      lines.push(csvEscape(
        `※ ${EXPORT_ROW_LIMIT.toLocaleString('ja-JP')}行の上限に達したため、これ以降のデータは含まれていません。期間や路線を絞って再度ダウンロードしてください。`
      ));
    }
    const csv = '﻿' + lines.join('\r\n'); // ExcelでのUTF-8誤認識を防ぐBOM付き

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="operation-records_${from}_${to}.csv"`);
    res.setHeader('X-Export-Truncated', truncated ? 'true' : 'false');
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

// GET /api/busstop/by-keys?keys=a,b,c -> 指定したstopKey群のバス停サマリー（お気に入りバス停を
// 検索・経路検索画面の候補に出す用途）。別名キー・標柱のstop_idどちらでも解決できる。
router.get('/busstop/by-keys', async (req, res) => {
  try {
    const keys = String(req.query.keys || '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    if (keys.length === 0) return res.json({ stops: [] });
    const stops = await getStopSummariesByKeys(keys.slice(0, 50));
    res.json({ stops });
  } catch (err) {
    console.error('[api] /busstop/by-keys エラー:', err);
    res.status(500).json({ error: 'バス停情報の取得に失敗しました。' });
  }
});

// GET /api/busstop/resolve-by-feed-stop?feedId=...&stopId=... -> リアルタイムDB側のバス停識別子
// （feedId + 生のGTFS stop_id。/api/timetable・/api/buses が返すstopIdの由来）から、
// 標柱単位で識別されたバス停詳細ページ（/busstop/{stopKey}?platform={platformKey}）のURLを組み立てる
// ためのキーを解決する。リアルタイム運行状況画面（カード表示・基本表示共通）のバス停タップから使う。
router.get('/busstop/resolve-by-feed-stop', async (req, res) => {
  try {
    const feedId = String(req.query.feedId || '').trim();
    const stopId = String(req.query.stopId || '').trim();
    if (!feedId || !stopId) return res.status(400).json({ error: 'feedId・stopIdを指定してください。' });
    const result = await resolvePlatformByFeedStop(feedId, stopId);
    if (!result) return res.status(404).json({ error: '対応するバス停が見つかりませんでした。' });
    res.json(result);
  } catch (err) {
    console.error('[api] /busstop/resolve-by-feed-stop エラー:', err);
    res.status(500).json({ error: 'バス停情報の解決に失敗しました。' });
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

// GET /api/busstop/:stopKey/nearby-spots -> 周辺の観光スポット（観光スポット情報_仕様書）
// 全乗り場ページ・乗り場別ページの両方でそのバス停グループの座標を基準に近接検索する。
// クエリ: radius=メートル（既定500） / limit（既定5）
router.get('/busstop/:stopKey/nearby-spots', async (req, res) => {
  try {
    const data = await getStopTimetable(req.params.stopKey, { date: req.query.date });
    if (!data) return res.status(404).json({ error: '指定のバス停が見つかりませんでした。' });

    const radius = Math.min(Math.max(Number.parseFloat(req.query.radius || '500') || 500, 50), 3000);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '5', 10) || 5, 1), 20);

    const spots = await touristSpots.findNearbySpots(data.stop.lat, data.stop.lon, { radiusMeters: radius, limit });
    res.json({ stopKey: data.stop.stopKey, stopName: data.stop.stopName, spots });
  } catch (err) {
    console.error('[api] /busstop/:stopKey/nearby-spots エラー:', err);
    res.status(500).json({ error: '観光スポット情報の取得に失敗しました。' });
  }
});

// GET /api/busstop/:stopKey/notices?platform=... -> そのバス停のお知らせ（docs/busstop-notices.md）
// バス停詳細ページの「このバス停でできること」の下に出す。
//   stopNotices     … scope='stop'（バス停単位）。表示モードによらず常に返す。
//   platformNotices … scope='platform'（乗り場単位）。乗り場が確定しているときだけ返す
//                     （platform 指定、または乗り場が1か所だけのバス停）。統合表示のときは空。
router.get('/busstop/:stopKey/notices', async (req, res) => {
  try {
    const platformParam = typeof req.query.platform === 'string' ? req.query.platform.trim() : '';
    const ref = await resolvePlatformRef(req.params.stopKey, platformParam);
    if (!ref) return res.status(404).json({ error: '指定のバス停が見つかりませんでした。' });

    const stopKeys = [ref.stopKey, ...(ref.aliases || [])];
    const stopNotices = await busstopNotices.getActiveStopNotices(stopKeys);
    const platformNoticeList = ref.platform
      ? await busstopNotices.getActivePlatformNotices(ref.platform.feedId, ref.platform.stopId)
      : [];

    res.json({
      stopKey: ref.stopKey,
      platformKey: ref.platform ? ref.platform.platformKey : null,
      stopNotices,
      platformNotices: platformNoticeList
    });
  } catch (err) {
    console.error('[api] /busstop/:stopKey/notices エラー:', err);
    res.status(500).json({ error: 'バス停お知らせの取得に失敗しました。' });
  }
});

// GET /api/tourist-spots/:id -> 観光スポット1件の詳細
// 経路検索結果でスポット名をタップしたときの詳細ポップアップ表示用（観光スポット情報_仕様書）。
router.get('/tourist-spots/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: '不正なIDです。' });
  try {
    const spot = await touristSpots.getSpotById(id);
    if (!spot) return res.status(404).json({ error: '指定の観光スポットが見つかりませんでした。' });
    res.json({ spot });
  } catch (err) {
    console.error('[api] /tourist-spots/:id エラー:', err);
    res.status(500).json({ error: '観光スポット情報の取得に失敗しました。' });
  }
});

// POST /api/tourist-spots/:id/link-click -> 公式サイトリンクのタップを記録する（観光スポット情報_仕様書）。
// バス停ページ・経路検索ポップアップの「公式サイトを見る」リンクから navigator.sendBeacon で叩く。
// 掲載の有用性を測るだけの用途なので、本文もクライアントIDも取らず、結果に関わらず 200 を返す（soft）。
// 無認証でタップ数を水増しできないようレートリミットを掛けている（S-3）。
router.post('/tourist-spots/:id/link-click', countRateLimit, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: '不正なIDです。' });
  try {
    await touristSpots.recordLinkClick(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /tourist-spots/:id/link-click エラー:', err);
    res.status(500).json({ error: 'タップの記録に失敗しました。' });
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
