// 時刻表検索（GTFS識別子ベース）とリアルタイム運行状況（DBの daily_trips ベース）を
// 便詳細ページのために橋渡しする、小さな専用モジュール。
//
// 2つの機能のデータ経路は独立を保つ設計（README/CLAUDE.md参照）だが、
// 便詳細ページのURL（/timetable/trips/{gtfs_id}/{route_id}/{trip_id}/{departure_time}）に
// 現れるGTFS識別子から「その便が今日DB側で運行中か」を引けないと、
// リアルタイム表示への切り替えボタンが作れない。ここでの突き合わせだけに用途を限定し、
// 他のコードから gtfsTimetable 側のインメモリインデックスへ依存させることはしない。
const pool = require('../config/db');
const { qualifyRouteId } = require('./gtfsFeedManager');
const { timeStrToMinutes, getServiceDateString } = require('../utils/time');
const { getArrivalsForAssignment } = require('./etaPredictor');

/**
 * daily_trips.start_time（"H:mm"）を便詳細URLの departure_time 表記（"0805"）に変換する。
 * gtfsTimetable.js の formatHhmm と同じ0埋め2桁×2の表記に合わせる（24時超えはそのまま）。
 */
function startTimeToUrlHhmm(startTime) {
  const minutes = timeStrToMinutes(startTime);
  if (Number.isNaN(minutes)) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

/** 便詳細URLの departure_time（"0805"のような4桁、または"H:mm"）を分単位に変換する。 */
function urlDepartureTimeToMinutes(value) {
  const s = String(value || '').trim();
  if (!s) return NaN;
  if (s.includes(':')) return timeStrToMinutes(s);
  if (!/^\d{3,4}$/.test(s)) return NaN;
  const padded = s.padStart(4, '0');
  return Number.parseInt(padded.slice(0, 2), 10) * 60 + Number.parseInt(padded.slice(2), 10);
}

/**
 * 便詳細ページのURLパラメータから、当日DB上でその便を担当している
 * 割り当て（trip_vehicle_assignments, role='assigned' state='active'）を探す。
 * 見つからなければ null（＝現在リアルタイム運行していない）。
 *
 * 注意: frequencies.txt由来の仮想便で、始発時刻が24時を跨ぐ場合
 * （dailyTripBuilder.js の minutesToTimeStr が 24時で折り返す）は
 * URL側（折り返さない表記）とマッチしないことがある。この路線の運行時間帯
 * （早朝〜23時台）では実質発生しないため、対応を割愛している。
 */
async function findLiveAssignment(feedId, routeId, tripId, departureTime) {
  const qualifiedRouteId = qualifyRouteId(routeId, feedId);
  const targetMinutes = urlDepartureTimeToMinutes(departureTime);
  if (Number.isNaN(targetMinutes)) return null;

  const serviceDate = getServiceDateString();
  const result = await pool.query(
    `SELECT d.id AS daily_trip_id, d.start_time, d.headsign,
            a.id AS assignment_id, a.delay_minutes,
            v.id AS vehicle_id, v.car_id
     FROM daily_trips d
     JOIN schedule_trips st ON st.id = d.schedule_trip_id
     JOIN trip_vehicle_assignments a
       ON a.daily_trip_id = d.id AND a.role = 'assigned' AND a.state = 'active'
     JOIN vehicles v ON v.id = a.vehicle_id
     WHERE d.route_id = $1
       AND st.gtfs_trip_id = $2
       AND d.service_date = $3
       AND d.closed_at IS NULL`,
    [qualifiedRouteId, tripId, serviceDate]
  );

  return result.rows.find((row) => timeStrToMinutes(row.start_time) === targetMinutes) || null;
}

/**
 * 1便分のリアルタイム詳細（停車進捗・遅延・到着予測・車両位置）を組み立てる。
 * /api/buses の1件分と同じ形。findLiveAssignment() の結果行を渡す。
 */
async function buildBusEntry(t, routeId, routeName) {
  const stopRows = await pool.query(
    `SELECT p.stop_id,
            p.seq_order,
            p.scheduled_time,
            p.status,
            p.actual_time,
            p.delay_minutes,
            p.interpolated,
            s.name,
            s.lat,
            s.lon,
            s.notice,
            s.timetable_link
     FROM trip_stop_progress p
     JOIN stops s ON s.id = p.stop_id
     WHERE p.assignment_id = $1
     ORDER BY p.seq_order ASC`,
    [t.assignment_id]
  );

  const latestGpsResult = await pool.query(
    `SELECT lat, lon FROM vehicle_gps_log
     WHERE vehicle_id = $1
     ORDER BY gps_time_ts DESC, id DESC LIMIT 1`,
    [t.vehicle_id]
  );
  const latestGps = latestGpsResult.rows[0] || null;

  const predictions = await getArrivalsForAssignment(pool, t.assignment_id);
  const predictionBySeq = new Map(predictions.map((p) => [p.seqOrder, p]));

  const stops = stopRows.rows.map((r) => {
    const pred = predictionBySeq.get(r.seq_order);
    return {
      stopId: r.stop_id,
      seqOrder: r.seq_order,
      name: r.name,
      lat: r.lat,
      lng: r.lon,
      notice: r.notice,
      timetableLink: r.timetable_link,
      scheduledTime: r.scheduled_time,
      status: r.status,
      actualTime: r.actual_time,
      delayMinutes: r.delay_minutes,
      interpolated: r.interpolated,
      predictedTime: pred ? pred.predictedTime : r.scheduled_time,
      predictedDelayMinutes: pred ? pred.predictedDelayMinutes : 0
    };
  });

  return {
    id: t.car_id,
    tripId: t.daily_trip_id,
    startTime: t.start_time,
    routeId,
    routeName,
    headsign: t.headsign || null,
    isRealtime: true,
    delayMinutes: t.delay_minutes,
    lat: latestGps ? latestGps.lat : null,
    lng: latestGps ? latestGps.lon : null,
    stops
  };
}

module.exports = {
  findLiveAssignment,
  buildBusEntry,
  urlDepartureTimeToMinutes,
  startTimeToUrlHhmm
};
