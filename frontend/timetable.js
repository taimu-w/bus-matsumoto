/* ==========================================================
 * 時刻表検索機能（SPA）
 *
 * 画面とURL（仕様書 3.2）:
 *   /timetable                                                      検索画面
 *   /timetable/stops/{stop_id}                                      バス停詳細（すべての乗り場）
 *   /timetable/stops/{stop_id}?platform={platform_stop_id}          バス停詳細（乗り場別）
 *   /timetable/trips/{gtfs_id}/{route_id}/{trip_id}/{departure_time} 便詳細（通過時刻）
 *
 * 既存画面はハッシュ（#/realtime など）でルーティングしているが、この機能は
 * 仕様書のURL設計に合わせて History API（パス）でルーティングする。
 * サーバー側は /api 以外をすべて index.html へフォールバックさせているので、
 * 直リンク・リロードでもこの画面から復帰できる。
 * ========================================================== */
(function () {
  const API_BASE = '/api';

  // 画面をまたいで保持する状態
  let searchQuery = '';
  let searchTimer = null;
  let searchSeq = 0;
  // 「近くのバス停」候補。位置情報の許可ダイアログを毎回出さないよう、取得結果をページ内で使い回す（busstop.jsと同じ方式）。
  let nearbyStopsCache = null;
  let nearbyStopsPromise = null;
  // 「乗り場別」を選んだ直後の選択UI（'map' | 'headsign' | null）
  let platformChooser = null;
  let chooserStopKey = null;
  // 非同期描画が追い抜かれたときに古い結果で上書きしないための世代番号
  let renderSeq = 0;
  let mapInstance = null;
  let platformMarkers = [];
  // 便詳細ページの「地図で表示」ポップアップ専用のLeafletインスタンス（プラットフォーム選択地図とは別管理）
  let tripMapPopupInstance = null;
  // 便詳細ページのリアルタイム表示中の自動更新タイマー（20秒間隔。他画面のPOLL_MSと合わせる）
  let tripRealtimeTimer = null;
  const TRIP_REALTIME_POLL_MS = 20000;

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
    const res = await fetch(url, { headers: { 'X-Client-Id': window.BUS_TIME_CLIENT_ID || '' } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  // app.jsで管理している「自動更新ON/OFF」（手動設定・サーバー高負荷時の一時停止の両方を反映）
  function autoRefreshEnabled() {
    return typeof window.isBusTimeAutoRefreshEnabled !== 'function' || window.isBusTimeAutoRefreshEnabled();
  }

  function root() {
    return document.getElementById('timetable-root');
  }

  function setTitle(title, subtitle) {
    if (typeof window.setPageTitle === 'function') window.setPageTitle(title, subtitle);
  }

  /* ---------- 日付ユーティリティ（JST基準） ---------- */
  const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

  function todayString() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function dateToUtc(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map((v) => parseInt(v, 10));
    return new Date(Date.UTC(y, m - 1, d));
  }

  function formatDateLabel(dateStr) {
    const d = dateToUtc(dateStr);
    if (Number.isNaN(d.getTime())) return dateStr;
    return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEKDAY_LABELS[d.getUTCDay()]}）`;
  }

  /**
   * 「平日」「土曜日」「日祝日」タグから、その区分に当てはまる直近の日付を求める。
   * 実際に適用されるダイヤは、この日付に対して calendar / calendar_dates から
   * サーバー側が判定する（祝日の特別ダイヤも calendar_dates 経由で反映される）。
   */
  function nextDateOfKind(kind, fromDateStr) {
    const start = dateToUtc(fromDateStr || todayString());
    for (let i = 0; i < 14; i += 1) {
      const candidate = new Date(start.getTime() + i * 86400000);
      const dow = candidate.getUTCDay();
      const matched =
        (kind === 'weekday' && dow >= 1 && dow <= 5) ||
        (kind === 'saturday' && dow === 6) ||
        (kind === 'holiday' && dow === 0);
      if (matched) {
        return `${candidate.getUTCFullYear()}-${String(candidate.getUTCMonth() + 1).padStart(2, '0')}-${String(candidate.getUTCDate()).padStart(2, '0')}`;
      }
    }
    return fromDateStr || todayString();
  }

  /* ---------- 路線カラーとコントラスト（仕様書 3.4 C） ---------- */
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

  /**
   * 白背景の上に路線カラーで数字を描けるかを判定する。
   * コントラスト比が足りない色（黄色など）は、数字を濃色にして
   * 路線カラーは下線＋円形バッジで表現する（仕様書 3.4 C 視認性確保）。
   */
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

  /** 凡例などで使う「路線カラーを背景にしたチップ」の文字色を決める。 */
  function chipTextColor(color, textColor) {
    const rgb = parseHexColor(color);
    if (!rgb) return '#1f2937';
    const declared = parseHexColor(textColor);
    if (declared) return `#${String(textColor).replace('#', '')}`;
    return relativeLuminance(rgb) > 0.5 ? '#111827' : '#ffffff';
  }

  /* ---------- ルーティング ---------- */
  function isTimetablePath() {
    return window.location.pathname === '/timetable' || window.location.pathname.startsWith('/timetable/');
  }

  function parsePath() {
    const parts = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(window.location.search);
    if (parts[0] !== 'timetable') return null;
    if (parts[1] === 'stops' && parts[2]) {
      return { view: 'stop', stopKey: parts.slice(2).join('/'), params };
    }
    if (parts[1] === 'trips' && parts.length >= 6) {
      return {
        view: 'trip',
        feedId: parts[2],
        routeId: parts[3],
        tripId: parts[4],
        departureTime: parts[5],
        params
      };
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

  // SPA内リンク（data-spa 付き）をページ遷移させずに処理する
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-spa]');
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(link.getAttribute('href'));
  });

  /**
   * 標柱の表示名。platform_code は「3」のような番号のほか「降車」など文字列の場合もあるため、
   * 数字のときだけ「◯番のりば」にする。
   */
  function platformLabel(platform) {
    const code = platform.platformCode;
    if (!code) return `のりば（${platform.stopId}）`;
    return /^\d+$/.test(code) ? `${code}番のりば` : code;
  }

  /** 現在のバス停詳細URLを組み立てる。 */
  function stopUrl(stopKey, { platform = null, date = null } = {}) {
    const query = new URLSearchParams();
    if (platform) query.set('platform', platform);
    if (date) query.set('date', date);
    const qs = query.toString();
    return `/timetable/stops/${encodeURIComponent(stopKey)}${qs ? `?${qs}` : ''}`;
  }

  /** バス停ページ（/busstop/...）のURLを組み立てる。platformKeyがあればその乗り場単独のページへ。 */
  function busStopUrl(stopKey, platformKey = null) {
    const query = new URLSearchParams();
    if (platformKey) query.set('platform', platformKey);
    const qs = query.toString();
    return `/busstop/${encodeURIComponent(stopKey)}${qs ? `?${qs}` : ''}`;
  }

  /** お気に入り対象（時刻表・バス停詳細）。urlは日付を含めず、開いた時点の「今日」で常に表示する。 */
  function timetableFavorite(data, platform) {
    const platformId = platform || '';
    let subtitle = '時刻表';
    if (data.hasMultiplePlatforms) subtitle = data.selectedPlatform ? `時刻表・${platformLabel(data.selectedPlatform)}` : '時刻表・すべての乗り場';
    return {
      id: `timetable|${data.stop.stopKey}|${platformId}`,
      type: 'timetable',
      title: data.stop.stopName,
      subtitle,
      url: stopUrl(data.stop.stopKey, { platform: platformId || null })
    };
  }

  /** お気に入り対象（便詳細）。 */
  function tripFavorite(data, state) {
    return {
      id: `trip|${state.feedId}|${state.routeId}|${state.tripId}|${state.departureTime}`,
      type: 'trip',
      title: data.headsign ? `${data.headsign} 行` : data.routeName,
      subtitle: `${data.routeName}・${state.departureTime}発`,
      url: `/timetable/trips/${encodeURIComponent(state.feedId)}/${encodeURIComponent(state.routeId)}/${encodeURIComponent(state.tripId)}/${encodeURIComponent(state.departureTime)}`
    };
  }

  /* ---------- 画面: 検索 ---------- */
  function renderSearchView() {
    setTitle('時刻表検索', 'Timetable Search');
    root().innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-sky-900">時刻表検索</h2>
        <a href="/" data-spa class="text-sm font-bold text-sky-700">メニューへ戻る</a>
      </div>
      <div class="bg-white rounded-2xl shadow-sm border-2 border-sky-200 p-5">
        <label class="block text-sm font-bold text-gray-700 mb-2" for="tt-search-input">バス停名で検索</label>
        <input id="tt-search-input" type="search" autocomplete="off"
               placeholder="漢字・ひらがな・カタカナ・ローマ字で入力（例：松本 / まつもと / matsumoto）"
               class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-sky-500 focus:outline-none font-bold">
        <p class="text-[11px] text-gray-500 font-bold mt-2">入力するとすぐに候補が表示されます。</p>
        <div id="tt-search-results" class="mt-4 space-y-2"></div>
      </div>
    `;

    const input = document.getElementById('tt-search-input');
    const container = document.getElementById('tt-search-results');
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
    // 入力欄への自動フォーカス（＝キーボードの自動表示）は廃止し、代わりに近くのバス停を候補として出す（busstop.jsと同じ方針）。
    if (searchQuery.trim()) runSearch();
    else showNearbyStops(container);
  }

  async function runSearch() {
    const container = document.getElementById('tt-search-results');
    if (!container) return;
    const query = searchQuery.trim();
    if (!query) {
      showNearbyStops(container);
      return;
    }

    const seq = ++searchSeq;
    try {
      const data = await fetchJson(`${API_BASE}/timetable/stops/search?q=${encodeURIComponent(query)}`);
      if (seq !== searchSeq) return; // 古いリクエストの結果は捨てる
      renderSearchResults(container, data.stops || []);
    } catch (err) {
      if (seq !== searchSeq) return;
      container.innerHTML = `<p class="text-sm font-bold text-red-600">検索に失敗しました：${esc(err.message)}</p>`;
    }
  }

  /** 検索結果カード1件分のHTML。「近くのバス停」候補でも見た目を揃えるため共通化する（busstop.jsのstopCardHtmlと同じ方針）。 */
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
      : `<span class="text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 rounded px-2 py-1 shrink-0">${stop.platformCount}乗り場</span>`;
    // 検索結果のタップ先は直接 /timetable/stops/{stop_id}（この画面の時刻表詳細）。
    return `
      <a href="${stopUrl(stop.stopKey)}" data-spa
         class="block bg-white border-2 border-gray-200 rounded-xl p-3 hover:border-sky-500 active:scale-[0.99] transition-all">
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

  /** 現在地から近いバス停（最大5件）。位置情報の許可ダイアログは1画面につき1回だけ出す（busstop.jsと同じ実装）。 */
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

  /**
   * お気に入り登録済みバス停のサマリー（重複なし・登録が新しい順、busstop.jsと同じ実装）。
   * 特定の乗り場のみお気に入りでもバス停単位（すべての乗り場）で候補に出す。
   */
  async function getFavoriteStops() {
    const keys = window.Favorites ? window.Favorites.favoriteBusStopKeys() : [];
    if (keys.length === 0) return [];
    try {
      const query = new URLSearchParams({ keys: keys.join(',') });
      const data = await fetchJson(`${API_BASE}/busstop/by-keys?${query.toString()}`);
      return data.stops || [];
    } catch (err) {
      return [];
    }
  }

  /** 検索欄が空のときの初期表示。自動フォーカスの代わりにお気に入りバス停・近くのバス停を
   *  候補として出す（お気に入りを一番上、その次に近い順。soft-fail：取得できなければ何も出さない）。 */
  async function showNearbyStops(container) {
    container.innerHTML = '<p class="text-sm font-bold text-gray-400 py-3 text-center">近くのバス停を確認中...</p>';
    const [favoriteStops, nearbyStops] = await Promise.all([getFavoriteStops(), getNearbyStops()]);
    // 取得を待つ間に入力・画面遷移されていたら上書きしない
    if (searchQuery.trim() || document.getElementById('tt-search-results') !== container) return;
    const favoriteKeys = new Set(favoriteStops.map((stop) => stop.stopKey));
    const nearbyOnlyStops = nearbyStops.filter((stop) => !favoriteKeys.has(stop.stopKey));
    if (favoriteStops.length === 0 && nearbyOnlyStops.length === 0) {
      container.innerHTML = '';
      return;
    }
    const sections = [];
    if (favoriteStops.length > 0) {
      sections.push(`<p class="text-xs font-bold text-gray-500 px-1">お気に入りバス停</p><div class="mt-2 space-y-2">${favoriteStops.map(stopCardHtml).join('')}</div>`);
    }
    if (nearbyOnlyStops.length > 0) {
      sections.push(`<p class="text-xs font-bold text-gray-500 px-1 ${favoriteStops.length > 0 ? 'mt-4' : ''}">現在地から近いバス停</p><div class="mt-2 space-y-2">${nearbyOnlyStops.map(stopCardHtml).join('')}</div>`);
    }
    container.innerHTML = sections.join('');
  }

  /* ---------- 画面: バス停詳細 ---------- */
  async function renderStopView(state) {
    const date = state.params.get('date') || todayString();
    const platform = state.params.get('platform') || '';

    if (chooserStopKey !== state.stopKey) {
      chooserStopKey = state.stopKey;
      platformChooser = null;
    }
    if (platform && !platformChooser) platformChooser = 'headsign';

    destroyMap();
    const seq = ++renderSeq;
    root().innerHTML = '<p class="text-sm font-bold text-gray-500 py-10 text-center">時刻表を読み込み中...</p>';

    let data;
    try {
      const query = new URLSearchParams({ date });
      if (platform) query.set('platform', platform);
      data = await fetchJson(`${API_BASE}/timetable/stops/${encodeURIComponent(state.stopKey)}?${query.toString()}`);
      if (seq !== renderSeq) return; // 連打で追い抜かれた描画は捨てる
    } catch (err) {
      if (seq !== renderSeq) return;
      root().innerHTML = `
        <div class="bg-white rounded-2xl border-2 border-red-200 p-5">
          <p class="font-bold text-red-700">${esc(err.status === 404 ? 'バス停が見つかりませんでした。' : err.message)}</p>
          <button data-role="tt-back" class="inline-block mt-4 text-sm font-bold text-sky-700">← 戻る</button>
        </div>`;
      // このページはバス停検索（busstop.js）の「時刻表へ」ボタン経由でも来るため、
      // 「検索画面へ」固定ではなく直前の画面へ戻る（履歴が無ければ検索画面にフォールバック）。
      const errBackBtn = root().querySelector('[data-role="tt-back"]');
      if (errBackBtn) errBackBtn.addEventListener('click', () => window.smartBack('/timetable'));
      return;
    }

    setTitle(data.stop.stopName, 'Timetable');

    // 別名で開かれた場合は正規のURLへ置き換える（ブックマークの正規化）
    if (data.stop.stopKey !== state.stopKey) {
      window.history.replaceState({}, '', stopUrl(data.stop.stopKey, { platform, date: state.params.get('date') }));
    }

    const reading = [data.stop.nameHiragana, data.stop.nameRomaji].filter(Boolean).join(' / ');
    root().innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <button data-role="tt-back" class="text-sm font-bold text-sky-700">← 戻る</button>
        <a href="/" data-spa class="text-sm font-bold text-gray-500">メニュー</a>
      </div>

      <div class="bg-white rounded-2xl shadow-sm border-2 border-sky-200 p-5 mb-4">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-xs text-sky-600 font-bold">バス停</p>
            <h2 class="text-2xl font-bold text-sky-900 leading-tight">${esc(data.stop.stopName)}</h2>
            ${reading ? `<p class="text-[11px] text-gray-500 font-bold mt-1">${esc(reading)}</p>` : ''}
          </div>
          ${window.Favorites ? window.Favorites.starButtonHtml(timetableFavorite(data, platform)) : ''}
        </div>
        ${renderModeSwitch(data, date)}
        <a href="${esc(busStopUrl(data.stop.stopKey, data.selectedPlatform ? data.selectedPlatform.platformKey : null))}" data-spa
           class="mt-4 block text-center bg-indigo-600 text-white py-3 rounded-xl font-bold text-sm shadow hover:bg-indigo-700">このバス停のページへ</a>
      </div>

      ${renderChooser(data, date)}
      ${renderCalendar(data, date, platform)}
      ${renderLegend(data)}
      ${renderTimetableGrid(data, date, platform)}
    `;

    bindStopViewEvents(data, date, platform);
  }

  /** 表示モード切替（標柱が複数ある場合のみ表示する。仕様書 3.4 A） */
  function renderModeSwitch(data, date) {
    if (!data.hasMultiplePlatforms) return '';
    const allActive = !data.selectedPlatform && platformChooser === null;
    const activeClass = 'bg-sky-600 text-white shadow';
    const idleClass = 'bg-gray-100 text-gray-700 hover:bg-gray-200';
    const selected = data.selectedPlatform;
    const selectedInfo = selected
      ? `<div class="mt-3 flex items-center justify-between bg-sky-50 border border-sky-200 rounded-xl px-3 py-2">
           <span class="text-sm font-bold text-sky-900">表示中の乗り場：${esc(platformLabel(selected))}</span>
           <button data-role="change-platform" class="text-xs font-bold text-sky-700 underline">変更</button>
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

  /** 「地図から選ぶ」「方面から選ぶ」の選択UI */
  function renderChooser(data, date) {
    if (!data.hasMultiplePlatforms) return '';
    if (data.selectedPlatform || platformChooser === null) return '';

    const tab = (key, label) => {
      const active = platformChooser === key;
      return `<button data-role="chooser-${key}" class="flex-1 py-2 rounded-lg font-bold text-sm ${active ? 'bg-sky-600 text-white' : 'bg-gray-100 text-gray-700'}">${label}</button>`;
    };

    const body = platformChooser === 'map'
      ? '<div id="tt-platform-map" class="h-64 rounded-xl overflow-hidden border border-gray-200"></div>'
      : renderHeadsignChooser(data, date);

    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-sky-100 p-4 mb-4">
        <div class="flex gap-2 mb-3">
          ${tab('map', '地図から選ぶ')}
          ${tab('headsign', '方面から選ぶ')}
        </div>
        ${body}
      </div>`;
  }

  /** 方面（stop_headsign）を路線カラー付きで並べる。 */
  function renderHeadsignChooser(data, date) {
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
          <button data-role="pick-platform" data-platform="${esc(platform.platformKey)}"
                  class="w-full text-left bg-white border-2 border-gray-200 rounded-xl p-3 hover:border-sky-500 active:scale-[0.99] transition-all">
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

  /** 日付選択・運行区分タグ（仕様書 3.4 B） */
  function renderCalendar(data, date, platform) {
    const tags = [
      { kind: 'weekday', label: '平日' },
      { kind: 'saturday', label: '土曜日' },
      { kind: 'holiday', label: '日祝日' }
    ]
      .map((tag) => {
        const target = nextDateOfKind(tag.kind, todayString());
        const active = target === date;
        return `<button data-role="date-kind" data-kind="${tag.kind}"
                  class="px-3 py-1.5 rounded-full text-xs font-bold border-2 ${active ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-gray-700 border-gray-200'}">${tag.label}</button>`;
      })
      .join('');

    const services = (data.services || [])
      .map((service) => `<span class="text-[10px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-0.5">${esc(service.serviceId)}（${esc(service.label)}）${service.isException ? '・特別ダイヤ' : ''}</span>`)
      .join('');

    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-200 p-4 mb-4">
        <div class="flex flex-wrap items-center gap-2">
          <input type="date" id="tt-date" value="${esc(date)}"
                 class="px-3 py-2 border-2 border-gray-200 rounded-lg font-bold text-sm focus:border-sky-500 focus:outline-none">
          <button data-role="date-today" class="px-3 py-1.5 rounded-full text-xs font-bold border-2 ${date === todayString() ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-gray-700 border-gray-200'}">今日</button>
          ${tags}
        </div>
        <p class="text-sm font-bold text-gray-800 mt-3">${esc(formatDateLabel(date))}の時刻表 ／ 全${data.totalDepartures}本</p>
        <div class="flex flex-wrap gap-1 mt-2">${services || '<span class="text-[10px] font-bold text-gray-400">この日に運行する系統はありません</span>'}</div>
        ${platform ? '' : '<p class="text-[11px] text-gray-500 font-bold mt-2">すべての乗り場を統合して表示しています。各時刻には行先を併記しています。</p>'}
      </div>`;
  }

  /** 凡例（路線カラー・略名・主要行先） */
  function renderLegend(data) {
    if (!data.legend || data.legend.length === 0) return '';
    const items = data.legend
      .map((route) => {
        const bg = parseHexColor(route.color) ? `#${route.color.replace('#', '')}` : '#e2e8f0';
        const fg = chipTextColor(route.color, route.textColor);
        const destinations = (route.headsigns || []).slice(0, 3).join('・');
        return `
          <div class="flex items-start gap-2 py-1">
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 mt-0.5" style="background:${esc(bg)};color:${esc(fg)}">${esc(route.shortName || route.name)}</span>
            <div class="min-w-0">
              <p class="text-xs font-bold text-gray-800 truncate">${esc(route.name)}</p>
              ${destinations ? `<p class="text-[10px] text-gray-500 font-bold truncate">${esc(destinations)}方面</p>` : ''}
            </div>
          </div>`;
      })
      .join('');

    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-200 p-4 mb-4">
        <p class="text-xs font-bold text-gray-500 mb-1">凡例（路線カラー）</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">${items}</div>
      </div>`;
  }

  /** 時刻表本体（縦軸=時 / 横軸=分） */
  function renderTimetableGrid(data, date, platform) {
    if (!data.hours || data.hours.length === 0) {
      return `
        <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-200 p-6 text-center">
          <p class="font-bold text-gray-500">${esc(formatDateLabel(date))}にこの乗り場から発車する便はありません。</p>
        </div>`;
    }

    const showHeadsign = !platform;
    const rows = data.hours
      .map((block) => {
        const isNextDay = block.hour >= 24;
        const hourLabel = isNextDay ? block.hour - 24 : block.hour;
        const tiles = block.departures
          .map((departure) => {
            const style = routeColorStyle(departure.routeColor);
            const sub = showHeadsign
              ? (departure.headsign || departure.routeShortName || '')
              : (departure.routeShortName || departure.routeName || '');
            const platformBadge = showHeadsign && departure.platformCode
              ? `${/^\d+$/.test(departure.platformCode) ? `${departure.platformCode}番` : departure.platformCode} `
              : '';
            const url = tripUrl(departure, data.stop.stopKey, date, platform);
            return `
              <a href="${esc(url)}" data-spa class="tt-min" style="border-bottom-color:${esc(style.underline)}"
                 title="${esc(`${departure.time} ${departure.routeName} ${departure.headsign || ''}`)}">
                ${style.needsBadge ? `<span class="tt-min-dot" style="background:${esc(style.hex)}"></span>` : ''}
                <span class="tt-min-num" style="color:${esc(style.numberColor)}">${String(departure.minute).padStart(2, '0')}</span>
                ${sub ? `<span class="tt-min-sub">${esc(platformBadge + sub)}</span>` : ''}
              </a>`;
          })
          .join('');

        return `
          <div class="tt-hour-row">
            <div class="tt-hour">${hourLabel}${isNextDay ? '<small>翌日</small>' : ''}</div>
            <div class="tt-minutes">${tiles}</div>
          </div>`;
      })
      .join('');

    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-sky-200 overflow-hidden">
        <div class="px-4 py-2 bg-sky-50 border-b border-sky-100 flex justify-between items-center">
          <span class="text-xs font-bold text-sky-900">時刻表</span>
          <span class="text-[10px] font-bold text-sky-700">時刻をタップすると各バス停の通過時刻を表示します</span>
        </div>
        ${rows}
      </div>`;
  }

  function tripUrl(departure, stopKey, date, platform) {
    const query = new URLSearchParams();
    query.set('stop', departure.platformStopId);
    query.set('from', stopUrl(stopKey, { platform: platform || null, date }));
    return `/timetable/trips/${encodeURIComponent(departure.feedId)}/${encodeURIComponent(departure.routeId)}/${encodeURIComponent(departure.tripId)}/${encodeURIComponent(departure.tripDepartureTime)}?${query.toString()}`;
  }

  function bindStopViewEvents(data, date, platform) {
    const container = root();

    const go = (nextPlatform, nextDate) => {
      navigate(stopUrl(data.stop.stopKey, { platform: nextPlatform || null, date: nextDate || date }));
    };

    // このページはバス停検索（busstop.js）の「時刻表へ」ボタン経由でも来るため、
    // 「検索画面へ」固定ではなく直前の画面へ戻る。
    const backBtn = container.querySelector('[data-role="tt-back"]');
    if (backBtn) backBtn.addEventListener('click', () => window.smartBack('/timetable'));

    const modeAll = container.querySelector('[data-role="mode-all"]');
    if (modeAll) {
      modeAll.addEventListener('click', () => {
        platformChooser = null;
        if (platform) go('', date);
        else renderStopView(parsePath());
      });
    }

    const modePlatform = container.querySelector('[data-role="mode-platform"]');
    if (modePlatform) {
      modePlatform.addEventListener('click', () => {
        // 既に乗り場を選んでいる場合は何もしない（切り替えは「変更」ボタンから）
        if (platform) return;
        platformChooser = platformChooser || 'headsign';
        renderStopView(parsePath());
      });
    }

    const changeBtn = container.querySelector('[data-role="change-platform"]');
    if (changeBtn) {
      changeBtn.addEventListener('click', () => {
        platformChooser = 'headsign';
        go('', date);
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
      button.addEventListener('click', () => go(button.dataset.platform, date));
    });

    const dateInput = container.querySelector('#tt-date');
    if (dateInput) {
      dateInput.addEventListener('change', () => {
        if (dateInput.value) go(platform, dateInput.value);
      });
    }
    const todayBtn = container.querySelector('[data-role="date-today"]');
    if (todayBtn) todayBtn.addEventListener('click', () => go(platform, todayString()));
    container.querySelectorAll('[data-role="date-kind"]').forEach((button) => {
      button.addEventListener('click', () => go(platform, nextDateOfKind(button.dataset.kind, todayString())));
    });

    if (platformChooser === 'map' && !data.selectedPlatform) {
      setupPlatformMap(data, date);
    }
  }

  /** 地図から標柱を選ぶ（仕様書 3.4 A「地図から選ぶ」） */
  function setupPlatformMap(data, date) {
    const el = document.getElementById('tt-platform-map');
    if (!el || typeof window.L === 'undefined') return;

    destroyMap();
    const points = data.platforms.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (points.length === 0) {
      el.innerHTML = '<p class="text-sm font-bold text-gray-500 p-4">位置情報が登録されていません。</p>';
      return;
    }

    mapInstance = window.L.map(el).setView([data.stop.lat, data.stop.lon], 17);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(mapInstance);

    const bounds = [];
    points.forEach((platform) => {
      const label = platform.platformCode || platform.stopId.split('_').pop();
      const marker = window.L.marker([platform.lat, platform.lon], {
        icon: window.L.divIcon({
          html: `<div style="background:#0284c7;color:#fff;border:2px solid #fff;border-radius:9999px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;box-shadow:0 1px 4px rgba(0,0,0,.4)">${esc(label)}</div>`,
          className: 'tt-platform-pin',
          iconSize: [34, 34]
        })
      }).addTo(mapInstance);

      const destinations = platform.headsigns.slice(0, 3).map((h) => h.headsign).filter(Boolean).join('・');
      marker.bindPopup(
        `<div style="font-weight:700">${esc(platformLabel(platform))}</div>` +
        (destinations ? `<div style="font-size:11px">${esc(destinations)}方面</div>` : '') +
        '<div style="font-size:11px;color:#0284c7;font-weight:700;margin-top:4px">この乗り場の時刻表を見る</div>'
      );
      marker.on('click', () => {
        navigate(stopUrl(data.stop.stopKey, { platform: platform.platformKey, date }));
      });
      platformMarkers.push(marker);
      bounds.push([platform.lat, platform.lon]);
    });

    if (bounds.length > 1) mapInstance.fitBounds(bounds, { padding: [30, 30] });
    setTimeout(() => mapInstance && mapInstance.invalidateSize(), 100);
  }

  function destroyMap() {
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
    platformMarkers = [];
  }

  function stopTripRealtimePolling() {
    if (tripRealtimeTimer) {
      clearInterval(tripRealtimeTimer);
      tripRealtimeTimer = null;
    }
  }

  function destroyTripMapPopup() {
    if (tripMapPopupInstance) {
      tripMapPopupInstance.remove();
      tripMapPopupInstance = null;
    }
  }

  /**
   * OpenStreetMapのポップアップ地図を表示する（外部サイトへは遷移しない）。
   * 車両の最新位置をバスアイコンで、この便が停車するバス停をバス停アイコンで表示する。
   * バス停全件が収まるようにズームアウトはせず、バスの現在地にある程度拡大した状態で開く。
   * バス停アイコンは1回タップするとバス停名を表示し、同じアイコンをもう一度タップすると
   * そのバス停（乗り場）のページへ遷移する。
   *
   * staticStopsは便詳細の静的停車リスト（data.stops）。bus.stopsと同じGTFS stop_times由来で
   * 並び・件数が一致するため、同じindexのstopKey/platformKeyをそのまま遷移先に使える
   * （renderRealtimeRowsのtt-rt-stopと同じ橋渡し方法）。
   */
  function showLocationPopup(bus, label, staticStops) {
    const vLat = Number(bus && bus.lat);
    const vLng = Number(bus && bus.lng);
    if (!Number.isFinite(vLat) || !Number.isFinite(vLng)) return;
    if (typeof window.openModal !== 'function' || typeof window.L === 'undefined') return;

    const titleEl = document.getElementById('tt-map-popup-title');
    if (titleEl) titleEl.textContent = label || '';
    window.openModal('tt-map-popup-modal');
    destroyTripMapPopup();

    // モーダルがdisplay:noneから表示に切り替わった直後はコンテナの実寸が取れないため、
    // 少し待ってから地図を初期化する（setupPlatformMap()のinvalidateSizeと同じ理由）。
    setTimeout(() => {
      const el = document.getElementById('tt-map-popup-canvas');
      if (!el) return;
      tripMapPopupInstance = window.L.map(el).setView([vLat, vLng], 16);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
      }).addTo(tripMapPopupInstance);

      // タップ中（名前表示中）のバス停マーカー。同じマーカーを連続タップしたときだけ遷移させる。
      let openStopMarker = null;

      (bus.stops || []).forEach((stop, index) => {
        const lat = Number(stop.lat);
        const lng = Number(stop.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const marker = window.L.marker([lat, lng], {
          icon: window.L.divIcon({
            html: `<div style="background:#0284c7;color:#fff;border:2px solid #fff;border-radius:9999px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4)">🚏</div>`,
            className: 'tt-map-popup-stop-pin',
            iconSize: [26, 26]
          })
        }).addTo(tripMapPopupInstance);
        marker.bindTooltip(esc(stop.name), { direction: 'top', offset: [0, -14] });

        const staticStop = (staticStops || [])[index] || null;
        const targetUrl = staticStop && staticStop.stopKey ? busStopUrl(staticStop.stopKey, staticStop.platformKey) : null;

        marker.on('click', () => {
          if (openStopMarker === marker) {
            if (targetUrl) {
              if (typeof window.closeModal === 'function') window.closeModal('tt-map-popup-modal');
              navigate(targetUrl);
            }
            return;
          }
          if (openStopMarker) openStopMarker.closeTooltip();
          openStopMarker = marker;
          marker.openTooltip();
        });
      });

      // 車両アイコンはバス停アイコンより上に重なるよう最後に追加する
      window.L.marker([vLat, vLng], {
        icon: window.L.divIcon({
          html: `<div style="background:#ef4444;color:#fff;border:2px solid #fff;border-radius:9999px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 1px 4px rgba(0,0,0,.5)">🚌</div>`,
          className: 'tt-map-popup-bus-pin',
          iconSize: [34, 34]
        }),
        zIndexOffset: 1000
      }).addTo(tripMapPopupInstance);

      tripMapPopupInstance.invalidateSize();
    }, 50);
  }

  function formatDelayLabel(minutes) {
    if (minutes === null || minutes === undefined) return '';
    return minutes <= 1 ? '定刻通り' : `${minutes}分遅れ`;
  }

  /** リアルタイム停車状況の中で「直近到着済み」のインデックスを返す（無ければ-1）。 */
  function findLastArrivedIndex(stops) {
    let idx = -1;
    (stops || []).forEach((s, i) => { if (s.status === '到着済') idx = i; });
    return idx;
  }

  /**
   * "H:mm"文字列を分単位に変換する（不正値・未設定はNaN）。
   * backend/src/utils/time.js の timeStrToMinutes と同じ考え方（フロントとバックエンドで
   * モジュールを共有していないため、この程度の小さなヘルパーは各ファイルで持つ）。
   */
  function timeStrToMinutesLocal(timeStr) {
    if (!timeStr) return NaN;
    const parts = String(timeStr).split(':');
    if (parts.length < 2) return NaN;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
    return h * 60 + m;
  }

  /**
   * 2つの"H:mm"由来の分数の差(a-b)を日跨ぎ考慮で正規化する
   * （backend/src/services/passDetection.js の diffMinutesSigned と同じ考え方）。
   */
  function diffMinutesSignedLocal(aMin, bMin) {
    let diff = aMin - bMin;
    if (diff < -720) diff += 24 * 60;
    else if (diff > 720) diff -= 24 * 60;
    return diff;
  }

  /* ---------- 画面: 便詳細（通過時刻一覧・リアルタイム表示） ---------- */
  async function renderTripView(state) {
    const seq = ++renderSeq;
    stopTripRealtimePolling();
    root().innerHTML = '<p class="text-sm font-bold text-gray-500 py-10 text-center">便情報を読み込み中...</p>';

    const backUrl = state.params.get('from') || '/timetable';
    const stopParam = state.params.get('stop') || '';
    const initialMode = state.params.get('view') === 'realtime' ? 'realtime' : 'schedule';
    const tripApiPath = `${API_BASE}/timetable/trips/${encodeURIComponent(state.feedId)}/${encodeURIComponent(state.routeId)}/${encodeURIComponent(state.tripId)}/${encodeURIComponent(state.departureTime)}`;

    let data;
    try {
      const query = stopParam ? `?stop=${encodeURIComponent(stopParam)}` : '';
      data = await fetchJson(`${tripApiPath}${query}`);
      if (seq !== renderSeq) return;
    } catch (err) {
      if (seq !== renderSeq) return;
      root().innerHTML = `
        <div class="bg-white rounded-2xl border-2 border-red-200 p-5">
          <p class="font-bold text-red-700">${esc(err.status === 404 ? 'この便の情報が見つかりませんでした。時刻表が改訂された可能性があります。' : err.message)}</p>
          <button data-role="tt-trip-back" class="inline-block mt-4 text-sm font-bold text-sky-700">← 戻る</button>
        </div>`;
      // 便詳細は時刻表・バス停ページ・経路検索・リアルタイム表示など様々な画面から来るため、
      // 直前の画面へ戻る（履歴が無ければ from パラメータ、それも無ければ時刻表検索へ）。
      const errBackBtn = root().querySelector('[data-role="tt-trip-back"]');
      if (errBackBtn) errBackBtn.addEventListener('click', () => window.smartBack(backUrl));
      return;
    }

    // リアルタイム運行状況の取得に失敗しても、静的時刻表の表示は妨げない（別経路のため独立してsoft-fail）
    let realtime = { available: false };
    try {
      realtime = await fetchJson(`${tripApiPath}/realtime`);
    } catch (err) {
      realtime = { available: false };
    }
    if (seq !== renderSeq) return;

    let mode = initialMode === 'realtime' && realtime.available ? 'realtime' : 'schedule';

    setTitle(data.headsign || data.routeName, 'Trip Detail');

    const bg = parseHexColor(data.routeColor) ? `#${data.routeColor.replace('#', '')}` : '#0f172a';
    const fg = chipTextColor(data.routeColor, data.routeTextColor);
    const currentIndex = data.stops.findIndex((stop) => stop.isCurrent);

    function renderScheduleRows() {
      return data.stops
        .map((stop, index) => {
          const time = stop.departureTime || stop.arrivalTime;
          const passed = stop.isThrough;
          const base = stop.isCurrent
            ? 'bg-blue-50 border-blue-300 tt-current-stop'
            : passed
              ? 'bg-gray-50 border-gray-200 opacity-70'
              : 'bg-white border-gray-200';
          const arrivalNote =
            stop.arrivalTime && stop.departureTime && stop.arrivalTime !== stop.departureTime
              ? `<span class="text-[10px] font-bold text-gray-500 block">着 ${esc(stop.arrivalTime)}</span>`
              : '';
          const tags = [
            stop.isCurrent ? '<span class="text-[10px] font-bold text-white bg-blue-600 rounded px-1.5 py-0.5">閲覧中</span>' : '',
            index === 0 ? '<span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">始発</span>' : '',
            index === data.stops.length - 1 ? '<span class="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5">終点</span>' : '',
            passed ? '<span class="text-[10px] font-bold text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">通過</span>' : '',
            !passed && stop.noPickup && index !== data.stops.length - 1 ? '<span class="text-[10px] font-bold text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">降車のみ</span>' : '',
            !passed && stop.noDropOff && index !== 0 ? '<span class="text-[10px] font-bold text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">乗車のみ</span>' : ''
          ].filter(Boolean).join(' ');

          // バス停名タップ先は「その乗り場のバス停ページ」（/busstop/...）。すべての乗り場ではなく
          // この便が実際に通る乗り場単独のページへ遷移させる（補完仕様書 3.6.2 に準じた措置）。
          const nameCell = stop.stopKey
            ? `<a href="${esc(busStopUrl(stop.stopKey, stop.platformKey))}" data-spa class="font-bold text-gray-900 hover:text-sky-700 underline decoration-dotted">${esc(stop.stopName)}</a>`
            : `<span class="font-bold text-gray-900">${esc(stop.stopName)}</span>`;

          return `
            <div class="flex items-center gap-3 border rounded-xl px-3 py-2.5 ${base}">
              <span class="w-7 h-7 shrink-0 rounded-full bg-gray-100 text-gray-600 text-xs font-bold flex items-center justify-center">${index + 1}</span>
              <div class="min-w-0 flex-1">
                ${nameCell}
                ${stop.platformCode ? `<span class="text-[10px] font-bold text-gray-500 ml-1">${esc(platformLabel(stop))}</span>` : ''}
                <div class="flex flex-wrap gap-1 mt-0.5">${tags}</div>
              </div>
              <div class="text-right shrink-0">
                <span class="text-xl font-bold ${passed ? 'text-gray-400 line-through-double' : 'text-gray-900'}">${esc(passed ? '通過' : (time || '--'))}</span>
                ${passed ? '' : arrivalNote}
              </div>
            </div>`;
        })
        .join('');
    }

    /**
     * リアルタイム表示中の停車行。定刻/予測/実績と遅延を表示する（app.jsのrenderStopRow相当）。
     *
     * 【バス停到着判定およびフロントエンド表示改善案】「次は」バッジは廃止した。既に通過して
     * いるのに到着済判定だけがまだ行われていない場合があり、利用者に誤解を与えるため。
     * 代わりに、より実態に近い3つの表示を導入する:
     *   ・「付近」バッジ: status==='付近'（バックエンドが2段階到着判定で新設した中間状態）。
     *     複数バス停に同時に付与され得る（付近入り後、到着確定前にGPS更新が途切れて次の
     *     バス停が先に付近入りすることがあるため）。
     *   ・「まもなく」バッジ: ETA到着予測時刻の2分前〜1分後（未満）の間だけ表示する。
     *   ・現在走行中区間の薄い青背景: 最後に到着済みとなったバス停から2停留所先までの
     *     うちETA5分以内の区間。ただし遅延で既にETAを過ぎている停留所が3停留所先より
     *     先にある場合は、そこまで（最大5停留所先まで）拡張する。
     * 同一バス停に「付近」「まもなく」の両方が該当する場合は「付近」を優先し「まもなく」は
     * 出さない（バッジのみの優先順位。背景の青帯とは独立）。
     * また「まもなく」バッジは、青帯（bandIndices）の最も先のバス停の1つ先までにしか
     * 付与しない。ETAだけで判定すると、実際の走行位置よりかなり先のバス停にまで
     * 「まもなく」が誤ってつくケースがあったため。
     */
    function renderRealtimeRows(bus) {
      const stops = bus.stops || [];
      const lastIdx = findLastArrivedIndex(stops);

      // 同一描画内で使うnowは1回だけ計算し、バッジ・青帯の判定で一貫させる。
      const nowDate = new Date();
      const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

      /** ETAまでの残り分（ETA-now）。ETAが無い/不正な場合はNaN。 */
      function etaRemainingMin(stop) {
        const etaStr = stop.predictedTime || stop.scheduledTime;
        const etaMin = timeStrToMinutesLocal(etaStr);
        if (Number.isNaN(etaMin)) return NaN;
        return diffMinutesSignedLocal(etaMin, nowMinutes);
      }

      // 【青帯】現在走行中と考えられる範囲を算出する。
      // 基本: lastIdx+1・lastIdx+2のうちETA5分以内。延長: 3停留所先より先にETAが
      // 既に経過（remain<=0）した停留所があれば、そこまで（最大lastIdx+5まで）拡張する。
      let bandEnd = lastIdx + 2;
      while (bandEnd < lastIdx + 5 && bandEnd + 1 < stops.length) {
        const remain = etaRemainingMin(stops[bandEnd + 1]);
        if (Number.isNaN(remain) || remain > 0) break;
        bandEnd++;
      }
      const bandIndices = new Set();
      for (let i = Math.max(lastIdx + 1, 0); i <= Math.min(bandEnd, stops.length - 1); i++) {
        const remain = etaRemainingMin(stops[i]);
        if (!Number.isNaN(remain) && remain <= 5) bandIndices.add(i);
      }
      // 「まもなく」バッジの上限インデックス。青帯（bandIndices）の最も先のバス停の
      // 1つ先までしか付けない（実際の走行位置より先のバス停に誤って付くのを防ぐため）。
      // 青帯が1件も無い場合は、直近到着済みの1つ先までに制限する。
      const maxBandIndex = bandIndices.size ? Math.max(...bandIndices) : lastIdx;
      const soonMaxIndex = maxBandIndex + 1;

      return stops
        .map((stop, index) => {
          const isArrived = stop.status === '到着済';
          const isThrough = stop.status === '通過';
          const isNearby = stop.status === '付近';
          const pending = !isArrived && !isThrough;
          const remain = pending ? etaRemainingMin(stop) : NaN;
          // 「まもなく」: ETA-2分 〜 ETA+1分未満。付近バッジがある場合は出さない（優先順位）。
          // さらに、青帯（bandIndices）の最も先のバス停の1つ先までにしか付けない。
          const isSoon = pending && !isNearby && !Number.isNaN(remain) && remain >= 0 && remain <= 2 && index <= soonMaxIndex;
          const isInBand = pending && bandIndices.has(index);

          // リアルタイム表示の停車行は便詳細の静的データ（data.stops）と同じ並び・件数になる
          // （どちらも同じ便のGTFS stop_times由来のため）。始発/終点/降車のみ/乗車のみといった
          // 表示用メタデータはリアルタイム側(trip_stop_progress)には持たせていないため、
          // 同じ便の静的データ側（常に正しい値を持つ）から補って表示する。
          const staticStop = data.stops[index] || null;
          const staticFallbackTime = staticStop ? (staticStop.departureTime || staticStop.arrivalTime) : null;
          const staticThrough = Boolean(staticStop && staticStop.isThrough);

          let timeLabel = '--';
          let delayLabel = '';
          if (isThrough) {
            timeLabel = '通過';
          } else if (isArrived) {
            timeLabel = stop.actualTime || '--';
            delayLabel = formatDelayLabel(stop.delayMinutes);
          } else {
            timeLabel = stop.predictedTime || stop.scheduledTime || staticFallbackTime || '--';
            delayLabel = formatDelayLabel(stop.predictedDelayMinutes);
          }
          const isDelayedPred = !isArrived && !isThrough && (stop.predictedDelayMinutes || 0) > 1;
          const base = isArrived || isThrough
            ? 'bg-gray-50 border-gray-200 opacity-70'
            : isInBand
              ? 'bg-sky-50 border-sky-200'
              : 'bg-white border-gray-200';
          const tags = [
            isNearby ? '<span class="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">付近</span>' : '',
            isSoon ? '<span class="text-[10px] font-bold text-white bg-blue-600 rounded px-1.5 py-0.5">まもなく</span>' : '',
            index === 0 ? '<span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">始発</span>' : '',
            index === stops.length - 1 ? '<span class="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5">終点</span>' : '',
            isArrived ? '<span class="text-[10px] font-bold text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">到着済</span>' : '',
            isThrough ? '<span class="text-[10px] font-bold text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">通過</span>' : '',
            !staticThrough && staticStop && staticStop.noPickup && index !== stops.length - 1 ? '<span class="text-[10px] font-bold text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">降車のみ</span>' : '',
            !staticThrough && staticStop && staticStop.noDropOff && index !== 0 ? '<span class="text-[10px] font-bold text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">乗車のみ</span>' : ''
          ].filter(Boolean).join(' ');

          return `
            <div class="flex items-center gap-3 border rounded-xl px-3 py-2.5 cursor-pointer active:opacity-70 ${base}"
                 data-role="tt-rt-stop" data-stop-key="${esc(staticStop ? staticStop.stopKey : '')}" data-platform-key="${esc(staticStop ? staticStop.platformKey : '')}">
              <span class="w-7 h-7 shrink-0 rounded-full bg-gray-100 text-gray-600 text-xs font-bold flex items-center justify-center">${index + 1}</span>
              <div class="min-w-0 flex-1">
                <span class="font-bold text-gray-900">${esc(stop.name)}</span>
                <div class="flex flex-wrap gap-1 mt-0.5">${tags}</div>
              </div>
              <div class="text-right shrink-0">
                <span class="text-lg font-bold ${isDelayedPred ? 'text-red-600' : 'text-gray-900'}">${esc(timeLabel)}</span>
                ${delayLabel ? `<span class="block text-[10px] font-bold text-gray-500">${esc(delayLabel)}</span>` : ''}
                <span class="block text-[10px] text-gray-400">定刻 ${esc(stop.scheduledTime || staticFallbackTime || '--')}</span>
              </div>
            </div>`;
        })
        .join('');
    }

    function paint() {
      if (seq !== renderSeq) return;
      const bus = mode === 'realtime' ? realtime.bus : null;
      // 「地図で表示」は車両の最新位置（バスアイコン）とこの便が停車するバス停（バス停アイコン）を表示する。
      const showMapBtn = bus && Number.isFinite(Number(bus.lat)) && Number.isFinite(Number(bus.lng));

      const delayBadge = bus
        ? `<span class="text-lg font-bold shrink-0 ${((bus.delayMinutes || 0) >= 5) ? 'bg-red-600 text-white' : 'bg-blue-100 text-blue-800'} px-3 py-1 rounded-full">${esc(formatDelayLabel(bus.delayMinutes) || '定刻通り')}</span>`
        : '';

      const toggleBtnHtml = realtime.available
        ? `<button data-role="tt-mode-toggle" class="text-xs font-bold text-white bg-sky-600 hover:bg-sky-700 rounded-full px-3 py-1.5 shrink-0">${mode === 'realtime' ? '<span class="inline-block w-2 h-2 bg-white rounded-full mr-1 animate-pulse"></span>' : ''}${esc(mode === 'realtime' ? '定刻表示に戻す' : 'リアルタイム表示に切替')}</button>`
        : '';
      const mapBtnHtml = showMapBtn
        ? `<button data-role="tt-map-btn" class="text-xs font-bold text-sky-700 bg-sky-50 border border-sky-200 rounded-full px-3 py-1.5 shrink-0">地図で表示</button>`
        : '';

      root().innerHTML = `
        <div class="flex items-center justify-between mb-3">
          <button data-role="tt-trip-back" class="text-sm font-bold text-sky-700">← 戻る</button>
          <a href="/timetable" data-spa class="text-sm font-bold text-gray-500">検索</a>
        </div>

        <div class="rounded-2xl shadow-sm border-2 border-gray-200 overflow-hidden mb-4">
          <div class="px-5 py-4" style="background:${esc(bg)};color:${esc(fg)}">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="text-xs font-bold opacity-90">${esc(data.agencyName || '')}</p>
                <h2 class="text-xl font-bold leading-tight">${esc(data.routeName)}</h2>
                <p class="text-sm font-bold mt-0.5">${esc(data.headsign ? `${data.headsign} 行` : '行先表示なし')}</p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                ${delayBadge}
                ${window.Favorites ? window.Favorites.starButtonHtml(tripFavorite(data, state), { size: 'w-9 h-9' }) : ''}
              </div>
            </div>
          </div>
          <div class="bg-white px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-bold text-gray-600">
            <span>始発 ${esc(data.stops[0] ? (data.stops[0].departureTime || '--') : '--')} ${esc(data.stops[0] ? data.stops[0].stopName : '')}</span>
            <span>終点 ${esc(data.stops.length ? (data.stops[data.stops.length - 1].arrivalTime || data.stops[data.stops.length - 1].departureTime || '--') : '--')} ${esc(data.stops.length ? data.stops[data.stops.length - 1].stopName : '')}</span>
            <span>運行区分 ${esc(data.serviceId)}</span>
            <span class="ml-auto flex items-center gap-2">${mapBtnHtml}${toggleBtnHtml}</span>
          </div>
          ${data.departureTimeMismatch ? '<div class="bg-amber-50 border-t border-amber-200 px-5 py-2 text-[11px] font-bold text-amber-800">指定された発車時刻と時刻表が一致しませんでした。GTFSの改訂により時刻が変更された可能性があります。</div>' : ''}
          ${initialMode === 'realtime' && !realtime.available ? '<div class="bg-gray-50 border-t border-gray-200 px-5 py-2 text-[11px] font-bold text-gray-500">現在この便のリアルタイム運行情報はありません。定刻表示を表示しています。</div>' : ''}
        </div>

        <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-200 p-4">
          <p class="text-xs font-bold text-gray-500 mb-2">${mode === 'realtime' ? 'リアルタイム運行状況' : `通過予定時刻（全${data.stops.length}停留所）`}</p>
          <div class="space-y-1.5">${mode === 'realtime' && bus ? renderRealtimeRows(bus) : renderScheduleRows()}</div>
        </div>
      `;

      if (mode === 'schedule' && currentIndex >= 0) {
        const currentEl = root().querySelectorAll('.tt-current-stop')[0];
        if (currentEl) setTimeout(() => currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
      }

      // 便詳細は時刻表・バス停ページ・経路検索・リアルタイム表示など様々な画面から来るため、
      // 直前の画面へ戻る（履歴が無ければ from パラメータ、それも無ければ時刻表検索へ）。
      const tripBackBtn = root().querySelector('[data-role="tt-trip-back"]');
      if (tripBackBtn) tripBackBtn.addEventListener('click', () => window.smartBack(backUrl));

      const toggleBtn = root().querySelector('[data-role="tt-mode-toggle"]');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          mode = mode === 'realtime' ? 'schedule' : 'realtime';
          paint();
          manageRealtimePolling();
        });
      }
      const mapBtn = root().querySelector('[data-role="tt-map-btn"]');
      if (mapBtn) {
        mapBtn.addEventListener('click', () => {
          showLocationPopup(bus, data.headsign ? `${data.headsign} 行` : data.routeName, data.stops);
        });
      }
      if (mode === 'realtime') {
        // バス停名タップで、通常表示（renderScheduleRows）と同様にそのバス停の乗り場ページへ遷移する。
        root().querySelectorAll('[data-role="tt-rt-stop"]').forEach((row) => {
          if (!row.dataset.stopKey) return;
          row.addEventListener('click', () => {
            navigate(busStopUrl(row.dataset.stopKey, row.dataset.platformKey || null));
          });
        });
      }
    }

    async function refreshRealtime() {
      if (seq !== renderSeq || mode !== 'realtime') { stopTripRealtimePolling(); return; }
      if (!autoRefreshEnabled()) return;
      try {
        const fresh = await fetchJson(`${tripApiPath}/realtime`);
        if (seq !== renderSeq || mode !== 'realtime') return;
        realtime = fresh;
        if (!realtime.available) stopTripRealtimePolling();
        paint();
      } catch (err) {
        // ポーリング失敗は無視し、次回の間隔で再試行する
      }
    }

    function manageRealtimePolling() {
      stopTripRealtimePolling();
      if (mode === 'realtime') {
        tripRealtimeTimer = setInterval(refreshRealtime, TRIP_REALTIME_POLL_MS);
      }
    }

    paint();
    manageRealtimePolling();
  }

  /* ---------- エントリポイント ---------- */
  async function render() {
    const section = document.getElementById('section-timetable');
    if (!section) return;
    section.style.display = 'block';
    destroyMap();
    stopTripRealtimePolling();

    const state = parsePath();
    if (!state || state.view === 'search') {
      renderSearchView();
      return;
    }
    if (state.view === 'stop') {
      await renderStopView(state);
      return;
    }
    if (state.view === 'trip') {
      await renderTripView(state);
    }
  }

  window.TimetableView = { render, isTimetablePath, navigate };
})();
