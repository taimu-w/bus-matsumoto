// gtfsCalendar.js のうち、DB/ファイルI/Oに依存しない純粋関数部分の回帰テスト。
// 点検所見 H-8（運行日カレンダーの日付・曜日算出がサーバのローカルタイムゾーンに依存する）の
// 再発防止用。コンテナがUTCで動く場合を process.env.TZ='UTC' で再現する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getDayOfWeek, formatDate } = require('../src/services/gtfsCalendar');

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

test('getDayOfWeek: 曜日番号の対応（日=0〜土=6、JST基準）', () => {
  withTz('UTC', () => {
    assert.equal(getDayOfWeek(new Date('2026-08-16T12:00:00+09:00')), 0); // 日
    assert.equal(getDayOfWeek(new Date('2026-08-17T12:00:00+09:00')), 1); // 月
    assert.equal(getDayOfWeek(new Date('2026-08-22T12:00:00+09:00')), 6); // 土
  });
});
