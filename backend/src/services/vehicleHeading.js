// 地図上のバスアイコンの向き（進行方向の方位角）を求める。docs/vehicle-profiles.md「地図上の向き」
//
// 管理画面「車両詳細情報」のバスアイコンは左向きの横顔の画像なので、地図上で進行方向に
// 向けて反転・回転させる（変形の決定は frontend/vehicle-info.js の markerTransform()）。
// ここではその元になる方位角（度、真北=0・東=90・時計回り）だけを返す。
//
// 判定の優先順位：
//   1. 走行軌跡：最新の測位と、直近 MOVEMENT_MAX_AGE_MS 以内で MOVEMENT_MIN_METERS 以上離れた
//      いちばん新しい測位を結んだ向き（GPSの揺らぎで停車中に向きが暴れないよう距離のしきいを置く）
//   2. 次のバス停：まだ到着していないバス停のうち、現在地から NEXT_STOP_MIN_METERS 以上離れた
//      最初のものへの向き（停車中で走行軌跡が取れないとき。始発で発車を待っている車両など）
//   3. どちらも取れなければ null（＝画像そのままの左向き）
// 表示専用で、通過判定・遅延計算・ETAには使わない。

const pool = require('../config/db');
const { haversineDistanceMeters, bearingDegrees } = require('../utils/geo');

const MOVEMENT_MIN_METERS = 20;
const MOVEMENT_MAX_AGE_MS = 5 * 60 * 1000;
const NEXT_STOP_MIN_METERS = 30;
// 1台あたり読む直近測位の上限と、SQLで読む時間範囲（インデックス (vehicle_id, gps_time_ts) を効かせる）。
const RECENT_POINTS_PER_VEHICLE = 15;
const RECENT_POINTS_WINDOW = '30 minutes';

/**
 * 走行軌跡からの方位角。points は新しい順の測位 [{ lat, lon, timeMs }]。取れなければ null。
 */
function headingFromMovement(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const latest = points[0];
  for (const p of points.slice(1)) {
    if (latest.timeMs - p.timeMs > MOVEMENT_MAX_AGE_MS) break;
    if (haversineDistanceMeters(p.lat, p.lon, latest.lat, latest.lon) >= MOVEMENT_MIN_METERS) {
      return bearingDegrees(p.lat, p.lon, latest.lat, latest.lon);
    }
  }
  return null;
}

/**
 * 次のバス停への方位角。remainingStops はまだ到着していないバス停を運行順に [{ lat, lon }]。
 * 現在地に近すぎるバス停（停車中のバス停など）は向きが定まらないので飛ばす。取れなければ null。
 */
function headingToNextStop(position, remainingStops) {
  if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)) return null;
  for (const s of remainingStops || []) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    if (haversineDistanceMeters(position.lat, position.lon, s.lat, s.lon) >= NEXT_STOP_MIN_METERS) {
      return bearingDegrees(position.lat, position.lon, s.lat, s.lon);
    }
  }
  return null;
}

function roundHeading(value) {
  return value === null ? null : Math.round(value) % 360;
}

/**
 * targets: [{ vehicleId, assignmentId, lat, lng }]（lat/lng は表示に使っている最新位置）
 * → Map(vehicleId → 方位角（整数度）| null)。
 * /api/buses-for-map のポーリング経路から呼ばれるため soft-fail（失敗時は空Map＝全車両そのままの向き）。
 */
async function getVehicleHeadings(db, targets) {
  const list = (targets || []).filter((t) => t && t.vehicleId !== null && t.vehicleId !== undefined);
  const headings = new Map();
  if (list.length === 0) return headings;
  const client = db || pool;

  try {
    const pointsRes = await client.query(
      `SELECT vehicle_id, lat, lon, gps_time_ts
       FROM (
         SELECT vehicle_id, lat, lon, gps_time_ts,
                row_number() OVER (PARTITION BY vehicle_id ORDER BY gps_time_ts DESC, id DESC) AS rn
         FROM vehicle_gps_log
         WHERE vehicle_id = ANY($1::int[])
           AND gps_time_ts >= now() - $2::interval
       ) t
       WHERE rn <= $3
       ORDER BY vehicle_id, rn`,
      [list.map((t) => t.vehicleId), RECENT_POINTS_WINDOW, RECENT_POINTS_PER_VEHICLE]
    );
    const pointsByVehicle = new Map();
    for (const r of pointsRes.rows) {
      if (!pointsByVehicle.has(r.vehicle_id)) pointsByVehicle.set(r.vehicle_id, []);
      pointsByVehicle.get(r.vehicle_id).push({
        lat: Number(r.lat),
        lon: Number(r.lon),
        timeMs: new Date(r.gps_time_ts).getTime()
      });
    }

    const needStops = [];
    for (const t of list) {
      const h = headingFromMovement(pointsByVehicle.get(t.vehicleId) || []);
      headings.set(t.vehicleId, roundHeading(h));
      if (h === null && t.assignmentId !== null && t.assignmentId !== undefined) needStops.push(t);
    }
    if (needStops.length === 0) return headings;

    // 走行軌跡が取れなかった車両だけ、最後に到着したバス停より先のバス停を引く。
    const stopsRes = await client.query(
      `SELECT p.assignment_id, p.seq_order, s.lat, s.lon
       FROM trip_stop_progress p
       JOIN stops s ON s.id = p.stop_id
       WHERE p.assignment_id = ANY($1::bigint[])
         AND p.seq_order > COALESCE(
           (SELECT MAX(p2.seq_order) FROM trip_stop_progress p2
            WHERE p2.assignment_id = p.assignment_id AND p2.status = '到着済'), -1)
       ORDER BY p.assignment_id, p.seq_order`,
      [needStops.map((t) => t.assignmentId)]
    );
    const stopsByAssignment = new Map();
    for (const r of stopsRes.rows) {
      const key = String(r.assignment_id);
      if (!stopsByAssignment.has(key)) stopsByAssignment.set(key, []);
      stopsByAssignment.get(key).push({ lat: Number(r.lat), lon: Number(r.lon) });
    }
    for (const t of needStops) {
      const h = headingToNextStop(
        { lat: Number(t.lat), lon: Number(t.lng) },
        stopsByAssignment.get(String(t.assignmentId)) || []
      );
      headings.set(t.vehicleId, roundHeading(h));
    }
  } catch (err) {
    console.warn('[vehicleHeading] 進行方向の算出に失敗（アイコンは向きを変えずに表示します）:', err.message);
    return new Map();
  }
  return headings;
}

module.exports = {
  headingFromMovement,
  headingToNextStop,
  getVehicleHeadings
};
