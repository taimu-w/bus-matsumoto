// gtfsCalendar.js のうち、DB/ファイルI/Oに依存しない純粋関数部分の回帰テスト。
// 運行日カレンダーの日付・曜日算出がサーバのローカルタイムゾーンに依存しないことの
// 回帰テスト。コンテナがUTCで動く場合を process.env.TZ='UTC' で再現する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getDayOfWeek,
  formatDate,
  getActiveServiceIds,
  getActiveServiceIdsWithStatus
} = require('../src/services/gtfsCalendar');

function withTz(tz, fn) {
  const orig = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (orig === undefined) delete process.env.TZ; else process.env.TZ = orig;
  }
}

test('getDayOfWeek: UTC実行環境でもJST基準の曜日を返す（JST月曜0:30 = UTC日曜15:30）', () => {
  withTz('UTC', () => {
    const d = new Date('2026-08-17T00:30:00+09:00');
    assert.equal(getDayOfWeek(d), 1); // 月曜
  });
});

test('formatDate: UTC実行環境でもJST基準の日付を返す（JST月曜0:30 = UTC日曜15:30）', () => {
  withTz('UTC', () => {
    const d = new Date('2026-08-17T00:30:00+09:00');
    assert.equal(formatDate(d), '20260817');
  });
});

test('getDayOfWeek: サーバがJSTでない他タイムゾーン（America/New_York）でも影響されない', () => {
  withTz('America/New_York', () => {
    const d = new Date('2026-08-17T00:30:00+09:00'); // JST月曜 早朝
    assert.equal(getDayOfWeek(d), 1);
    assert.equal(formatDate(d), '20260817');
  });
});

// 「service_idが1件も無い」の2つの意味（本当に運行なし／カレンダーを読めなかった）を
// 呼び出し側が区別できることの回帰テスト。区別できないと dailyTripBuilder が
// 読み込み失敗を「今日は運行なし」として確定させ、当日便0件のまま固定される。
test('getActiveServiceIdsWithStatus: カレンダーを読めないフィードは失敗として報告する', async () => {
  const result = await getActiveServiceIdsWithStatus(new Date('2026-08-17T12:00:00+09:00'), 'no-such-feed');
  assert.deepEqual(result.serviceIds, []);
  assert.equal(result.complete, false);
  assert.deepEqual(result.failedFeedIds, ['no-such-feed']);
});

test('getActiveServiceIds: 従来どおり配列だけを返す（読み込み失敗時は空配列）', async () => {
  const ids = await getActiveServiceIds(new Date('2026-08-17T12:00:00+09:00'), 'no-such-feed');
  assert.ok(Array.isArray(ids));
  assert.equal(ids.length, 0);
});

test('getDayOfWeek: 曜日番号の対応（日=0〜土=6、JST基準）', () => {
  withTz('UTC', () => {
    assert.equal(getDayOfWeek(new Date('2026-08-16T12:00:00+09:00')), 0); // 日
    assert.equal(getDayOfWeek(new Date('2026-08-17T12:00:00+09:00')), 1); // 月
    assert.equal(getDayOfWeek(new Date('2026-08-22T12:00:00+09:00')), 6); // 土
  });
});
