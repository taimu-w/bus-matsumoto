// utils/time.js の現在の挙動を固定する回帰テスト。DB・ネットワーク不要な純粋関数のみ対象。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeDelayMinutes,
  getDayType,
  isNightTime,
  timeStrToMinutes,
  minutesToTimeStr
} = require('../src/utils/time');

test('computeDelayMinutes: 定刻通りなら0分', () => {
  assert.equal(computeDelayMinutes('8:00', '8:00'), 0);
});

test('computeDelayMinutes: 5分遅れ', () => {
  assert.equal(computeDelayMinutes('8:00', '8:05'), 5);
});

test('computeDelayMinutes: 定刻より早着は0分に丸める', () => {
  assert.equal(computeDelayMinutes('8:00', '7:55'), 0);
});

test('computeDelayMinutes: 半日を超える差分だけ日跨ぎ補正する', () => {
  // 23:50発が翌0:05着（15分遅れ）となるケース
  assert.equal(computeDelayMinutes('23:50', '0:05'), 15);
});

test('computeDelayMinutes: 不正な時刻文字列はnull', () => {
  assert.equal(computeDelayMinutes('通過', '8:00'), null);
  assert.equal(computeDelayMinutes('8:00', null), null);
});

test('getDayType: 日曜は常にholiday扱い', () => {
  assert.equal(getDayType(new Date('2026-08-16T03:00:00Z')), 'holiday'); // JST日曜
});

test('getDayType: 土曜はsaturday', () => {
  assert.equal(getDayType(new Date('2026-08-15T03:00:00Z')), 'saturday'); // JST土曜
});

test('getDayType: 平日はweekday', () => {
  assert.equal(getDayType(new Date('2026-08-17T03:00:00Z')), 'weekday'); // JST月曜
});

test('getDayType: holidaySetに含まれる平日はholiday扱い', () => {
  const holidaySet = new Set(['2026-08-17']);
  assert.equal(getDayType(new Date('2026-08-17T03:00:00Z'), holidaySet), 'holiday');
});

test('isNightTime: 全時間帯を覆う設定では常にtrue', (t) => {
  const origStart = process.env.NIGHT_START;
  const origEnd = process.env.NIGHT_END;
  t.after(() => {
    if (origStart === undefined) delete process.env.NIGHT_START; else process.env.NIGHT_START = origStart;
    if (origEnd === undefined) delete process.env.NIGHT_END; else process.env.NIGHT_END = origEnd;
  });
  process.env.NIGHT_START = '00:00';
  process.env.NIGHT_END = '23:59';
  assert.equal(isNightTime(), true);
});

test('timeStrToMinutes / minutesToTimeStr: 相互変換', () => {
  assert.equal(timeStrToMinutes('8:30'), 510);
  assert.equal(minutesToTimeStr(510), '8:30');
});

test('timeStrToMinutes: 通過扱いの記号はNaN', () => {
  assert.ok(Number.isNaN(timeStrToMinutes('↓')));
  assert.ok(Number.isNaN(timeStrToMinutes('通過')));
});
