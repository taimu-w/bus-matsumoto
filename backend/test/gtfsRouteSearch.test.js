const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeConsecutiveWalkLegs } = require('../src/services/gtfsRouteSearch');

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
