const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTransferIndex,
  parseTransferRules,
  addTransferRules,
  lookupMinTransferSeconds
} = require('../src/services/gtfsTransfers');
const {
  buildBoardingsByGroup,
  runRaptor,
  runRaptorReverse,
  normalizeReverseLabels,
  buildJourney,
  normalizeSearchPreferences
} = require('../src/services/gtfsRouteSearch');

const makeKey = (feedId, id) => `${feedId}:${id}`;

function transferIndexOf(rows, childStopIdsByParent) {
  const transfers = createTransferIndex();
  addTransferRules(transfers, parseTransferRules(rows, { feedId: 'f', makeKey, childStopIdsByParent }));
  return transfers;
}

/* ---------- parseTransferRules / lookupMinTransferSeconds ---------- */

test('min_transfer_time が指定された行だけを使う（空・不正・乗換不可は無視）', () => {
  const transfers = transferIndexOf([
    { from_stop_id: 'a', to_stop_id: 'b', transfer_type: '2', min_transfer_time: '180' },
    { from_stop_id: 'a', to_stop_id: 'c', transfer_type: '0', min_transfer_time: '' },
    { from_stop_id: 'a', to_stop_id: 'd', transfer_type: '2', min_transfer_time: 'abc' },
    { from_stop_id: 'a', to_stop_id: 'e', transfer_type: '3', min_transfer_time: '60' },
    { from_stop_id: 'a', to_stop_id: 'g', transfer_type: '', min_transfer_time: '0' }
  ]);
  assert.equal(lookupMinTransferSeconds(transfers, 'f:a', 'f:b'), 180);
  assert.equal(lookupMinTransferSeconds(transfers, 'f:a', 'f:c'), null);
  assert.equal(lookupMinTransferSeconds(transfers, 'f:a', 'f:d'), null);
  assert.equal(lookupMinTransferSeconds(transfers, 'f:a', 'f:e'), null);
  // 0秒の指定も「指定あり」
  assert.equal(lookupMinTransferSeconds(transfers, 'f:a', 'f:g'), 0);
  // 向きがある（b→a は指定なし）
  assert.equal(lookupMinTransferSeconds(transfers, 'f:b', 'f:a'), null);
});

test('transfers.txt が無い（空の索引）なら常に null', () => {
  assert.equal(lookupMinTransferSeconds(createTransferIndex(), 'f:a', 'f:b'), null);
  assert.equal(lookupMinTransferSeconds(undefined, 'f:a', 'f:b'), null);
});

test('駅（親停留所）を指す行は配下の標柱すべてに展開する', () => {
  const transfers = transferIndexOf(
    [{ from_stop_id: 'st', to_stop_id: 'st', transfer_type: '2', min_transfer_time: '240' }],
    new Map([['st', ['st_1', 'st_2']]])
  );
  assert.equal(lookupMinTransferSeconds(transfers, 'f:st_1', 'f:st_2'), 240);
  assert.equal(lookupMinTransferSeconds(transfers, 'f:st_2', 'f:st_1'), 240);
  assert.equal(lookupMinTransferSeconds(transfers, 'f:st_1', 'f:st_1'), 240);
});

test('便指定 > 路線指定 > 標柱のみ の順で具体的な行を優先し、合わない条件の行は使わない', () => {
  const transfers = transferIndexOf([
    { from_stop_id: 'a', to_stop_id: 'b', transfer_type: '2', min_transfer_time: '120' },
    { from_stop_id: 'a', to_stop_id: 'b', to_route_id: 'R2', transfer_type: '2', min_transfer_time: '300' },
    { from_stop_id: 'a', to_stop_id: 'b', from_trip_id: 't1', transfer_type: '2', min_transfer_time: '30' }
  ]);
  const r1 = { tripKey: 'f:t9', routeKey: 'f:R1' };
  assert.equal(lookupMinTransferSeconds(transfers, 'f:a', 'f:b', r1, { tripKey: 'f:t5', routeKey: 'f:R1' }), 120);
  assert.equal(lookupMinTransferSeconds(transfers, 'f:a', 'f:b', r1, { tripKey: 'f:t5', routeKey: 'f:R2' }), 300);
  assert.equal(
    lookupMinTransferSeconds(transfers, 'f:a', 'f:b', { tripKey: 'f:t1', routeKey: 'f:R1' }, { tripKey: 'f:t5', routeKey: 'f:R2' }),
    30
  );
});

test('利用者が乗換余裕を明示したときだけ、指定値の下限になる', () => {
  assert.equal(normalizeSearchPreferences({}).transferFloorSeconds, 0);
  assert.equal(normalizeSearchPreferences({ minTransferMinutes: '' }).transferFloorSeconds, 0);
  assert.equal(normalizeSearchPreferences({ minTransferMinutes: '5' }).transferFloorSeconds, 300);
});

/* ---------- 経路探索への反映（合成したGTFSインデックス） ----------
 *
 *  O ──便1(R1)──▶ T(のりば a)  … 900発 → 1000着
 *                 T(のりば b) ──便2(R2)──▶ D  … 1030発 → 1300着
 *                 T(のりば b) ──便3(R2)──▶ D  … 1200発 → 1500着
 *                 T(のりば b) ──便4(R2)──▶ D  … 1400発 → 1600着
 *  W(のりば w、Tから徒歩300秒) ──便5(R3)──▶ D  … 1100発 → 1250着
 */
function buildFixture(transferRows = []) {
  const index = {
    routes: new Map(),
    stops: new Map(),
    groups: new Map(),
    trips: new Map(),
    stopTimesByTrip: new Map(),
    transfers: transferIndexOf(transferRows)
  };
  const group = (groupKey, lat, lon) => index.groups.set(groupKey, { groupKey, name: groupKey, lat, lon });
  group('O', 36.0, 137.0);
  group('T', 36.01, 137.0);
  group('W', 36.012, 137.0);
  group('D', 36.02, 137.0);
  const stop = (stopId, groupKey) => {
    const g = index.groups.get(groupKey);
    index.stops.set(makeKey('f', stopId), {
      feedId: 'f', stopId, stopKey: makeKey('f', stopId), groupKey, name: groupKey, lat: g.lat, lon: g.lon, platformCode: ''
    });
  };
  stop('o', 'O');
  stop('a', 'T');
  stop('b', 'T');
  stop('w', 'W');
  stop('d', 'D');
  for (const routeId of ['R1', 'R2', 'R3']) {
    index.routes.set(makeKey('f', routeId), { feedId: 'f', routeId, routeKey: makeKey('f', routeId), name: routeId, shortName: '', color: '', textColor: '', agencyName: '' });
  }
  const trip = (tripId, routeId, calls) => {
    const tripKey = makeKey('f', tripId);
    index.trips.set(tripKey, {
      feedId: 'f', tripId, tripKey, routeId, routeKey: makeKey('f', routeId), serviceId: 's', directionId: 0,
      headsign: 'D', shortName: '', firstDepartureSeconds: calls[0][1], frequencies: null
    });
    index.stopTimesByTrip.set(tripKey, calls.map(([stopId, seconds], i) => ({
      tripKey, stopKey: makeKey('f', stopId), stopId, sequence: i + 1, tripIndex: i,
      arrivalSeconds: seconds, departureSeconds: seconds, stopHeadsign: '', pickupType: 0, dropOffType: 0
    })));
  };
  trip('t1', 'R1', [['o', 900], ['a', 1000]]);
  trip('t2', 'R2', [['b', 1030], ['d', 1300]]);
  trip('t3', 'R2', [['b', 1200], ['d', 1500]]);
  trip('t4', 'R2', [['b', 1400], ['d', 1600]]);
  trip('t5', 'R3', [['w', 1100], ['d', 1250]]);
  return index;
}

function contextOf(index, { walk = false, transferFloorSeconds = 0 } = {}) {
  const footpaths = new Map();
  if (walk) {
    footpaths.set('T', [{ groupKey: 'W', walkSeconds: 300, distanceMeters: 250 }]);
    footpaths.set('W', [{ groupKey: 'T', walkSeconds: 300, distanceMeters: 250 }]);
  }
  return {
    searchIndex: { index, boardingsByGroup: buildBoardingsByGroup(index), alightingsByGroup: null },
    footpaths,
    activeTripsByShift: [{ offsetSeconds: 0, activeTripKeys: new Set(index.trips.keys()) }],
    maxRounds: 3,
    windowSeconds: 6 * 3600,
    minTransferSeconds: 60,
    transferFloorSeconds
  };
}

function earliestArrival(ctx) {
  const results = runRaptor(ctx, new Map([['O', 800]]), new Set(['D']));
  return results.length ? Math.min(...results.map((r) => r.arrivalSeconds)) : null;
}

function latestDeparture(ctx, deadline) {
  const results = runRaptorReverse(ctx, new Map([['D', deadline]]), new Set(['O']));
  return results.length ? Math.max(...results.map((r) => r.departureSeconds)) : null;
}

test('指定が無ければ既定の乗換余裕（60秒）で探索する', () => {
  const index = buildFixture();
  assert.equal(earliestArrival(contextOf(index)), 1500); // 1000着+60 > 1030発 → 便3
  assert.equal(latestDeparture(contextOf(index), 1300), null); // 便2には間に合わない
});

test('同一バス停の乗換で min_transfer_time を既定の乗換余裕より優先する（出発・到着時刻指定の両方）', () => {
  const short = buildFixture([{ from_stop_id: 'a', to_stop_id: 'b', transfer_type: '2', min_transfer_time: '0' }]);
  assert.equal(earliestArrival(contextOf(short)), 1300); // 便2に乗れる
  assert.equal(latestDeparture(contextOf(short), 1300), 900);

  const long = buildFixture([{ from_stop_id: 'a', to_stop_id: 'b', transfer_type: '2', min_transfer_time: '300' }]);
  assert.equal(earliestArrival(contextOf(long)), 1600); // 1000+300 > 1200 → 便4
  assert.equal(latestDeparture(contextOf(long), 1500), null); // 便3（1200発）には1000着+300で間に合わない
  assert.equal(latestDeparture(contextOf(long), 1600), 900);
});

test('利用者が明示した乗換余裕は指定値の下限になる', () => {
  const index = buildFixture([{ from_stop_id: 'a', to_stop_id: 'b', transfer_type: '2', min_transfer_time: '0' }]);
  assert.equal(earliestArrival(contextOf(index, { transferFloorSeconds: 120 })), 1500);
  assert.equal(latestDeparture(contextOf(index, { transferFloorSeconds: 120 }), 1300), null);
});

test('条件（路線）が合わない行は使わず、既定の乗換余裕に戻る', () => {
  const index = buildFixture([
    { from_stop_id: 'a', to_stop_id: 'b', to_route_id: 'R9', transfer_type: '2', min_transfer_time: '0' }
  ]);
  assert.equal(earliestArrival(contextOf(index)), 1500);
});

test('徒歩乗継では「徒歩＋乗換余裕」の代わりに指定値を使い、徒歩区間の表示も指定値に縮める', () => {
  const plain = buildFixture();
  // 1000着 + 徒歩300 + 余裕60 > 1100発 → 便5には乗れず、同一バス停の便3
  assert.equal(earliestArrival(contextOf(plain, { walk: true })), 1500);

  const index = buildFixture([{ from_stop_id: 'a', to_stop_id: 'w', transfer_type: '2', min_transfer_time: '60' }]);
  const ctx = contextOf(index, { walk: true });
  const results = runRaptor(ctx, new Map([['O', 800]]), new Set(['D']));
  const best = results.reduce((a, b) => (a.arrivalSeconds <= b.arrivalSeconds ? a : b));
  assert.equal(best.arrivalSeconds, 1250);

  const journey = buildJourney(index, best.labels, 0);
  const walkLeg = journey.legs.find((leg) => leg.type === 'walk');
  assert.equal(walkLeg.departureSeconds, 1000);
  assert.equal(walkLeg.arrivalSeconds, 1060);
  const secondBus = journey.legs.filter((leg) => leg.type === 'bus')[1];
  assert.equal(secondBus.specifiedTransferSeconds, 60);

  // 到着時刻指定でも同じ乗継が成立する（順向き・逆向きの対称性）
  const reverse = runRaptorReverse(contextOf(index, { walk: true }), new Map([['D', 1250]]), new Set(['O']));
  const bestReverse = reverse.reduce((a, b) => (a.departureSeconds >= b.departureSeconds ? a : b));
  assert.equal(bestReverse.departureSeconds, 900);
  const reverseJourney = buildJourney(index, normalizeReverseLabels(bestReverse.labels), 0);
  const reverseWalk = reverseJourney.legs.find((leg) => leg.type === 'walk');
  assert.equal(reverseWalk.departureSeconds, 1000);
  assert.equal(reverseWalk.arrivalSeconds, 1060);
});

/* ---------- 乗換地点の乗り場（platformKey） ---------- */

function transferStopsOf(index) {
  const results = runRaptor(contextOf(index), new Map([['O', 800]]), new Set(['D']));
  const best = results.reduce((a, b) => (a.arrivalSeconds <= b.arrivalSeconds ? a : b));
  const [first, second] = buildJourney(index, best.labels, 0).legs.filter((leg) => leg.type === 'bus');
  return { alight: first.toStop, board: second.fromStop };
}

test('乗換地点の降車・乗車の乗り場を platformKey で返す（別の標柱なら異なる）', () => {
  const { alight, board } = transferStopsOf(buildFixture());
  assert.equal(alight.stopKey, 'T');
  assert.equal(board.stopKey, 'T');
  assert.equal(alight.platformKey, 'f_a');
  assert.equal(board.platformKey, 'f_b');
});

test('座標統合で畳まれた標柱は代表標柱の platformKey にそろえる（同じ乗り場と判定できる）', () => {
  const index = buildFixture();
  index.stops.get(makeKey('f', 'a')).mergedInto = makeKey('f', 'b');
  const { alight, board } = transferStopsOf(index);
  assert.equal(alight.platformKey, 'f_b');
  assert.equal(board.platformKey, 'f_b');
  // 遷移先URL（?platform=）は従来どおり実際の標柱のまま（resolvePlatform が代表へ解決する）
  assert.equal(alight.busstopUrl, '/busstop/T?platform=f_a');
});
