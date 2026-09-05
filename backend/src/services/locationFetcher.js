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
const { formatNowNoFormat, formatTimeNoFormat, parseGpsTimeToDate } = require('../utils/time');
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

// GPS時刻が現在時刻より未来でも、これ以内なら受け入れる許容幅（秒）。
// フィード側サーバーとこちらの時計のズレを吸収するためのもので、
// 「フィードが未来の時刻を出している」異常を見逃さない程度に小さく取る。
const FUTURE_TOLERANCE_SEC = 60;

// 路線が一致した行のうち、これ以上の割合が時刻の書式エラーで捨てられたら
// フィードの書式が変わったとみなし、feeds.last_status を 'error' にする。
// 「1件も入らないのに正常と表示される」状態を無くすのが目的なので、
// 一部の行が壊れている程度（既定 50% 未満）では従来どおり 'ok' のままにする。
const INVALID_TIME_FORMAT_ERROR_RATIO = 0.5;

/**
 * 単一の位置情報フィードを取得してvehicle_positions_rawに追記する。
 * 失敗してもthrowせず、feedsテーブルにエラー情報を記録して0件を返す。
 */
async function fetchLocationFeed(client, feed, freshnessMin, nowLabel) {
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

  // GPS時刻の鮮度・未来判定に使う「現在時刻」は、このフィードの本文を読み終えた時点で取る。
  // 全フィード共通の1個のタイムスタンプを使い回すと、フィード取得（各最大30秒）が
  // 進むほど基準時刻が過去にずれ、後続フィードの正常なデータが「未来」判定で捨てられていく。
  const now = new Date();
  const timeLimit = new Date(now.getTime() - freshnessMin * 60 * 1000);
  const futureLimit = new Date(now.getTime() + FUTURE_TOLERANCE_SEC * 1000);

  // 車両IDごとに最新のGPS時刻のものだけを残す
  const latestByCar = new Map();
  let skippedNoRouteMatch = 0;
  let skippedStaleOrInvalidTime = 0; // 下3つの合計（管理画面の既存表示「時刻異常」の値）
  let skippedInvalidTimeFormat = 0;  // 時刻として解釈できなかった
  let skippedStaleTime = 0;          // 鮮度（GPS_FRESHNESS_MIN）より古い
  let skippedFutureTime = 0;         // 現在時刻より未来（許容幅を超える）
  let sampleInvalidTime = null;      // 書式エラーの実例（原因調査用に1件だけ残す）
  let routeMatched = 0;
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

    routeMatched++;
    const carId = row[0].trim();
    const gpsTimeStr = row[1].trim();
    const gpsDate = parseGpsTimeToDate(gpsTimeStr);
    if (gpsDate === null) {
      skippedInvalidTimeFormat++;
      skippedStaleOrInvalidTime++;
      if (sampleInvalidTime === null) sampleInvalidTime = gpsTimeStr.slice(0, 40);
      continue;
    }
    if (gpsDate < timeLimit) {
      skippedStaleTime++;
      skippedStaleOrInvalidTime++;
      continue;
    }
    if (gpsDate > futureLimit) {
      skippedFutureTime++;
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

  // 路線が一致した行の大半が「時刻として解釈できない」なら、フィードの書式が変わったとみなす。
  // 旧実装はこの状況（例: 配信がISO 8601化して全行が捨てられる）でも last_status='ok' のままで、
  // 唯一の痕跡が管理画面の「時刻異常」カウンタだけだった。ここでエラーとして残す。
  const timeFormatError =
    skippedInvalidTimeFormat > 0 &&
    skippedInvalidTimeFormat >= routeMatched * INVALID_TIME_FORMAT_ERROR_RATIO
      ? `GPS時刻の書式を解釈できません（${skippedInvalidTimeFormat}/${routeMatched}行）。例: ${sampleInvalidTime}`
      : null;

  await client.query(
    `UPDATE feeds SET last_fetched_at = now(), last_status = $2, last_error = $3 WHERE id = $1`,
    [feedId, timeFormatError ? 'error' : 'ok', timeFormatError]
  );

  if (timeFormatError) {
    console.error(`[locationFetcher] feed=${feedId} ${timeFormatError}`);
  }
  if (skippedFutureTime > 0) {
    console.warn(
      `[locationFetcher] feed=${feedId} 現在時刻より未来のGPS時刻を ${skippedFutureTime} 件破棄しました` +
      `（許容幅${FUTURE_TOLERANCE_SEC}秒）。フィード側の時刻がずれている可能性があります。`
    );
  }
  if (entries.length === 0) {
    console.log(`[locationFetcher] feed=${feedId} 有効なバスデータがありませんでした。`);
  } else {
    console.log(`[locationFetcher] feed=${feedId} 位置情報を ${inserted} 件追記しました。`);
  }

  return {
    inserted,
    feedId,
    scanned: rows.length,
    routeMatched,
    skippedNoRouteMatch,
    skippedStaleOrInvalidTime,
    skippedInvalidTimeFormat,
    skippedStaleTime,
    skippedFutureTime,
    sampleInvalidTime,
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

  // received_time（受信時刻の表示用ラベル）はこのポーリング全体で1つに揃える。
  // GPS時刻の鮮度・未来判定に使う基準時刻はフィードごとに取り直すため、ここでは作らない
  // （フィード取得が長引くほど基準が古くなり、正常なデータが「未来」判定で捨てられていた）。
  const nowLabel = formatNowNoFormat();

  // 各フィードを独立して処理（1つの失敗が他に影響しない）
  const results = [];
  let totalInserted = 0;
  for (const feed of locationFeeds) {
    const feedClient = await pool.connect();
    try {
      const result = await fetchLocationFeed(feedClient, feed, freshnessMin, nowLabel);
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