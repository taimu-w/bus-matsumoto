// 車両ごとの「直近の運行履歴」（vehicle_operation_history）の記録・参照。
//
// 管理者が「この車両は最近どの路線・どの便で運用されたか」を車両単位で確認するための機能。
// completed_trips は COMPLETED_TRIP_RETENTION_DAYS（既定7日）で purge されるため、たまにしか
// 走らない予備車・応援車の運用実績が追えない。そこで car_id × 曜日区分（バケット）ごとに
// 「直近1日ぶんの便」だけを保持する（平日1日分・土休日1日分。1便=1行）。
//
// - 記録: finishService.archiveAssignment() から、便の実績として正とみなす割り当て
//   （is_official=TRUE）について recordVehicleOperation() を呼ぶ。1便追記したうえで、
//   そのバケットの「最新の運行日」より前の行を掃除する（冪等・クローズ順非依存）。
// - 参照: 管理画面「車両運用状況」（一覧）と、運行ダッシュボードで車両名/車両IDをタップした
//   ときの詳細（GET /api/admin/vehicle-operation-status、/api/admin/vehicle-operation-history/:carId）。
//
// 曜日区分（day_type）は utils/time.js の getDayType() と同じ 'weekday' / 'saturday' / 'holiday'。
// 要件上の「土休日」は saturday + holiday を参照・掃除時にまとめる（bucketOperationRows / BUCKET_DAY_TYPES）。

// day_type → 表示上のバケット。
const BUCKET_BY_DAY_TYPE = {
  weekday: 'weekday',
  saturday: 'weekendHoliday',
  holiday: 'weekendHoliday'
};

// バケット → そのバケットに属する day_type の配列（掃除の DELETE 条件に使う）。
const BUCKET_DAY_TYPES = {
  weekday: ['weekday'],
  saturday: ['saturday', 'holiday'],
  holiday: ['saturday', 'holiday']
};

/**
 * 1台ぶんの vehicle_operation_history 行を、「直近の平日1日分」「直近の土休日1日分」の
 * 2枠（それぞれ便の配列）へ畳む純関数。掃除が追いつかず古い日の行が残っていても、
 * 各バケットで最新 service_date の便だけを返す（表示側の保険）。便は始発時刻の昇順。
 *
 * @param {Array<{dayType:string, serviceDate:string, startTime:string, startAt:(string|Date),
 *                routeId:string, routeName:string, headsign:(string|null)}>} rows
 * @returns {{weekday: object[], weekendHoliday: object[]}}
 */
function bucketOperationRows(rows) {
  const groups = { weekday: [], weekendHoliday: [] };
  for (const row of rows || []) {
    const bucket = BUCKET_BY_DAY_TYPE[row.dayType];
    if (bucket) groups[bucket].push(row);
  }
  const latestDay = (list) => {
    if (list.length === 0) return [];
    const maxDate = list.reduce((m, r) => (r.serviceDate > m ? r.serviceDate : m), list[0].serviceDate);
    return list
      .filter((r) => r.serviceDate === maxDate)
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  };
  return { weekday: latestDay(groups.weekday), weekendHoliday: latestDay(groups.weekendHoliday) };
}

/**
 * 便のクローズ時に、その車両の当該バケットの「直近の運行履歴」を更新する。
 *  1) この便を1行追記する（同一便の再クローズに備え UPSERT）。
 *  2) そのバケット（平日 / 土休日）で最新の運行日より前の行を消す。
 *     冪等かつクローズ順非依存なので、便が前後してクローズされても・運行日終了バッチで
 *     前日以前の便が後からクローズされても、直近1日分だけが残る（古い便は自分自身の掃除で消える）。
 *
 * @param {import('pg').PoolClient} client 呼び出し元のトランザクションと同じ接続
 */
async function recordVehicleOperation(client, params) {
  const { carId, dayType, serviceDate, startTime, startAt, routeId, headsign, completedTripId } = params;
  const bucketDayTypes = BUCKET_DAY_TYPES[dayType];
  if (!bucketDayTypes) return; // 想定外の day_type は記録しない（CHECK制約とも整合）

  await client.query(
    `INSERT INTO vehicle_operation_history
       (car_id, day_type, service_date, start_time, start_at, route_id, headsign, completed_trip_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (car_id, day_type, start_at) DO UPDATE SET
       service_date = EXCLUDED.service_date,
       start_time = EXCLUDED.start_time,
       route_id = EXCLUDED.route_id,
       headsign = EXCLUDED.headsign,
       completed_trip_id = EXCLUDED.completed_trip_id,
       updated_at = now()`,
    [carId, dayType, serviceDate, startTime, startAt, routeId, headsign || null, completedTripId || null]
  );

  await client.query(
    `DELETE FROM vehicle_operation_history v
     WHERE v.car_id = $1 AND v.day_type = ANY($2::text[])
       AND v.service_date < (
         SELECT max(service_date) FROM vehicle_operation_history
         WHERE car_id = $1 AND day_type = ANY($2::text[])
       )`,
    [carId, bucketDayTypes]
  );
}

/**
 * 指定した car_id 群について、直近の平日1日分・土休日1日分の運行履歴を返す。
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {string[]} carIds
 * @returns {Promise<Map<string, {weekday: object[], weekendHoliday: object[]}>>}
 */
async function getOperationHistoryByCarIds(db, carIds) {
  const byCar = new Map();
  if (!Array.isArray(carIds) || carIds.length === 0) return byCar;
  for (const carId of carIds) byCar.set(carId, { weekday: [], weekendHoliday: [] });

  const res = await db.query(
    `SELECT h.car_id, h.day_type, h.service_date::text AS service_date,
            h.start_time, h.start_at, h.headsign, h.route_id, r.name AS route_name
     FROM vehicle_operation_history h
     LEFT JOIN routes r ON r.id = h.route_id
     WHERE h.car_id = ANY($1::text[])`,
    [carIds]
  );

  const rowsByCar = new Map();
  for (const row of res.rows) {
    const list = rowsByCar.get(row.car_id) || [];
    list.push({
      dayType: row.day_type,
      serviceDate: row.service_date,
      startTime: row.start_time,
      startAt: row.start_at,
      routeId: row.route_id,
      routeName: row.route_name || row.route_id,
      headsign: row.headsign || null
    });
    rowsByCar.set(row.car_id, list);
  }
  for (const [carId, rows] of rowsByCar.entries()) {
    byCar.set(carId, bucketOperationRows(rows));
  }
  return byCar;
}

module.exports = { bucketOperationRows, recordVehicleOperation, getOperationHistoryByCarIds };
