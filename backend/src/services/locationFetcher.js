// GASの ReNewLocation() に相当。
// 複数の位置情報CSVフィード（事業者ごと）をすべて取得し、それぞれのバス位置情報を
// vehicle_positions_raw に追記する。
// 各フィードは独立したtry/catchで処理され、1つの事業者の取得失敗が他に影響しない。
// 位置情報フィードの一覧とGTFSフィードとの対応は config/feeds.js（コード）が唯一の情報源。
// 外部ID→route_idの対応は route_external_ids（DB）を services/routeExternalIdMapping.js が
// TTLキャッシュ付きで読む。管理画面から編集した際はキャッシュを即時破棄するため、
// 反映まで最大60秒（次回ポーリング）で済む。
// （旧: feed_mappings テーブルによるconfidence推測は廃止。route_external_idsは
//   一時期コード管理化したが、厳格な検証を維持したままDB管理・管理画面編集に戻した）
const fetch = require('cross-fetch');
const pool = require('../config/db');
const { formatNowNoFormat, formatTimeNoFormat } = require('../utils/time');
const { resolveDirectionId } = require('./directionRules');
const { getEnabledLocationFeeds, getGtfsFeedIdsFor } = require('../config/feeds');
const { getExternalIdsForFeeds } = require('./routeExternalIdMapping');
const { getRuntimeSetting } = require('./runtimeSettings');

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

/**
 * 単一の位置情報フィードを取得してvehicle_positions_rawに追記する。
 * 失敗してもthrowせず、feedsテーブルにエラー情報を記録して0件を返す。
 */
async function fetchLocationFeed(client, feed, freshnessMin, now, timeLimit, nowLabel) {
  const feedId = feed.id;
  const url = feed.url;

  // この位置情報フィードに対応するGTFSフィード（複数可）の外部IDだけに絞り込む。
  // 旧実装は feed_mappings から confidence 降順で**1件だけ**選んでいたため、
  // 同値の場合に採用フィードが不定になり、またがる事業者の片方が落ちていた。
  // 対応が未設定（空配列）の場合、getExternalIdsForFeeds は絞り込まず全件を返す。
  const effectiveExternalIdMap = await getExternalIdsForFeeds(getGtfsFeedIdsFor(feedId));

  let response;
  try {
    response = await fetch(url.trim(), { redirect: 'follow', timeout: 30000 });
  } catch (e) {
    const msg = `データ取得エラー: ${e.message}`;
    console.error(`[locationFetcher] feed=${feedId} ${msg}`);
    await client.query(
      `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
      [feedId, msg]
    );
    return { inserted: 0, feedId };
  }

  if ([429, 502, 503].includes(response.status) || response.status >= 500) {
    const msg = `サーバー負荷または障害を検知。ステータス: ${response.status}`;
    console.warn(`[locationFetcher] feed=${feedId} ${msg}`);
    await client.query(
      `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
      [feedId, msg]
    );
    return { inserted: 0, feedId };
  }
  if (response.status !== 200) {
    const msg = `予期しないステータスコード: ${response.status}`;
    console.warn(`[locationFetcher] feed=${feedId} ${msg}`);
    await client.query(
      `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
      [feedId, msg]
    );
    return { inserted: 0, feedId };
  }

  let text;
  try {
    text = await response.text();
  } catch (e) {
    const msg = `レスポンス読み取りエラー: ${e.message}`;
    console.error(`[locationFetcher] feed=${feedId} ${msg}`);
    await client.query(
      `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
      [feedId, msg]
    );
    return { inserted: 0, feedId };
  }

  let rows;
  try {
    rows = parseCsv(text);
  } catch (e) {
    const msg = `CSV形式異常: ${e.message}`;
    console.error(`[locationFetcher] feed=${feedId} ${msg}`);
    await client.query(
      `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
      [feedId, msg]
    );
    return { inserted: 0, feedId };
  }

  if (rows.length === 0) {
    const msg = '取得データなし';
    console.log(`[locationFetcher] feed=${feedId} ${msg}`);
    await client.query(
      `UPDATE feeds SET last_fetched_at = now(), last_status = 'ok', last_error = NULL WHERE id = $1`,
      [feedId]
    );
    return { inserted: 0, feedId };
  }

  // 車両IDごとに最新のGPS時刻のものだけを残す
  const latestByCar = new Map();
  let skippedNoRouteMatch = 0;
  let skippedStaleOrInvalidTime = 0;
  let skippedInvalidLatLon = 0;
  for (const row of rows) {
    if (row.length < 4) continue;
    const joined = row.join(',');
    let matchedRouteId = null;
    for (const [externalId, routeId] of effectiveExternalIdMap.entries()) {
      if (joined.includes(externalId)) {
        matchedRouteId = routeId;
        break;
      }
    }
    if (!matchedRouteId) {
      skippedNoRouteMatch++;
      continue;
    }

    const carId = row[0].trim();
    const gpsTimeStr = row[1].trim();
    const gpsDate = new Date(gpsTimeStr.replace(/-/g, '/') + ' +0900');
    if (Number.isNaN(gpsDate.getTime()) || gpsDate < timeLimit || gpsDate > now) {
      skippedStaleOrInvalidTime++;
      continue;
    }

    // 方向列（5列目 / row[4]）を読み取り、路線別の方向マッピング（route_direction_rules。
    // 管理画面「方向マッピング」で編集）で direction_id に変換する。
    // 方向を使わない路線（既定）・値が空の場合は null（方向不明）になり、便判定では方向で絞り込まない。
    const directionCsvValue = row[4] ? row[4].trim() : '';
    const directionId = resolveDirectionId(matchedRouteId, directionCsvValue);

    const prev = latestByCar.get(carId);
    if (!prev || gpsDate > prev.gpsDate) {
      latestByCar.set(carId, {
        carId,
        routeId: matchedRouteId,
        directionId,
        directionRaw: directionCsvValue,
        gpsDate,
        gpsTimeFormatted: formatTimeNoFormat(gpsDate),
        lat: parseFloat(row[2].trim()),
        lon: parseFloat(row[3].trim())
      });
    }
  }

  const entries = Array.from(latestByCar.values());
  if (entries.length === 0) {
    console.log(`[locationFetcher] feed=${feedId} 有効なバスデータがありませんでした。`);
    await client.query(
      `UPDATE feeds SET last_fetched_at = now(), last_status = 'ok', last_error = NULL WHERE id = $1`,
      [feedId]
    );
    return {
      inserted: 0,
      feedId,
      scanned: rows.length,
      skippedNoRouteMatch,
      skippedStaleOrInvalidTime,
      skippedInvalidLatLon
    };
  }

  let inserted = 0;
  for (const e of entries) {
    if (Number.isNaN(e.lat) || Number.isNaN(e.lon)) {
      skippedInvalidLatLon++;
      continue;
    }
    await client.query(
      `INSERT INTO vehicle_positions_raw (route_id, direction_id, direction_raw, car_id, received_time, gps_time, gps_time_ts, lat, lon, feed_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.routeId || '',
        e.directionId,
        e.directionRaw || null,
        e.carId,
        nowLabel,
        e.gpsTimeFormatted,
        e.gpsDate.toISOString(),
        e.lat,
        e.lon,
        feedId
      ]
    );
    inserted++;
  }

  await client.query(
    `UPDATE feeds SET last_fetched_at = now(), last_status = 'ok', last_error = NULL WHERE id = $1`,
    [feedId]
  );

  console.log(`[locationFetcher] feed=${feedId} 位置情報を ${inserted} 件追記しました。`);
  return {
    inserted,
    feedId,
    scanned: rows.length,
    skippedNoRouteMatch,
    skippedStaleOrInvalidTime,
    skippedInvalidLatLon
  };
}

async function fetchLocation() {
  const freshnessMin = getRuntimeSetting('GPS_FRESHNESS_MIN');

  // フィード一覧はコード上の設定（config/feeds.js）から取得する。
  const locationFeeds = getEnabledLocationFeeds();

  if (locationFeeds.length === 0) {
    console.error('[locationFetcher] 有効な位置情報フィードが設定されていません。');
    return { inserted: 0, feeds: [] };
  }

  const now = new Date();
  const timeLimit = new Date(now.getTime() - freshnessMin * 60 * 1000);
  const nowLabel = formatNowNoFormat();

  // 各フィードを独立して処理（1つの失敗が他に影響しない）
  const results = [];
  let totalInserted = 0;
  for (const feed of locationFeeds) {
    const feedClient = await pool.connect();
    try {
      const result = await fetchLocationFeed(
        feedClient,
        feed,
        freshnessMin,
        now,
        timeLimit,
        nowLabel
      );
      results.push(result);
      totalInserted += result.inserted;
    } catch (err) {
      // 予期しないエラーでも他フィードに影響させない
      console.error(`[locationFetcher] feed=${feed.id} 処理エラー:`, err.message);
      try {
        await feedClient.query(
          `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
          [feed.id, `処理エラー: ${err.message}`]
        );
      } catch (dbErr) {
        console.error(`[locationFetcher] feedsテーブル更新エラー: ${dbErr.message}`);
      }
      results.push({ inserted: 0, feedId: feed.id, error: err.message });
    } finally {
      feedClient.release();
    }
  }

  console.log(`[locationFetcher] 全フィード合計: ${totalInserted} 件追記しました。`);
  return { inserted: totalInserted, feeds: results };
}

module.exports = { fetchLocation, parseCsv };