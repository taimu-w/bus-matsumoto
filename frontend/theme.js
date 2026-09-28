// 配色テーマ（ライト／ダーク）の切替。
//
// 実際の色はすべて style.css のカスタムプロパティ側で持っており、
// このファイルの仕事は <html> に data-theme 属性を付け外しすることだけ。
//   - 属性なし        … OSの設定に追従（prefers-color-scheme）
//   - data-theme="light" … ライト固定
//   - data-theme="dark"  … ダーク固定
//
// 【重要】このスクリプトは各ページの <head> 内で、defer も async も付けずに
// 同期読み込みすること。body の描画前に data-theme を確定させないと、
// ダーク設定の利用者に一瞬だけ白い画面が出る（いわゆるFOUC）。
(function () {
  'use strict';

  var STORAGE_KEY = 'bustime.theme';
  var MODES = ['auto', 'light', 'dark'];
  var LABELS = {
    auto: '配色：端末の設定に合わせる',
    light: '配色：ライト',
    dark: '配色：ダーク'
  };
  // ヘッダー（bg-blue-800）の実値。ブラウザのアドレスバーの色を合わせる。
  // style.css の --brand-header と同じ値にすること。
  var THEME_COLOR = { light: '#1e40af', dark: '#16223f' };

  var root = document.documentElement;

  function read() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      return MODES.indexOf(v) >= 0 ? v : 'auto';
    } catch (e) {
      // プライベートブラウズ等でlocalStorageが触れないことがある。
      // その場合はOS追従（既定）のまま動かす。
      return 'auto';
    }
  }

  function save(mode) {
    try {
      if (mode === 'auto') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) { /* 保存できなくても表示自体は切り替わる */ }
  }

  // いま実際に暗いか（autoのときはOSの設定を見る）
  function isDark(mode) {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function apply(mode) {
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);

    // <meta name="theme-color"> はheadの解析後にしか存在しないので、
    // 初回適用時（head実行中）は空振りする。DOMContentLoadedで再適用する。
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDark(mode) ? THEME_COLOR.dark : THEME_COLOR.light);

    var btns = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-label', LABELS[mode]);
      btns[i].setAttribute('title', LABELS[mode] + '（タップで切替）');
    }
  }

  // ---- 初期適用（描画前に行う） ----
  var current = read();
  apply(current);

  // ---- ボタンの配線 ----
  // ボタンはこのスクリプトの実行時点ではまだ存在しないため、document への
  // 委任で拾う（ページごとにヘッダーの組み方が違っても1か所で済む）。
  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest('.theme-toggle');
    if (!btn) return;
    ev.preventDefault();
    current = MODES[(MODES.indexOf(current) + 1) % MODES.length];
    save(current);
    apply(current);
  });

  document.addEventListener('DOMContentLoaded', function () {
    apply(current); // meta[theme-color] とボタンのラベルを確定させる
  });

  // OS側の設定が変わったとき、auto のままの人はアドレスバーの色も追従させる
  // （配色そのものはCSSのメディアクエリが自動で切り替える）。
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (current === 'auto') apply('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange); // 古いSafari向け
  }
})();
