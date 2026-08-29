const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldConfirmDeparture,
  passStepConfirm,
  buildNearbyTrackingState,
  findNextUnarrivedStop,
  evaluateVectorCrossing,
  findVectorConfirmation,
  describeArrivalMethod
} = require('../src/services/passDetection');

test('shouldConfirmDeparture: マージン以内は到着確定しない', () => {
  assert.equal(shouldConfirmDeparture(50, 40, 20), false);
  assert.equal(shouldConfirmDeparture(60, 40, 20), false); // 40+20=60ちょうどは含まない
});

test('shouldConfirmDeparture: マージンを超えたら到着確定', () => {
  assert.equal(shouldConfirmDeparture(61, 40, 20), true);
});

// バス停は緯度経度をそのまま距離計算に使わず、テストでは真上（同経度）の南北方向の
// オフセットで距離を作る（緯度1度 ≈ 111km、0.0001度 ≈ 11m）。
const STOP = { lat: 36.2380, lon: 137.9720 };
function gpsAtOffsetMeters(offsetMeters, gpsTime, gpsTimeTs) {
  const deltaLat = offsetMeters / 111000;
  return { lat: STOP.lat + deltaLat, lon: STOP.lon, gps_time: gpsTime, gps_time_ts: gpsTimeTs };
}

function makeNearbyStop(minDistMeters, minGpsTime, minGpsTimeTs) {
  return {
    stopId: 1,
    seqOrder: 3,
    lat: STOP.lat,
    lon: STOP.lon,
    minDist: minDistMeters,
    minGpsTime,
    minGpsTimeTs
  };
}

test('passStepConfirm: 距離が縮み続ける間は到着確定しない（最小距離だけ更新）', () => {
  const stop = makeNearbyStop(80, '8:00', '2026-08-25T08:00:00+09:00');
  const gpsRows = [
    gpsAtOffsetMeters(60, '8:01', '2026-08-25T08:01:00+09:00'),
    gpsAtOffsetMeters(30, '8:02', '2026-08-25T08:02:00+09:00')
  ];
  const results = passStepConfirm([stop], gpsRows, 20);
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'refine');
  assert.ok(Math.abs(results[0].minDist - 30) < 1);
  assert.equal(results[0].minGpsTime, '8:02');
});

test('passStepConfirm: 最小距離+マージンを超えて離れたら到着確定し、actualTimeは最小距離の時点になる', () => {
  const stop = makeNearbyStop(100, '8:00', '2026-08-25T08:00:00+09:00');
  const gpsRows = [
    gpsAtOffsetMeters(40, '8:01', '2026-08-25T08:01:00+09:00'), // 最小距離を更新（100->40）
    gpsAtOffsetMeters(70, '8:02', '2026-08-25T08:02:00+09:00')  // 40+20=60を超えて離れた -> 到着確定
  ];
  const results = passStepConfirm([stop], gpsRows, 20);
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'confirm');
  assert.equal(results[0].stopId, 1);
  assert.equal(results[0].actualTime, '8:01'); // 遠ざかりを検知した8:02ではなく、最小距離の8:01
  // arrival_evidence 用に最接近の距離・GPS時刻も confirm 結果へ含める
  assert.ok(Math.abs(results[0].minDist - 40) < 1, `minDist was ${results[0].minDist}`);
  assert.equal(results[0].minGpsTime, '8:01');
});

test('passStepConfirm: 記録済み最小距離より前のGPS点は評価しない（古い未消費pingによる巻き戻り防止）', () => {
  const stop = makeNearbyStop(40, '8:05', '2026-08-25T08:05:00+09:00');
  const gpsRows = [
    // 記録済みの最小距離観測時刻(8:05)より前の点。仮にこれが0mでも無視されなければならない。
    gpsAtOffsetMeters(0, '7:50', '2026-08-25T07:50:00+09:00'),
    gpsAtOffsetMeters(70, '8:06', '2026-08-25T08:06:00+09:00')
  ];
  const results = passStepConfirm([stop], gpsRows, 20);
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'confirm');
  assert.equal(results[0].actualTime, '8:05'); // 7:50の0m点に巻き戻されていないこと
});

test('buildNearbyTrackingState: DB由来の付近状態とこのバッチの新規付近入りをマージする', () => {
  const stopMaster = [
    { stop_id: 1, seq_order: 1, lat: 36.0, lon: 137.0, status: '到着済' },
    { stop_id: 2, seq_order: 2, lat: 36.1, lon: 137.1, status: '付近', nearby_min_distance_meters: 55, nearby_min_distance_gps_time: '8:10', nearby_min_distance_gps_time_ts: '2026-08-25T08:10:00+09:00' },
    { stop_id: 3, seq_order: 3, lat: 36.2, lon: 137.2, status: '' }
  ];
  const freshEntries = [
    { stopId: 3, seqOrder: 3, dist: 90, gpsTime: '8:20', gpsTimeTs: '2026-08-25T08:20:00+09:00' }
  ];
  const state = buildNearbyTrackingState(stopMaster, freshEntries);
  assert.equal(state.length, 2);
  const byStopId = new Map(state.map((s) => [s.stopId, s]));
  assert.equal(byStopId.get(2).minDist, 55);
  assert.equal(byStopId.get(3).minDist, 90);
  assert.equal(byStopId.get(3).lat, 36.2); // GPS点の座標ではなく、バス停自身の座標を使うこと
});

// --- ここからベクトル通過判定（到着判定高速化）のテスト ---
// STOPを原点(0,0)として、北方向オフセットnorthMeters・東方向オフセットeastMetersで
// GPS点を作る（緯度1度≈111000m、経度は緯度によるcos補正込み）。
function gpsAt2DOffsetMeters(northMeters, eastMeters, gpsTime, gpsTimeTs) {
  const deltaLat = northMeters / 111000;
  const deltaLon = eastMeters / (111000 * Math.cos((STOP.lat * Math.PI) / 180));
  return { lat: STOP.lat + deltaLat, lon: STOP.lon + deltaLon, gps_time: gpsTime, gps_time_ts: gpsTimeTs };
}

test('findNextUnarrivedStop: 最後に到着済のバス停の直後の1件だけを返す', () => {
  const stopMaster = [
    { stop_id: 1, seq_order: 1, status: '到着済' },
    { stop_id: 2, seq_order: 2, status: '到着済' },
    { stop_id: 3, seq_order: 3, status: '付近' },
    { stop_id: 4, seq_order: 4, status: '' }
  ];
  const next = findNextUnarrivedStop(stopMaster);
  assert.equal(next.stop_id, 3);
});

test('findNextUnarrivedStop: 全停留所が到着済ならnull', () => {
  const stopMaster = [
    { stop_id: 1, seq_order: 1, status: '到着済' },
    { stop_id: 2, seq_order: 2, status: '到着済' }
  ];
  assert.equal(findNextUnarrivedStop(stopMaster), null);
});

test('findNextUnarrivedStop: extraArrivedSeqOrdersで同一バッチ内の確定分を考慮する', () => {
  const stopMaster = [
    { stop_id: 1, seq_order: 1, status: '到着済' },
    { stop_id: 2, seq_order: 2, status: '付近' }, // stopMaster取得後にこのバッチで到着確定済み（スナップショットには未反映）
    { stop_id: 3, seq_order: 3, status: '' }
  ];
  const withoutExtra = findNextUnarrivedStop(stopMaster);
  assert.equal(withoutExtra.stop_id, 2); // 素の状態のままだとstop2を返してしまう
  const withExtra = findNextUnarrivedStop(stopMaster, [2]);
  assert.equal(withExtra.stop_id, 3); // 追加確定分を考慮すると正しくstop3を返す
});

test('evaluateVectorCrossing: バス停を挟んで直進通過した場合は確定する', () => {
  const stop = { lat: STOP.lat, lon: STOP.lon };
  const p1 = gpsAt2DOffsetMeters(-100, 0, '8:10', '2026-08-25T08:10:00+09:00');
  const p2 = gpsAt2DOffsetMeters(100, 0, '8:12', '2026-08-25T08:12:00+09:00');
  const result = evaluateVectorCrossing(p1, p2, stop);
  assert.equal(result.confirmed, true);
  assert.ok(Math.abs(result.t - 0.5) < 0.01, `t was ${result.t}`);
});

test('evaluateVectorCrossing: バス停から50m以内をかすめて通過した場合も確定する（線分条件）', () => {
  const stop = { lat: STOP.lat, lon: STOP.lon };
  const p1 = gpsAt2DOffsetMeters(-100, 20, '8:10', '2026-08-25T08:10:00+09:00');
  const p2 = gpsAt2DOffsetMeters(80, 20, '8:12', '2026-08-25T08:12:00+09:00');
  const result = evaluateVectorCrossing(p1, p2, stop);
  assert.equal(result.confirmed, true);
  assert.ok(Math.abs(result.debug.segDist - 20) < 1, `segDist was ${result.debug.segDist}`);
});

test('evaluateVectorCrossing: バス停から100mより離れた経路は確定しない（線分条件）', () => {
  const stop = { lat: STOP.lat, lon: STOP.lon };
  const p1 = gpsAt2DOffsetMeters(-100, 150, '8:10', '2026-08-25T08:10:00+09:00');
  const p2 = gpsAt2DOffsetMeters(80, 150, '8:12', '2026-08-25T08:12:00+09:00');
  const result = evaluateVectorCrossing(p1, p2, stop);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'segment_too_far');
});

test('evaluateVectorCrossing: まだバス停側に到達していない（反対側に抜けていない）場合は確定しない', () => {
  const stop = { lat: STOP.lat, lon: STOP.lon };
  // P2をバス停の30m手前(まだ同じ側)に置く。クランプにより線分最短距離はP2自身
  // までの距離(30m、<=50mの線分条件は満たす)になるため、ベクトル条件のみで弾かれる。
  const p1 = gpsAt2DOffsetMeters(-100, 0, '8:10', '2026-08-25T08:10:00+09:00');
  const p2 = gpsAt2DOffsetMeters(-30, 0, '8:11', '2026-08-25T08:11:00+09:00'); // 依然として同じ側
  const result = evaluateVectorCrossing(p1, p2, stop);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'not_opposite_side');
});

test('evaluateVectorCrossing: P1-P2間の距離が10m未満なら判定しない（フォールバック）', () => {
  const stop = { lat: STOP.lat, lon: STOP.lon };
  const p1 = gpsAt2DOffsetMeters(-3, 0, '8:10', '2026-08-25T08:10:00+09:00');
  const p2 = gpsAt2DOffsetMeters(3, 0, '8:10', '2026-08-25T08:10:05+09:00');
  const result = evaluateVectorCrossing(p1, p2, stop);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'step_distance_out_of_range');
});

test('evaluateVectorCrossing: P1-P2間の距離が700mを超えたら判定しない（フォールバック）', () => {
  const stop = { lat: STOP.lat, lon: STOP.lon };
  const p1 = gpsAt2DOffsetMeters(-400, 0, '8:10', '2026-08-25T08:10:00+09:00');
  const p2 = gpsAt2DOffsetMeters(400, 0, '8:11', '2026-08-25T08:11:00+09:00');
  const result = evaluateVectorCrossing(p1, p2, stop);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'step_distance_out_of_range');
});

test('evaluateVectorCrossing: P1・P2ともにバス停から600mを超えたら判定しない（フォールバック）', () => {
  const stop = { lat: STOP.lat, lon: STOP.lon };
  const p1 = gpsAt2DOffsetMeters(-700, 0, '8:10', '2026-08-25T08:10:00+09:00');
  const p2 = gpsAt2DOffsetMeters(-650, 0, '8:11', '2026-08-25T08:11:00+09:00');
  const result = evaluateVectorCrossing(p1, p2, stop);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'too_far_from_stop');
});

test('evaluateVectorCrossing: 600m以内だがどちらも500mより遠い場合は判定しない（フォールバック）', () => {
  const stop = { lat: STOP.lat, lon: STOP.lon };
  const p1 = gpsAt2DOffsetMeters(-550, 0, '8:10', '2026-08-25T08:10:00+09:00');
  const p2 = gpsAt2DOffsetMeters(-520, 0, '8:11', '2026-08-25T08:11:00+09:00');
  const result = evaluateVectorCrossing(p1, p2, stop);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'not_close_enough');
});

test('findVectorConfirmation: 履歴が1点以下ならnull（フォールバック）', () => {
  const stop = { stop_id: 3, seq_order: 3, name: 'テスト停', lat: STOP.lat, lon: STOP.lon };
  assert.equal(findVectorConfirmation([], stop), null);
  assert.equal(findVectorConfirmation([gpsAt2DOffsetMeters(-100, 0, '8:10', '2026-08-25T08:10:00+09:00')], stop), null);
});

test('findVectorConfirmation: 最初に条件を満たしたペアで確定し、actual_timeはt補間したH:mm形式になる', () => {
  const stop = { stop_id: 3, seq_order: 3, name: 'テスト停', lat: STOP.lat, lon: STOP.lon };
  const gpsRows = [
    gpsAt2DOffsetMeters(-820, 0, '8:05', '2026-08-25T08:05:00+09:00'), // ペア距離が700mを超え対象外(step_distance_out_of_range)
    gpsAt2DOffsetMeters(-100, 0, '8:10', '2026-08-25T08:10:00+09:00'), // P1（このペアから条件成立）
    gpsAt2DOffsetMeters(100, 0, '8:12', '2026-08-25T08:12:00+09:00')   // P2
  ];
  const result = findVectorConfirmation(gpsRows, stop);
  assert.ok(result, 'ベクトル判定で確定するはず');
  assert.equal(result.stopId, 3);
  assert.equal(result.seqOrder, 3);
  assert.equal(result.actualTime, '8:11'); // 8:10と8:12のt=0.5補間
});

test('findVectorConfirmation: 条件を満たすペアが無ければnull（フォールバック、従来ロジックのみ使用）', () => {
  const stop = { stop_id: 3, seq_order: 3, name: 'テスト停', lat: STOP.lat, lon: STOP.lon };
  const gpsRows = [
    gpsAt2DOffsetMeters(-100, 0, '8:10', '2026-08-25T08:10:00+09:00'),
    gpsAt2DOffsetMeters(-50, 0, '8:11', '2026-08-25T08:11:00+09:00') // まだ反対側に抜けていない
  ];
  assert.equal(findVectorConfirmation(gpsRows, stop), null);
});

test('describeArrivalMethod: 既知の判定方法は日本語ラベルを返す', () => {
  assert.equal(describeArrivalMethod('vector').label, 'ベクトル判定');
  assert.equal(describeArrivalMethod('nearby').label, '付近経由');
  assert.equal(describeArrivalMethod('manual').label, '手動確定');
  assert.ok(describeArrivalMethod('interpolated').description.length > 0);
});

test('describeArrivalMethod: 未知値・null はフォールバックする', () => {
  assert.equal(describeArrivalMethod(null).label, '記録なし');
  assert.equal(describeArrivalMethod('なにか未知の値').label, 'なにか未知の値');
  assert.equal(describeArrivalMethod('なにか未知の値').description, '');
});
