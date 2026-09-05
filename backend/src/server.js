require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const apiRouter = require('./routes/api');
const scheduler = require('./jobs/scheduler');
const serviceStatusJob = require('./jobs/serviceStatusJob');
const security = require('./config/security');
const { httpsRedirect, securityHeaders } = require('./middleware/securityHeaders');
const { refreshRuntimeSettingsCache } = require('./services/runtimeSettings');
const { refreshDirectionRulesCache } = require('./services/directionRules');
const { getHealth } = require('./services/healthCheck');
const pool = require('./config/db');

const app = express();

// リバースプロキシ配下でクライアントIP（レートリミットの単位）とプロトコル（req.secure＝HSTS・
// Secure Cookieの前提）を正しく判定するための設定。既定はfalse（X-Forwarded-Forを信用しない）。
// 手前にプロキシが無いのに有効化すると、ヘッダー詐称でレートリミットを回避されるため注意。
app.set('trust proxy', security.TRUST_PROXY);
// バージョン込みの`X-Powered-By: Express`を返さない（狙い撃ちの手がかりを減らす）
app.disable('x-powered-by');

// ヘルスチェック（docs/system-review-2026-09.md D-8）。
// 「DB疎通・直近パイプライン完了・GTFS鮮度」を返す軽量エンドポイント。
// docker-compose / オーケストレータの healthcheck やロードバランサの死活監視から叩く前提で、
// HTTPS強制・セキュリティヘッダー・CORS・レートリミット・閲覧数カウントのいずれの
// ミドルウェアより手前に置く（FORCE_HTTPS=true でも平文の localhost から到達できるように）。
// 正常時は200、DB不通またはパイプラインが詰まっているときは503を返す。
app.get('/healthz', async (req, res) => {
  try {
    const health = await getHealth();
    res.status(health.healthy ? 200 : 503).json(health);
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      healthy: false,
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.use(httpsRedirect);
app.use(securityHeaders);

// CORS: 公開APIにだけ付ける。/api/admin/* にはCORSヘッダーを一切付けないため、
// 別オリジンのページから管理APIのレスポンスを読むことはできない
// （管理画面は同一オリジンから叩くのでCORSを必要としない）。
// CORS_ALLOWED_ORIGINSが未設定なら、従来どおり公開APIは全オリジン許可のまま。
const corsMiddleware = cors(
  security.CORS_ALLOWED_ORIGINS.length > 0 ? { origin: security.CORS_ALLOWED_ORIGINS } : undefined
);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/admin')) return next();
  return corsMiddleware(req, res, next);
});

app.use(express.json());

app.use('/api', apiRouter);

// apiRouter 内のどのルートにも一致しなかった /api/* は、Express既定の
// HTML 404（APIクライアントには扱いづらい）ではなくJSONの404を返す。
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// フロントエンド（静的ファイル）を配信
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin.html'));
});
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin.html'));
});
app.get('/servicestatus', (req, res) => {
  res.sendFile(path.join(frontendDir, 'servicestatus.html'));
});
app.get('/servicestatus.html', (req, res) => {
  res.sendFile(path.join(frontendDir, 'servicestatus.html'));
});
app.get('/howto', (req, res) => {
  res.sendFile(path.join(frontendDir, 'howto.html'));
});
app.get('/howto.html', (req, res) => {
  res.sendFile(path.join(frontendDir, 'howto.html'));
});

// SPAのパスルーティング画面（frontend/*.js の isXxxPath() が受理するパスと同一に保つこと）。
// これ以外の未知パスは、監視・SEO・404計測が機能するよう本物の404を返す
// （以前は '*' が無条件に index.html を200で返しており、存在しないURLも200になっていた）。
const SPA_PATH_EXACT = new Set(['/', '/stopmap', '/spotsearch']);
const SPA_PATH_PREFIXES = ['/timetable', '/busstop', '/routesearch'];
function isKnownSpaPath(pathname) {
  if (SPA_PATH_EXACT.has(pathname)) return true;
  return SPA_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (!isKnownSpaPath(req.path)) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});
app.use((req, res) => {
  res.status(404).send('Not Found');
});

const PORT = parseInt(process.env.PORT || '3000', 10);
// グレースフルシャットダウンの猶予（ミリ秒）。close()/pool.end() がこの時間で
// 返ってこなくても、Dockerの既定SIGKILL（stop後10秒）より前に必ずプロセスを抜ける。
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);
const httpServer = app.listen(PORT, async () => {
  console.log(`[server] 横田信大循環線リアルタイム運行管理システム起動: http://localhost:${PORT}`);
  // セキュリティ設定は環境変数でしか変えられない（管理画面から見えない）ため、
  // 「本番なのにHTTPS強制もCORS制限も入っていない」を起動ログで気づけるようにしておく。
  console.log(
    `[server] セキュリティ設定: trustProxy=${JSON.stringify(security.TRUST_PROXY)} ` +
    `forceHttps=${security.FORCE_HTTPS} ` +
    `cors=${security.CORS_ALLOWED_ORIGINS.length > 0 ? security.CORS_ALLOWED_ORIGINS.join(',') : '全オリジン許可'} ` +
    `csp=${security.CSP_MODE} rateLimit=${security.RATE_LIMIT_ENABLED ? 'ON' : 'OFF'}`
  );

  // 管理画面から上書きされた運用パラメータ（POLL_INTERVAL_SECONDS等、起動時にしか
  // 読まれない設定を含む）をscheduler/serviceStatusJob起動前に読み込んでおく。
  // 失敗しても環境変数/コード既定値で起動を継続する（runtimeSettings.js内でcatchずみ）。
  await refreshRuntimeSettingsCache(true);
  // 方向マッピング（route_direction_rules）もウォームアップしておく（失敗しても全路線ignoreで継続）。
  await refreshDirectionRulesCache(true);

  scheduler.start();
  serviceStatusJob.start();
  // 時刻表検索のインデックスを先に作っておく（初回リクエストを待たせないため）。
  // 失敗してもサーバーは動かし続ける（リクエスト時に再構築される）。
  require('./services/gtfsTimetable')
    .getIndex()
    .catch((err) => console.error('[server] 時刻表インデックスの事前構築に失敗:', err.message));
});

// グレースフルシャットダウン（docs/system-review-2026-09.md D-4）。
// `docker stop` と各種PaaS（Render等）のデプロイは SIGTERM を送る。従来は SIGINT だけを
// 処理し `process.exit(0)` で即座に落としていたため、進行中のパイプライン処理・DBクエリが
// 途中で切れていた。SIGTERM/SIGINT の両方で「タイマー停止 → HTTPサーバーの close()
// （処理中リクエストの完了を待つ）→ pool.end()（進行中クエリの完了を待つ）」の順に待つ。
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} を受信しました。シャットダウンします。`);

  // close()/end() が万一返ってこなくても、SIGKILL より前に必ず抜ける保険。
  const forceExit = setTimeout(() => {
    console.warn('[server] 正常終了がタイムアウトしました。強制終了します。');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // 1. これ以上新しい仕事を積まない（定期タイマーを止める）。
    scheduler.stop();
    serviceStatusJob.stop();

    // 2. HTTPサーバーを閉じる。新規接続を止め、処理中のリクエストの完了を待つ。
    //    20秒ポーリングのクライアントが張っているアイドルなkeep-alive接続は
    //    即座に閉じて、close() が猶予いっぱいまで返らないのを避ける（Node 18.2+）。
    await new Promise((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
      if (typeof httpServer.closeIdleConnections === 'function') {
        httpServer.closeIdleConnections();
      }
    });

    // 3. DB接続プールを閉じる（進行中のクエリの完了を待ってからソケットを閉じる）。
    await pool.end();

    console.log('[server] 正常に終了しました。');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    console.error('[server] シャットダウン中にエラー:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
