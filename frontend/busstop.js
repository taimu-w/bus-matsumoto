/* ==========================================================
 * バス停検索機能（SPA） / 補完仕様書 バス停検索機能_補完仕様書.md
 *
 * 画面とURL:
 *   /busstop                              検索画面
 *   /busstop/{stop_id}                    バス停詳細（すべての乗り場）
 *   /busstop/{stop_id}?platform={id}      バス停詳細（乗り場別）
 *
 * 時刻表検索機能（timetable.js）と同じくHistory API（パス）でルーティングする。
 * data-spa委任クリックリスナーは timetable.js が既にdocument全体へ登録しているため
 * ここでは重複登録しない（navigate()は自前で持ち、ボタン等の動的要素から呼ぶ）。
 *
 * バス停詳細データ自体は新規APIを作らず、既存の /api/timetable/stops/{stopKey} を
 * そのまま利用する（補完仕様書 10.2）。新規APIは検索の別名 /api/busstop/search と
 * 接近中バス情報 /api/busstop/{stopKey}/approaching のみ。
 * ========================================================== */
(function () {
  const API_BASE = '/api';
  const APPROACHING_POLL_MS = 20000; // 既存のTRIP_REALTIME_POLL_MSと統一（仕様書 3.5.3）

  // 画面をまたいで保持する状態
  let searchQuery = '';
  let searchTimer = null;
  let searchSeq = 0;
  // 「近くのバス停」候補。位置情報の許可ダイアログを毎回出さないよう、取得結果をページ内で使い回す。
  let nearbyStopsCache = null;
  let nearbyStopsPromise = null;
  // 「乗り場別」を選んだ直後の選択UI（'map' | 'headsign' | null）
  let platformChooser = null;
  let chooserStopKey = null;
  let renderSeq = 0;
  // 「地図から選ぶ」タブの地図
  let platformPickerMap = null;
  let platformPickerMarkers = [];
  // 「マップで見る」モーダルの地図（上とは別管理）
  let overviewMapInstance = null;
  let overviewMarkers = [];
  let approachingTimer = null;

  /* ---------- 小さなヘルパー ---------- */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  function root() {
    return document.getElementById('busstop-root');
  }

  function setTitle(title, subtitle) {
    if (typeof window.setPageTitle === 'function') window.setPageTitle(title, subtitle);
  }

  function todayString() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  /* ---------- 路線カラーとコントラスト（timetable.jsと同一ロジック） ---------- */
  function parseHexColor(color) {
    if (!color) return null;
    const hex = String(color).replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }

  function relativeLuminance(rgb) {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function contrastWithWhite(rgb) {
    const l = relativeLuminance(rgb);
    return 1.05 / (l + 0.05);
  }

  function routeColorStyle(color) {
    const rgb = parseHexColor(color);
    if (!rgb) {
      return { hex: null, numberColor: '#1f2937', underline: '#cbd5e1', needsBadge: false };
    }
    const hex = `#${String(color).replace('#', '')}`;
    const readable = contrastWithWhite(rgb) >= 3;
    return {
      hex,
      numberColor: readable ? hex : '#1f2937',
      underline: hex,
      needsBadge: !readable
    };
  }

  function chipTextColor(color, textColor) {
    const rgb = parseHexColor(color);
    if (!rgb) return '#1f2937';
    const declared = parseHexColor(textColor);
    if (declared) return `#${String(textColor).replace('#', '')}`;
    return relativeLuminance(rgb) > 0.5 ? '#111827' : '#ffffff';
  }

  function formatDelayLabel(minutes) {
    if (minutes === null || minutes === undefined) return '';
    return minutes <= 1 ? '定刻通り' : `${minutes}分遅れ`;
  }

  /* ---------- ルーティング ---------- */
  function isBusStopPath() {
    return window.location.pathname === '/busstop' || window.location.pathname.startsWith('/busstop/');
  }

  function parsePath() {
    const parts = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(window.location.search);
    if (parts[0] !== 'busstop') return null;
    if (parts.length >= 2) {
      return { view: 'stop', stopKey: parts.slice(1).join('/'), params };
    }
    return { view: 'search', params };
  }

  function navigate(url, { replace = false } = {}) {
    if (replace) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);
    if (typeof window.renderCurrentRoute === 'function') window.renderCurrentRoute();
    else render();
    window.scrollTo(0, 0);
  }

  function busStopUrl(stopKey, { platform = null } = {}) {
    const query = new URLSearchParams();
    if (platform) query.set('platform', platform);
    const qs = query.toString();
    return `/busstop/${encodeURIComponent(stopKey)}${qs ? `?${qs}` : ''}`;
  }

  function timetableUrl(stopKey, { platform = null } = {}) {
    const query = new URLSearchParams();
    if (platform) query.set('platform', platform);
    const qs = query.toString();
    return `/timetable/stops/${encodeURIComponent(stopKey)}${qs ? `?${qs}` : ''}`;
  }

  function tripUrl(bus, backUrl) {
    const query = new URLSearchParams();
    if (bus.hasRealtime) query.set('view', 'realtime');
    if (backUrl) query.set('from', backUrl);
    const qs = query.toString();
    return `/timetable/trips/${encodeURIComponent(bus.feedId)}/${encodeURIComponent(bus.routeId)}/${encodeURIComponent(bus.tripId)}/${encodeURIComponent(bus.tripDepartureTime)}${qs ? `?${qs}` : ''}`;
  }

  function googleMapsUrl(lat, lng) {
    return `https://maps.google.com/maps?daddr=${lat},${lng}`;
  }

  /**
   * 標柱の表示名。platform_code は「3」のような番号のほか「降車」など文字列の場合もあるため、
   * 数字のときだけ「◯番のりば」にする（timetable.jsと同一ロジック）。
   */
  function platformLabel(platform) {
    const code = platform.platformCode;
    if (!code) return `のりば（${platform.stopId}）`;
    return /^\d+$/.test(code) ? `${code}番のりば` : code;
  }

  /** 表示モード（すべての乗り場・乗り場別）に応じて、行き先が確定している標柱を返す。複数標柱かつ未選択ならnull。 */
  function effectivePlatform(data) {
    if (data.selectedPlatform) {
      return data.platforms.find((p) => p.stopId === data.selectedPlatform.stopId) || null;
    }
    if (!data.hasMultiplePlatforms) return data.platforms[0] || null;
    return null;
  }

  /* ---------- 画面: 検索 ---------- */
  function renderSearchView() {
    setTitle('バス停検索', 'Bus Stop Search');
    root().innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-indigo-900">バス停検索</h2>
        <a href="/" data-spa class="text-sm font-bold text-indigo-700">メニューへ戻る</a>
      </div>
      <div class="bg-white rounded-2xl shadow-sm border-2 border-indigo-200 p-5">
        <label class="block text-sm font-bold text-gray-700 mb-2" for="bs-search-input">バス停名で検索</label>
        <input id="bs-search-input" type="search" autocomplete="off"
               placeholder="漢字・ひらがな・カタカナ・ローマ字で入力（例：松本 / まつもと / matsumoto）"
               class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:outline-none font-bold">
        <p class="text-[11px] text-gray-500 font-bold mt-2">入力するとすぐに候補が表示されます。</p>
        <div id="bs-search-results" class="mt-4 space-y-2"></div>
      </div>
    `;

    const input = document.getElementById('bs-search-input');
    const container = document.getElementById('bs-search-results');
    input.value = searchQuery;
    input.addEventListener('input', () => {
      searchQuery = input.value;
      clearTimeout(searchTimer);
      if (!searchQuery.trim()) {
        showNearbyStops(container);
        return;
      }
      searchTimer = setTimeout(runSearch, 180);
    });
    // 入力欄への自動フォーカス（＝キーボードの自動表示）は廃止し、代わりに近くのバス停を候補として出す。
    if (searchQuery.trim()) runSearch();
    else showNearbyStops(container);
  }

  async function runSearch() {
    const container = document.getElementById('bs-search-results');
    if (!container) return;
    const query = searchQuery.trim();
    if (!query) {
      showNearbyStops(container);
      return;
    }

    const seq = ++searchSeq;
    try {
      const data = await fetchJson(`${API_BASE}/busstop/search?q=${encodeURIComponent(query)}`);
      if (seq !== searchSeq) return;
      renderSearchResults(container, data.stops || []);
    } catch (err) {
      if (seq !== searchSeq) return;
      container.innerHTML = `<p class="text-sm font-bold text-red-600">検索に失敗しました：${esc(err.message)}</p>`;
    }
  }

  /** 検索結果カード1件分のHTML。「近くのバス停」候補でも見た目を揃えるため共通化する。 */
  function stopCardHtml(stop) {
    const reading = [stop.nameHiragana, stop.nameRomaji].filter(Boolean).join(' / ');
    const chips = (stop.routes || [])
      .slice(0, 6)
      .map((route) => {
        const bg = parseHexColor(route.color) ? `#${route.color.replace('#', '')}` : '#e2e8f0';
        const fg = chipTextColor(route.color, route.textColor);
        return `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full" style="background:${esc(bg)};color:${esc(fg)}">${esc(route.shortName || route.name)}</span>`;
      })
      .join('');
    const more = (stop.routes || []).length > 6 ? `<span class="text-[10px] font-bold text-gray-500">ほか${stop.routes.length - 6}路線</span>` : '';
    const badge = Number.isFinite(stop.walkMinutes)
      ? `<span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 shrink-0">徒歩約${stop.walkMinutes}分</span>`
      : `<span class="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-2 py-1 shrink-0">${stop.platformCount}乗り場</span>`;
    return `
      <a href="${esc(busStopUrl(stop.stopKey))}" data-spa
         class="block bg-white border-2 border-gray-200 rounded-xl p-3 hover:border-indigo-500 active:scale-[0.99] transition-all">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="font-bold text-lg text-gray-900 truncate">${esc(stop.stopName)}</p>
            ${reading ? `<p class="text-[11px] text-gray-500 font-bold truncate">${esc(reading)}</p>` : ''}
          </div>
          ${badge}
        </div>
        <div class="flex flex-wrap gap-1 mt-2 items-center">${chips}${more}</div>
      </a>`;
  }

  function renderSearchResults(container, stops) {
    if (stops.length === 0) {
      container.innerHTML = '<p class="text-sm font-bold text-gray-500">該当するバス停が見つかりませんでした。</p>';
      return;
    }

    container.innerHTML = stops.map(stopCardHtml).join('');
  }

  /** 現在地から近いバス停（最大5件）。位置情報の許可ダイアログは1画面につき1回だけ出す。 */
  async function getNearbyStops() {
    if (nearbyStopsCache) return nearbyStopsCache;
    if (!nearbyStopsPromise) {
      nearbyStopsPromise = (async () => {
        if (typeof window.getUserLocation !== 'function') return [];
        const location = await window.getUserLocation();
        if (!location) return [];
        try {
          const query = new URLSearchParams({ lat: location.lat, lon: location.lng, limit: 5 });
          const data = await fetchJson(`${API_BASE}/busstop/nearby?${query.toString()}`);
          return data.stops || [];
        } catch (err) {
          return [];
        }
      })();
    }
    nearbyStopsCache = await nearbyStopsPromise;
    return nearbyStopsCache;
  }

  /** 検索欄が空のときの初期表示。自動フォーカスの代わりに近くのバス停を候補として出す（soft-fail：取得できなければ何も出さない）。 */
  async function showNearbyStops(container) {
    container.innerHTML = '<p class="text-sm font-bold text-gray-400 py-3 text-center">近くのバス停を確認中...</p>';
    const stops = await getNearbyStops();
    // 取得を待つ間に入力・画面遷移されていたら上書きしない
    if (searchQuery.trim() || document.getElementById('bs-search-results') !== container) return;
    if (stops.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = `<p class="text-xs font-bold text-gray-500 px-1">現在地から近いバス停</p><div class="mt-2 space-y-2">${stops.map(stopCardHtml).join('')}</div>`;
  }

  /* ---------- 画面: バス停詳細 ---------- */
  async function renderStopView(state) {
    const platform = state.params.get('platform') || '';

    if (chooserStopKey !== state.stopKey) {
      chooserStopKey = state.stopKey;
      platformChooser = null;
    }
    if (platform && !platformChooser) platformChooser = 'headsign';

    destroyPlatformPickerMap();
    stopApproachingPolling();
    const seq = ++renderSeq;
    root().innerHTML = '<p class="text-sm font-bold text-gray-500 py-10 text-center">バス停情報を読み込み中...</p>';

    const date = todayString();
    let data;
    try {
      const query = new URLSearchParams({ date });
      if (platform) query.set('platform', platform);
      data = await fetchJson(`${API_BASE}/timetable/stops/${encodeURIComponent(state.stopKey)}?${query.toString()}`);
      if (seq !== renderSeq) return;
    } catch (err) {
      if (seq !== renderSeq) return;
      root().innerHTML = `
        <div class="bg-white rounded-2xl border-2 border-red-200 p-5">
          <p class="font-bold text-red-700">${esc(err.status === 404 ? '指定のバス停が見つかりませんでした。' : err.message)}</p>
          <button data-role="bs-back" class="inline-block mt-4 text-sm font-bold text-indigo-700">← 戻る</button>
        </div>`;
      // このページは検索結果・経路検索・時刻表・お気に入りなど複数の入口から来ることがあるため、
      // 「検索画面へ」固定ではなく直前の画面へ戻る（履歴が無ければ検索画面にフォールバック）。
      const backBtn = root().querySelector('[data-role="bs-back"]');
      if (backBtn) backBtn.addEventListener('click', () => window.smartBack('/busstop'));
      return;
    }

    setTitle(data.stop.stopName, 'Bus Stop');

    // 別名で開かれた場合は正規のURLへ置き換える（timetable.jsと同じブックマーク正規化）
    if (data.stop.stopKey !== state.stopKey) {
      window.history.replaceState({}, '', busStopUrl(data.stop.stopKey, { platform }));
    }

    const reading = [data.stop.nameHiragana, data.stop.nameRomaji].filter(Boolean).join(' / ');
    const platform_ = effectivePlatform(data);

    root().innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <button data-role="bs-back" class="text-sm font-bold text-indigo-700">← 戻る</button>
        <a href="/" data-spa class="text-sm font-bold text-gray-500">メニュー</a>
      </div>

      <div class="bg-white rounded-2xl shadow-sm border-2 border-indigo-200 p-5 mb-4">
        <p class="text-xs text-indigo-600 font-bold">バス停</p>
        <h2 class="text-2xl font-bold text-indigo-900 leading-tight">${esc(data.stop.stopName)}</h2>
        ${reading ? `<p class="text-[11px] text-gray-500 font-bold mt-1">${esc(reading)}</p>` : ''}
        ${renderModeSwitch(data)}
      </div>

      ${renderChooser(data)}

      <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-200 p-4 mb-4">
        <p class="text-xs font-bold text-gray-500 mb-2">このバス停でできること</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <a href="${esc(timetableUrl(data.stop.stopKey, { platform: platform_ ? platform_.stopId : null }))}" data-spa
             class="block text-center bg-sky-600 text-white py-3 rounded-xl font-bold text-sm shadow hover:bg-sky-700">時刻表へ</a>
          <button data-role="bs-goto" class="bg-emerald-600 text-white py-3 rounded-xl font-bold text-sm shadow hover:bg-emerald-700">このバス停に行く</button>
          <button data-role="bs-showmap" class="bg-teal-600 text-white py-3 rounded-xl font-bold text-sm shadow hover:bg-teal-700">マップで見る</button>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-200 p-4">
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs font-bold text-gray-500">接近中のバス情報</p>
          <span class="text-[10px] font-bold text-gray-400">30分以内に到着予定の便</span>
        </div>
        <div id="bs-approaching-list"><p class="text-sm font-bold text-gray-400 py-3 text-center">読み込み中...</p></div>
      </div>
    `;

    bindStopViewEvents(data, platform);
    loadApproaching(data, seq, platform);
    manageApproachingPolling(data, seq, platform);
  }

  /** 表示モード切替（標柱が複数ある場合のみ表示する。仕様書 3.4 A） */
  function renderModeSwitch(data) {
    if (!data.hasMultiplePlatforms) return '';
    const allActive = !data.selectedPlatform && platformChooser === null;
    const activeClass = 'bg-indigo-600 text-white shadow';
    const idleClass = 'bg-gray-100 text-gray-700 hover:bg-gray-200';
    const selected = data.selectedPlatform;
    const selectedInfo = selected
      ? `<div class="mt-3 flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2">
           <span class="text-sm font-bold text-indigo-900">表示中の乗り場：${esc(platformLabel(selected))}</span>
           <button data-role="change-platform" class="text-xs font-bold text-indigo-700 underline">変更</button>
         </div>`
      : '';

    return `
      <div class="mt-4">
        <p class="text-[11px] font-bold text-gray-500 mb-1">表示モード（この停留所には乗り場が${data.platforms.length}か所あります）</p>
        <div class="flex gap-2">
          <button data-role="mode-all" class="flex-1 py-2.5 rounded-lg font-bold text-sm transition-all ${allActive ? activeClass : idleClass}">すべての乗り場</button>
          <button data-role="mode-platform" class="flex-1 py-2.5 rounded-lg font-bold text-sm transition-all ${allActive ? idleClass : activeClass}">乗り場別</button>
        </div>
        ${selectedInfo}
      </div>`;
  }

  /** 「地図から選ぶ」「方面から選ぶ」の選択UI（timetable.jsと同型） */
  function renderChooser(data) {
    if (!data.hasMultiplePlatforms) return '';
    if (data.selectedPlatform || platformChooser === null) return '';

    const tab = (key, label) => {
      const active = platformChooser === key;
      return `<button data-role="chooser-${key}" class="flex-1 py-2 rounded-lg font-bold text-sm ${active ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700'}">${label}</button>`;
    };

    const body = platformChooser === 'map'
      ? '<div id="bs-platform-map" class="h-64 rounded-xl overflow-hidden border border-gray-200"></div>'
      : renderHeadsignChooser(data);

    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-indigo-100 p-4 mb-4">
        <div class="flex gap-2 mb-3">
          ${tab('map', '地図から選ぶ')}
          ${tab('headsign', '方面から選ぶ')}
        </div>
        ${body}
      </div>`;
  }

  /** 方面（stop_headsign）を路線カラー付きで並べる（timetable.jsと同型）。 */
  function renderHeadsignChooser(data) {
    const cards = data.platforms
      .map((platform) => {
        const headsigns = platform.headsigns.length > 0
          ? platform.headsigns
              .map((h) => {
                const bg = parseHexColor(h.color) ? `#${h.color.replace('#', '')}` : '#e2e8f0';
                const fg = chipTextColor(h.color, h.textColor);
                return `<div class="flex items-center gap-2 py-1">
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0" style="background:${esc(bg)};color:${esc(fg)}">${esc(h.routeShortName || h.routeName)}</span>
                    <span class="text-sm font-bold text-gray-800 truncate">${esc(h.headsign || '行先表示なし')}</span>
                  </div>`;
              })
              .join('')
          : '<p class="text-xs font-bold text-gray-400 py-1">この日の運行はありません</p>';

        return `
          <button data-role="pick-platform" data-platform="${esc(platform.stopId)}"
                  class="w-full text-left bg-white border-2 border-gray-200 rounded-xl p-3 hover:border-indigo-500 active:scale-[0.99] transition-all">
            <div class="flex items-center justify-between">
              <span class="font-bold text-gray-900">${esc(platformLabel(platform))}</span>
              <span class="text-[10px] font-bold text-gray-400">${esc(platform.stopId)}</span>
            </div>
            <div class="mt-1">${headsigns}</div>
          </button>`;
      })
      .join('');

    return `<div class="space-y-2">${cards}</div>`;
  }

  function bindStopViewEvents(data, platform) {
    const container = root();

    const go = (nextPlatform) => {
      navigate(busStopUrl(data.stop.stopKey, { platform: nextPlatform || null }));
    };

    // このページは検索結果・経路検索・時刻表・お気に入り・バス停マップなど複数の入口から
    // 来ることがあるため、「検索画面へ」固定ではなく直前の画面へ戻る（補完仕様書対応）。
    const backBtn = container.querySelector('[data-role="bs-back"]');
    if (backBtn) backBtn.addEventListener('click', () => window.smartBack('/busstop'));

    const modeAll = container.querySelector('[data-role="mode-all"]');
    if (modeAll) {
      modeAll.addEventListener('click', () => {
        platformChooser = null;
        if (platform) go('');
        else renderStopView(parsePath());
      });
    }

    const modePlatform = container.querySelector('[data-role="mode-platform"]');
    if (modePlatform) {
      modePlatform.addEventListener('click', () => {
        if (platform) return; // 既に選択中なら「変更」から
        platformChooser = platformChooser || 'headsign';
        renderStopView(parsePath());
      });
    }

    const changeBtn = container.querySelector('[data-role="change-platform"]');
    if (changeBtn) {
      changeBtn.addEventListener('click', () => {
        platformChooser = 'headsign';
        go('');
      });
    }

    const chooserMap = container.querySelector('[data-role="chooser-map"]');
    if (chooserMap) {
      chooserMap.addEventListener('click', () => {
        platformChooser = 'map';
        renderStopView(parsePath());
      });
    }
    const chooserHeadsign = container.querySelector('[data-role="chooser-headsign"]');
    if (chooserHeadsign) {
      chooserHeadsign.addEventListener('click', () => {
        platformChooser = 'headsign';
        renderStopView(parsePath());
      });
    }

    container.querySelectorAll('[data-role="pick-platform"]').forEach((button) => {
      button.addEventListener('click', () => go(button.dataset.platform));
    });

    const gotoBtn = container.querySelector('[data-role="bs-goto"]');
    if (gotoBtn) gotoBtn.addEventListener('click', () => handleGoTo(data));

    const showMapBtn = container.querySelector('[data-role="bs-showmap"]');
    if (showMapBtn) showMapBtn.addEventListener('click', () => handleShowMap(data));

    if (platformChooser === 'map' && !data.selectedPlatform) {
      setupPlatformPickerMap(data);
    }
  }

  /** 地図から標柱を選ぶ（仕様書 3.3.3「地図から選ぶ」） */
  function setupPlatformPickerMap(data) {
    const el = document.getElementById('bs-platform-map');
    if (!el || typeof window.L === 'undefined') return;

    destroyPlatformPickerMap();
    const points = data.platforms.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (points.length === 0) {
      el.innerHTML = '<p class="text-sm font-bold text-gray-500 p-4">位置情報が登録されていません。</p>';
      return;
    }

    platformPickerMap = window.L.map(el).setView([data.stop.lat, data.stop.lon], 17);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(platformPickerMap);

    const bounds = [];
    points.forEach((platform) => {
      const label = platform.platformCode || platform.stopId.split('_').pop();
      const marker = window.L.marker([platform.lat, platform.lon], {
        icon: window.L.divIcon({
          html: `<div style="background:#4f46e5;color:#fff;border:2px solid #fff;border-radius:9999px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;box-shadow:0 1px 4px rgba(0,0,0,.4)">${esc(label)}</div>`,
          className: 'bs-platform-pin',
          iconSize: [34, 34]
        })
      }).addTo(platformPickerMap);

      const destinations = platform.headsigns.slice(0, 3).map((h) => h.headsign).filter(Boolean).join('・');
      marker.bindPopup(
        `<div style="font-weight:700">${esc(platformLabel(platform))}</div>` +
        (destinations ? `<div style="font-size:11px">${esc(destinations)}方面</div>` : '') +
        '<div style="font-size:11px;color:#4f46e5;font-weight:700;margin-top:4px">この乗り場を見る</div>'
      );
      marker.on('click', () => {
        navigate(busStopUrl(data.stop.stopKey, { platform: platform.stopId }));
      });
      platformPickerMarkers.push(marker);
      bounds.push([platform.lat, platform.lon]);
    });

    if (bounds.length > 1) platformPickerMap.fitBounds(bounds, { padding: [30, 30] });
    setTimeout(() => platformPickerMap && platformPickerMap.invalidateSize(), 100);
  }

  function destroyPlatformPickerMap() {
    if (platformPickerMap) {
      platformPickerMap.remove();
      platformPickerMap = null;
    }
    platformPickerMarkers = [];
  }

  /* ---------- 「このバス停に行く」（Googleマップ、仕様書 3.4.2） ---------- */
  function handleGoTo(data) {
    const platform = effectivePlatform(data);
    if (platform) {
      window.open(googleMapsUrl(platform.lat, platform.lon), '_blank', 'noopener');
      return;
    }
    // すべての乗り場モード・標柱複数 -> 乗り場選択ポップアップ（リスト形式）
    openPlatformPicker(data, (picked) => {
      window.open(googleMapsUrl(picked.lat, picked.lon), '_blank', 'noopener');
    });
  }

  function openPlatformPicker(data, onPick) {
    const list = document.getElementById('bs-platform-picker-list');
    if (!list || typeof window.openModal !== 'function') return;

    list.innerHTML = data.platforms
      .map((p) => {
        const destinations = p.headsigns.slice(0, 2).map((h) => h.headsign).filter(Boolean).join('・');
        return `
          <button data-role="bs-pick" data-stop-id="${esc(p.stopId)}"
                  class="w-full text-left bg-white border-2 border-gray-200 rounded-xl p-3 hover:border-emerald-500 active:scale-[0.99] transition-all">
            <span class="font-bold text-gray-900">${esc(platformLabel(p))}</span>
            ${destinations ? `<span class="block text-[11px] text-gray-500 font-bold mt-0.5">${esc(destinations)}方面</span>` : ''}
          </button>`;
      })
      .join('');

    window.openModal('bs-platform-picker-modal');
    list.querySelectorAll('[data-role="bs-pick"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const picked = data.platforms.find((p) => p.stopId === btn.dataset.stopId);
        if (typeof window.closeModal === 'function') window.closeModal('bs-platform-picker-modal');
        if (picked) onPick(picked);
      });
    });
  }

  /* ---------- 「マップで見る」（OpenStreetMap、仕様書 3.4.3） ---------- */
  function handleShowMap(data) {
    const platform = effectivePlatform(data);
    if (platform) {
      showStopMapModal([platform], { navigable: false });
    } else {
      showStopMapModal(data.platforms, { navigable: true, stopKey: data.stop.stopKey });
    }
  }

  function destroyOverviewMap() {
    if (overviewMapInstance) {
      overviewMapInstance.remove();
      overviewMapInstance = null;
    }
    overviewMarkers = [];
  }

  function showStopMapModal(platforms, { navigable, stopKey } = {}) {
    if (typeof window.openModal !== 'function' || typeof window.L === 'undefined') return;
    window.openModal('bs-map-modal');
    destroyOverviewMap();

    // モーダルがdisplay:noneから表示に切り替わった直後はコンテナの実寸が取れないため少し待つ
    // （timetable.jsのshowLocationPopup/setupPlatformMapと同じ理由）。
    setTimeout(() => {
      const el = document.getElementById('bs-map-canvas');
      if (!el) return;
      const points = platforms.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (points.length === 0) {
        el.innerHTML = '<p class="text-sm font-bold text-gray-500 p-4">位置情報が登録されていません。</p>';
        return;
      }

      overviewMapInstance = window.L.map(el).setView([points[0].lat, points[0].lon], points.length > 1 ? 15 : 17);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
      }).addTo(overviewMapInstance);

      const bounds = [];
      points.forEach((platform) => {
        const label = platform.platformCode || platform.stopId.split('_').pop();
        const marker = window.L.marker([platform.lat, platform.lon], {
          icon: window.L.divIcon({
            html: `<div style="background:#0d9488;color:#fff;border:2px solid #fff;border-radius:9999px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;box-shadow:0 1px 4px rgba(0,0,0,.4)">${esc(label)}</div>`,
            className: 'bs-overview-pin',
            iconSize: [34, 34]
          })
        }).addTo(overviewMapInstance);

        const destinations = (platform.headsigns || []).slice(0, 3).map((h) => h.headsign).filter(Boolean).join('・');
        marker.bindPopup(
          `<div style="font-weight:700">${esc(platformLabel(platform))}</div>` +
          (destinations ? `<div style="font-size:11px">${esc(destinations)}方面</div>` : '') +
          (navigable ? '<div style="font-size:11px;color:#0d9488;font-weight:700;margin-top:4px">この乗り場の詳細を見る</div>' : '')
        );
        if (navigable) {
          marker.on('click', () => {
            if (typeof window.closeModal === 'function') window.closeModal('bs-map-modal');
            navigate(busStopUrl(stopKey, { platform: platform.stopId }));
          });
        }
        overviewMarkers.push(marker);
        bounds.push([platform.lat, platform.lon]);
      });

      if (bounds.length > 1) overviewMapInstance.fitBounds(bounds, { padding: [30, 30] });
      setTimeout(() => overviewMapInstance && overviewMapInstance.invalidateSize(), 100);
    }, 50);
  }

  /* ---------- 接近中のバス情報（仕様書 3.4.4 / 3.5） ---------- */
  function stopApproachingPolling() {
    if (approachingTimer) {
      clearInterval(approachingTimer);
      approachingTimer = null;
    }
  }

  function manageApproachingPolling(data, seq, platform) {
    stopApproachingPolling();
    approachingTimer = setInterval(() => {
      if (seq !== renderSeq) { stopApproachingPolling(); return; }
      loadApproaching(data, seq, platform);
    }, APPROACHING_POLL_MS);
  }

  async function loadApproaching(data, seq, platform) {
    const container = document.getElementById('bs-approaching-list');
    if (!container) return;
    try {
      const query = new URLSearchParams();
      if (platform) query.set('platform', platform);
      const res = await fetchJson(`${API_BASE}/busstop/${encodeURIComponent(data.stop.stopKey)}/approaching?${query.toString()}`);
      if (seq !== renderSeq) return;
      renderApproachingList(container, res.approachingBuses || [], data, platform);
    } catch (err) {
      if (seq !== renderSeq) return;
      // リアルタイム取得の失敗は静的情報の表示を妨げない（soft-fail、仕様書5.2）
      container.innerHTML = '<p class="text-sm font-bold text-gray-400 py-3 text-center">接近中のバス情報を取得できませんでした。</p>';
    }
  }

  function renderApproachingList(container, buses, data, platform) {
    if (buses.length === 0) {
      container.innerHTML = '<p class="text-sm font-bold text-gray-400 py-3 text-center">現在、30分以内に到着予定の便はありません。</p>';
      return;
    }

    const backUrl = busStopUrl(data.stop.stopKey, { platform: platform || null });

    container.innerHTML = buses
      .map((bus) => {
        const style = routeColorStyle(bus.routeColor);
        const bg = style.hex || '#e2e8f0';
        const fg = chipTextColor(bus.routeColor, bus.routeTextColor);
        const timeLabel = bus.hasRealtime ? (bus.predictedArrivalTime || bus.scheduledArrivalTime) : bus.scheduledArrivalTime;
        const delayLabel = bus.hasRealtime ? (formatDelayLabel(bus.delayMinutes) || '定刻通り') : '';
        const posLabel = bus.hasRealtime
          ? [
              bus.currentStopName ? `${bus.currentStopName}通過済` : '始発前',
              bus.remainingStops !== null && bus.remainingStops !== undefined ? `あと${bus.remainingStops}停留所` : ''
            ].filter(Boolean).join(' ／ ')
          : '時刻表どおりの到着予想';
        const badge = bus.hasRealtime
          ? '<span class="text-[10px] font-bold text-green-700 bg-green-50 px-2 py-0.5 rounded border border-green-200 inline-flex items-center"><span class="w-1.5 h-1.5 bg-green-500 rounded-full mr-1 animate-pulse"></span>リアルタイム</span>'
          : '<span class="text-[10px] font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded border border-gray-200">時刻表</span>';

        const url = bus.tripDepartureTime ? tripUrl(bus, backUrl) : null;
        const tag = url ? 'a' : 'div';
        const hrefAttr = url ? `href="${esc(url)}" data-spa` : '';

        return `
          <${tag} ${hrefAttr} class="block border-2 border-gray-200 rounded-xl p-3 ${url ? 'hover:border-indigo-500 active:scale-[0.99] transition-all' : ''}">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0" style="background:${esc(bg)};color:${esc(fg)}">${esc(bus.routeName)}</span>
                <span class="text-sm font-bold text-gray-800 truncate">${esc(bus.headsign || '行先表示なし')}行</span>
              </div>
              ${badge}
            </div>
            <div class="flex items-center justify-between mt-2">
              <p class="text-[11px] font-bold text-gray-500">${esc(posLabel)}</p>
              <div class="text-right">
                <span class="text-lg font-bold text-gray-900">${esc(timeLabel || '--')}</span>
                ${delayLabel ? `<span class="block text-[10px] font-bold text-gray-500">${esc(delayLabel)}</span>` : ''}
              </div>
            </div>
          </${tag}>`;
      })
      .join('');
  }

  /* ---------- エントリポイント ---------- */
  async function render() {
    const section = document.getElementById('section-busstop');
    if (!section) return;
    section.style.display = 'block';
    destroyPlatformPickerMap();
    destroyOverviewMap();
    stopApproachingPolling();

    const state = parsePath();
    if (!state || state.view === 'search') {
      renderSearchView();
      return;
    }
    if (state.view === 'stop') {
      await renderStopView(state);
    }
  }

  window.BusStopView = { render, isBusStopPath, navigate };
})();
