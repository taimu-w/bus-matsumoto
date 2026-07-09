// GASの pass() 系関数群（passStep1And3 / passStep2 / passUpdateAndInterpolate / passInterpolate）に相当。
// GPS走行ログとバス停マスタを突き合わせ、バス停通過を検知する。
// 循環線対策は元GASと同じ2条件を踏襲しつつ、DBとの同期ズレを防ぐ安全な設計に変更。
//   ① 直近の到着済バス停インデックスから4つ先までしか探索しない
//   ② 出発20分以内は、路線全体の後半80%のバス停を候補から除外する
const pool = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');
const { timeStrToMinutes, minutesToTimeStr } = require('../utils/time');

async function getActiveVehiclesForPass(client) {
  const res = await client.query(
    `SELECT id, car_id, departure_time FROM vehicles WHERE status = 'active'`
  );
  return res.rows;
}

async function getStopMaster(client, vehicleId) {
  const res = await client.query(
    `SELECT vss.stop_id, vss.seq_order, vss.status, s.name, s.lat, s.lon, s.notice
     FROM vehicle_stop_status vss
     JOIN stops s ON s.id = vss.stop_id
     WHERE vss.vehicle_id = $1
     ORDER BY vss.seq_order ASC`,
    [vehicleId]
  );
  return res.rows;
}

async function passStep1And3(client, vehicle, stopMaster, gpsRows, radiusMeters, freshnessMs) {
  const now = Date.now();
  const totalStops = stopMaster.length;
  const f3Min = timeStrToMinutes(vehicle.departure_time);

  // DB上で確定している「最後に到着したバス停」のインデックスを取得
  // 【循環線対策】このバッチ処理中は、この基準値を書き換えない（固定する）
  let lastArrivedIdx = -1;
  for (let i = stopMaster.length - 1; i >= 0; i--) {
    if (stopMaster[i].status === '到着済') {
      lastArrivedIdx = stopMaster[i].seq_order;
      break;
    }
  }

  // 【巻き戻り防止用】バッチ内での進行状況を記録する変数（初期値はDBの直近バス停）
  let currentMaxIdx = lastArrivedIdx;

  // 確定済みのバス停セット
  const arrivedSet = new Set(stopMaster.filter((s) => s.status === '到着済').map((s) => s.seq_order));
  const tentativeMatches = []; // {gpsRowId, stopId, seqOrder, stopName, dist, gpsTime}

  for (const gps of gpsRows) {
    const gpsTimeMs = new Date(gps.gps_time_ts).getTime();
    if (now - gpsTimeMs > freshnessMs) continue;

    const gpsMin = timeStrToMinutes(gps.gps_time);
    const minSinceDep = !Number.isNaN(f3Min) && !Number.isNaN(gpsMin) ? gpsMin - f3Min : NaN;

    let best = null;
    for (const stop of stopMaster) {
      if (arrivedSet.has(stop.seq_order)) continue;

      // 【巻き戻り防止】すでに通過した（またはこのバッチ内で通過判定が出た）バス停は除外
      if (stop.seq_order <= currentMaxIdx) continue;
      
      // 【循環線対策①】探索範囲の制限（確定している直近バス停の4つ先まで）
      if (lastArrivedIdx !== -1 && stop.seq_order > lastArrivedIdx + 4) continue;
      
      // 【循環線対策②】初期の誤判定防止（出発20分以内は後半80%を除外）
      if (!Number.isNaN(minSinceDep) && minSinceDep < 20 && stop.seq_order / totalStops > 0.8) continue;

      const dist = haversineDistanceMeters(gps.lat, gps.lon, stop.lat, stop.lon);
      if (dist <= radiusMeters) {
        if (!best || dist < best.dist) {
          best = { stopId: stop.stop_id, seqOrder: stop.seq_order, stopName: stop.name, dist };
        }
      }
    }

    if (best) {
      tentativeMatches.push({
        gpsRowId: gps.id,
        gpsTime: gps.gps_time,
        lat: gps.lat,
        lon: gps.lon,
        ...best
      });
      
      // 【巻き戻り防止】マッチしたバス停を記録し、次のGPSログからはこれより前を探索させない
      currentMaxIdx = Math.max(currentMaxIdx, best.seqOrder);
    }
  }

  return tentativeMatches;
}

function passStep2Dedup(matches, stopMaster) {
  const coordByStop = new Map(stopMaster.map((s) => [s.stop_id, { lat: s.lat, lon: s.lon }]));
  const byStop = new Map();
  for (const m of matches) {
    if (!byStop.has(m.stopId)) byStop.set(m.stopId, []);
    byStop.get(m.stopId).push(m);
  }
  const kept = [];
  for (const [stopId, arr] of byStop.entries()) {
    if (arr.length === 1) {
      kept.push(arr[0]);
      continue;
    }
    const coord = coordByStop.get(stopId);
    arr.sort((a, b) => {
      const da = haversineDistanceMeters(a.lat, a.lon, coord.lat, coord.lon);
      const db = haversineDistanceMeters(b.lat, b.lon, coord.lat, coord.lon);
      return da - db;
    });
    kept.push(arr[0]);
  }
  return kept;
}

async function passInterpolate(client, vehicleId) {
  const rows = await client.query(
    `SELECT stop_id, seq_order, status, actual_time FROM vehicle_stop_status
     WHERE vehicle_id = $1 ORDER BY seq_order ASC`,
    [vehicleId]
  );

  const arrivedList = [];
  for (const r of rows.rows) {
    if (r.status !== '到着済' || !r.actual_time) continue;
    const mins = timeStrToMinutes(r.actual_time);
    if (Number.isNaN(mins)) continue;
    arrivedList.push({ seqOrder: r.seq_order, mins });
  }
  if (arrivedList.length < 2) return 0;

  const firstArrivedSeq = arrivedList[0].seqOrder;
  const statusBySeq = new Map(rows.rows.map((r) => [r.seq_order, r]));
  let filled = 0;

  for (let a = 0; a < arrivedList.length - 1; a++) {
    const prev = arrivedList[a];
    const next = arrivedList[a + 1];
    const segments = next.seqOrder - prev.seqOrder;
    if (segments <= 1) continue;

    for (let j = 1; j < segments; j++) {
      const targetSeq = prev.seqOrder + j;
      if (targetSeq < firstArrivedSeq) continue;
      const target = statusBySeq.get(targetSeq);
      if (!target || target.status === '到着済') continue;

      const interpolatedMins = Math.round(prev.mins + ((next.mins - prev.mins) * j) / segments);
      if (Number.isNaN(interpolatedMins) || interpolatedMins < 0 || interpolatedMins > 1439) continue;

      const timeStr = minutesToTimeStr(interpolatedMins);
      await client.query(
        `UPDATE vehicle_stop_status
         SET status = '到着済', actual_time = $1, interpolated = TRUE
         WHERE vehicle_id = $2 AND stop_id = $3`,
        [timeStr, vehicleId, target.stop_id]
      );
      filled++;
    }
  }
  return filled;
}

async function pass() {
  const client = await pool.connect();
  const radiusMeters = parseFloat(process.env.STOP_RADIUS_METERS || '120');
  const freshnessMs = parseInt(process.env.GPS_FRESHNESS_MIN || '15', 10) * 60 * 1000;
  let totalPassed = 0;
  let totalInterpolated = 0;

  try {
    const vehicles = await getActiveVehiclesForPass(client);

    for (const vehicle of vehicles) {
      const stopMaster = await getStopMaster(client, vehicle.id);
      if (stopMaster.length === 0) continue;

      const gpsRes = await client.query(
        `SELECT id, gps_time, gps_time_ts, lat, lon FROM vehicle_gps_log
         WHERE vehicle_id = $1 AND matched_label IS NULL
         ORDER BY gps_time_ts ASC`,
        [vehicle.id]
      );
      if (gpsRes.rows.length === 0) {
        await passInterpolate(client, vehicle.id);
        continue;
      }

      const tentative = await passStep1And3(
        client,
        vehicle,
        stopMaster,
        gpsRes.rows,
        radiusMeters,
        freshnessMs
      );
      
      const kept = passStep2Dedup(tentative, stopMaster);

      for (const m of kept) {
        await client.query('BEGIN');
        try {
          await client.query(
            `UPDATE vehicle_gps_log SET matched_stop_id = $1, matched_label = $2 WHERE id = $3`,
            [m.stopId, m.stopName, m.gpsRowId]
          );
          await client.query(
            `UPDATE vehicle_stop_status
             SET status = '到着済', actual_time = $1
             WHERE vehicle_id = $2 AND stop_id = $3 AND status != '到着済'`,
            [m.gpsTime, vehicle.id, m.stopId]
          );
          await client.query(
            `UPDATE vehicles SET last_arrived_seq = GREATEST(last_arrived_seq, $1) WHERE id = $2`,
            [m.seqOrder, vehicle.id]
          );
          await client.query('COMMIT');
          totalPassed++;
          console.log(`[pass] 通過判定: carId=${vehicle.car_id} バス停=${m.stopName} 時刻=${m.gpsTime}`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[pass] エラー carId=${vehicle.car_id}:`, err.message);
        }
      }

      // マッチしなかった（重複除去で外れた）行は再評価できるよう未処理に戻す
      const keptIds = new Set(kept.map((k) => k.gpsRowId));
      const discarded = tentative.filter((m) => !keptIds.has(m.gpsRowId));
      for (const d of discarded) {
        await client.query(`UPDATE vehicle_gps_log SET matched_label = NULL WHERE id = $1`, [
          d.gpsRowId
        ]);
      }

      const filled = await passInterpolate(client, vehicle.id);
      totalInterpolated += filled;
      if (filled > 0) {
        console.log(`[pass] 欠落補完: carId=${vehicle.car_id} 件数=${filled}`);
      }
    }
  } finally {
    client.release();
  }

  return { totalPassed, totalInterpolated };
}

module.exports = { pass };