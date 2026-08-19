const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { getGtfsDir, qualifyRouteId, unqualifyRouteId, ensureGtfsFilesPresent } = require('../services/gtfsFeedManager');
const { readFrequenciesByTripId } = require('../services/gtfsFrequencies');
const { getEnabledGtfsFeeds, getAllFeedsForDb, validateFeedConfig } = require('../config/feeds');
const { validateRouteExternalIdMap } = require('../config/routeExternalIdMapping');
const { getNationalHolidays } = require('../utils/japaneseHolidays');

const GTFS_DIR = getGtfsDir(null);

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
 * 便のstop_times行（stop_sequence昇順）に「同一stop_idが同じ便の中で何回目の通過か」
 * （0始まりの通過回数=occurrence）を付与する。循環路線の折返しなどで同じ物理停留所を
 * 1便の中で複数回通る場合、stop_idだけをキーにすると2回目以降の通過がstopsテーブル上で
 * 1回目と同一行に潰れてしまう（定刻・進捗が上書きされる）ため、(gtfsStopId, occurrence)
 * の組を停留所行の識別キーとして使う。
 *
 * occurrenceは「その便自身の中で何回目の通過か」という便に閉じた概念なので、
 * 呼び出しは必ず「1便ぶんのstop_times行（tripStopRows）」を渡すこと。この前提のもと、
 * 同じ物理停留所への同じ順番の通過には、どのservice_idグループ・どの便から見ても
 * 必ず同じ(gtfsStopId, occurrence)が付く。seedStopsAndTimetable内の複数箇所
 * （stops構築／schedule_stop_times構築）で同じ並び・同じロジックを使うことで、
 * それらの間でも一貫したキーになる。
 */
function withOccurrenceKeys(sortedStopRows) {
  const seenCounts = new Map();
  return sortedStopRows.map((row) => {
    const occurrence = seenCounts.get(row.stop_id) || 0;
    seenCounts.set(row.stop_id, occurrence + 1);
    return { row, gtfsStopId: row.stop_id, occurrence, occurrenceKey: `${row.stop_id}#${occurrence}` };
  });
}

function sortByStopSequence(rows) {
  return rows.slice().sort((a, b) => Number.parseInt(a.stop_sequence, 10) - Number.parseInt(b.stop_sequence, 10));
}

/**
 * config/feeds.js で定義された全フィードについて、feedsテーブルの行の存在を保証する。
 *
 * feeds テーブルはもう構成マスタではなく、**コードで定義されたフィードの稼働状態を
 * 記録するテーブル**である（仕様書 3.3）。id / feed_type / name / url / enabled は
 * コードが正で、DBを直接編集しても次回起動時にここで上書きされる。
 *
 * ⚠️ ON CONFLICT DO UPDATE の SET句に last_fetched_at / last_status / last_error を
 * 含めてはいけない。含めると再起動のたびに稼働状態がリセットされ、
 * 「最後に取得に成功したのはいつか」が失われる。
 *
 * コード側から削除されたフィードの行は自動削除しない。どこからも参照されなくなるだけで
 * 実害がなく、誤削除の方が危険なため。
 */
async function ensureFeedRows(client) {
  const feeds = getAllFeedsForDb();
  for (const feed of feeds) {
    await client.query(
      `INSERT INTO feeds (id, feed_type, name, url, enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET feed_type = EXCLUDED.feed_type,
             name      = EXCLUDED.name,
             url       = EXCLUDED.url,
             enabled   = EXCLUDED.enabled`,
      [feed.id, feed.feedType, feed.name, feed.url, feed.enabled]
    );
  }
  console.log(`[seed] フィード ${feeds.length} 件の稼働状態レコードを用意しました。`);
}

/**
 * コード上の設定（config/feeds.js・config/routeExternalIdMapping.js）と
 * 実際のGTFSデータの整合を検証し、問題があれば警告ログを出す（仕様書 4.2・4.4）。
 *
 * ⚠️ 問題があっても throw しないこと。GTFS更新でフィード側の route_id が一時的に
 * 消えたときに、システム全体が起動不能になるのを避けるため
 * （REQUIRED_GTFS_FILES に関する既知の注意点と同じ考え方）。
 */
async function validateCodeConfig(client) {
  const routeRows = await client.query(`SELECT id FROM routes`);
  const knownRouteIds = new Set(routeRows.rows.map((row) => row.id));

  const problems = [
    ...validateFeedConfig(),
    ...validateRouteExternalIdMap(knownRouteIds)
  ];

  if (problems.length === 0) {
    console.log('[seed] フィード構成・外部ID対応の検証: 問題ありません。');
    return;
  }
  for (const problem of problems) {
    console.warn(`[seed] 設定の警告: ${problem}`);
  }
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

    // stopsは(route_id, direction_id)単位で共有するマスタなので、同じ方向に属する
    // service_idグループ（平日／土休日など）をまとめて扱う。下のstops構築ループで
    // 全service_idの全便を横断して1回だけ行うことで、平日グループが書いたstops行を
    // 土休日グループが（別の物理バス停のデータで）上書きする事故を構造的に防ぐ
    // （旧設計はservice_idごとにseq_orderを0から振り直しており、UNIQUE制約に
    // service_idが入っていなかったため、この上書きが起きていた）。
    const groupsByDirection = new Map();
    for (const group of directionServiceTrips) {
      if (group.trips.length === 0) continue;
      if (!groupsByDirection.has(group.directionId)) groupsByDirection.set(group.directionId, []);
      groupsByDirection.get(group.directionId).push(group);
    }

    for (const [directionId, serviceGroups] of groupsByDirection.entries()) {
      // ==== stops構築（この方向に属する全service_idの全便を横断して1回だけ行う）====
      // (gtfsStopId, occurrence) の組ごとに停留所テーブル行を1つ持つ。occurrenceは
      // 「便自身の中で何回目にその物理停留所を通るか」という便に閉じた概念なので、
      // service_idグループが違っても同じ意味になる（withOccurrenceKeys参照）。
      // これにより、平日グループと土休日グループが同じ物理停留所を通る便を持つ場合、
      // 同じstops行を安全に共有できる（区間統計等が無用に分裂しない）。
      const gtfsStopIdByOccurrence = new Map(); // occurrenceKey -> GTFS stop_id
      const occurrenceByKey = new Map();        // occurrenceKey -> occurrence
      const stopSeqByOccurrence = new Map();    // occurrenceKey -> 表示順算出用の最小stop_sequence

      for (const { trips: routeTrips } of serviceGroups) {
        for (const trip of routeTrips) {
          const tripStopRows = sortByStopSequence(stopTimesByTrip.get(trip.trip_id) || []);

          for (const { row, occurrenceKey, gtfsStopId, occurrence } of withOccurrenceKeys(tripStopRows)) {
            const stopMeta = stopMetaById.get(row.stop_id);
            if (!stopMeta) continue;
            const seq = Number.parseInt(row.stop_sequence, 10);
            if (Number.isNaN(seq)) continue;

            if (!stopSeqByOccurrence.has(occurrenceKey) || seq < stopSeqByOccurrence.get(occurrenceKey)) {
              stopSeqByOccurrence.set(occurrenceKey, seq);
            }
            gtfsStopIdByOccurrence.set(occurrenceKey, gtfsStopId);
            occurrenceByKey.set(occurrenceKey, occurrence);
          }
        }
      }

      const occurrenceKeys = Array.from(gtfsStopIdByOccurrence.keys()).sort((a, b) => {
        const aSeq = stopSeqByOccurrence.get(a) ?? Number.MAX_SAFE_INTEGER;
        const bSeq = stopSeqByOccurrence.get(b) ?? Number.MAX_SAFE_INTEGER;
        return aSeq - bSeq;
      });

      // seq_orderは表示順専用の値（一覧表示・バス停マップの並び替えにのみ使う）。
      // 便ごとの実際の停車順はこのあと別途 schedule_stop_times.stop_sequence に持たせる。
      const stopRowIdByOccurrence = new Map();
      let seqOrder = 0;
      for (const occurrenceKey of occurrenceKeys) {
        const gtfsStopId = gtfsStopIdByOccurrence.get(occurrenceKey);
        const occurrence = occurrenceByKey.get(occurrenceKey);
        const meta = stopMetaById.get(gtfsStopId);
        if (!meta) continue;
        const result = await client.query(
          `INSERT INTO stops (route_id, direction_id, gtfs_stop_id, occurrence, seq_order, name, name_kana, name_en, lat, lon, notice, timetable_link)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (route_id, direction_id, gtfs_stop_id, occurrence) DO UPDATE
             SET seq_order = EXCLUDED.seq_order,
                 name = EXCLUDED.name,
                 name_kana = EXCLUDED.name_kana,
                 name_en = EXCLUDED.name_en,
                 lat = EXCLUDED.lat,
                 lon = EXCLUDED.lon,
                 notice = EXCLUDED.notice,
                 timetable_link = EXCLUDED.timetable_link
           RETURNING id`,
          [routeId, directionId, gtfsStopId, occurrence, seqOrder, meta.stop_name, '', '', parseFloat(meta.stop_lat), parseFloat(meta.stop_lon), '', '']
        );
        stopRowIdByOccurrence.set(occurrenceKey, result.rows[0].id);
        seqOrder += 1;
        totalStops++;
      }

      // ==== schedule_trips / schedule_stop_times構築（service_idグループごと）====
      for (const { serviceId, trips: routeTrips } of serviceGroups) {
        const routeTripIds = [];
        for (const [tripIndex, trip] of routeTrips.entries()) {
          const firstStop = sortByStopSequence(stopTimesByTrip.get(trip.trip_id) || [])[0];
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
          const tripStopRows = sortByStopSequence(stopTimesByTrip.get(trip.trip_id) || []);

          // この便の全停車駅の最小・最大シーケンス番号を求める（始発・終点の通過誤判定防止）
          const allSeqs = tripStopRows.map(row => Number.parseInt(row.stop_sequence, 10)).filter(n => !Number.isNaN(n));
          const minSeq = Math.min(...allSeqs);
          const maxSeq = Math.max(...allSeqs);

          // occurrenceKeyの算出は上のstops構築ループと同じ並び・同じロジックで行う必要がある
          // （同じ便の同じ通過には必ず同じoccurrenceKeyが付くようにするため）。
          // localSeq（withOccurrenceKeysが返す配列でのインデックス、0始まり）が、
          // この便自身の中での実際の停車順＝schedule_stop_times.stop_sequenceになる。
          for (const [localSeq, { row, occurrenceKey }] of withOccurrenceKeys(tripStopRows).entries()) {
            const stopMeta = stopMetaById.get(row.stop_id);
            if (!stopMeta) continue;
            const stopSeq = Number.parseInt(row.stop_sequence, 10);
            const stopRowId = stopRowIdByOccurrence.get(occurrenceKey);
            if (!stopRowId) continue;

            // 始発バス停（最小シーケンス）と終点バス停（最大シーケンス）は、
            // pickup_type/drop_off_type が 1 でも通過扱いにしない（時刻を正しく表示するため）
            const isFirst = stopSeq === minSeq;
            const isLast = stopSeq === maxSeq;
            const isThrough = !isFirst && !isLast && (row.pickup_type === '1' || row.drop_off_type === '1');
            const scheduledTime = isThrough ? null : toClockTime(row.departure_time || row.arrival_time);
            const stopHeadsign = (row.stop_headsign || '').trim() || null;
            await client.query(
              `INSERT INTO schedule_stop_times (trip_id, stop_id, stop_sequence, scheduled_time, is_through, stop_headsign)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (trip_id, stop_id) DO UPDATE
                 SET stop_sequence = EXCLUDED.stop_sequence,
                     scheduled_time = EXCLUDED.scheduled_time,
                     is_through = EXCLUDED.is_through,
                     stop_headsign = EXCLUDED.stop_headsign`,
              [routeTripIds[tripIndex], stopRowId, localSeq, scheduledTime, isThrough, stopHeadsign]
            );
          }
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

/**
 * 祝日カレンダーの初期値を投入する。年ごとに「既にその年のデータが1件でもあれば
 * 何もしない」判定にしてあるのは、seed()はGTFS再取得のたびに毎時走るため、
 * 管理画面での追加・削除（自動生成分の削除も含む）を上書きしないようにするため。
 * 年が変わって新しい年のデータがまだ無い場合にだけ、自動的に補充される。
 */
async function seedHolidays(client) {
  const currentYear = new Date().getFullYear();
  for (const year of [currentYear, currentYear + 1]) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM holidays WHERE holiday_date >= $1 AND holiday_date < $2`,
      [`${year}-01-01`, `${year + 1}-01-01`]
    );
    if (rows[0].c > 0) continue;

    const holidays = getNationalHolidays(year);
    for (const [date, name] of holidays) {
      await client.query(
        `INSERT INTO holidays (holiday_date, name) VALUES ($1, $2) ON CONFLICT (holiday_date) DO NOTHING`,
        [date, name]
      );
    }
    console.log(`[seed] ${year}年の祝日カレンダー初期値を登録しました。`);
  }
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 稼働状態を記録するための行を用意する（構成そのものはコード側が正）
    await ensureFeedRows(client);

    // 有効なGTFSフィードを取得（取得元は config/feeds.js）
    const gtfsFeeds = getEnabledGtfsFeeds();

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

    await seedSettings(client);
    await seedHolidays(client);

    // コード上の設定と、いま投入したGTFSデータの整合を検証する（警告のみ・起動は止めない）
    await validateCodeConfig(client);

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