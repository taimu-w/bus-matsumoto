// 管理画面の認証（services/adminAuth.js）の回帰テスト。
// DB・ネットワーク・Expressを必要としない部分だけを対象にする。
// 資格情報は環境変数未設定時のコード既定値（admin / admin123）を前提にしている。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const adminAuth = require('../src/services/adminAuth');

test('verifyCredentials: 正しい組み合わせだけを通す', () => {
  assert.equal(adminAuth.verifyCredentials('admin', 'admin123'), true);
  assert.equal(adminAuth.verifyCredentials('admin', 'admin124'), false);
  assert.equal(adminAuth.verifyCredentials('Admin', 'admin123'), false); // 大文字小文字は区別する
  assert.equal(adminAuth.verifyCredentials('', ''), false);
});

test('verifyCredentials: undefined/null を渡しても例外にならず false', () => {
  assert.equal(adminAuth.verifyCredentials(undefined, undefined), false);
  assert.equal(adminAuth.verifyCredentials(null, null), false);
  assert.equal(adminAuth.verifyCredentials('admin', null), false);
});

test('parseBasicAuthHeader: Basicヘッダーをユーザー名とパスワードへ分解する', () => {
  const header = 'Basic ' + Buffer.from('admin:admin123').toString('base64');
  assert.deepEqual(adminAuth.parseBasicAuthHeader(header), { username: 'admin', password: 'admin123' });
});

test('parseBasicAuthHeader: パスワードに「:」が含まれても最初の「:」だけで分割する', () => {
  const header = 'Basic ' + Buffer.from('admin:a:b:c').toString('base64');
  assert.deepEqual(adminAuth.parseBasicAuthHeader(header), { username: 'admin', password: 'a:b:c' });
});

test('parseBasicAuthHeader: 形式が違えば null（例外にしない）', () => {
  assert.equal(adminAuth.parseBasicAuthHeader(undefined), null);
  assert.equal(adminAuth.parseBasicAuthHeader(''), null);
  assert.equal(adminAuth.parseBasicAuthHeader('Bearer abcdef'), null);
  // 「:」を含まない＝ユーザー名とパスワードに分けられない
  assert.equal(adminAuth.parseBasicAuthHeader('Basic ' + Buffer.from('adminonly').toString('base64')), null);
});

test('hasPresentedCredentials: Basicヘッダーがあるときだけ真（セッションCookieは含めない）', () => {
  // 総当たりのカウント対象を絞るための判定。期限切れセッションのポーリングを
  // 「失敗」として数えると、管理画面が自分自身をロックアウトしてしまう。
  const basic = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
  assert.equal(adminAuth.hasPresentedCredentials({ headers: { authorization: basic } }), true);
  assert.equal(adminAuth.hasPresentedCredentials({ headers: {} }), false);
  assert.equal(adminAuth.hasPresentedCredentials({ headers: { cookie: 'bt_admin_session=stale' } }), false);
});

test('セッション: 発行したトークンは有効、破棄すると無効になる', () => {
  const { token, expiresAt } = adminAuth.createSession();
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
  assert.ok(expiresAt > Date.now());
  assert.equal(adminAuth.verifySessionToken(token), true);

  adminAuth.destroySession(token);
  assert.equal(adminAuth.verifySessionToken(token), false);
  assert.equal(adminAuth.getSessionExpiry(token), null);
});

test('セッション: 未知・空・非文字列のトークンは無効', () => {
  assert.equal(adminAuth.verifySessionToken('存在しないトークン'), false);
  assert.equal(adminAuth.verifySessionToken(''), false);
  assert.equal(adminAuth.verifySessionToken(null), false);
  assert.equal(adminAuth.verifySessionToken(undefined), false);
});

test('セッション: 発行ごとに異なるトークンになる', () => {
  const a = adminAuth.createSession();
  const b = adminAuth.createSession();
  assert.notEqual(a.token, b.token);
  adminAuth.destroySession(a.token);
  adminAuth.destroySession(b.token);
});

test('parseCookies: Cookieヘッダーを名前→値へ分解する', () => {
  const cookies = adminAuth.parseCookies('a=1; bt_admin_session=xyz; b=%E3%81%82');
  assert.equal(cookies.a, '1');
  assert.equal(cookies.bt_admin_session, 'xyz');
  assert.equal(cookies.b, 'あ'); // パーセントエンコードは復号する
});

test('parseCookies: ヘッダーが無い・壊れていても空オブジェクトを返す', () => {
  assert.deepEqual(adminAuth.parseCookies(undefined), {});
  assert.deepEqual(adminAuth.parseCookies(''), {});
  assert.deepEqual(adminAuth.parseCookies('壊れた値'), {}); // 「=」が無い要素は無視
});

test('readSessionToken: Cookieからセッショントークンを取り出す', () => {
  assert.equal(adminAuth.readSessionToken({ headers: { cookie: 'other=1; bt_admin_session=tok' } }), 'tok');
  assert.equal(adminAuth.readSessionToken({ headers: {} }), null);
});

test('buildSessionCookie: HttpOnly・SameSite=Strict が必ず付く', () => {
  const cookie = adminAuth.buildSessionCookie('tok', { secure: false });
  assert.ok(cookie.startsWith('bt_admin_session=tok;'));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Strict'));
  assert.ok(cookie.includes('Path=/'));
  // 平文HTTPのリクエストにはSecureを付けない（付けるとCookieが一切保存されず動かなくなる）
  assert.ok(!cookie.includes('Secure'));
});

test('buildSessionCookie: HTTPSのリクエストには Secure が付く', () => {
  assert.ok(adminAuth.buildSessionCookie('tok', { secure: true }).includes('Secure'));
});

test('buildClearedSessionCookie: Max-Age=0 で即時失効させる', () => {
  const cookie = adminAuth.buildClearedSessionCookie({ secure: false });
  assert.ok(cookie.includes('Max-Age=0'));
  assert.ok(cookie.includes('HttpOnly'));
});

test('isSameOriginRequest: Originが無ければ素通し（同一オリジンのGETには付かないため）', () => {
  assert.equal(adminAuth.isSameOriginRequest({ headers: { host: 'bus.example.jp' }, hostname: 'bus.example.jp' }), true);
});

test('isSameOriginRequest: 自ホストと同じOriginだけ許可する（CSRFの多層防御）', () => {
  const req = (origin) => ({ headers: { host: 'bus.example.jp', origin }, hostname: 'bus.example.jp' });
  assert.equal(adminAuth.isSameOriginRequest(req('https://bus.example.jp')), true);
  assert.equal(adminAuth.isSameOriginRequest(req('http://bus.example.jp')), true); // TLS終端の有無で割れないようスキームは見ない
  assert.equal(adminAuth.isSameOriginRequest(req('https://evil.example')), false);
  assert.equal(adminAuth.isSameOriginRequest(req('https://bus.example.jp.evil.example')), false);
  assert.equal(adminAuth.isSameOriginRequest(req('URLとして壊れた値')), false);
});
