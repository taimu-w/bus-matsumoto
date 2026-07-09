require('dotenv').config();
const { Pool } = require('pg');

// DATABASE_URL（Render用）が存在する場合はそれを使い、無ければ個別設定（ローカル用）を使う
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false // Renderの内部ネットワーク接続に必要なSSL設定
      },
      max: 10,
      idleTimeoutMillis: 30000
    }
  : {
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || 'bus_realtime',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      max: 10,
      idleTimeoutMillis: 30000
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[db] 予期しないプールエラー:', err);
});

module.exports = pool;