// PWAのオフラインシェル用Service Worker。
//
// 目的は「電波が無いときに真っ白なブラウザのエラー画面ではなく、直前に開けていた
// アプリの外枠が出る」ことだけ。リアルタイム性が命の画面なので、方針は次の2つに絞る。
//
// 1. /api/ 配下は絶対にキャッシュしない・インターセプトもしない。
//    バスの位置・遅延・時刻表APIをキャッシュすると「古い運行情報を今の情報として
//    見せてしまう」事故になる（docs/system-review-2026-09.md F-4）。常にネットワークへ通す。
// 2. 静的ファイル（HTML/CSS/JS/vendor）は「オンライン時は必ずネットワークを優先し、
//    取得できたら丸ごとキャッシュを上書きする」方式にする。キャッシュ優先にすると、
//    このプロジェクトはファイル名にハッシュを付けていないため、デプロイ後も利用者が
//    ずっと古いapp.js等を見続ける事故になる。SWが効くのはオフラインでネットワークに
//    失敗したときだけ。
const CACHE_NAME = 'bustime-shell-v1';

const SHELL_URLS = [
  '/',
  '/style.css',
  '/vendor/tailwind/tailwind-3.4.17.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/images/layers.png',
  '/vendor/leaflet/images/layers-2x.png',
  '/vendor/leaflet/images/marker-icon.png',
  '/vendor/leaflet/images/marker-icon-2x.png',
  '/vendor/leaflet/images/marker-shadow.png',
  '/favorites.js',
  '/spot-photos.js',
  '/timetable.js',
  '/stopmap.js',
  '/busstop.js',
  '/routesearch.js',
  '/spotsearch.js',
  '/onboarding.js',
  '/app.js',
  '/manifest.json',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch((err) => {
        // 1件でも取得に失敗するとaddAll全体が失敗するが、SW自体のインストールは
        // 妨げない（キャッシュが空でも従来どおりネットワークから配信されるだけ）。
        console.warn('[sw] シェルの事前キャッシュに失敗しました:', err);
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Googleフォント・OSMタイル等はSWを通さない
  if (url.pathname.startsWith('/api/')) return; // リアルタイムデータは常にネットワーク直行

  // 管理画面はこのPWAオフラインシェルの対象外（SHELL_URLSにも含めていない。上のコメント参照）。
  // ここで素通りさせないと、fetch(req)が失敗したときのフォールバックが
  // 「そのURL自体のキャッシュ」→「'/'のキャッシュ」の順で探すため、admin.htmlは
  // 一度もキャッシュされていないぶん必ず後者に落ち、URLは/adminのままなのに
  // 公開トップページの中身が表示されるという事故になる（バックエンド再起動・
  // 一時的な接続断のたびに発生しうる）。管理画面はSWを通さず常に素のネットワーク
  // フェッチにすることで、失敗時はブラウザ標準のオフラインエラーが出るだけになる。
  if (url.pathname === '/admin' || url.pathname === '/admin.html' ||
      url.pathname === '/admin.css' || /^\/admin-[\w-]+\.js$/.test(url.pathname)) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match('/'))
      )
  );
});
