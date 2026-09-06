const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeConsecutiveWalkLegs,
  attachSpotWalkLegs,
  legDisplayArrivalSeconds
} = require('../src/services/gtfsRouteSearch');

// 徒歩レグ1本。時刻は「発→着」を秒で持ち、表示用の文字列も一緒に持つ。
function walk(fromName, toName, walkMinutes, distanceMeters, departureSeconds, arrivalSeconds) {
  return {
    type: 'walk',
    fromStop: { name: fromName },
    toStop: { name: toName },
    walkMinutes,
    distanceMeters,
    departureSeconds,
    arrivalSeconds,
    departureTime: String(departureSeconds),
    arrivalTime: String(arrivalSeconds),
    departureDayOffset: 0,
    arrivalDayOffset: 0
  };
}

function bus(fromName, toName, departureSeconds, arrivalSeconds) {
  return {
    type: 'bus',
    fromStop: { name: fromName },
    toStop: { name: toName },
    departureSeconds,
    arrivalSeconds
  };
}

test('mergeConsecutiveWalkLegs: 連続する徒歩を1本にまとめ、距離と分数を足す', () => {
  // 追分 →（バス）→ 清水 →（徒歩）→ 蚕糸公園 →（徒歩）→ スポット
  const journey = {
    legs: [
      bus('追分', '清水', 0, 600),
      walk('清水', '蚕糸公園', 3, 220, 600, 780),
      walk('蚕糸公園', '県ケ丘高校', 5, 400, 780, 1080)
    ]
  };
  mergeConsecutiveWalkLegs([journey]);

  assert.equal(journey.legs.length, 2);
  const merged = journey.legs[1];
  assert.equal(merged.type, 'walk');
  assert.equal(merged.fromStop.name, '清水');
  assert.equal(merged.toStop.name, '県ケ丘高校');
  assert.equal(merged.walkMinutes, 8);
  assert.equal(merged.distanceMeters, 620);
  // 時刻は前後の区間と連続させるため、先頭の発・末尾の着をそのまま使う
  assert.equal(merged.departureSeconds, 600);
  assert.equal(merged.arrivalSeconds, 1080);
  assert.equal(merged.departureTime, '600');
  assert.equal(merged.arrivalTime, '1080');
});

test('mergeConsecutiveWalkLegs: 3本以上の連続もまとめる', () => {
  const journey = {
    legs: [
      walk('スポットA', '出発バス停', 4, 300, 0, 240),
      walk('出発バス停', '隣のバス停', 2, 150, 240, 360),
      walk('隣のバス停', 'さらに隣', 1, 90, 360, 420),
      bus('さらに隣', '目的地', 420, 900)
    ]
  };
  mergeConsecutiveWalkLegs([journey]);

  assert.equal(journey.legs.length, 2);
  assert.equal(journey.legs[0].walkMinutes, 7);
  assert.equal(journey.legs[0].distanceMeters, 540);
  assert.equal(journey.legs[0].fromStop.name, 'スポットA');
  assert.equal(journey.legs[0].toStop.name, 'さらに隣');
  assert.equal(journey.legs[0].arrivalSeconds, 420);
});

test('mergeConsecutiveWalkLegs: バスを挟んだ徒歩はまとめない', () => {
  const journey = {
    legs: [
      walk('スポットA', 'バス停1', 4, 300, 0, 240),
      bus('バス停1', 'バス停2', 240, 900),
      walk('バス停2', 'スポットB', 3, 220, 900, 1080)
    ]
  };
  mergeConsecutiveWalkLegs([journey]);

  assert.equal(journey.legs.length, 3);
  assert.equal(journey.legs[0].walkMinutes, 4);
  assert.equal(journey.legs[2].walkMinutes, 3);
});

test('mergeConsecutiveWalkLegs: 徒歩が1本だけの経路は変わらない', () => {
  const journey = { legs: [bus('A', 'B', 0, 600), walk('B', 'C', 3, 220, 600, 780)] };
  mergeConsecutiveWalkLegs([journey]);

  assert.equal(journey.legs.length, 2);
  assert.equal(journey.legs[1].walkMinutes, 3);
  assert.equal(journey.legs[1].distanceMeters, 220);
});

/* ---------- attachSpotWalkLegs：末尾スポット徒歩に遅延を反映する ---------- */

// 市役所口で降車するバス区間。attachRealtime 相当の状態
//（arrivalTime は予測へ置換済み、realtime.* は埋まっている）を直接組む。
function busLegToSpotStop({ schedArrivalSeconds, realtime }) {
  return {
    type: 'bus',
    fromStop: { name: '追分', stopKey: 'oiwake' },
    toStop: { name: '市役所口', stopKey: 'shiyakushoguchi' },
    departureSeconds: 37260, // 10:21
    arrivalSeconds: schedArrivalSeconds,
    departureTime: '10:21',
    arrivalTime: realtime ? realtime.predictedArrivalTime : '10:27',
    realtime: realtime || null
  };
}

function journeyToMatsumotojo(busLeg) {
  return {
    departureSeconds: busLeg.departureSeconds,
    arrivalSeconds: busLeg.arrivalSeconds,
    departureTime: '10:21',
    arrivalTime: busLeg.arrivalTime,
    departureDayOffset: 0,
    arrivalDayOffset: 0,
    durationMinutes: 6,
    walkMinutes: 0,
    realtime: Boolean(busLeg.realtime),
    legs: [busLeg]
  };
}

// 目的地スポット（松本城）。市役所口から約390m。
const DEST_SPOT = {
  viaSpot: { name: '松本城', lat: 36.2385, lng: 137.9689, spotId: 'matsumotojo' },
  distanceByGroupKey: new Map([['shiyakushoguchi', 390]])
};
const NO_SPOT = {};

test('attachSpotWalkLegs: 末尾スポット徒歩は最後のバスの予測到着を起点にする（遅延を反映）', () => {
  const schedArrival = 37620; // 10:27 定刻
  const busLeg = busLegToSpotStop({
    schedArrivalSeconds: schedArrival,
    realtime: {
      hasRealtime: true,
      predictedDepartureTime: '10:21',
      predictedArrivalTime: '10:32', // 5分遅れの予測到着
      predictedArrivalDelayMinutes: 5
    }
  });
  const journey = journeyToMatsumotojo(busLeg);

  attachSpotWalkLegs([journey], NO_SPOT, DEST_SPOT);

  assert.equal(journey.legs.length, 2);
  const spotWalk = journey.legs[1];
  assert.equal(spotWalk.type, 'walk');
  assert.equal(spotWalk.toStop.spotId, 'matsumotojo');

  // 徒歩の起点＝バスの予測到着（10:32＝37920秒）。定刻(37620)ではない。
  assert.equal(spotWalk.departureSeconds, 37920);
  assert.equal(spotWalk.departureTime, '10:32');
  assert.equal(spotWalk.arrivalSeconds, 37920 + spotWalk.walkMinutes * 60);

  // 経路全体の到着時刻・所要時間も遅延を含んだ値になる。
  assert.equal(journey.arrivalTime, spotWalk.arrivalTime);
  assert.equal(journey.durationMinutes, Math.round((spotWalk.arrivalSeconds - 37260) / 60));

  // journey.arrivalSeconds は「1本前/1本後」の再検索アンカー用に定刻ベースを維持する。
  assert.equal(journey.arrivalSeconds, schedArrival + spotWalk.walkMinutes * 60);
});

test('attachSpotWalkLegs: リアルタイムが無ければ従来どおり定刻を起点にする', () => {
  const schedArrival = 37620; // 10:27
  const busLeg = busLegToSpotStop({ schedArrivalSeconds: schedArrival, realtime: null });
  const journey = journeyToMatsumotojo(busLeg);

  attachSpotWalkLegs([journey], NO_SPOT, DEST_SPOT);

  const spotWalk = journey.legs[1];
  assert.equal(spotWalk.departureSeconds, schedArrival);
  assert.equal(spotWalk.arrivalSeconds, schedArrival + spotWalk.walkMinutes * 60);
  assert.equal(journey.arrivalSeconds, schedArrival + spotWalk.walkMinutes * 60);
});

test('attachSpotWalkLegs + mergeConsecutiveWalkLegs: 降車後の乗継徒歩と地点徒歩が遅延ぶんそろって連結される', () => {
  // バス（10:27定刻着 / 10:32予測着） → 乗継徒歩(3分) → スポット徒歩
  const busLeg = busLegToSpotStop({
    schedArrivalSeconds: 37620,
    realtime: {
      hasRealtime: true,
      predictedDepartureTime: '10:21',
      predictedArrivalTime: '10:32',
      predictedArrivalDelayMinutes: 5
    }
  });
  busLeg.toStop = { name: '清水', stopKey: 'shimizu' };
  // attachRealtime が乗継徒歩を遅延ぶん（+300秒）ずらした後の状態。
  const raptorWalk = walk('清水', '市役所口', 3, 220, 37920, 38100);
  raptorWalk.toStop = { name: '市役所口', stopKey: 'shiyakushoguchi' };
  const journey = {
    departureSeconds: 37260,
    arrivalSeconds: 37800, // 定刻の乗継徒歩着（37620 + 180）
    departureTime: '10:21',
    arrivalTime: '10:32',
    departureDayOffset: 0,
    arrivalDayOffset: 0,
    durationMinutes: 9,
    walkMinutes: 3,
    realtime: true,
    legs: [busLeg, raptorWalk]
  };

  attachSpotWalkLegs([journey], NO_SPOT, DEST_SPOT);
  mergeConsecutiveWalkLegs([journey]);

  assert.equal(journey.legs.length, 2);
  const mergedWalk = journey.legs[1];
  assert.equal(mergedWalk.type, 'walk');
  assert.equal(mergedWalk.fromStop.name, '清水');
  assert.equal(mergedWalk.toStop.spotId, 'matsumotojo');
  // 乗継徒歩の（遅延反映済み）発時刻から、連続してスポットまで歩く。
  assert.equal(mergedWalk.departureSeconds, 37920);
  assert.equal(mergedWalk.arrivalSeconds, 38100 + (mergedWalk.walkMinutes - 3) * 60);
  assert.equal(journey.arrivalTime, mergedWalk.arrivalTime);
});

test('legDisplayArrivalSeconds: 徒歩区間とリアルタイム無しのバスは秒をそのまま返す', () => {
  assert.equal(legDisplayArrivalSeconds(walk('A', 'B', 3, 220, 600, 780)), 780);
  assert.equal(
    legDisplayArrivalSeconds({ type: 'bus', arrivalSeconds: 1234, realtime: null }),
    1234
  );
  assert.equal(
    legDisplayArrivalSeconds({
      type: 'bus',
      arrivalSeconds: 37620,
      realtime: { predictedArrivalTime: '10:32' }
    }),
    37920
  );
});
