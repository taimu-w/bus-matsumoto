/**
 * HTTPSの強制とセキュリティヘッダーの付与（docs/system-review-2026-09.md S-5）。
 *
 * TLS終端はリバースプロキシ（nginx / Cloudflare / PaaS）側で行う前提で、ここでは
 *   - 平文HTTPで届いたリクエストをHTTPSへ寄せる（`FORCE_HTTPS=true`のときだけ）
 *   - HSTS・nosniff・クリックジャッキング対策などのヘッダーを付ける
 * を担当します。**既定ではHTTPSリダイレクトもCSPも無効**で、ローカル開発や
 * 既存のデプロイの挙動は変わりません。設定は`config/security.js`（環境変数）にまとめてあります。
 *
 * `req.secure`はリバースプロキシ配下だと`TRUST_PROXY`を設定しないと常にfalseになります。
 * `server.js`で`app.set('trust proxy', ...)`を先に済ませてからこのミドルウェアを挟むこと。
 */
const security = require('../config/security');

// CSPは既定OFF。有効にする場合の内容（外部依存を同梱に寄せたS-6の対応後を前提にしている）。
//   - script-src 'self' … Tailwind・Leafletを frontend/vendor/ から配信しているため外部CDNは不要
//   - 'unsafe-inline'/'unsafe-eval' … ビルドステップ無しの素のHTML/JS（インラインの
//     onclick・style属性、Tailwind Play CDNのブラウザ内コンパイル）が動かなくなるため許可する
//   - img-src に https: … 観光スポットの写真とOSMタイルが任意の外部ホストから来る
//   - style-src/font-src の fonts.g*.com … Google Fontsを外部参照しているため（同レビュー F-5）
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'"
].join('; ');

/**
 * 平文HTTPをHTTPSへ寄せる。GET/HEADは301でリダイレクトし、それ以外のメソッドは
 * 平文で本文（＝お知らせの更新内容や資格情報）を受け取ってしまわないよう403で拒否する。
 */
function httpsRedirect(req, res, next) {
  if (!security.FORCE_HTTPS || req.secure) return next();

  const host = req.headers.host;
  if (!host) return res.status(400).json({ error: 'Hostヘッダーがありません。' });

  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  return res.status(403).json({ error: 'HTTPSでアクセスしてください。' });
}

function securityHeaders(req, res, next) {
  // MIMEタイプの推測を止める（アップロードや静的配信からのスクリプト実行を防ぐ定番）
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // クリックジャッキング対策。現状このシステムを外部サイトへ埋め込む用途は無い。
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // 外部サイトへ遷移するとき（観光スポットの公式サイトリンク等）にパス・クエリを渡さない
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // HSTSはHTTPSで届いたリクエストにだけ付ける。平文HTTPで付けても効果が無いうえ、
  // ローカル開発（http://localhost）にHTTPS必須を焼き付けてしまう事故を避けるため。
  if (security.HSTS_MAX_AGE_SEC > 0 && (req.secure || security.FORCE_HTTPS)) {
    const hsts = `max-age=${security.HSTS_MAX_AGE_SEC}` +
      (security.HSTS_INCLUDE_SUBDOMAINS ? '; includeSubDomains' : '');
    res.setHeader('Strict-Transport-Security', hsts);
  }

  if (security.CSP_MODE === 'on') {
    res.setHeader('Content-Security-Policy', CSP_DIRECTIVES);
  } else if (security.CSP_MODE === 'report-only') {
    res.setHeader('Content-Security-Policy-Report-Only', CSP_DIRECTIVES);
  }

  next();
}

module.exports = { httpsRedirect, securityHeaders, CSP_DIRECTIVES };
