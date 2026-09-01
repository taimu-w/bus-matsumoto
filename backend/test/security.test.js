// セキュリティ設定の解釈（config/security.js）とレートリミッタの数え方
// （middleware/rateLimit.js の WindowCounter）の回帰テスト。
// どちらもDB・ネットワーク・Expressを必要としない。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../src/config/security');
const { WindowCounter, getClientKey } = require('../src/middleware/rateLimit');

// ---- 既定値（何も設定しなければ「これまでどおり動く」側に倒してあること）----

test('既定値: HTTPS強制・CORS制限・CSPはいずれも無効', () => {
  // これらが既定で有効になると、ローカル開発や既存デプロイが黙って動かなくなる。
  assert.equal(security.FORCE_HTTPS, false);
  assert.equal(security.TRUST_PROXY, false);
  assert.deepEqual(security.CORS_ALLOWED_ORIGINS, []); // 空＝公開APIは全オリジン許可のまま
  assert.equal(security.CSP_MODE, 'off');
});

test('既定値: レートリミットは有効で、上限は実利用が届かない水準', () => {
  assert.equal(security.RATE_LIMIT_ENABLED, true);
  assert.ok(security.ROUTE_SEARCH_RATE_LIMIT_PER_MIN >= 60);
  assert.ok(security.COUNT_RATE_LIMIT_PER_MIN >= 60);
  assert.ok(security.ADMIN_AUTH_MAX_FAILURES > 0);
});

// ---- 環境変数のパース ----

test('parseBool: 真偽らしい表記を受け付け、解釈できない値は既定値に落ちる', () => {
  for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(security.parseBool(truthy, false), true);
  for (const falsy of ['0', 'false', 'no', 'off']) assert.equal(security.parseBool(falsy, true), false);
  assert.equal(security.parseBool(undefined, true), true);
  assert.equal(security.parseBool('', true), true);
  assert.equal(security.parseBool('よくわからない値', true), true);
});

test('parsePositiveInt / parseNonNegativeInt: 0の扱いだけが違う', () => {
  assert.equal(security.parsePositiveInt('30', 10), 30);
  assert.equal(security.parsePositiveInt('0', 10), 10); // 0は無効扱い→既定値
  assert.equal(security.parsePositiveInt('abc', 10), 10);
  // レートリミットの上限は「0＝その項目だけ無効化」を許すため0を通す
  assert.equal(security.parseNonNegativeInt('0', 10), 0);
  assert.equal(security.parseNonNegativeInt('-5', 10), 10);
});

test('parseTrustProxy: 未設定は false（X-Forwarded-For を信用しない）', () => {
  // 手前にプロキシが無いのに信用すると、ヘッダー詐称でレートリミットを回避できてしまう。
  assert.equal(security.parseTrustProxy(undefined), false);
  assert.equal(security.parseTrustProxy(''), false);
  assert.equal(security.parseTrustProxy('false'), false);
  assert.equal(security.parseTrustProxy('0'), false);
});

test('parseTrustProxy: 数値は段数、true は全信頼、その他はExpressへそのまま渡す', () => {
  assert.equal(security.parseTrustProxy('1'), 1);
  assert.equal(security.parseTrustProxy('2'), 2);
  assert.equal(security.parseTrustProxy('true'), true);
  assert.equal(security.parseTrustProxy('loopback'), 'loopback');
  assert.equal(security.parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
});

test('parseOriginList: カンマ区切り・末尾スラッシュ・空要素を正規化する', () => {
  assert.deepEqual(security.parseOriginList('https://a.jp, https://b.jp/'), ['https://a.jp', 'https://b.jp']);
  assert.deepEqual(security.parseOriginList(''), []);
  assert.deepEqual(security.parseOriginList(undefined), []);
  assert.deepEqual(security.parseOriginList(' , , '), []);
});

// ---- レートリミットの数え方 ----

test('WindowCounter: 同じキーは積み上がり、別キーは干渉しない', () => {
  const counter = new WindowCounter(60 * 1000);
  assert.equal(counter.hit('a').count, 1);
  assert.equal(counter.hit('a').count, 2);
  assert.equal(counter.hit('b').count, 1);
  assert.equal(counter.peek('a').count, 2);
});

test('WindowCounter: peek は消費しない／有効なウィンドウが無ければ null', () => {
  const counter = new WindowCounter(60 * 1000);
  assert.equal(counter.peek('x'), null);
  counter.hit('x');
  assert.equal(counter.peek('x').count, 1);
  assert.equal(counter.peek('x').count, 1);
});

test('WindowCounter: reset で解除できる（認証成功時にカウンタを消すため）', () => {
  const counter = new WindowCounter(60 * 1000);
  counter.hit('a');
  counter.hit('a');
  counter.reset('a');
  assert.equal(counter.peek('a'), null);
  assert.equal(counter.hit('a').count, 1);
});

test('WindowCounter: ウィンドウを跨ぐと数え直す', () => {
  const counter = new WindowCounter(0); // 幅0＝毎回ウィンドウ切れ
  assert.equal(counter.hit('a').count, 1);
  assert.equal(counter.hit('a').count, 1);
});

test('getClientKey: IPv4射影のIPv6表記を素のIPv4へ寄せる', () => {
  // 同じクライアントが2つのキーに割れて上限が実質2倍になるのを防ぐ。
  assert.equal(getClientKey({ ip: '::ffff:203.0.113.9' }), '203.0.113.9');
  assert.equal(getClientKey({ ip: '203.0.113.9' }), '203.0.113.9');
  assert.equal(getClientKey({ socket: { remoteAddress: '198.51.100.4' } }), '198.51.100.4');
  assert.equal(getClientKey({}), 'unknown');
});
