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

// calendar.txt の start_date / end_date（有効期間）の範囲外の日付では service_id を返さない。
// 「現行ダイヤ」と「次期ダイヤ」が同じZIPに同梱されたときの二重生成と、期間切れ後も
// 当日便が作られ続けるずれを防ぐ（gtfsTimetable.getActiveServices() と同じ解釈）。
test('getActiveServiceIdsWithStatus: calendar.txt の有効期間外は service_id を返さない（読み込み失敗ではない）', async () => {
  // 現行データ（data gtfs/guruttomatsumotobus1）は全 service が 20260801〜20280331。
  const before = await getActiveServiceIdsWithStatus(
    new Date('2026-01-05T12:00:00+09:00'), 'guruttomatsumotobus1'
  );
  assert.deepEqual(before.serviceIds, []);
  assert.equal(before.complete, true); // 「読めたが期間外」＝読み込み失敗ではない
  assert.deepEqual(before.failedFeedIds, []);

  const after = await getActiveServiceIdsWithStatus(
    new Date('2028-04-01T12:00:00+09:00'), 'guruttomatsumotobus1'
  );
  assert.deepEqual(after.serviceIds, []);
  assert.equal(after.complete, true);

  // 期間内の平日は従来どおり service_id を返す（回帰防止）
  const during = await getActiveServiceIdsWithStatus(
    new Date('2026-09-07T12:00:00+09:00'), 'guruttomatsumotobus1' // 月曜
  );
  assert.ok(during.serviceIds.includes('guruttomatsumotobus1:平日'));
});

test('getDayOfWeek: 曜日番号の対応（日=0〜土=6、JST基準）', () => {
  withTz('UTC', () => {
    assert.equal(getDayOfWeek(new Date('2026-08-16T12:00:00+09:00')), 0); // 日
    assert.equal(getDayOfWeek(new Date('2026-08-17T12:00:00+09:00')), 1); // 月
    assert.equal(getDayOfWeek(new Date('2026-08-22T12:00:00+09:00')), 6); // 土
  });
});
