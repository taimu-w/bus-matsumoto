// 当日の運行便（daily_trips / daily_trip_stop_times）を生成する。
//
// 便起点方式の入口となるモジュール。車両のGPSを待たず、その日にGTFS上で運行する便を
// あらかじめすべてDBへ展開しておく（仕様書 3）。始発時刻までは担当車両を持たない。
//
// frequencies.txt（頻度ベース運行）による仮想便もここで展開し、
// daily_trip_stop_times にオフセット適用済みの定刻を焼き込む。これにより、
// 以降の全処理（割り当て・通過判定・遅延計算・ETA・API）は仮想便と通常便を
// 一切区別しなくてよくなる（仕様書 3.4.2）。
const pool = require('../config/db');
const { getActiveServiceIds } = require('./gtfsCalendar');
const { expandFrequencies } = require('./gtfsFrequencies');
const {
  timeStrToMinutes,
  minutesToTimeStr,
  getServiceDateString,
  serviceDateTimeToDate
} = require('../utils/time');

// 生成済みの運行日（プロセス内キャッシュ）。GTFS再投入時は invalidateDailyTripCache() で無効化する。
let builtServiceDate = null;

function invalidateDailyTripCache() {
  builtServiceDate = null;
}

/**
 * その運行日に有効なservice_idを取得する。
 * getActiveServiceIds は日付から曜日を見るため、JSTの正午を渡してタイムゾーンのズレを避ける。
 */
async function loadActiveServiceIds(serviceDate) {
  return getActiveServiceIds(new Date(`${serviceDate}T12:00:00+09:00`));
}

/**
 * 対象service_idの全便と、その停車時刻を1クエリでまとめて読み込む。
 */
async function loadScheduleTrips(client, activeServiceIds) {
  const res = await client.query(
    `SELECT st.id            AS schedule_trip_id,
            st.route_id,
            st.direction_id,
            st.service_id,
            st.headsign,
            sst.stop_id,
            s.seq_order,
            sst.scheduled_time,
            sst.is_through,
            sst.stop_headsign
     FROM schedule_trips st
     JOIN schedule_stop_times sst ON sst.trip_id = st.id
     JOIN stops s ON s.id = sst.stop_id
     WHERE st.service_id = ANY($1::text[])
     ORDER BY st.id ASC, s.seq_order ASC`,
    [activeServiceIds]
  );

  const trips = new Map();
  for (const row of res.rows) {
    let trip = trips.get(row.schedule_trip_id);
    if (!trip) {
      trip = {
        scheduleTripId: row.schedule_trip_id,
        routeId: row.route_id,
        directionId: row.direction_id,
        serviceId: row.service_id,
        headsign: row.headsign,
        stopTimes: []
      };
      trips.set(row.schedule_trip_id, trip);
    }
    trip.stopTimes.push({
      stopId: row.stop_id,
      seqOrder: row.seq_order,
      scheduledTime: row.scheduled_time,
      isThrough: row.is_through,
      stopHeadsign: row.stop_headsign
    });
  }
  return Array.from(trips.values());
}

async function loadFrequencies(client, scheduleTripIds) {
  if (scheduleTripIds.length === 0) return new Map();
  const res = await client.query(
    `SELECT trip_id, start_time, end_time, headway_secs, exact_times
     FROM schedule_trip_frequencies
     WHERE trip_id = ANY($1::int[])
     ORDER BY trip_id ASC, start_time ASC`,
    [scheduleTripIds]
  );
  const byTrip = new Map();
  for (const row of res.rows) {
    if (!byTrip.has(row.trip_id)) byTrip.set(row.trip_id, []);
    byTrip.get(row.trip_id).push(row);
  }
  return byTrip;
}

/**
 * 1つの便について、当日生成すべきインスタンス（通常便1件 or 仮想便N件）を決める。
 */
function buildInstances(trip, frequencyRows, baseStartMinutes) {
  if (!frequencyRows || frequencyRows.length === 0) {
    return [{ frequencyIndex: 0, offsetMinutes: 0, origin: 'static' }];
  }

  const expanded = expandFrequencies(frequencyRows, baseStartMinutes * 60);
  if (expanded.length === 0) {
    // frequencies の内容が壊れている場合でも便自体は失わないようにする
    console.warn(
      `[dailyTripBuilder] frequencies を展開できませんでした。通常便として生成します: schedule_trip_id=${trip.scheduleTripId}`
    );
    return [{ frequencyIndex: 0, offsetMinutes: 0, origin: 'static' }];
  }

  // frequencies.txt に登場する便は仮想便としてのみ展開し、素の便は生成しない（GTFS標準の解釈）
  return expanded.map((inst) => ({
    frequencyIndex: inst.frequencyIndex,
    offsetMinutes: inst.offsetMinutes,
    origin: 'frequency'
  }));
}

/**
 * オフセットを適用した定刻文字列を返す。
 * offset が 0 のとき（＝通常便）は元の文字列をそのまま使い、表記を一切変えない。
 */
function shiftTime(timeStr, offsetMinutes) {
  if (offsetMinutes === 0) return timeStr;
  const minutes = timeStrToMinutes(timeStr);
  if (Number.isNaN(minutes)) return null;
  return minutesToTimeStr(minutes + offsetMinutes);
}

async function upsertDailyTrip(client, serviceDate, trip, instance, startStop, startTimeStr, startMinutes) {
  const startAt = serviceDateTimeToDate(serviceDate, startMinutes);
  const res = await client.query(
    `INSERT INTO daily_trips
       (service_date, route_id, direction_id, schedule_trip_id, service_id, origin,
        frequency_index, offset_minutes, start_stop_id, start_time, start_at, headsign)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (service_date, schedule_trip_id, frequency_index) DO UPDATE
       SET
         -- 既に車両を割り当て済みの便は、GTFSが更新されても当日中は書き換えない。
         -- 走行中の便の定刻がずれると遅延計算と実績が破綻するため。
         route_id       = CASE WHEN daily_trips.assignment_state = 'pending' THEN EXCLUDED.route_id       ELSE daily_trips.route_id END,
         direction_id   = CASE WHEN daily_trips.assignment_state = 'pending' THEN EXCLUDED.direction_id   ELSE daily_trips.direction_id END,
         service_id     = CASE WHEN daily_trips.assignment_state = 'pending' THEN EXCLUDED.service_id     ELSE daily_trips.service_id END,
         origin         = CASE WHEN daily_trips.assignment_state = 'pending' THEN EXCLUDED.origin         ELSE daily_trips.origin END,
         offset_minutes = CASE WHEN daily_trips.assignment_state = 'pending' THEN EXCLUDED.offset_minutes ELSE daily_trips.offset_minutes END,
         start_stop_id  = CASE WHEN daily_trips.assignment_state = 'pending' THEN EXCLUDED.start_stop_id  ELSE daily_trips.start_stop_id END,
         start_time     = CASE WHEN daily_trips.assignment_state = 'pending' THEN EXCLUDED.start_time     ELSE daily_trips.start_time END,
         start_at       = CASE WHEN daily_trips.assignment_state = 'pending' THEN EXCLUDED.start_at       ELSE daily_trips.start_at END,
         headsign       = CASE WHEN daily_trips.assignment_state = 'pending' THEN EXCLUDED.headsign       ELSE daily_trips.headsign END
     RETURNING id, assignment_state`,
    [
      serviceDate,
      trip.routeId,
      trip.directionId,
      trip.scheduleTripId,
      trip.serviceId,
      instance.origin,
      instance.frequencyIndex,
      instance.offsetMinutes,
      startStop.stopId,
      startTimeStr,
      startAt,
      trip.headsign
    ]
  );
  return res.rows[0];
}

async function replaceStopTimes(client, dailyTripId, trip, offsetMinutes) {
  await client.query(`DELETE FROM daily_trip_stop_times WHERE daily_trip_id = $1`, [dailyTripId]);

  const values = [];
  const params = [];
  let i = 1;
  for (const st of trip.stopTimes) {
    const scheduled = st.scheduledTime ? shiftTime(st.scheduledTime, offsetMinutes) : null;
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(dailyTripId, st.stopId, st.seqOrder, scheduled, st.isThrough, st.stopHeadsign || null);
  }
  if (values.length === 0) return;

  await client.query(
    `INSERT INTO daily_trip_stop_times (daily_trip_id, stop_id, seq_order, scheduled_time, is_through, stop_headsign)
     VALUES ${values.join(', ')}
     ON CONFLICT (daily_trip_id, stop_id) DO UPDATE
       SET seq_order = EXCLUDED.seq_order,
           scheduled_time = EXCLUDED.scheduled_time,
           is_through = EXCLUDED.is_through,
           stop_headsign = EXCLUDED.stop_headsign`,
    params
  );
}

/**
 * 当日の運行便を生成する（冪等）。
 * 既に生成済みで、かつGTFSの再投入もなければ何もしない。
 */
async function ensureDailyTrips(options = {}) {
  const serviceDate = options.serviceDate || getServiceDateString();
  if (!options.force && builtServiceDate === serviceDate) {
    return { serviceDate, skipped: true, created: 0 };
  }

  const client = await pool.connect();
  let generated = 0;
  let virtualGenerated = 0;

  try {
    const activeServiceIds = await loadActiveServiceIds(serviceDate);
    if (activeServiceIds.length === 0) {
      console.warn(`[dailyTripBuilder] ${serviceDate} に有効なservice_idがありません。当日便を生成しません。`);
      builtServiceDate = serviceDate;
      return { serviceDate, skipped: false, created: 0 };
    }

    const trips = await loadScheduleTrips(client, activeServiceIds);
    const frequenciesByTrip = await loadFrequencies(
      client,
      trips.map((t) => t.scheduleTripId)
    );

    const keptIds = [];

    for (const trip of trips) {
      if (trip.stopTimes.length === 0) continue;

      // 始発バス停＝この便の最小seq_orderの停留所。路線内で始発が異なる便にも対応できる。
      const startStopRow = trip.stopTimes[0];
      const baseStartMinutes = timeStrToMinutes(startStopRow.scheduledTime);
      if (Number.isNaN(baseStartMinutes)) {
        // 始発バス停に定刻が無い便は始発時刻を決められないため対象外
        continue;
      }
      const startStop = { stopId: startStopRow.stopId, seqOrder: startStopRow.seqOrder };

      const instances = buildInstances(trip, frequenciesByTrip.get(trip.scheduleTripId), baseStartMinutes);

      for (const instance of instances) {
        const startMinutes = baseStartMinutes + instance.offsetMinutes;
        const startTimeStr = instance.offsetMinutes === 0
          ? startStopRow.scheduledTime
          : minutesToTimeStr(startMinutes);

        await client.query('BEGIN');
        try {
          const row = await upsertDailyTrip(
            client, serviceDate, trip, instance, startStop, startTimeStr, startMinutes
          );
          keptIds.push(row.id);

          // 割り当て済みの便の停車予定は書き換えない（上のUPSERTと同じ理由）
          if (row.assignment_state === 'pending') {
            await replaceStopTimes(client, row.id, trip, instance.offsetMinutes);
          }
          await client.query('COMMIT');
          generated++;
          if (instance.origin === 'frequency') virtualGenerated++;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(
            `[dailyTripBuilder] 便生成エラー schedule_trip_id=${trip.scheduleTripId} freq=${instance.frequencyIndex}:`,
            err.message
          );
        }
      }
    }

    // GTFSから消えた便のうち、まだ車両を割り当てていないものを掃除する
    if (keptIds.length > 0) {
      const removed = await client.query(
        `DELETE FROM daily_trips
         WHERE service_date = $1
           AND assignment_state = 'pending'
           AND id <> ALL($2::bigint[])`,
        [serviceDate, keptIds]
      );
      if (removed.rowCount > 0) {
        console.log(`[dailyTripBuilder] GTFSから消えた未割り当ての便 ${removed.rowCount} 件を削除しました。`);
      }
    }

    builtServiceDate = serviceDate;
    console.log(
      `[dailyTripBuilder] ${serviceDate} の運行便 ${generated} 件を生成しました` +
      (virtualGenerated > 0 ? `（うち frequencies 由来の仮想便 ${virtualGenerated} 件）` : '') + '。'
    );
    return { serviceDate, skipped: false, created: generated, virtual: virtualGenerated };
  } finally {
    client.release();
  }
}

/**
 * 古い運行日のデータを掃除する。
 */
async function purgeOldDailyTrips(retentionDays = parseInt(process.env.DAILY_TRIP_RETENTION_DAYS || '7', 10)) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `DELETE FROM daily_trips WHERE service_date < (CURRENT_DATE - $1::int)`,
      [retentionDays]
    );
    if (res.rowCount > 0) {
      console.log(`[dailyTripBuilder] 保持期間を過ぎた運行便 ${res.rowCount} 件を削除しました。`);
    }
    return { deleted: res.rowCount };
  } finally {
    client.release();
  }
}

module.exports = {
  ensureDailyTrips,
  invalidateDailyTripCache,
  purgeOldDailyTrips
};
