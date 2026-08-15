const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expandFrequencies, parseGtfsTimeToSeconds } = require('../src/services/gtfsFrequencies');

test('parseGtfsTimeToSeconds: 通常の時刻', () => {
  assert.equal(parseGtfsTimeToSeconds('07:00:00'), 7 * 3600);
});

test('parseGtfsTimeToSeconds: 24時を超える表記も許容する', () => {
  assert.equal(parseGtfsTimeToSeconds('25:10:00'), 25 * 3600 + 10 * 60);
});

test('expandFrequencies: end_timeを含まない範囲で仮想便を展開する', () => {
  const rows = [{ start_time: '07:00:00', end_time: '09:00:00', headway_secs: 600 }];
  const instances = expandFrequencies(rows, 7 * 3600);
  assert.equal(instances.length, 12); // 7:00, 7:10, ..., 8:50
  assert.equal(instances[0].startSeconds, 7 * 3600);
  assert.equal(instances[0].offsetMinutes, 0);
  assert.equal(instances[instances.length - 1].startSeconds, 8 * 3600 + 50 * 60);
});

test('expandFrequencies: 不正な行は無視する', () => {
  const rows = [{ start_time: '07:00:00', end_time: '07:00:00', headway_secs: 600 }]; // end <= start
  assert.deepEqual(expandFrequencies(rows, 7 * 3600), []);
});

test('expandFrequencies: frequencyIndexは開始時刻順に1から採番される', () => {
  const rows = [{ start_time: '08:00:00', end_time: '08:20:00', headway_secs: 600 }];
  const instances = expandFrequencies(rows, 7 * 3600);
  assert.deepEqual(instances.map((i) => i.frequencyIndex), [1, 2]);
});
