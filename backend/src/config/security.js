/**
 * セキュリティ関連設定（HTTPS強制・セキュリティヘッダー・CORS・レートリミット・
 * 管理者セッション）の環境変数を1か所で解決するモジュール。
 *
 * **運用パラメータ（config/runtimeSettingsCatalog.js・services/runtimeSettings.js）とは
 * 意図的に分けてあり、管理画面からは編集できません。** レートリミットの上限やセッションの
 * 有効期限を管理画面から変更できると、設定ミスがそのまま管理画面自身へのロックアウト
 * （＝自分で自分を締め出して復旧手段が無い状態）になるためです。変更はデプロイで行います。
 *
 * 既定値はすべて「これまでと同じように動く」側に倒してあります
 * （HTTPS強制OFF・CORSは全オリジン許可・trust proxy無効・CSPは無効）。
 * 本番で締めるべき項目はREADME §8の環境変数一覧を参照してください。
 */

function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

// 0以下・数値でない値は既定値に落とす（「0を指定して無効化」を許す項目は個別に扱う）。
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// レートリミットの上限は「0＝その項目だけ無効化」を許すため、0を通す専用のパーサを使う。
function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Expressの`trust proxy`に渡す値を組み立てる。
 * 未設定なら false（＝X-Forwarded-Forを信用しない）。リバースプロキシが手前に無いのに
 * true にすると、クライアントがX-Forwarded-Forを詐称してレートリミットを回避できるため、
 * 既定は必ず false 側にしておくこと。
 *   - 未設定 / false / 0   … 信用しない（既定）
 *   - 整数                  … 信用するプロキシの段数（例: `TRUST_PROXY=1`）
 *   - true                  … すべて信用する（手前に必ず自前のプロキシがある場合のみ）
 *   - それ以外の文字列      … Expressにそのまま渡す（`loopback`・CIDR・カンマ区切りなど）
 */
function parseTrustProxy(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const value = String(raw).trim();
  const normalized = value.toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  if (['true', 'yes', 'on'].includes(normalized)) return true;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

// カンマ区切りのオリジン一覧。空なら「絞り込みなし（従来どおり全オリジン許可）」。
function parseOriginList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
}

function parseCspMode(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized === 'on' || normalized === 'enforce') return 'on';
  if (normalized === 'report-only' || normalized === 'report') return 'report-only';
  return 'off';
}

module.exports = {
  // ---- HTTPS / セキュリティヘッダー ----
  // リバースプロキシ配下でクライアントIP（レートリミットの単位）とプロトコル（req.secure）を
  // 正しく判定するために必要。未設定だと全利用者が同じIP（プロキシのIP）として数えられる。
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),
  // 平文HTTPで来たリクエストをHTTPSへリダイレクトする（TLS終端がプロキシ側にある前提）。
  FORCE_HTTPS: parseBool(process.env.FORCE_HTTPS, false),
  // Strict-Transport-Securityのmax-age（秒）。既定180日。0でHSTSヘッダー自体を出さない。
  HSTS_MAX_AGE_SEC: parseNonNegativeInt(process.env.HSTS_MAX_AGE_SEC, 15552000),
  // includeSubDomainsは、同じドメインの他サブドメインを巻き込んでHTTPS必須にしてしまうため既定OFF。
  HSTS_INCLUDE_SUBDOMAINS: parseBool(process.env.HSTS_INCLUDE_SUBDOMAINS, false),
  // Content-Security-Policy。既定off（誤検知でフロントが壊れるのを避けるため明示的に有効化する運用）。
  CSP_MODE: parseCspMode(process.env.CSP_MODE),

  // ---- CORS ----
  // 空なら従来どおり全オリジン許可（公開APIのみ。/api/admin/* にはそもそもCORSヘッダーを付けない）。
  CORS_ALLOWED_ORIGINS: parseOriginList(process.env.CORS_ALLOWED_ORIGINS),

  // ---- 管理者セッション ----
  // 絶対有効期限（分）。スライド更新はしないので、この時間で必ず再ログインになる。
  ADMIN_SESSION_TTL_MIN: parsePositiveInt(process.env.ADMIN_SESSION_TTL_MIN, 720),
  // Cookieのsecure属性。'auto'（既定）はリクエストがHTTPSのとき、またはFORCE_HTTPS時に付ける。
  ADMIN_SESSION_COOKIE_SECURE: String(process.env.ADMIN_SESSION_COOKIE_SECURE || 'auto').trim().toLowerCase(),

  // ---- レートリミット ----
  RATE_LIMIT_ENABLED: parseBool(process.env.RATE_LIMIT_ENABLED, true),
  // 管理画面の認証失敗（総当たり対策）。ウィンドウ内でこの回数を超えると429を返す。
  ADMIN_AUTH_MAX_FAILURES: parseNonNegativeInt(process.env.ADMIN_AUTH_MAX_FAILURES, 10),
  ADMIN_AUTH_WINDOW_MIN: parsePositiveInt(process.env.ADMIN_AUTH_WINDOW_MIN, 15),
  // 高コストなRAPTOR探索（/api/route-search）の1IP・1分あたりの上限。0で無効。
  // 攻撃側の連打（毎秒数十〜数百件）は確実に止まり、CGNAT配下の実利用者は届かない水準にしてある。
  ROUTE_SEARCH_RATE_LIMIT_PER_MIN: parseNonNegativeInt(process.env.ROUTE_SEARCH_RATE_LIMIT_PER_MIN, 240),
  // 集計値を増やす系（スポット検索の検索回数・公式サイトリンクのタップ）の1IP・1分あたりの上限。0で無効。
  COUNT_RATE_LIMIT_PER_MIN: parseNonNegativeInt(process.env.COUNT_RATE_LIMIT_PER_MIN, 240),
  // サイト閲覧数（X-Client-Id）を1IPあたり何種類まで数えるか。0で無制限（＝従来どおり）。
  VISITOR_MAX_CLIENTS_PER_IP: parseNonNegativeInt(process.env.VISITOR_MAX_CLIENTS_PER_IP, 200),

  // テスト・他モジュールから使えるように公開しておく
  parseBool,
  parsePositiveInt,
  parseNonNegativeInt,
  parseTrustProxy,
  parseOriginList
};
