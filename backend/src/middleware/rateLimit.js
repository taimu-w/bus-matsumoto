/**
 * プロセス内メモリの固定ウィンドウ方式レートリミッタ（docs/system-review-2026-09.md S-3）。
 *
 * `express-rate-limit`を入れずに自前で持っているのは、このリポジトリが依存を最小限に保つ方針
 * （lockfile無し・`npm install`で起動）で、必要なのが「1IPあたり1分あたり何件」という
 * 単純な上限だけだからです。監視系（jobMonitor・apiMetrics・visitorTracker）と同じく
 * 単一プロセス前提のインメモリ実装で、再起動でカウンタは消えます。
 *
 * **注意: 1プロセス前提です。** APIを複数インスタンスへ水平展開する場合（同レビュー X-8）は、
 * Redis等の共有ストアか、リバースプロキシ側のレートリミットへ移してください。
 *
 * **注意: リバースプロキシ配下では`TRUST_PROXY`の設定が必須です。** 未設定だと`req.ip`が
 * プロキシのIPになり、全利用者が1つのキーに集約されてしまいます（＝実質的に全体上限になる）。
 * 逆に、プロキシが手前に無いのに`TRUST_PROXY`を有効にすると、クライアントが
 * X-Forwarded-Forを詐称して上限を回避できます。
 */
const security = require('../config/security');

// キー数の上限。これを超えたら期限切れを掃除し、それでも超えるなら全消去する（fail-open）。
// 攻撃で無数のキーを作られてもメモリが際限なく伸びないようにするための安全弁。
const MAX_KEYS = 50000;

class WindowCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.entries = new Map(); // key -> { count, resetAt }
  }

  /** 1件消費して現在の状態を返す。ウィンドウを跨いでいればリセットしてから数える。 */
  hit(key) {
    const now = Date.now();
    this._enforceCapacity(now);
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + this.windowMs };
      this.entries.set(key, fresh);
      return fresh;
    }
    entry.count += 1;
    return entry;
  }

  /** 消費せずに現在の状態を返す（有効なウィンドウが無ければ null）。 */
  peek(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= Date.now()) return null;
    return entry;
  }

  reset(key) {
    this.entries.delete(key);
  }

  _enforceCapacity(now) {
    if (this.entries.size < MAX_KEYS) return;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    if (this.entries.size >= MAX_KEYS) {
      console.warn(`[rateLimit] 追跡キーが上限(${MAX_KEYS})に達したためカウンタを初期化します。`);
      this.entries.clear();
    }
  }
}

/**
 * レートリミットの単位になるクライアント識別子。
 * IPv4射影のIPv6表記（`::ffff:1.2.3.4`）は素のIPv4へ寄せて、同じクライアントが
 * 2つのキーに割れないようにする。
 */
function getClientKey(req) {
  const raw = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  return String(raw).replace(/^::ffff:/, '');
}

/**
 * レートリミットのミドルウェアを作る。
 * `max`が0、または`RATE_LIMIT_ENABLED=false`のときは素通しのミドルウェアを返す
 * （呼び出し側で分岐を書かなくて済むように）。
 */
function createRateLimiter({ windowMs, max, message, scope }) {
  if (!security.RATE_LIMIT_ENABLED || !max || max <= 0) {
    return function rateLimitDisabled(req, res, next) { next(); };
  }

  const counter = new WindowCounter(windowMs);

  return function rateLimit(req, res, next) {
    const key = getClientKey(req);
    const { count, resetAt } = counter.hit(key);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));

    if (count <= max) return next();

    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    // 上限を超えた瞬間だけログに出す（超過中の全リクエストを出すとログが溢れるため）。
    if (count === max + 1) {
      console.warn(`[rateLimit] ${scope}: ${key} が上限(${max}件/${Math.round(windowMs / 1000)}秒)を超えました。`);
    }
    return res.status(429).json({ error: message, retryAfterSeconds });
  };
}

// ---- 管理画面の認証失敗（総当たり対策）----
// 通常のレートリミッタと違い「失敗したときだけ」数える。管理画面は15〜30秒間隔で
// ポーリングするため、成功リクエストまで数えるとすぐ上限に達してしまう。
const adminAuthFailures = new WindowCounter(security.ADMIN_AUTH_WINDOW_MIN * 60 * 1000);
const adminAuthLimitEnabled = security.RATE_LIMIT_ENABLED && security.ADMIN_AUTH_MAX_FAILURES > 0;

/** 認証失敗が続いてブロック中なら`{ retryAfterSeconds }`、そうでなければ null。 */
function getAdminAuthBlock(req) {
  if (!adminAuthLimitEnabled) return null;
  const entry = adminAuthFailures.peek(getClientKey(req));
  if (!entry || entry.count < security.ADMIN_AUTH_MAX_FAILURES) return null;
  return { retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)) };
}

function recordAdminAuthFailure(req) {
  if (!adminAuthLimitEnabled) return;
  const key = getClientKey(req);
  const { count } = adminAuthFailures.hit(key);
  if (count === security.ADMIN_AUTH_MAX_FAILURES) {
    console.warn(
      `[rateLimit] 管理画面の認証失敗が${count}回に達したため ${key} を` +
      `${security.ADMIN_AUTH_WINDOW_MIN}分間ブロックします。`
    );
  }
}

/** 認証に成功したらカウンタを解除する（正規の管理者がタイプミスで締め出されないように）。 */
function clearAdminAuthFailures(req) {
  if (!adminAuthLimitEnabled) return;
  adminAuthFailures.reset(getClientKey(req));
}

module.exports = {
  createRateLimiter,
  getClientKey,
  getAdminAuthBlock,
  recordAdminAuthFailure,
  clearAdminAuthFailures,
  WindowCounter
};
