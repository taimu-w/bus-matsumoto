// GASの ReNewLocation() に相当。
// 現行システムが利用しているリアルタイム位置情報取得方法・APIをそのまま踏襲する:
//   - LOCATION_FEED_URL からCSVを取得
//   - TARGET_EXTRA_ID を含む行のみ対象とする
//   - 車両IDごとに最新1件（GPS_FRESHNESS_MIN分以内）のみ採用
//   - 位置情報最新ログ(vehicle_positions_raw)に追記する
const fetch = require('cross-fetch');
const pool = require('../config/db');
const { formatNowNoFormat, formatTimeNoFormat } = require('../utils/time');

function parseCsvLine(line) {
  // 単純なCSVパーサ（ダブルクォート囲みに簡易対応）。フィードはシンプルなCSVのため十分。
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function parseCsv(text) {
  return text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim().length > 0)
    .map(parseCsvLine);
}

async function fetchLocation() {
  const url = process.env.LOCATION_FEED_URL;
  const targetExtraId = process.env.TARGET_EXTRA_ID || '';
  const freshnessMin = parseInt(process.env.GPS_FRESHNESS_MIN || '15', 10);

  if (!url) {
    console.error('[locationFetcher] LOCATION_FEED_URL が設定されていません。');
    return { inserted: 0 };
  }

  let response;
  try {
    response = await fetch(url.trim(), { redirect: 'follow' });
  } catch (e) {
    console.error('[locationFetcher] データ取得エラー:', e.message);
    return { inserted: 0 };
  }

  if ([429, 502, 503].includes(response.status) || response.status >= 500) {
    console.warn(`[locationFetcher] サーバー負荷または障害を検知。ステータス: ${response.status}`);
    return { inserted: 0 };
  }
  if (response.status !== 200) {
    console.warn(`[locationFetcher] 予期しないステータスコード: ${response.status}`);
    return { inserted: 0 };
  }

  const text = await response.text();
  const rows = parseCsv(text);
  if (rows.length === 0) {
    console.log('[locationFetcher] 取得データなし');
    return { inserted: 0 };
  }

  const now = new Date();
  const timeLimit = new Date(now.getTime() - freshnessMin * 60 * 1000);
  const nowLabel = formatNowNoFormat();

  // 車両IDごとに最新のGPS時刻のものだけを残す
  const latestByCar = new Map();
  for (const row of rows) {
    if (row.length < 4) continue;
    if (targetExtraId && !row.join(',').includes(targetExtraId)) continue;

    const carId = row[0].trim();
    const gpsTimeStr = row[1].trim();
    const gpsDate = new Date(gpsTimeStr.replace(/-/g, '/') + ' +0900');
    if (Number.isNaN(gpsDate.getTime()) || gpsDate < timeLimit || gpsDate > now) continue;

    const prev = latestByCar.get(carId);
    if (!prev || gpsDate > prev.gpsDate) {
      latestByCar.set(carId, {
        carId,
        gpsDate,
        gpsTimeFormatted: formatTimeNoFormat(gpsDate),
        lat: parseFloat(row[2].trim()),
        lon: parseFloat(row[3].trim())
      });
    }
  }

  const entries = Array.from(latestByCar.values());
  if (entries.length === 0) {
    console.log('[locationFetcher] 有効なバスデータがありませんでした。');
    return { inserted: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      if (Number.isNaN(e.lat) || Number.isNaN(e.lon)) continue;
      await client.query(
        `INSERT INTO vehicle_positions_raw (car_id, received_time, gps_time, gps_time_ts, lat, lon)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.carId, nowLabel, e.gpsTimeFormatted, e.gpsDate.toISOString(), e.lat, e.lon]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`[locationFetcher] 位置情報を ${entries.length} 件追記しました。`);
  return { inserted: entries.length };
}

module.exports = { fetchLocation, parseCsv };
