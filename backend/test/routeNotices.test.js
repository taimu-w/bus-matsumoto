// routeNotices.js のうち、DBアクセスを伴わない純粋関数（normalizeRouteNoticeContent）の回帰テスト。
// 題名必須（リアルタイム時刻表には題名だけが出るため）・画像/本文の少なくとも一方必須・
// 画像URLは https:// のみ・配信期間の妥当性チェックを固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRouteNoticeContent } = require('../src/services/routeNotices');

test('normalizeRouteNoticeContent: 題名＋本文だけで通り、前後空白を落とす', () => {
  const result = normalizeRouteNoticeContent({ title: ' 迂回運行 ', body: ' 本文 [詳細](https://example.com) ' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    title: '迂回運行',
    imageUrl: '',
    body: '本文 [詳細](https://example.com)',
    startDate: '',
    endDate: '',
    enabled: true
  });
});

test('normalizeRouteNoticeContent: 題名が空ならエラー', () => {
  assert.equal(normalizeRouteNoticeContent({ title: '  ', body: '本文' }).ok, false);
  assert.equal(normalizeRouteNoticeContent({ body: '本文' }).ok, false);
});

test('normalizeRouteNoticeContent: 題名は60文字まで', () => {
  assert.equal(normalizeRouteNoticeContent({ title: 'あ'.repeat(60), body: 'x' }).ok, true);
  assert.equal(normalizeRouteNoticeContent({ title: 'あ'.repeat(61), body: 'x' }).ok, false);
});

test('normalizeRouteNoticeContent: 画像と本文の両方が空ならエラー、画像だけなら通る', () => {
  assert.equal(normalizeRouteNoticeContent({ title: 't' }).ok, false);
  const imageOnly = normalizeRouteNoticeContent({ title: 't', imageUrl: 'https://res.cloudinary.com/a.jpg' });
  assert.equal(imageOnly.ok, true);
  assert.equal(imageOnly.value.imageUrl, 'https://res.cloudinary.com/a.jpg');
});

test('normalizeRouteNoticeContent: 画像URLは https:// のみ', () => {
  assert.equal(normalizeRouteNoticeContent({ title: 't', imageUrl: 'http://example.com/a.jpg' }).ok, false);
  assert.equal(normalizeRouteNoticeContent({ title: 't', imageUrl: 'javascript:alert(1)' }).ok, false);
});

test('normalizeRouteNoticeContent: 本文は1000文字まで', () => {
  assert.equal(normalizeRouteNoticeContent({ title: 't', body: 'x'.repeat(1000) }).ok, true);
  assert.equal(normalizeRouteNoticeContent({ title: 't', body: 'x'.repeat(1001) }).ok, false);
});

test('normalizeRouteNoticeContent: 配信期間は実在する日付で、開始<=終了', () => {
  const ok = normalizeRouteNoticeContent({ title: 't', body: 'b', startDate: '2026-10-01', endDate: '2026-10-01' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.startDate, '2026-10-01');
  assert.equal(ok.value.endDate, '2026-10-01');
  assert.equal(normalizeRouteNoticeContent({ title: 't', body: 'b', startDate: '2026-10-02', endDate: '2026-10-01' }).ok, false);
  assert.equal(normalizeRouteNoticeContent({ title: 't', body: 'b', startDate: '2026-02-30' }).ok, false);
  assert.equal(normalizeRouteNoticeContent({ title: 't', body: 'b', endDate: '2026/10/01' }).ok, false);
});

test('normalizeRouteNoticeContent: enabled は未指定なら true、指定があればその真偽値', () => {
  assert.equal(normalizeRouteNoticeContent({ title: 't', body: 'b' }).value.enabled, true);
  assert.equal(normalizeRouteNoticeContent({ title: 't', body: 'b', enabled: false }).value.enabled, false);
});
