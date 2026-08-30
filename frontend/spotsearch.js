/* ==========================================================
 * スポット検索機能（SPA） / docs/spot-search.md
 *
 * 「簡易的な路線・バス停検索」。地名（観光スポット・その他のスポット）・バス停・路線を
 * 1つ入力すると、
 *   - 観光スポット／その他のスポットなら、そのスポット情報
 *   - あわせて、付近のバス停と、それらを通る路線
 * を表示する。路線名クリックでリアルタイム時刻表（#/realtime/{feedId}/{routeId}）、
 * バス停名タップでバス停ページ（/busstop/{stopKey}）へ遷移する。
 *
 * 画面とURL:
 *   /spotsearch                 検索フォーム
 *   /spotsearch?spot={id}       観光スポットを対象にした結果
 *   /spotsearch?stop={stopKey}  バス停を対象にした結果
 *   /spotsearch?q={文字列}       自由文字列の結果（あいまい一致）
 *
 * 時刻表検索・バス停検索・経路検索と同じくHistory API（パス）でルーティングする。
 * data-spa の委任クリックリスナーは timetable.js が document 全体へ登録済みなので
 * ここでは重複登録しない（navigate() は自前で持ち、動的要素から呼ぶ）。
 *
 * 路線カラーの扱い（parseHexColor / routeColorStyle / chipTextColor）は
 * timetable.js・busstop.js・routesearch.js と同一ロジック（画面で見た目を揃えるため）。
 * ========================================================== */
(function () {
  const API_BASE = '/api';

  // 画面をまたいで保持する状態
  let searchTimer = null;
  let suggestSeq = 0;
  let renderSeq = 0;
  // 確定済みの対象（候補から選んだもの）。テキストを編集すると解除される。
  let selected = null;
  // 「近くのバス停」候補。位置情報の許可ダイアログを毎回出さないよう使い回す。
  let nearbyStopsCache = null;
  let nearbyStopsPromise = null;

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

  function root() {
    return document.getElementById('spotsearch-root');
  }

  function setTitle(title, subtitle) {
    if (typeof window.setPageTitle === 'function') window.setPageTitle(title, subtitle);
  }

  /* ---------- 路線カラーとコントラスト（timetable.js/busstop.js/routesearch.jsと同一ロジック） ---------- */
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
    return 1.05 / (relativeLuminance(rgb) + 0.05);
  }

  function chipTextColor(color, textColor) {
    const rgb = parseHexColor(color);
    if (!rgb) return '#1f2937';
    const declared = parseHexColor(textColor);
    if (declared) return `#${String(textColor).replace('#', '')}`;
    return relativeLuminance(rgb) > 0.5 ? '#111827' : '#ffffff';
  }

  /** 路線カラーのチップ（クリックでその路線のリアルタイム時刻表へ）。 */
  function routeChipButton(route) {
    const bg = parseHexColor(route.color) ? `#${route.color.replace('#', '')}` : '#e2e8f0';
    const fg = chipTextColor(route.color, route.textColor);
    return `<button type="button" data-role="ss-route" data-feed="${esc(route.feedId)}" data-route="${esc(route.routeId)}"
                   class="text-[11px] font-bold px-2.5 py-1 rounded-full shrink-0 active:scale-95 transition-transform"
                   style="background:${esc(bg)};color:${esc(fg)}">${esc(route.shortName || route.name)}</button>`;
  }

  /* ---------- 観光スポット公式サイトリンクのタップ計測（busstop.js / routesearch.js と同じ） ---------- */
  function spotLinkLabel(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return `公式サイト（${host}）を見る`;
    } catch {
      return '公式サイトを見る';
    }
  }

  function sendSpotLinkBeacon(spotId) {
    if (spotId == null || spotId === '') return;
    const url = `${API_BASE}/tourist-spots/${encodeURIComponent(spotId)}/link-click`;
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
    } catch (_) { /* 続けて fetch でフォールバック */ }
    try { fetch(url, { method: 'POST', keepalive: true }).catch(() => {}); } catch (_) {}
  }

  /* ---------- ルーティング ---------- */
  function isSpotSearchPath() {
    return window.location.pathname === '/spotsearch';
  }

  function readState() {
    const params = new URLSearchParams(window.location.search);
    return {
      spotId: params.get('spot') || '',
      stopKey: params.get('stop') || '',
      q: params.get('q') || ''
    };
  }

  function buildUrl({ spotId, stopKey, q } = {}) {
    const params = new URLSearchParams();
    if (spotId) params.set('spot', spotId);
    else if (stopKey) params.set('stop', stopKey);
    else if (q) params.set('q', q);
    const qs = params.toString();
    return `/spotsearch${qs ? `?${qs}` : ''}`;
  }

  function navigate(url, { replace = false } = {}) {
    if (replace) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);
    if (typeof window.renderCurrentRoute === 'function') window.renderCurrentRoute();
    else render();
    window.scrollTo(0, 0);
  }

  /** その路線のリアルタイム時刻表（#/realtime/{feedId}/{routeId}）へSPA遷移する。
   *  パスルーティングの画面からハッシュルーティングの画面へ移るため、pathname も '/' に戻す。
   *  replace:true は「自由文字列が路線に解決してリダイレクトする」ケース用（?q= のURLを
   *  履歴に残すと、ブラウザの戻るたびに同じリダイレクトが起きるため）。 */
  function goToRealtimeTimetable(feedId, routeId, { replace = false } = {}) {
    if (!feedId || !routeId) return;
    const url = `/#/realtime/${encodeURIComponent(feedId)}/${encodeURIComponent(routeId)}`;
    if (replace) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);
    if (typeof window.renderCurrentRoute === 'function') window.renderCurrentRoute();
    else window.location.assign(url);
    window.scrollTo(0, 0);
  }

  /* ==========================================================
   * 画面描画
   * ========================================================== */
  async function render() {
    if (!root()) return;
    const seq = ++renderSeq;
    setTitle('スポット検索', 'Spot Search');

    const state = readState();
    const hasTarget = state.spotId || state.stopKey || state.q;

    root().innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-emerald-900">スポット検索</h2>
        <a href="/" data-spa class="text-sm font-bold text-emerald-700">メニューへ戻る</a>
      </div>
      <div class="bg-white rounded-2xl shadow-sm border-2 border-emerald-200 p-5">
        <label class="block text-sm font-bold text-gray-700 mb-2" for="ss-input">スポット・バス停・路線で検索</label>
        <input id="ss-input" type="search" autocomplete="off"
               placeholder="漢字・ひらがな・ローマ字で入力（例：松本城 / まつもとじょう / matsumoto）"
               class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-emerald-500 focus:outline-none font-bold">
        <p class="text-[11px] text-gray-500 font-bold mt-2">1文字でも候補が出ます。観光スポットを選ぶと、そのスポット情報と付近のバス停・路線を表示します。</p>
        <div id="ss-suggest" class="mt-3 space-y-1"></div>
      </div>
      <div id="ss-result" class="mt-6"></div>
    `;

    bindForm(state);

    if (hasTarget) await runSearch(state, seq);
  }

  /* ---------- 検索フォーム ---------- */
  function bindForm(state) {
    const input = document.getElementById('ss-input');
    const box = document.getElementById('ss-suggest');
    if (!input || !box) return;

    // 対象確定済みで来た場合は、入力欄にその名前を戻す（結果ページからの復元）
    input.value = state.q || (selected ? selected.name : '');

    // フォームだけを開いているとき（対象未指定）だけ初期候補を出す。
    // 結果ページ（?spot=/?stop=/?q=）では runSearch 側が入力欄を対象名で埋める。
    const hasTarget = state.spotId || state.stopKey || state.q;
    if (!hasTarget && !input.value.trim()) showInitialSuggestions(box);

    input.addEventListener('input', () => {
      selected = null;
      clearTimeout(searchTimer);
      const query = input.value.trim();
      if (!query) {
        box.innerHTML = '';
        showInitialSuggestions(box);
        return;
      }
      searchTimer = setTimeout(async () => {
        const seq = ++suggestSeq;
        let data = { stops: [], spots: [], routes: [] };
        try {
          data = await fetchJson(`${API_BASE}/spot-search/suggest?q=${encodeURIComponent(query)}&limit=8`);
        } catch (err) {
          console.error('スポット候補の取得エラー:', err);
        }
        if (seq !== suggestSeq) return;
        renderSuggestions(box, data);
      }, 180);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const query = input.value.trim();
        if (query) navigate(buildUrl({ q: query }));
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => { box.innerHTML = ''; }, 200);
    });
  }

  /* ---------- 候補の描画 ---------- */
  function stopCardHtml(stop, index) {
    const reading = [stop.nameHiragana, stop.nameRomaji].filter(Boolean).join(' / ');
    const chips = (stop.routes || []).slice(0, 5).map((route) => {
      const bg = parseHexColor(route.color) ? `#${route.color.replace('#', '')}` : '#e2e8f0';
      const fg = chipTextColor(route.color, route.textColor);
      return `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full" style="background:${esc(bg)};color:${esc(fg)}">${esc(route.shortName || route.name)}</span>`;
    }).join('');
    return `
      <button type="button" data-role="ss-pick" data-index="${index}"
              class="w-full text-left bg-white border-2 border-emerald-100 rounded-lg p-3 hover:bg-emerald-50 active:scale-95 transition-all">
        <span class="flex items-center gap-1.5">
          <span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded shrink-0">バス停</span>
          <span class="font-bold text-gray-900 truncate">${esc(stop.stopName)}</span>
        </span>
        ${reading ? `<span class="block text-[11px] text-gray-400">${esc(reading)}</span>` : ''}
        ${chips ? `<span class="flex flex-wrap gap-1 mt-1">${chips}</span>` : ''}
      </button>`;
  }

  function spotCardHtml(spot, index) {
    const photo = Array.isArray(spot.photoUrls) && spot.photoUrls[0] ? spot.photoUrls[0] : '';
    return `
      <button type="button" data-role="ss-pick" data-index="${index}"
              class="w-full text-left bg-white border-2 border-emerald-100 rounded-lg p-3 hover:bg-emerald-50 active:scale-95 transition-all flex items-center gap-2">
        ${photo ? `<img src="${esc(photo)}" alt="" class="w-10 h-10 rounded-lg object-cover shrink-0">` : ''}
        <span class="min-w-0">
          <span class="flex items-center gap-1.5">
            <span class="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded shrink-0">スポット</span>
            <span class="font-bold text-gray-900 truncate">${esc(spot.name)}</span>
          </span>
          ${spot.kana ? `<span class="block text-[11px] text-gray-400">${esc(spot.kana)}${spot.romaji ? ` / ${esc(spot.romaji)}` : ''}</span>` : ''}
        </span>
      </button>`;
  }

  function routeCardHtml(route, index) {
    const bg = parseHexColor(route.color) ? `#${route.color.replace('#', '')}` : '#e2e8f0';
    const fg = chipTextColor(route.color, route.textColor);
    return `
      <button type="button" data-role="ss-pick" data-index="${index}"
              class="w-full text-left bg-white border-2 border-emerald-100 rounded-lg p-3 hover:bg-emerald-50 active:scale-95 transition-all flex items-center gap-2">
        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0" style="background:${esc(bg)};color:${esc(fg)}">路線</span>
        <span class="font-bold text-gray-900 truncate">${esc(route.name)}</span>
        <span class="ml-auto text-[11px] font-bold text-emerald-700 shrink-0">リアルタイム時刻表 ›</span>
      </button>`;
  }

  function renderSuggestions(box, data) {
    const stops = data.stops || [];
    const spots = data.spots || [];
    const routes = data.routes || [];
    if (stops.length === 0 && spots.length === 0 && routes.length === 0) {
      box.innerHTML = '<p class="text-xs font-bold text-gray-500 px-1">一致するスポット・バス停・路線がありません。</p>';
      return;
    }
    // 表示順: 観光スポット → バス停 → 路線
    const items = [
      ...spots.map((s) => ({ kind: 'spot', ...s })),
      ...stops.map((s) => ({ kind: 'stop', ...s })),
      ...routes.map((r) => ({ kind: 'route', ...r }))
    ];
    box.innerHTML = items.map((item, i) => {
      if (item.kind === 'spot') return spotCardHtml(item, i);
      if (item.kind === 'route') return routeCardHtml(item, i);
      return stopCardHtml(item, i);
    }).join('');

    box.querySelectorAll('[data-role="ss-pick"]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => pickItem(items[Number(button.dataset.index)]));
    });
  }

  function pickItem(item) {
    if (!item) return;
    if (item.kind === 'route') {
      goToRealtimeTimetable(item.feedId, item.routeId);
      return;
    }
    if (item.kind === 'spot') {
      selected = { kind: 'spot', name: item.name };
      navigate(buildUrl({ spotId: item.spotId }));
      return;
    }
    selected = { kind: 'stop', name: item.stopName };
    navigate(buildUrl({ stopKey: item.stopKey }));
  }

  /* ---------- 検索欄が空のときの初期候補（お気に入り・近くのバス停。soft-fail） ---------- */
  async function getNearbyStops() {
    if (nearbyStopsCache) return nearbyStopsCache;
    if (!nearbyStopsPromise) {
      nearbyStopsPromise = (async () => {
        if (typeof window.getUserLocation !== 'function') return [];
        const location = await window.getUserLocation();
        if (!location) return [];
        try {
          const query = new URLSearchParams({ lat: location.lat, lon: location.lng, limit: 5 });
          const result = await fetchJson(`${API_BASE}/busstop/nearby?${query.toString()}`);
          return result.stops || [];
        } catch (err) {
          return [];
        }
      })();
    }
    nearbyStopsCache = await nearbyStopsPromise;
    return nearbyStopsCache;
  }

  async function getFavoriteStops() {
    const keys = window.Favorites ? window.Favorites.favoriteBusStopKeys() : [];
    if (keys.length === 0) return [];
    try {
      const query = new URLSearchParams({ keys: keys.join(',') });
      const result = await fetchJson(`${API_BASE}/busstop/by-keys?${query.toString()}`);
      return result.stops || [];
    } catch (err) {
      return [];
    }
  }

  async function showInitialSuggestions(box) {
    const [favoriteStops, nearbyStops] = await Promise.all([getFavoriteStops(), getNearbyStops()]);
    if (box.innerHTML !== '' || !box.isConnected) return;
    const favoriteKeys = new Set(favoriteStops.map((stop) => stop.stopKey));
    const nearbyOnly = nearbyStops.filter((stop) => !favoriteKeys.has(stop.stopKey));
    const groups = [
      { label: 'お気に入りバス停', stops: favoriteStops },
      { label: '近くのバス停', stops: nearbyOnly }
    ].filter((group) => group.stops.length > 0);
    if (groups.length === 0) {
      box.innerHTML = '';
      return;
    }
    const all = [];
    box.innerHTML = groups.map((group) => {
      const header = `<p class="text-[11px] font-bold text-gray-500 px-1 mb-1">${esc(group.label)}</p>`;
      const cards = group.stops.map((stop) => {
        const html = stopCardHtml({ ...stop, kind: 'stop' }, all.length);
        all.push({ kind: 'stop', ...stop });
        return html;
      }).join('');
      return header + cards;
    }).join('');
    box.querySelectorAll('[data-role="ss-pick"]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => pickItem(all[Number(button.dataset.index)]));
    });
  }

  /* ==========================================================
   * 検索の実行と結果表示
   * ========================================================== */
  async function runSearch(state, seq) {
    const container = document.getElementById('ss-result');
    if (!container) return;
    container.innerHTML = `
      <div class="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-4">
        <p class="text-sm font-bold text-emerald-900">検索しています...</p>
      </div>`;

    let result;
    try {
      const params = new URLSearchParams();
      if (state.spotId) params.set('spotId', state.spotId);
      else if (state.stopKey) params.set('stopKey', state.stopKey);
      else params.set('q', state.q);
      result = await fetchJson(`${API_BASE}/spot-search?${params.toString()}`);
    } catch (err) {
      if (seq !== renderSeq) return;
      container.innerHTML = `
        <div class="bg-red-50 border-2 border-red-300 rounded-2xl p-4">
          <p class="text-sm font-bold text-red-900">スポット検索に失敗しました：${esc(err.message)}</p>
        </div>`;
      return;
    }
    if (seq !== renderSeq) return;

    // 自由文字列が路線に解決したときはリアルタイム時刻表へ。?q= のURLを履歴に残さない。
    if (result.found && result.resolvedFrom === 'route' && result.route) {
      goToRealtimeTimetable(result.route.feedId, result.route.routeId, { replace: true });
      return;
    }

    // 対象名で検索欄を埋める（?spot= / ?stop= の直リンク・リロードからの復元）
    const input = document.getElementById('ss-input');
    if (input && !input.value.trim() && result.origin && result.origin.name) {
      input.value = result.origin.name;
    }

    container.innerHTML = result.found ? renderResult(result) : renderNotFound(result);
    bindResultEvents(container);
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- スポット情報カード（busstop.js の周辺観光スポット表示と同じ考え方） ---------- */
  function spotPhotoStrip(spot) {
    const photos = Array.isArray(spot.photoUrls) ? spot.photoUrls : [];
    if (photos.length === 0) return '';
    return `<div class="flex gap-1 overflow-x-auto bg-gray-100">${photos
      .map((u) => `<img src="${esc(u)}" alt="${esc(spot.name)}" class="h-40 object-contain shrink-0${photos.length === 1 ? ' w-full' : ''}">`)
      .join('')}</div>`;
  }

  function spotInfoCardHtml(spot) {
    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-amber-200 overflow-hidden mb-4">
        ${spotPhotoStrip(spot)}
        <div class="p-4">
          <p class="text-xs text-amber-700 font-bold">スポット情報</p>
          <p class="text-xl font-bold text-gray-900 mt-0.5">${esc(spot.name)}</p>
          ${spot.kana ? `<p class="text-[11px] text-gray-400 mt-0.5">${esc(spot.kana)}${spot.romaji ? ` / ${esc(spot.romaji)}` : ''}</p>` : ''}
          ${spot.hours ? `<p class="text-xs text-gray-500 mt-2">営業時間：${esc(spot.hours)}</p>` : ''}
          ${spot.stayDuration ? `<p class="text-xs text-gray-500">滞在目安：${esc(spot.stayDuration)}</p>` : ''}
          ${spot.description ? `<p class="text-sm text-gray-700 mt-2 leading-relaxed">${esc(spot.description)}</p>` : ''}
          ${spot.url ? `
            <a href="${esc(spot.url)}" target="_blank" rel="noopener noreferrer" data-spot-link="${esc(spot.spotId)}"
               class="inline-flex items-center gap-1 mt-3 text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-3 py-1 hover:bg-indigo-100">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              ${esc(spotLinkLabel(spot.url))}
            </a>` : ''}
        </div>
      </div>`;
  }

  /* ---------- 周辺のバス停カード ---------- */
  function nearbyStopCardHtml(stop) {
    const reading = [stop.nameHiragana, stop.nameRomaji].filter(Boolean).join(' / ');
    const distanceBadge = stop.isPrimary
      ? '<span class="text-[10px] font-bold text-emerald-800 bg-emerald-100 border border-emerald-300 rounded px-2 py-1 shrink-0">このバス停</span>'
      : (Number.isFinite(stop.walkMinutes)
        ? `<span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 shrink-0">徒歩約${stop.walkMinutes}分（${stop.distanceMeters}m）</span>`
        : '');
    const chips = (stop.routes || []).length > 0
      ? `<div class="flex flex-wrap gap-1.5 mt-2">${stop.routes.map(routeChipButton).join('')}</div>`
      : '<p class="text-[11px] font-bold text-gray-400 mt-2">この付近を通る路線情報がありません。</p>';
    return `
      <div class="border-2 ${stop.isPrimary ? 'border-emerald-300' : 'border-gray-200'} rounded-xl p-3">
        <div class="flex items-start justify-between gap-2">
          <a href="/busstop/${encodeURIComponent(stop.stopKey)}" data-spa class="min-w-0">
            <span class="block font-bold text-gray-900 underline decoration-dotted underline-offset-2 hover:text-emerald-700 truncate">${esc(stop.stopName)}</span>
            ${reading ? `<span class="block text-[11px] text-gray-400 truncate">${esc(reading)}</span>` : ''}
          </a>
          ${distanceBadge}
        </div>
        ${chips}
      </div>`;
  }

  function renderResult(result) {
    const stops = [];
    if (result.primaryStop) stops.push(result.primaryStop);
    for (const stop of result.nearbyStops || []) stops.push(stop);

    const routesSection = (result.routes || []).length > 0
      ? `
        <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-100 p-4 mb-4">
          <p class="text-xs font-bold text-gray-500 mb-2">この周辺を通る路線（タップでリアルタイム時刻表）</p>
          <div class="flex flex-wrap gap-1.5">${result.routes.map(routeChipButton).join('')}</div>
        </div>`
      : '';

    const stopsSection = stops.length > 0
      ? `
        <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-100 p-4">
          <div class="flex items-center justify-between mb-2">
            <p class="text-xs font-bold text-gray-500">周辺のバス停（半径${Math.round(result.radiusMeters)}m）</p>
            <span class="text-[10px] font-bold text-gray-400">バス停名タップでバス停ページへ</span>
          </div>
          <div class="space-y-2">${stops.map(nearbyStopCardHtml).join('')}</div>
        </div>`
      : `
        <div class="bg-yellow-50 border-2 border-yellow-300 rounded-2xl p-4">
          <p class="text-sm font-bold text-yellow-900">この付近（半径${Math.round(result.radiusMeters)}m）にバス停が見つかりませんでした。</p>
        </div>`;

    const header = `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-100 p-4 mb-4">
        <p class="text-sm font-bold text-gray-900">${esc(result.origin ? result.origin.name : result.query)}</p>
        <p class="text-xs font-bold text-gray-500 mt-1">
          ${result.spot ? '観光スポット' : 'バス停'}を中心に、付近のバス停と路線を表示しています。
          ${result.resolvedFrom === 'fuzzy-spot' || result.resolvedFrom === 'fuzzy-stop'
            ? '<br>入力した文字列に近いものを選んでいます。候補から選ぶとより正確になります。' : ''}
        </p>
      </div>`;

    return `
      ${header}
      ${result.spot ? spotInfoCardHtml(result.spot) : ''}
      ${routesSection}
      ${stopsSection}
      <p class="text-[11px] text-gray-500 font-bold mt-4 px-1">
        時刻・路線はGTFSデータに基づく目安です。実際のダイヤは事業者にご確認ください。
      </p>
    `;
  }

  function renderNotFound(result) {
    const suggestions = result.suggestions || {};
    const stopButtons = (suggestions.stops || []).map((stop) => `
      <button type="button" data-role="ss-use-stop" data-key="${esc(stop.stopKey)}"
              class="w-full text-left bg-white border-2 border-yellow-200 rounded-lg px-3 py-2 font-bold text-sm hover:bg-yellow-50">
        ${esc(stop.stopName)}
      </button>`).join('');
    const spotButtons = (suggestions.spots || []).map((spot) => `
      <button type="button" data-role="ss-use-spot" data-id="${esc(spot.spotId)}"
              class="w-full text-left bg-white border-2 border-yellow-200 rounded-lg px-3 py-2 font-bold text-sm hover:bg-yellow-50">
        ${esc(spot.name)}
      </button>`).join('');

    return `
      <div class="bg-yellow-50 border-2 border-yellow-300 rounded-2xl p-5">
        <p class="text-sm font-bold text-yellow-900">
          ${result.reason === 'spot-not-found' || result.reason === 'stop-not-found'
            ? '指定のスポットが見つかりませんでした。'
            : `「${esc(result.query)}」に一致するスポット・バス停が見つかりませんでした。`}
        </p>
        ${stopButtons || spotButtons ? `
          <p class="text-xs font-bold text-yellow-900 mt-3 mb-2">もしかして</p>
          <div class="space-y-2">${spotButtons}${stopButtons}</div>` : ''}
      </div>`;
  }

  function bindResultEvents(container) {
    container.querySelectorAll('[data-role="ss-route"]').forEach((button) => {
      button.addEventListener('click', () => goToRealtimeTimetable(button.dataset.feed, button.dataset.route));
    });
    container.querySelectorAll('a[data-spot-link]').forEach((link) => {
      link.addEventListener('click', () => sendSpotLinkBeacon(link.dataset.spotLink));
    });
    container.querySelectorAll('[data-role="ss-use-stop"]').forEach((button) => {
      button.addEventListener('click', () => navigate(buildUrl({ stopKey: button.dataset.key })));
    });
    container.querySelectorAll('[data-role="ss-use-spot"]').forEach((button) => {
      button.addEventListener('click', () => navigate(buildUrl({ spotId: button.dataset.id })));
    });
  }

  window.SpotSearchView = { render, isSpotSearchPath, navigate };
})();
