const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bucketOperationRows } = require('../src/services/vehicleOperationHistory');

// vehicle_operation_history の1行を作るヘルパー。isoStartAt は "YYYY-MM-DDTHH:mm:00+09:00"。
function row(dayType, isoStartAt, extra = {}) {
  return {
    dayType,
    serviceDate: isoStartAt.slice(0, 10),
    startTime: isoStartAt.slice(11, 16),
    startAt: isoStartAt,
    routeId: 'guruttomatsumotobus1:11',
    routeName: '横田信大循環線',
    headsign: '信州大学',
    ...extra
  };
}

test('bucketOperationRows: 行が無ければ両バケットとも空配列', () => {
  assert.deepEqual(bucketOperationRows([]), { weekday: [], weekendHoliday: [] });
  assert.deepEqual(bucketOperationRows(undefined), { weekday: [], weekendHoliday: [] });
});

test('bucketOperationRows: 平日は最新運行日の全便を始発時刻昇順で返す', () => {
  const rows = [
    row('weekday', '2026-08-24T18:00:00+09:00'), // 古い日
    row('weekday', '2026-08-26T12:00:00+09:00'),
    row('weekday', '2026-08-26T08:00:00+09:00'),
    row('weekday', '2026-08-26T18:00:00+09:00')
  ];
  const result = bucketOperationRows(rows);
  assert.deepEqual(result.weekday.map((r) => r.startTime), ['08:00', '12:00', '18:00']);
  assert.equal(result.weekendHoliday.length, 0);
});

test('bucketOperationRows: 土休日は saturday/holiday を1バケットにまとめ最新運行日を採用', () => {
  const rows = [
    row('holiday', '2026-08-24T07:30:00+09:00'), // 日曜（古い）
    row('saturday', '2026-08-29T09:00:00+09:00'),
    row('saturday', '2026-08-29T18:40:00+09:00')
  ];
  const result = bucketOperationRows(rows);
  assert.equal(result.weekday.length, 0);
  assert.deepEqual(result.weekendHoliday.map((r) => r.startTime), ['09:00', '18:40']);
  assert.equal(result.weekendHoliday[0].serviceDate, '2026-08-29');
});

test('bucketOperationRows: 土休日の最新日が holiday なら holiday の便を返す', () => {
  const rows = [
    row('saturday', '2026-08-22T09:00:00+09:00'),
    row('holiday', '2026-08-24T07:30:00+09:00') // 日曜（より新しい）
  ];
  const result = bucketOperationRows(rows);
  assert.deepEqual(result.weekendHoliday.map((r) => r.dayType), ['holiday']);
});

test('bucketOperationRows: 未知の day_type は無視する', () => {
  const result = bucketOperationRows([row('unknown', '2026-08-26T08:00:00+09:00')]);
  assert.deepEqual(result, { weekday: [], weekendHoliday: [] });
});
