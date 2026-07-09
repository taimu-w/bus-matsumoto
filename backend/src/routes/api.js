const express = require('express');
const pool = require('../config/db');
const { predictArrivals } = require('../services/etaPredictor');

const router = express.Router();

// GET /api/settings -> お知らせ・重要なお知らせ（GASの「設定 システム」シート相当）
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM system_settings');
    const settings = {};
    for (const row of result.rows) settings[row.key] = row.value;
    res.json({
      notice1: settings.notice1 || '',
      notice2: settings.notice2 || '',
      importantNotice: settings.important_notice || '',
      routeName: settings.route_name || '',
      operatorName: settings.operator_name || ''
    });
  } catch (err) {
    console.error('[api] /settings エラー:', err);
    res.status(500).json({ error: 'システム設定の取得に失敗しました。' });
  }
});

// GET /api/stops -> 全バス停マスタ（時刻表画面・地図表示用）
router.get('/stops', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, seq_order, name, name_kana, name_en, lat, lon, notice, timetable_link FROM stops ORDER BY seq_order ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[api] /stops エラー:', err);
    res.status(500).json({ error: 'バス停情報の取得に失敗しました。' });
  }
});

// GET /api/timetable -> 全便の時刻表（非リアルタイム表示・バス停詳細用）
router.get('/timetable', async (req, res) => {
  try {
    const trips = await pool.query('SELECT id, trip_index, first_stop_time FROM schedule_trips ORDER BY trip_index ASC');
    const times = await pool.query(
      `SELECT st.trip_id, s.seq_order, s.name AS stop_name, st.scheduled_time, st.is_through
       FROM schedule_stop_times st JOIN stops s ON s.id = st.stop_id
       ORDER BY st.trip_id ASC, s.seq_order ASC`
    );
    const byTrip = new Map();
    for (const t of trips.rows) byTrip.set(t.id, { tripIndex: t.trip_index, stops: [] });
    for (const r of times.rows) {
      const entry = byTrip.get(r.trip_id);
      if (entry) {
        entry.stops.push({
          seqOrder: r.seq_order,
          stopName: r.stop_name,
          scheduledTime: r.is_through ? null : r.scheduled_time
        });
      }
    }
    res.json(Array.from(byTrip.values()));
  } catch (err) {
    console.error('[api] /timetable エラー:', err);
    res.status(500).json({ error: '時刻表の取得に失敗しました。' });
  }
});

// GET /api/buses -> 稼働中バスのリアルタイム運行状況（GASの getBusData() 相当）
router.get('/buses', async (req, res) => {
  try {
    const vehicles = await pool.query(
      `SELECT id, car_id, business_start_time, departure_time, trip_type, delay_minutes, trip_id
       FROM vehicles WHERE status = 'active' ORDER BY id ASC`
    );

    const buses = [];
    for (const v of vehicles.rows) {
      const stopRows = await pool.query(
        `SELECT vss.stop_id, vss.seq_order, vss.scheduled_time, vss.status, vss.actual_time,
                vss.delay_minutes, vss.interpolated, s.name, s.lat, s.lon, s.notice, s.timetable_link
         FROM vehicle_stop_status vss
         JOIN stops s ON s.id = vss.stop_id
         WHERE vss.vehicle_id = $1
         ORDER BY vss.seq_order ASC`,
        [v.id]
      );

      const hasAnyProgress = stopRows.rows.some((r) => r.status !== '');
      if (!hasAnyProgress) continue; // まだ何も検知できていない車両は表示しない（GASのhasDataチェック相当）

      const predictions = await predictArrivals(pool, v.id);
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

      buses.push({
        id: v.car_id,
        routeName: '横田信大循環線',
        isRealtime: !!v.departure_time,
        tripType: v.trip_type,
        delayMinutes: v.delay_minutes,
        stops
      });
    }

    res.json({ buses });
  } catch (err) {
    console.error('[api] /buses エラー:', err);
    res.status(500).json({ error: '運行情報の取得に失敗しました。' });
  }
});

module.exports = router;
