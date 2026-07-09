require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const apiRouter = require('./routes/api');
const scheduler = require('./jobs/scheduler');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', apiRouter);

// フロントエンド（静的ファイル）を配信
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`[server] 横田信大循環線リアルタイム運行管理システム起動: http://localhost:${PORT}`);
  scheduler.start();
});

process.on('SIGINT', () => {
  console.log('\n[server] シャットダウンします。');
  scheduler.stop();
  process.exit(0);
});
