/**
 * 管理画面の認証。
 *
 * 担当するのは次の3つで、いずれもDBアクセスを持たない（プロセス内メモリのみ）。
 *   1. 資格情報の突き合わせ（タイミング攻撃に強い定数時間比較）
 *   2. サーバー側セッションの発行・検証・破棄（httpOnly Cookieで受け渡す）
 *   3. Basic認証ヘッダーの解釈（従来経路の互換維持）
 *
 * **なぜセッションを足したか**: 以前は管理画面が`btoa("user:pass")`をlocalStorageへ保存し、
 * 毎リクエストのAuthorizationヘッダーに載せていた。base64は暗号化ではないので、XSSが1件でも
 * あれば資格情報そのものが漏れ、共用端末では次の利用者にも残る
 * （docs/system-review-2026-09.md S-2）。ログイン時だけ資格情報を送り、以後は
 * httpOnly・SameSite=Strict のランダムトークンで認証する方式に変えてある。
 *
 * **Basic認証ヘッダーの経路は残してある。** curl・監視ツール・既存の手順書がこの形式で
 * 叩いている可能性があるため、消すと黙って壊れる。セッションが無ければ従来どおり
 * Authorizationヘッダーで認証できる。
 *
 * **セッションはプロセス内メモリなので、再起動・デプロイで全て失効する**（＝再ログインが要る）。
 * 資格情報をクライアントに残さない以上これは避けられないトレードオフで、管理画面側は
 * 401を受けたらログイン画面へ戻す実装になっている（frontend/admin-core.js）。
 *
 * **ADMIN_PASSWORD未設定時の扱い**: 以前は固定の既定値（'admin123'）にフォールバックしており、
 * 運用者が明示的に設定しない限り誰でも知っている資格情報で管理画面が開いた
 * （docs/system-review-2026-09.md S-1）。管理画面からは運用パラメータの変更・お知らせ配信・
 * GTFS手動再取得ができるため、乗っ取られると利用者に誤情報を配信できてしまう。
 * 未設定のときは起動のたびに変わるランダム値へ差し替え、起動ログに1回だけ出す方式にした
 * （既知の固定パスワードを無くしつつ、`ADMIN_PASSWORD`を設定していない開発環境でも
 * 起動自体は失敗させない）。`ADMIN_PASSWORD`を設定済みの環境は一切影響を受けない。
 */
const crypto = require('crypto');
const security = require('../config/security');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

const configuredAdminPassword = process.env.ADMIN_PASSWORD;
const ADMIN_PASSWORD_AUTO_GENERATED = !configuredAdminPassword;
const ADMIN_PASSWORD = configuredAdminPassword || crypto.randomBytes(18).toString('base64url');

if (ADMIN_PASSWORD_AUTO_GENERATED) {
  // eslint未導入のためconsoleを直接使用。起動ログにしか出さない一度きりの警告。
  console.warn(
    '[adminAuth] ADMIN_PASSWORDが未設定のため、起動時にランダムなパスワードを生成しました。\n' +
    `[adminAuth] 管理画面ログイン → ユーザー名: ${ADMIN_USERNAME} / パスワード: ${ADMIN_PASSWORD}\n` +
    '[adminAuth] このパスワードはプロセスを再起動するたびに変わります。' +
    '固定したい場合は環境変数 ADMIN_PASSWORD を設定してください（本番では必須）。'
  );
}

const SESSION_COOKIE_NAME = 'bt_admin_session';
const SESSION_TTL_MS = security.ADMIN_SESSION_TTL_MIN * 60 * 1000;

// token -> 失効時刻(epoch ms)。スライド更新はしない（絶対有効期限）。
const sessions = new Map();

/**
 * 文字列の定数時間比較。
 * `crypto.timingSafeEqual`は長さが違うと例外を投げ、長さ自体も漏らしてしまうため、
 * 先にSHA-256で固定長へ潰してから比較する（パスワード長の推測を防ぐ定番の手当て）。
 */
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * ユーザー名・パスワードが管理者の資格情報と一致するか。
 * `&&`で短絡させるとユーザー名の一致/不一致が応答時間に出るため、両方を必ず評価する。
 */
function verifyCredentials(username, password) {
  const usernameMatches = safeEqual(username === undefined || username === null ? '' : username, ADMIN_USERNAME);
  const passwordMatches = safeEqual(password === undefined || password === null ? '' : password, ADMIN_PASSWORD);
  return usernameMatches && passwordMatches;
}

/** `Basic xxxx`形式のAuthorizationヘッダーを{username, password}へ分解する（不正なら null）。 */
function parseBasicAuthHeader(authHeader) {
  if (typeof authHeader !== 'string' || !/^Basic\s+/i.test(authHeader)) return null;

  let decoded;
  try {
    decoded = Buffer.from(authHeader.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  } catch (err) {
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return null;

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1)
  };
}

/**
 * 「このリクエストは資格情報（ユーザー名＋パスワード）を提示したか」。
 * 総当たりのカウント対象を絞るために使う。**期限切れのセッションCookieは含めない** ——
 * 含めると、セッションが切れた管理画面のポーリングが自分自身をロックアウトしてしまう。
 */
function hasPresentedCredentials(req) {
  return parseBasicAuthHeader(req.headers.authorization) !== null;
}

function purgeExpiredSessions(now = Date.now()) {
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

function createSession() {
  purgeExpiredSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, expiresAt);
  return { token, expiresAt };
}

/** セッショントークンが有効か（失効していれば掃除もする）。 */
function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const expiresAt = sessions.get(token);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getSessionExpiry(token) {
  return verifySessionToken(token) ? sessions.get(token) : null;
}

function destroySession(token) {
  if (typeof token === 'string') sessions.delete(token);
}

/** Cookieヘッダーを名前→値のオブジェクトへ分解する（cookie-parserを足さずに済ませるための最小実装）。 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return cookies;
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = part.slice(0, separatorIndex).trim();
    if (!name) continue;
    let value = part.slice(separatorIndex + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (err) {
      cookies[name] = value;
    }
  }
  return cookies;
}

function readSessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] || null;
}

/**
 * Secure属性を付けるか。'auto'（既定）はリクエストがHTTPSのとき、またはHTTPS強制時。
 * `req.secure`はリバースプロキシ配下だと`TRUST_PROXY`を設定しないと常にfalseになる点に注意
 * （付かなくてもCookie自体は機能するが、平文HTTPへ漏れる保護が効かない）。
 */
function shouldUseSecureCookie(req) {
  if (security.ADMIN_SESSION_COOKIE_SECURE === 'true') return true;
  if (security.ADMIN_SESSION_COOKIE_SECURE === 'false') return false;
  return Boolean(req && req.secure) || security.FORCE_HTTPS;
}

function buildCookie(value, maxAgeSec, req) {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    // 管理画面は同一オリジンからしか叩かないためStrictで良い。
    // これ自体がCSRF対策にもなる（他サイトからの遷移・埋め込みではCookieが送られない）。
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`
  ];
  if (shouldUseSecureCookie(req)) attributes.push('Secure');
  return attributes.join('; ');
}

function buildSessionCookie(token, req) {
  return buildCookie(token, Math.floor(SESSION_TTL_MS / 1000), req);
}

function buildClearedSessionCookie(req) {
  return buildCookie('', 0, req);
}

/**
 * Cookie認証に対するCSRFの多層防御。
 * SameSite=Strictで大半は防げるが、古いブラウザ・将来SameSiteを緩めた場合の保険として
 * 「Originヘッダーがあるなら自分自身と同じホストであること」を要求する。
 * 同一オリジンのGETにはOriginが付かないため、無い場合は判定材料なしとして素通しする。
 */
function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHostname;
  try {
    originHostname = new URL(origin).hostname;
  } catch (err) {
    return false;
  }
  // req.hostnameはtrust proxy有効時にX-Forwarded-Hostも解決する（ポートは含まない）。
  const selfHostname = req.hostname || String(req.headers.host || '').split(':')[0];
  return Boolean(selfHostname) && originHostname === selfHostname;
}

module.exports = {
  SESSION_COOKIE_NAME,
  ADMIN_PASSWORD_AUTO_GENERATED,
  verifyCredentials,
  parseBasicAuthHeader,
  hasPresentedCredentials,
  createSession,
  verifySessionToken,
  getSessionExpiry,
  destroySession,
  parseCookies,
  readSessionToken,
  buildSessionCookie,
  buildClearedSessionCookie,
  isSameOriginRequest
};
