const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldConfirmDeparture,
  passStepEntry,
  computeSameNameOrderGate,
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

// --- 循環線対策④（同名バス停の通過順序ゲート）のテスト ---
// 美ヶ原温泉線・浅間線のような「往路と復路が区別されない循環線」で、同じ物理バス停を
// 1便で2回通るケース。往路の標柱と復路の標柱は seq_order 違いの同名2行になり、
// 数十m しか離れていないため GPS のばらつきで復路側へ誤マッチしうる。

test('computeSameNameOrderGate: 1回目が未到着なら同名の2回目以降だけをゲートする', () => {
  const stopMaster = [
    { seq_order: 0, name: '松本バスターミナル', status: '到着済' }, // 始発（origin）
    { seq_order: 13, name: '新井口', status: '到着済' },
    { seq_order: 14, name: '新井橋', status: '' },                 // 往路の1回目（未到着）
    { seq_order: 15, name: '藤井', status: '' },
    { seq_order: 19, name: '新井橋', status: '' },                 // 復路の2回目 → ゲート対象
    { seq_order: 33, name: '松本バスターミナル', status: '' }      // 終点（始発が到着済なのでゲートしない）
  ];
  const gate = computeSameNameOrderGate(stopMaster);
  assert.deepEqual([...gate].sort((a, b) => a - b), [19]);
});

test('computeSameNameOrderGate: 1回目が到着済になればゲートは解ける', () => {
  const stopMaster = [
    { seq_order: 14, name: '新井橋', status: '到着済' }, // 往路の1回目が到着済に
    { seq_order: 19, name: '新井橋', status: '' }        // 復路の2回目は候補に戻る
  ];
  assert.equal(computeSameNameOrderGate(stopMaster).size, 0);
});

test('computeSameNameOrderGate: 1回目が付近のうちは2回目をゲートしたままにする', () => {
  const stopMaster = [
    { seq_order: 14, name: '新井橋', status: '付近' },
    { seq_order: 19, name: '新井橋', status: '' }
  ];
  assert.deepEqual([...computeSameNameOrderGate(stopMaster)], [19]);
});

test('computeSameNameOrderGate: 1回しか通らない通常路線ではゲートは空（現行挙動を変えない）', () => {
  const stopMaster = [
    { seq_order: 0, name: 'A', status: '到着済' },
    { seq_order: 1, name: 'B', status: '' },
    { seq_order: 2, name: 'C', status: '' },
    { seq_order: 3, name: 'D', status: '' }
  ];
  assert.equal(computeSameNameOrderGate(stopMaster).size, 0);
});

test('computeSameNameOrderGate: 同名が3回登場する場合、直前の同名が片付いている回だけ候補に戻す', () => {
  const stopMaster = [
    { seq_order: 0, name: 'ターミナル', status: '到着済' }, // 1回目（始発）は済み
    { seq_order: 5, name: 'ターミナル', status: '' },        // 2回目：直前(seq0)が到着済 → ゲートしない
    { seq_order: 9, name: 'ターミナル', status: '' }         // 3回目：直前(seq5)が未到着 → ゲートする
  ];
  assert.deepEqual([...computeSameNameOrderGate(stopMaster)], [9]);
});

// passStepEntry の結合テスト。新井橋（往路 seq14 / 復路 seq19、約60m）に相当する配置で、
// GPS点が復路側の標柱の方に近くても、往路側が未到着なら復路側へは付近入りしないこと。
const ARAIBASHI_OUT = { stop_id: 140, seq_order: 14, name: '新井橋', lat: 36.242741, lon: 137.999857, scheduled_time: '6:13' };
const ARAIBASHI_IN = { stop_id: 190, seq_order: 19, name: '新井橋', lat: 36.243198, lon: 137.999377, scheduled_time: '6:20' };
function loopStopMaster(overrides = {}) {
  const base = [
    { stop_id: 130, seq_order: 13, name: '新井口', lat: 36.241774, lon: 137.996229, status: '到着済', scheduled_time: '6:11' },
    { ...ARAIBASHI_OUT, status: '' },
    { stop_id: 150, seq_order: 15, name: '藤井', lat: 36.243285, lon: 138.004533, status: '', scheduled_time: '6:15' },
    { ...ARAIBASHI_IN, status: '' },
    { stop_id: 200, seq_order: 20, name: '新井口', lat: 36.241659, lon: 137.996159, status: '', scheduled_time: '6:22' }
  ];
  return base.map((s) => ({ ...s, ...(overrides[s.seq_order] || {}) }));
}

test('passStepEntry: 往路の新井橋が未到着なら、GPSが復路側に近くても復路側へは付近入りしない', () => {
  const stopMaster = loopStopMaster();
  // 復路標柱(seq19)から約9m・往路標柱(seq14)から約58m の1点（GPSのばらつきを模した配置）
  const gpsRows = [
    { id: 1, gps_time: '6:13', gps_time_ts: '2026-08-25T06:13:00+09:00', lat: 36.24315, lon: 137.99945 }
  ];
  const matches = passStepEntry({ start_time: '6:00' }, stopMaster, gpsRows, 120, null);
  assert.equal(matches.length, 1);
  // 復路側(seq19)ではなく往路側(seq14)へ付近入りする
  assert.equal(matches[0].seqOrder, 14);
  assert.equal(matches[0].stopId, ARAIBASHI_OUT.stop_id);
});

test('passStepEntry: 往路の新井橋が到着済になれば、復路側の新井橋へ通常どおり付近入りできる', () => {
  const stopMaster = loopStopMaster({ 14: { status: '到着済', actual_time: '6:13' } });
  const gpsRows = [
    { id: 1, gps_time: '6:20', gps_time_ts: '2026-08-25T06:20:00+09:00', lat: 36.24315, lon: 137.99945 }
  ];
  const matches = passStepEntry({ start_time: '6:00' }, stopMaster, gpsRows, 120, null);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].seqOrder, 19);
  assert.equal(matches[0].stopId, ARAIBASHI_IN.stop_id);
});

test('passStepEntry: 同名バス停が無い通常配置では従来どおり最近傍へ付近入りする（回帰防止）', () => {
  const stopMaster = [
    { stop_id: 1, seq_order: 0, name: 'A', lat: 36.2400, lon: 137.9700, status: '到着済', scheduled_time: '6:00' },
    { stop_id: 2, seq_order: 1, name: 'B', lat: 36.2410, lon: 137.9700, status: '', scheduled_time: '6:02' },
    { stop_id: 3, seq_order: 2, name: 'C', lat: 36.2420, lon: 137.9700, status: '', scheduled_time: '6:04' }
  ];
  const gpsRows = [
    { id: 1, gps_time: '6:02', gps_time_ts: '2026-08-25T06:02:00+09:00', lat: 36.2410, lon: 137.9700 }
  ];
  const matches = passStepEntry({ start_time: '6:00' }, stopMaster, gpsRows, 120, null);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].seqOrder, 1);
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
