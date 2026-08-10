require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const apiRouter = require('./routes/api');
const scheduler = require('./jobs/scheduler');
const serviceStatusJob = require('./jobs/serviceStatusJob');

const app = express();
app.use(cors());
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
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`[server] 横田信大循環線リアルタイム運行管理システム起動: http://localhost:${PORT}`);
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
