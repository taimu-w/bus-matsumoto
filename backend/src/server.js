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

const app = express();

// リバースプロキシ配下でクライアントIP（レートリミットの単位）とプロトコル（req.secure＝HSTS・
// Secure Cookieの前提）を正しく判定するための設定。既定はfalse（X-Forwarded-Forを信用しない）。
// 手前にプロキシが無いのに有効化すると、ヘッダー詐称でレートリミットを回避されるため注意。
app.set('trust proxy', security.TRUST_PROXY);
// バージョン込みの`X-Powered-By: Express`を返さない（狙い撃ちの手がかりを減らす）
app.disable('x-powered-by');

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
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, async () => {
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

process.on('SIGINT', () => {
  console.log('\n[server] シャットダウンします。');
  scheduler.stop();
  serviceStatusJob.stop();
  process.exit(0);
});
