const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { getGtfsDir, getEnabledGtfsFeeds, qualifyRouteId, unqualifyRouteId, ensureGtfsFilesPresent } = require('../services/gtfsFeedManager');
const { readFrequenciesByTripId } = require('../services/gtfsFrequencies');

const GTFS_DIR = getGtfsDir(null);
const DEFAULT_ROUTE_EXTERNAL_ID_MAPPINGS = [
  { externalId: '01h9j04qf5pfg6za7eg0c4wqea', routeName: '信大横田循環線' },
  { externalId: '01h9j06f82mw3wvnddsbs4z7fs', routeName: '横田信大循環線' },
  { externalId: '01h9j07mcq8yvmvcepyyetchhh', routeName: '浅間線' },
  { externalId: '01h9j099yhcqm8h414kwmenm5p', routeName: '新浅間線' },
  { externalId: '01h9j0aq0jnyqd6bnce5tdshsx', routeName: '美ケ原温泉線' },
  { externalId: '01h9j0bk8t8qxpk23m4bqmeaqf', routeName: '北市内線' },
  { externalId: '01h9j0cgk3qvw6t8j9z5kp50bg', routeName: '岡田線' },
  { externalId: '01h9j0dfrkbgq5srqsstmb87zr', routeName: 'アルプス公園線' },
  { externalId: '01h9j0eaxbqfgeapy0wcyff5cg', routeName: '鹿教湯温泉線' },
  { externalId: '01h9j0f842rq9nvmc1f0hr615a', routeName: '空港今井線' },
  { externalId: '01h9j0g3wfs5j4jnfm0w3q0mq9', routeName: '大久保工場団地線・神林線' },
  { externalId: '01h9pfrv7rm8dwfb97y4nptdxv', routeName: '大久保工場団地線・神林線' },
  { externalId: '01h9j0h2f2zey9px0ek9brh1m6', routeName: '山形線' },
  { externalId: '01h9j0hym391fkbt20ffchkame', routeName: '寿台線' },
  { externalId: '01h9j0jyc4x4nrc0y859nxpkhy', routeName: '松原線' },
  { externalId: '01h9j0kxkm4x90ffdxsk0mbznh', routeName: '内田線' },
  { externalId: '01gtk2gfphyzgzm7mb0pwn8eqp', routeName: '並柳団地線' },
  { externalId: '01ha922g5tvbnnkmmcvna9524w', routeName: '並柳団地線' },
  { externalId: '01h9j0msfjw147rc5ky4thtrt7', routeName: '四賀線' },
  { externalId: '01fsp3daby2y055rwgx9w1nk5j', routeName: 'TS北コース' },
  { externalId: '01fsp3dym3e1mhg5wpze8ykbmn', routeName: 'TS東コース' },
  { externalId: '01fsp3ee248pz8pgmaq32x639a', routeName: 'TS南コース' },
  { externalId: '01gtx3caern3gv4z2rhkzba9f4', routeName: '合庁ライナー' },
  { externalId: '01ft4y663269mwmtjft8bb2gc6', routeName: '南部循環線' },
  { externalId: '01kkdhrxy2vtnqs4dzedzdkf2e', routeName: '第一高校スクール' },
  { externalId: '01hcv1n381vs9r0j6d297xepg2', routeName: '松本・島内線' },
  { externalId: '01hdj79wsrrz2n9ee0vq01e6k2', routeName: '松本・島内線' },
  { externalId: '01hcv1ny46af2pagpysazrbrz7', routeName: '南松本・山形線' },
  { externalId: '01hcv1p87398b578fghsmy2wjh', routeName: '梓川・波田線' },
  { externalId: '01hcv1pnxzz3s3zc9hxpgm3h4n', routeName: '村井・山形線' },
  { externalId: '01hcv1q1zs8av0kszg6a74rtnp', routeName: '朝日・波田線' },
  { externalId: '01hcv1qc4k73nr6hav35kaz57q', routeName: '南松本・平田線' },
  { externalId: '01hcv1qnjyrb99ph8m0zb1hpra', routeName: '平田・村井線' },
  { externalId: '01hd0f04bm9e9x0hf196k5e3r2', routeName: '四賀循環線' },
  { externalId: '01hd0f0m9bdf4xatjaknthjjjb', routeName: '四賀循環線' },
  { externalId: '01hd0f12fbb55tmydz5n9cs79k', routeName: '四賀循環線' },
  { externalId: '01hd0f1fzc3903rx7ncp0jrevq', routeName: '四賀循環線' },
  { externalId: '01hd0f1s4vkm0qm6061mvq79fm', routeName: '奈川・安曇線' },
];

// フィード初期設定（feedsテーブルに投入するデフォルト値）
const DEFAULT_FEEDS = [
  // GTFSフィード
  { id: 'guruttomatsumotobus1', feedType: 'gtfs', name: 'ぐるっと松本バス1', url: 'https://api.gtfs-data.jp/v2/organizations/matsumotocity/feeds/guruttomatsumotobus1/files/feed.zip?rid=current' },
  { id: 'guruttomatsumotobus2', feedType: 'gtfs', name: 'ぐるっと松本バス2', url: 'https://api.gtfs-data.jp/v2/organizations/matsumotocity/feeds/guruttomatsumotobus2/files/feed.zip?rid=current' },
  // 位置情報フィード
  { id: 'matsumotoshicombus', feedType: 'location', name: '松本市民バス', url: 'https://dashboard.wakoticket.net/information/matsumotoshicombus/latlon.csv' },
  { id: 'alpicokotsu', feedType: 'location', name: 'アルピコ交通', url: 'https://dashboard.wakoticket.net/information/alpicokotsu/latlon.csv' },
  { id: 'matsumotoshiei', feedType: 'location', name: '松本市営', url: 'https://dashboard.wakoticket.net/information/matsumotoshiei/latlon.csv' }
];

// 位置情報フィード⇔GTFSフィードの初期対応関係（推測値）
// 実際の対応は管理画面や自動推測で更新可能。コードにハードコードせずDBで管理する。
const DEFAULT_FEED_MAPPINGS = [
  { locationFeedId: 'matsumotoshicombus', gtfsFeedId: 'guruttomatsumotobus2', confidence: 0.5 },
  { locationFeedId: 'alpicokotsu', gtfsFeedId: 'guruttomatsumotobus1', confidence: 0.5 },
  { locationFeedId: 'matsumotoshiei', gtfsFeedId: 'guruttomatsumotobus1', confidence: 0.3 }
];

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function readCsv(fileName, feedId) {
  const filePath = path.join(getGtfsDir(feedId), fileName);
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (rows.length === 0) return [];

  const headers = parseCsvLine(rows[0]);
  return rows.slice(1).map((row) => {
    const values = parseCsvLine(row);
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });
    return record;
  });
}

function toClockTime(value) {
  if (!value) return null;
  const parts = String(value).split(':');
  if (parts.length < 2) return null;
  const hour = Number.parseInt(parts[0], 10);
  const minute = Number.parseInt(parts[1], 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * feedsテーブルにデフォルトフィードを投入する。
 */
async function seedFeeds(client) {
  for (const feed of DEFAULT_FEEDS) {
    await client.query(
      `INSERT INTO feeds (id, feed_type, name, url, enabled)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (id) DO UPDATE
         SET feed_type = EXCLUDED.feed_type,
             name = EXCLUDED.name,
             url = EXCLUDED.url`,
      [feed.id, feed.feedType, feed.name, feed.url]
    );
  }
  console.log(`[seed] フィード設定 ${DEFAULT_FEEDS.length} 件を登録しました。`);
}

/**
 * feed_mappingsテーブルにデフォルトの対応関係を投入する。
 */
async function seedFeedMappings(client) {
  for (const mapping of DEFAULT_FEED_MAPPINGS) {
    await client.query(
      `INSERT INTO feed_mappings (location_feed_id, gtfs_feed_id, confidence)
       VALUES ($1, $2, $3)
       ON CONFLICT (location_feed_id, gtfs_feed_id) DO NOTHING`,
      [mapping.locationFeedId, mapping.gtfsFeedId, mapping.confidence]
    );
  }
  console.log(`[seed] フィード対応関係 ${DEFAULT_FEED_MAPPINGS.length} 件を登録しました。`);
}

/**
 * 指定フィードのroutes.txtを読み込んでroutesテーブルに登録する。
 * route_idは「feedId:routeId」形式でグローバル一意にする。
 */
async function seedRoutes(client, feedId) {
  const routeRows = readCsv('routes.txt', feedId);
  const targetRouteNames = new Map();

  for (const row of routeRows) {
    const qualifiedRouteId = qualifyRouteId(row.route_id, feedId);
    const routeName = row.route_long_name || row.route_short_name || row.route_id;
    targetRouteNames.set(qualifiedRouteId, routeName);

    await client.query(
      `INSERT INTO routes (id, name, short_name, color, text_color, feed_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             short_name = EXCLUDED.short_name,
             color = EXCLUDED.color,
             text_color = EXCLUDED.text_color,
             feed_id = EXCLUDED.feed_id`,
      [qualifiedRouteId, routeName, row.route_short_name || '', row.route_color || '', row.route_text_color || '', feedId]
    );
  }

  console.log(`[seed] feed=${feedId} 路線 ${routeRows.length} 件を登録しました。`);
  return targetRouteNames;
}

/**
 * 静的GTFS（フィード未設定）のroutes.txtを読み込んでroutesテーブルに登録する。
 */
async function seedRoutesStatic(client) {
  const routeRows = readCsv('routes.txt', null);
  const targetRouteNames = new Map();

  for (const row of routeRows) {
    const routeName = row.route_long_name || row.route_short_name || row.route_id;
    targetRouteNames.set(row.route_id, routeName);

    await client.query(
      `INSERT INTO routes (id, name, short_name, color, text_color, feed_id)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             short_name = EXCLUDED.short_name,
             color = EXCLUDED.color,
             text_color = EXCLUDED.text_color,
             feed_id = NULL`,
      [row.route_id, routeName, row.route_short_name || '', row.route_color || '', row.route_text_color || '']
    );
  }

  console.log(`[seed] 静的GTFS 路線 ${routeRows.length} 件を登録しました。`);
  return targetRouteNames;
}

/**
 * 外部ID⇔route_idの対応表に、初期値（DEFAULT_ROUTE_EXTERNAL_ID_MAPPINGS）を投入する。
 *
 * この対応表は管理画面（PUT /api/admin/route-mappings）からも編集される。
 * ここで投入するのはあくまで「初期値」なので、**既にDBにある割り当ては上書きしない**。
 * 管理画面で既定と違う路線に付け替えた設定が、コンテナ再起動のたびに巻き戻ることを防ぐ。
 *
 * ⚠️ ON CONFLICT の対象は必ず (external_id) にすること。
 * route_external_ids には PRIMARY KEY (route_id, external_id) とは別に UNIQUE (external_id) があり、
 * 対象を (route_id, external_id) にすると「同じexternal_idが別のroute_idに割り当て済み」のケースを
 * 拾えず、UNIQUE(external_id) 違反でseedごと落ちる（＝コンテナが起動不能になる）。
 */
async function seedRouteExternalIds(client) {
  const routeRows = await client.query(`SELECT id, name, feed_id FROM routes ORDER BY id ASC`);
  const routeIdByName = new Map(routeRows.rows.map((row) => [row.name, row.id]));
  const routeFeedByName = new Map(routeRows.rows.map((row) => [row.name, row.feed_id]));

  // 既存の割り当てを先に読み、既定と食い違う場合に警告を出せるようにする
  const existingRows = await client.query(`SELECT external_id, route_id FROM route_external_ids`);
  const existingByExternalId = new Map(existingRows.rows.map((row) => [row.external_id, row.route_id]));

  let inserted = 0;
  let kept = 0;
  const seenExternalIds = new Set();

  for (const mapping of DEFAULT_ROUTE_EXTERNAL_ID_MAPPINGS) {
    const routeId = routeIdByName.get(mapping.routeName);
    if (!routeId) continue;
    // 同じ初期値リスト内に同じexternal_idが複数あっても1件だけ扱う
    if (seenExternalIds.has(mapping.externalId)) continue;
    seenExternalIds.add(mapping.externalId);
    const feedId = routeFeedByName.get(mapping.routeName) || null;

    const existingRouteId = existingByExternalId.get(mapping.externalId);
    if (existingRouteId !== undefined) {
      if (existingRouteId !== routeId) {
        console.log(
          `[seed] 外部ID ${mapping.externalId} はDB上で ${existingRouteId} に割り当て済みのため、` +
          `初期値（${mapping.routeName} = ${routeId}）を適用せず現在の設定を維持します。`
        );
      }
      kept++;
      continue;
    }

    const result = await client.query(
      `INSERT INTO route_external_ids (route_id, external_id, feed_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (external_id) DO NOTHING`,
      [routeId, mapping.externalId, feedId]
    );
    if (result.rowCount > 0) inserted++;
    else kept++;
  }

  console.log(
    `[seed] 外部IDマッピングを ${inserted} 件登録しました` +
    (kept > 0 ? `（既存の設定 ${kept} 件はそのまま維持）` : '') + '。'
  );
}

/**
 * 指定フィードの停留所・時刻表を登録する。
 */
async function seedStopsAndTimetable(client, routesById, feedId) {
  const stopRows = readCsv('stops.txt', feedId);
  const stopMetaById = new Map(
    stopRows.map((row) => [row.stop_id, row])
  );

  const trips = readCsv('trips.txt', feedId);
  const tripsByRouteDirectionService = new Map();
  for (const trip of trips) {
    const directionId = Number.parseInt(trip.direction_id || '0', 10);
    // service_idにフィードIDプレフィックスを付ける（全フィードで一意にするため）
    const qualifiedServiceId = feedId ? `${feedId}:${trip.service_id}` : trip.service_id;
    const key = `${trip.route_id}_${directionId}_${qualifiedServiceId}`;
    if (!tripsByRouteDirectionService.has(key)) tripsByRouteDirectionService.set(key, []);
    tripsByRouteDirectionService.get(key).push({ ...trip, directionId, service_id: qualifiedServiceId });
  }

  const stopTimes = readCsv('stop_times.txt', feedId);
  const stopTimesByTrip = new Map();
  for (const row of stopTimes) {
    if (!stopTimesByTrip.has(row.trip_id)) stopTimesByTrip.set(row.trip_id, []);
    stopTimesByTrip.get(row.trip_id).push(row);
  }

  // frequencies.txt は任意ファイル。無いフィードでは空のMapが返り、以降の処理は
  // 従来どおり個別便だけを登録する（挙動の変化なし）。
  const frequenciesByTripId = readFrequenciesByTripId(feedId, readCsv);

  let totalStops = 0;
  let totalTrips = 0;
  let totalFrequencies = 0;

  for (const [routeId, routeName] of routesById.entries()) {
    // routeIdからfeedIdプレフィックスを除去して元のroute_idを取得
    const originalRouteId = unqualifyRouteId(routeId, feedId);
    // この路線の全方向・全service_idの便を取得
    const directionServiceTrips = [];
    for (const [key, trips] of tripsByRouteDirectionService.entries()) {
      if (key.startsWith(`${originalRouteId}_`)) {
        const parts = key.split('_');
        const directionId = Number.parseInt(parts[1], 10);
        const serviceId = parts.slice(2).join('_'); // service_idに"_"が含まれる可能性があるため
        directionServiceTrips.push({ directionId, serviceId, trips });
      }
    }

    if (directionServiceTrips.length === 0) continue;

    for (const { directionId, serviceId, trips: routeTrips } of directionServiceTrips) {
      if (routeTrips.length === 0) continue;

      const routeStopIds = new Map();
      const stopSeqByRouteStop = new Map();

      for (const trip of routeTrips) {
        const tripStopRows = (stopTimesByTrip.get(trip.trip_id) || [])
          .sort((a, b) => Number.parseInt(a.stop_sequence, 10) - Number.parseInt(b.stop_sequence, 10));

        for (const row of tripStopRows) {
          const stopMeta = stopMetaById.get(row.stop_id);
          if (!stopMeta) continue;
          const seq = Number.parseInt(row.stop_sequence, 10);
          if (Number.isNaN(seq)) continue;

          const key = `${row.stop_id}`;
          if (!stopSeqByRouteStop.has(key) || seq < stopSeqByRouteStop.get(key)) {
            stopSeqByRouteStop.set(key, seq);
          }
          routeStopIds.set(key, row.stop_id);
        }
      }

      const stopRecords = Array.from(routeStopIds.values()).sort((a, b) => {
        const aSeq = stopSeqByRouteStop.get(a) ?? Number.MAX_SAFE_INTEGER;
        const bSeq = stopSeqByRouteStop.get(b) ?? Number.MAX_SAFE_INTEGER;
        return aSeq - bSeq;
      });

      for (const stopId of stopRecords) {
        const meta = stopMetaById.get(stopId);
        if (!meta) continue;
        const seq = stopSeqByRouteStop.get(stopId) ?? 0;
        await client.query(
          `INSERT INTO stops (route_id, direction_id, seq_order, name, name_kana, name_en, lat, lon, notice, timetable_link)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (route_id, direction_id, seq_order) DO UPDATE
             SET name = EXCLUDED.name,
                 name_kana = EXCLUDED.name_kana,
                 name_en = EXCLUDED.name_en,
                 lat = EXCLUDED.lat,
                 lon = EXCLUDED.lon,
                 notice = EXCLUDED.notice,
                 timetable_link = EXCLUDED.timetable_link`,
          [routeId, directionId, seq - 1, meta.stop_name, '', '', parseFloat(meta.stop_lat), parseFloat(meta.stop_lon), '', '']
        );
        totalStops++;
      }

      const routeTripIds = [];
      for (const [tripIndex, trip] of routeTrips.entries()) {
        const firstStop = (stopTimesByTrip.get(trip.trip_id) || [])
          .slice()
          .sort((a, b) => Number.parseInt(a.stop_sequence, 10) - Number.parseInt(b.stop_sequence, 10))[0];
        // 仕様書 4.3 の始発時刻の定義（departure_time優先、片方のみなら記載のある方）は
        // この `departure_time || arrival_time` が既に満たしている。
        const firstStopTime = firstStop ? toClockTime(firstStop.departure_time || firstStop.arrival_time) : null;
        const headsign = trip.trip_headsign || null;
        const tripInsert = await client.query(
          `INSERT INTO schedule_trips (route_id, direction_id, service_id, trip_index, gtfs_trip_id, first_stop_time, headsign)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (route_id, direction_id, service_id, trip_index) DO UPDATE
             SET gtfs_trip_id = EXCLUDED.gtfs_trip_id,
                 first_stop_time = EXCLUDED.first_stop_time,
                 headsign = EXCLUDED.headsign
           RETURNING id`,
          [routeId, directionId, serviceId, tripIndex, trip.trip_id, firstStopTime, headsign]
        );
        routeTripIds.push(tripInsert.rows[0].id);
        totalTrips++;

        // frequencies.txt（任意ファイル）に定義があれば取り込む。
        // 当日便生成時に仮想便へ展開される（仕様書 3.4）。
        const frequencyRows = frequenciesByTripId.get(trip.trip_id) || [];
        if (frequencyRows.length > 0) {
          await client.query(`DELETE FROM schedule_trip_frequencies WHERE trip_id = $1`, [
            tripInsert.rows[0].id
          ]);
          for (const freq of frequencyRows) {
            await client.query(
              `INSERT INTO schedule_trip_frequencies (trip_id, start_time, end_time, headway_secs, exact_times)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (trip_id, start_time) DO UPDATE
                 SET end_time = EXCLUDED.end_time,
                     headway_secs = EXCLUDED.headway_secs,
                     exact_times = EXCLUDED.exact_times`,
              [tripInsert.rows[0].id, freq.start_time, freq.end_time, freq.headway_secs, freq.exact_times]
            );
            totalFrequencies++;
          }
        }
      }

      for (const [tripIndex, trip] of routeTrips.entries()) {
        const tripStopRows = (stopTimesByTrip.get(trip.trip_id) || [])
          .slice()
          .sort((a, b) => Number.parseInt(a.stop_sequence, 10) - Number.parseInt(b.stop_sequence, 10));

        // この便の全停車駅の最小・最大シーケンス番号を求める（始発・終点の通過誤判定防止）
        const allSeqs = tripStopRows.map(row => Number.parseInt(row.stop_sequence, 10)).filter(n => !Number.isNaN(n));
        const minSeq = Math.min(...allSeqs);
        const maxSeq = Math.max(...allSeqs);

        for (const row of tripStopRows) {
          const stopMeta = stopMetaById.get(row.stop_id);
          if (!stopMeta) continue;
          const stopSeq = Number.parseInt(row.stop_sequence, 10);
          const stopRes = await client.query(
            `SELECT id FROM stops WHERE route_id = $1 AND direction_id = $2 AND seq_order = $3`,
            [routeId, directionId, stopSeq - 1]
          );
          if (stopRes.rows.length === 0) continue;

          // 始発バス停（最小シーケンス）と終点バス停（最大シーケンス）は、
          // pickup_type/drop_off_type が 1 でも通過扱いにしない（時刻を正しく表示するため）
          const isFirst = stopSeq === minSeq;
          const isLast = stopSeq === maxSeq;
          const isThrough = !isFirst && !isLast && (row.pickup_type === '1' || row.drop_off_type === '1');
          const scheduledTime = isThrough ? null : toClockTime(row.departure_time || row.arrival_time);
          const stopHeadsign = (row.stop_headsign || '').trim() || null;
          await client.query(
            `INSERT INTO schedule_stop_times (trip_id, stop_id, scheduled_time, is_through, stop_headsign)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (trip_id, stop_id) DO UPDATE
               SET scheduled_time = EXCLUDED.scheduled_time,
                   is_through = EXCLUDED.is_through,
                   stop_headsign = EXCLUDED.stop_headsign`,
            [routeTripIds[tripIndex], stopRes.rows[0].id, scheduledTime, isThrough, stopHeadsign]
          );
        }
      }
    }
  }

  console.log(
    `[seed] feed=${feedId} GTFS 停留所 ${totalStops} 件・時刻表 ${totalTrips} 便` +
    (totalFrequencies > 0 ? `・frequencies ${totalFrequencies} 件` : '') +
    'を登録しました。'
  );
}

async function seedSettings(client) {
  const defaults = [
    ['notice1', ''],
    ['notice2', ''],
    ['important_notice', ''],
    ['route_name', '横田信大循環線'],
    ['operator_name', 'ぐるっと松本バス（アルピコ交通）']
  ];
  for (const [key, value] of defaults) {
    await client.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
  console.log('[seed] システム設定の初期値を登録しました。');
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // フィード設定を投入
    await seedFeeds(client);
    await seedFeedMappings(client);

    // 有効なGTFSフィードを取得
    const gtfsFeeds = await getEnabledGtfsFeeds(client);

    // data gtfs/配下のファイルが失われている場合（コンテナ再作成等）に備え、
    // CSVを読む前に欠損分だけ再取得しておく。トランザクション内で長時間の
    // ダウンロードを行わないよう、CSV読み込みより前のこの時点で済ませる。
    for (const feed of gtfsFeeds) {
      await ensureGtfsFilesPresent(client, feed);
    }

    // 各フィードのGTFSデータを登録
    let totalRoutes = 0;
    if (gtfsFeeds.length > 0) {
      for (const feed of gtfsFeeds) {
        const routesById = await seedRoutes(client, feed.id);
        await seedStopsAndTimetable(client, routesById, feed.id);
        totalRoutes += routesById.size;
      }
    } else {
      // フィード未設定の場合は静的GTFSデータを使う（後方互換）
      const routesById = await seedRoutesStatic(client);
      await seedStopsAndTimetable(client, routesById, null);
      totalRoutes += routesById.size;
    }

    await seedRouteExternalIds(client);
    await seedSettings(client);

    await client.query('COMMIT');
    console.log(`[seed] 完了しました。全フィード合計 ${totalRoutes} 路線を登録。`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seed()
    .then(() => {
      console.log('[seed] 完了しました。');
      return pool.end();
    })
    .catch((err) => {
      console.error('[seed] エラー:', err);
      process.exit(1);
    });
}

module.exports = seed;