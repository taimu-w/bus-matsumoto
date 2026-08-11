/* ==========================================================
 * 経路検索機能（SPA） / docs/経路検索機能_改善仕様書.md
 *
 * 画面とURL（仕様書 6.1）:
 *   /routesearch                                              検索フォーム
 *   /routesearch?from=…&fromKey=…&to=…&toKey=…&date=…&time=…  検索結果
 *
 * 時刻表検索（timetable.js）・バス停検索（busstop.js）と同じくHistory API
 * （パス）でルーティングする。検索条件をURLに持たせているので、結果から
 * /busstop へ移動して戻ってきても検索結果がそのまま復元される。
 *
 * data-spa の委任クリックリスナーは timetable.js が document 全体へ登録済みなので
 * ここでは重複登録しない（navigate() は自前で持ち、ボタン等の動的要素から呼ぶ）。
 *
 * 路線カラーの扱い（parseHexColor / routeColorStyle / chipTextColor）は
 * timetable.js・busstop.js と同一ロジック。3画面で見た目を揃えるため。
 * ========================================================== */
(function () {
  const API_BASE = '/api';
  // リアルタイム更新の間隔。他画面（TRIP_REALTIME_POLL_MS / APPROACHING_POLL_MS）と統一する。
  const REALTIME_POLL_MS = 20000;

  // 画面をまたいで保持する状態
  let suggestTimers = { from: null, to: null };
  let suggestSeq = 0;
  // 確定済みのバス停（候補から選んだもの）。テキストを編集すると解除される。
  let selected = { from: null, to: null };
  // 「通過バス停」を開いている区間のキー（再描画をまたいで維持する）
  const openLegKeys = new Set();
  let realtimeTimer = null;
  let renderSeq = 0;
  let lastResult = null;

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
    return document.getElementById('routesearch-root');
  }

  function setTitle(title, subtitle) {
    if (typeof window.setPageTitle === 'function') window.setPageTitle(title, subtitle);
  }

  /* ---------- 日付ユーティリティ（JST基準・timetable.jsと同じ） ---------- */
  const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

  function todayString() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function nowHhmm() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('hour')}:${get('minute')}`;
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

  function shiftDate(dateStr, days) {
    const d = dateToUtc(dateStr);
    const shifted = new Date(d.getTime() + days * 86400000);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  }

  /** 「平日」「土曜」「日祝」から、その区分に当てはまる直近の日付を求める。 */
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

  /* ---------- 路線カラーとコントラスト（仕様書 6.3） ---------- */
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

  /** 白背景の上に路線カラーで文字を描けるか。描けない色は濃色にフォールバックする。 */
  function routeColorStyle(color) {
    const rgb = parseHexColor(color);
    if (!rgb) return { hex: '#94a3b8', textOnWhite: '#1f2937', hasColor: false };
    const hex = `#${String(color).replace('#', '')}`;
    return { hex, textOnWhite: contrastWithWhite(rgb) >= 3 ? hex : '#1f2937', hasColor: true };
  }

  /** 路線カラーを背景にしたチップの文字色。 */
  function chipTextColor(color, textColor) {
    const rgb = parseHexColor(color);
    if (!rgb) return '#1f2937';
    const declared = parseHexColor(textColor);
    if (declared) return `#${String(textColor).replace('#', '')}`;
    return relativeLuminance(rgb) > 0.5 ? '#111827' : '#ffffff';
  }

  function routeChip(leg, extraClass = '') {
    const style = routeColorStyle(leg.routeColor);
    const bg = style.hasColor ? style.hex : '#e2e8f0';
    const fg = chipTextColor(leg.routeColor, leg.routeTextColor);
    const label = leg.routeShortName || leg.routeName;
    return `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${extraClass}"
                  style="background:${esc(bg)};color:${esc(fg)}">${esc(label)}</span>`;
  }

  /* ---------- 表示の小道具 ---------- */
  function timeWithDay(time, dayOffset) {
    if (!time) return '';
    return dayOffset > 0 ? `翌日 ${time}` : time;
  }

  function yen(value) {
    return `¥${Number(value).toLocaleString('ja-JP')}`;
  }

  function platformLabel(stop) {
    if (!stop || !stop.platformCode) return '';
    return /^\d+$/.test(stop.platformCode) ? `${stop.platformCode}番のりば` : stop.platformCode;
  }

  /* ---------- ルーティング ---------- */
  function isRouteSearchPath() {
    return window.location.pathname === '/routesearch' || window.location.pathname.startsWith('/routesearch/');
  }

  function currentParams() {
    return new URLSearchParams(window.location.search);
  }

  function buildUrl(state) {
    const query = new URLSearchParams();
    if (state.fromText) query.set('from', state.fromText);
    if (state.fromKey) query.set('fromKey', state.fromKey);
    if (state.toText) query.set('to', state.toText);
    if (state.toKey) query.set('toKey', state.toKey);
    if (state.date) query.set('date', state.date);
    if (state.time) query.set('time', state.time);
    const qs = query.toString();
    return `/routesearch${qs ? `?${qs}` : ''}`;
  }

  function navigate(url) {
    window.history.pushState({}, '', url);
    if (typeof window.renderCurrentRoute === 'function') window.renderCurrentRoute();
    else render();
    window.scrollTo(0, 0);
  }

  function readState() {
    const params = currentParams();
    return {
      fromText: params.get('from') || '',
      fromKey: params.get('fromKey') || '',
      toText: params.get('to') || '',
      toKey: params.get('toKey') || '',
      date: params.get('date') || todayString(),
      time: params.get('time') || nowHhmm()
    };
  }

  /* ==========================================================
   * 画面描画
   * ========================================================== */

  async function render() {
    if (!root()) return;
    const seq = ++renderSeq;
    stopRealtimePolling();

    const state = readState();
    setTitle('経路検索', 'Route Search');
    root().innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-purple-900">経路検索</h2>
        <a href="/" data-spa class="text-sm font-bold text-purple-700">メニューへ戻る</a>
      </div>
      ${renderForm(state)}
      <div id="rs-result" class="mt-6"></div>
    `;
    bindFormEvents(state);

    const hasEndpoints = (state.fromKey || state.fromText) && (state.toKey || state.toText);
    if (!hasEndpoints) return;

    await runSearch(state, seq);
  }

  function renderForm(state) {
    const dateTags = [
      { kind: 'today', label: '今日', target: todayString() },
      { kind: 'tomorrow', label: '明日', target: shiftDate(todayString(), 1) },
      { kind: 'weekday', label: '平日', target: nextDateOfKind('weekday', todayString()) },
      { kind: 'saturday', label: '土曜', target: nextDateOfKind('saturday', todayString()) },
      { kind: 'holiday', label: '日祝', target: nextDateOfKind('holiday', todayString()) }
    ];

    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-purple-200 p-5 space-y-1">
        <div>
          <label class="block text-sm font-bold text-gray-700 mb-2" for="rs-from">出発地</label>
          <input type="text" id="rs-from" autocomplete="off" value="${esc(state.fromText)}"
                 placeholder="漢字・ひらがな・ローマ字で入力（例：松本 / まつもと / matsumoto）"
                 class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 focus:outline-none font-bold">
          <div id="rs-from-suggest" class="mt-2 space-y-1 relative z-10"></div>
          <p id="rs-from-meta" class="text-xs text-purple-700 font-bold mt-1 px-1" style="display:none;"></p>
        </div>

        <div class="flex justify-center -my-1">
          <button id="rs-swap" type="button" aria-label="出発地と目的地を入れ替え"
                  class="bg-purple-50 text-purple-700 border-2 border-purple-200 rounded-full w-10 h-10 flex items-center justify-center hover:bg-purple-100 active:scale-95 transition-all">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4"></path>
            </svg>
          </button>
        </div>

        <div>
          <label class="block text-sm font-bold text-gray-700 mb-2" for="rs-to">目的地</label>
          <input type="text" id="rs-to" autocomplete="off" value="${esc(state.toText)}"
                 placeholder="バス停名を入力（例：浅間温泉）"
                 class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 focus:outline-none font-bold">
          <div id="rs-to-suggest" class="mt-2 space-y-1 relative z-10"></div>
          <p id="rs-to-meta" class="text-xs text-purple-700 font-bold mt-1 px-1" style="display:none;"></p>
        </div>

        <div class="pt-3">
          <label class="block text-sm font-bold text-gray-700 mb-2" for="rs-date">日付</label>
          <div class="flex flex-wrap gap-2 mb-2">
            ${dateTags.map((tag) => `
              <button type="button" data-role="rs-date-kind" data-target="${esc(tag.target)}"
                      class="px-3 py-1.5 rounded-full text-xs font-bold border-2 ${state.date === tag.target ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-700 border-gray-200'}">
                ${esc(tag.label)}
              </button>`).join('')}
          </div>
          <input type="date" id="rs-date" value="${esc(state.date)}"
                 class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 focus:outline-none font-bold">
          <p class="text-xs text-gray-500 font-bold mt-1 px-1">${esc(formatDateLabel(state.date))}のダイヤで検索します。</p>
        </div>

        <div class="pt-3">
          <label class="block text-sm font-bold text-gray-700 mb-2" for="rs-time">出発時刻</label>
          <div class="flex gap-2">
            <input type="time" id="rs-time" value="${esc(state.time)}"
                   class="flex-1 min-w-0 px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 focus:outline-none font-bold">
            <button id="rs-now" type="button"
                    class="shrink-0 px-4 py-3 border-2 border-purple-200 text-purple-700 bg-purple-50 rounded-xl font-bold text-sm hover:bg-purple-100 active:scale-95 transition-all">
              現在時刻
            </button>
          </div>
        </div>

        <div id="rs-warning" class="text-sm font-bold text-red-700 bg-red-50 border-2 border-red-200 rounded-xl px-4 py-2 mt-3" style="display:none;"></div>

        <button id="rs-search" type="button"
                class="w-full bg-purple-600 text-white py-4 rounded-xl font-bold text-lg shadow-lg hover:bg-purple-700 active:scale-95 transition-all mt-3">
          経路を検索
        </button>
      </div>
    `;
  }

  /* ---------- フォームの操作 ---------- */
  function bindFormEvents(state) {
    setupAutocomplete('from', 'rs-from', 'rs-from-suggest', 'rs-from-meta', state);
    setupAutocomplete('to', 'rs-to', 'rs-to-suggest', 'rs-to-meta', state);

    // URLにキーが載っていれば「確定済み」として復元する
    selected.from = state.fromKey ? { stopKey: state.fromKey, name: state.fromText } : null;
    selected.to = state.toKey ? { stopKey: state.toKey, name: state.toText } : null;

    const container = root();
    // 日付を変えたら即再検索する。出発地・目的地が未入力のときは
    // 入力内容を消さないよう再描画せず、クイックボタンの選択状態だけ更新する。
    const resubmitIfReady = () => {
      const fromText = document.getElementById('rs-from').value.trim();
      const toText = document.getElementById('rs-to').value.trim();
      if (fromText && toText) {
        submit();
        return;
      }
      const current = document.getElementById('rs-date').value;
      container.querySelectorAll('[data-role="rs-date-kind"]').forEach((button) => {
        const active = button.dataset.target === current;
        button.className = `px-3 py-1.5 rounded-full text-xs font-bold border-2 ${active ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-700 border-gray-200'}`;
      });
    };
    container.querySelectorAll('[data-role="rs-date-kind"]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('rs-date').value = button.dataset.target;
        resubmitIfReady();
      });
    });
    document.getElementById('rs-date').addEventListener('change', resubmitIfReady);
    document.getElementById('rs-now').addEventListener('click', () => {
      document.getElementById('rs-time').value = nowHhmm();
      document.getElementById('rs-date').value = todayString();
    });
    document.getElementById('rs-swap').addEventListener('click', () => {
      const fromInput = document.getElementById('rs-from');
      const toInput = document.getElementById('rs-to');
      const text = fromInput.value;
      fromInput.value = toInput.value;
      toInput.value = text;
      const key = selected.from;
      selected.from = selected.to;
      selected.to = key;
      showMeta('rs-from-meta', selected.from);
      showMeta('rs-to-meta', selected.to);
    });
    document.getElementById('rs-search').addEventListener('click', submit);
    ['rs-from', 'rs-to', 'rs-time'].forEach((id) => {
      document.getElementById(id).addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
      });
    });
  }

  function showWarning(message) {
    const el = document.getElementById('rs-warning');
    if (!el) return;
    el.textContent = message;
    el.style.display = message ? 'block' : 'none';
  }

  function showMeta(metaId, stop) {
    const el = document.getElementById(metaId);
    if (!el) return;
    if (!stop) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    const routeNames = (stop.routes || []).map((route) => route.shortName || route.name).filter(Boolean);
    const parts = [`選択中：${stop.name}`];
    if (stop.platformCount > 1) parts.push(`乗り場${stop.platformCount}件`);
    if (routeNames.length > 0) parts.push(routeNames.slice(0, 4).join('・'));
    el.textContent = parts.join('｜');
    el.style.display = 'block';
  }

  function setupAutocomplete(side, inputId, suggestId, metaId, state) {
    const input = document.getElementById(inputId);
    const box = document.getElementById(suggestId);
    if (!input || !box) return;

    if (side === 'from' && state.fromKey) showMeta(metaId, { stopKey: state.fromKey, name: state.fromText });
    if (side === 'to' && state.toKey) showMeta(metaId, { stopKey: state.toKey, name: state.toText });

    input.addEventListener('input', () => {
      // テキストを編集した時点で確定を解除する（自由文字列検索へ戻す）
      selected[side] = null;
      showMeta(metaId, null);
      clearTimeout(suggestTimers[side]);
      const query = input.value.trim();
      if (!query) {
        box.innerHTML = '';
        return;
      }
      suggestTimers[side] = setTimeout(async () => {
        const seq = ++suggestSeq;
        let stops = [];
        try {
          const result = await fetchJson(`${API_BASE}/route-search/stops?q=${encodeURIComponent(query)}&limit=8`);
          stops = result.stops || [];
        } catch (err) {
          console.error('バス停候補の取得エラー:', err);
        }
        if (seq !== suggestSeq) return;
        renderSuggestions(box, stops, (stop) => {
          input.value = stop.name;
          selected[side] = stop;
          showMeta(metaId, stop);
          box.innerHTML = '';
        });
      }, 180);
    });

    input.addEventListener('blur', () => {
      // クリックを拾えるよう少し待ってから閉じる
      setTimeout(() => { box.innerHTML = ''; }, 200);
    });
  }

  function renderSuggestions(box, stops, onSelect) {
    if (stops.length === 0) {
      box.innerHTML = '<p class="text-xs font-bold text-gray-500 px-1">一致するバス停がありません。</p>';
      return;
    }
    box.innerHTML = stops
      .map((stop, i) => `
        <button type="button" data-index="${i}"
                class="w-full text-left bg-white border-2 border-purple-100 rounded-lg p-3 hover:bg-purple-50 active:scale-95 transition-all">
          <span class="block font-bold text-gray-900">${esc(stop.name)}</span>
          ${stop.kana ? `<span class="block text-[11px] text-gray-400">${esc(stop.kana)}${stop.romaji ? ` / ${esc(stop.romaji)}` : ''}</span>` : ''}
          <span class="flex flex-wrap gap-1 mt-1">
            ${(stop.routes || []).slice(0, 5).map((route) => {
              const bg = parseHexColor(route.color) ? `#${route.color.replace('#', '')}` : '#e2e8f0';
              const fg = chipTextColor(route.color, route.textColor);
              return `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full" style="background:${esc(bg)};color:${esc(fg)}">${esc(route.shortName || route.name)}</span>`;
            }).join('')}
          </span>
        </button>`)
      .join('');
    box.querySelectorAll('button[data-index]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => onSelect(stops[Number(button.dataset.index)]));
    });
  }

  function submit() {
    const fromText = document.getElementById('rs-from').value.trim();
    const toText = document.getElementById('rs-to').value.trim();
    const date = document.getElementById('rs-date').value || todayString();
    const time = document.getElementById('rs-time').value || nowHhmm();

    if (!fromText || !toText) {
      showWarning('出発地と目的地を入力してください。');
      return;
    }
    const sameKey = selected.from && selected.to && selected.from.stopKey === selected.to.stopKey;
    const sameText = (!selected.from || !selected.to) && fromText === toText;
    if (sameKey || sameText) {
      showWarning('出発地と目的地が同じです。目的地を変更してください。');
      return;
    }
    showWarning('');
    openLegKeys.clear();

    navigate(buildUrl({
      fromText,
      fromKey: selected.from ? selected.from.stopKey : '',
      toText,
      toKey: selected.to ? selected.to.stopKey : '',
      date,
      time
    }));
  }

  /* ==========================================================
   * 検索の実行と結果表示
   * ========================================================== */

  function buildApiUrl(state) {
    const query = new URLSearchParams();
    if (state.fromKey) query.set('fromStopKey', state.fromKey);
    else query.set('from', state.fromText);
    if (state.toKey) query.set('toStopKey', state.toKey);
    else query.set('to', state.toText);
    query.set('date', state.date);
    query.set('time', state.time);
    return `${API_BASE}/route-search?${query.toString()}`;
  }

  async function runSearch(state, seq, { silent = false } = {}) {
    const container = document.getElementById('rs-result');
    if (!container) return;
    if (!silent) {
      container.innerHTML = `
        <div class="bg-purple-50 border-2 border-purple-200 rounded-2xl p-4">
          <p class="text-sm font-bold text-purple-900">経路を探しています...</p>
        </div>`;
    }

    let result;
    try {
      result = await fetchJson(buildApiUrl(state));
    } catch (err) {
      if (seq !== renderSeq) return;
      container.innerHTML = `
        <div class="bg-red-50 border-2 border-red-300 rounded-2xl p-4">
          <p class="text-sm font-bold text-red-900">経路検索に失敗しました：${esc(err.message)}</p>
        </div>`;
      return;
    }
    if (seq !== renderSeq) return;

    lastResult = result;
    container.innerHTML = result.found ? renderResults(result) : renderNotFound(result);
    bindResultEvents(container, state);

    // 本日の検索で、リアルタイムに追随できる経路があるときだけポーリングする
    if (result.found && result.isToday) startRealtimePolling(state, seq);
  }

  function startRealtimePolling(state, seq) {
    stopRealtimePolling();
    realtimeTimer = setInterval(() => {
      if (seq !== renderSeq || !isRouteSearchPath()) {
        stopRealtimePolling();
        return;
      }
      runSearch(state, seq, { silent: true });
    }, REALTIME_POLL_MS);
  }

  function stopRealtimePolling() {
    if (realtimeTimer) {
      clearInterval(realtimeTimer);
      realtimeTimer = null;
    }
  }

  /* ---------- 結果一覧 ---------- */
  function renderResults(result) {
    const notes = [];
    if (result.fuzzy) {
      notes.push('入力した文字列に近いバス停で検索しました。候補から選ぶとより正確になります。');
    }
    if (result.relaxationNote) notes.push(result.relaxationNote);
    if (result.walkableHint) {
      notes.push(`このバス停間は徒歩約${result.walkableHint.walkMinutes}分（約${result.walkableHint.distanceMeters}m）です。`);
    }

    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-100 p-4 mb-4">
        <p class="text-sm font-bold text-gray-900">
          ${esc(result.from.name)} <span class="text-gray-400">→</span> ${esc(result.to.name)}
        </p>
        <p class="text-xs font-bold text-gray-500 mt-1">
          ${esc(formatDateLabel(result.date))} ${esc(result.baseTime)} 以降に出発 ／ ${result.journeys.length}件
        </p>
        ${notes.map((note) => `<p class="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">${esc(note)}</p>`).join('')}
      </div>
      <div class="space-y-4">
        ${result.journeys.map((journey, index) => renderJourneyCard(journey, index)).join('')}
      </div>
      <p class="text-[11px] text-gray-500 font-bold mt-4 px-1">
        運賃・時刻はGTFSデータに基づく目安です。実際の運賃・ダイヤは事業者にご確認ください。
      </p>
    `;
  }

  function renderJourneyCard(journey, index) {
    const badges = [];
    if (journey.isRecommended) {
      badges.push('<span class="text-[11px] font-bold text-amber-800 bg-amber-100 border border-amber-300 px-2 py-1 rounded">★ おすすめ</span>');
    }
    badges.push(
      journey.transferCount === 0
        ? '<span class="text-[11px] font-bold text-purple-800 bg-purple-100 border border-purple-300 px-2 py-1 rounded">直通</span>'
        : `<span class="text-[11px] font-bold text-blue-800 bg-blue-100 border border-blue-300 px-2 py-1 rounded">乗換${journey.transferCount}回</span>`
    );
    if (journey.walkMinutes > 0) {
      badges.push(`<span class="text-[11px] font-bold text-gray-700 bg-gray-100 border border-gray-300 px-2 py-1 rounded">徒歩${journey.walkMinutes}分</span>`);
    }
    if (journey.realtime) {
      badges.push('<span class="text-[11px] font-bold text-green-800 bg-green-100 border border-green-300 px-2 py-1 rounded">● リアルタイム反映</span>');
    }
    if (journey.arrivalDayOffset > 0) {
      badges.push('<span class="text-[11px] font-bold text-indigo-800 bg-indigo-100 border border-indigo-300 px-2 py-1 rounded">翌日着</span>');
    }

    const fareText = journey.fare.unknown
      ? '運賃不明'
      : `${yen(journey.fare.total)}${journey.fare.partial ? '〜（一部不明）' : ''}`;

    return `
      <article class="bg-white rounded-2xl shadow-sm border-2 ${journey.isRecommended ? 'border-amber-300' : 'border-gray-100'} overflow-hidden">
        <div class="px-4 pt-4 pb-3 border-b border-gray-100">
          <div class="flex flex-wrap gap-1 mb-2">${badges.join(' ')}</div>
          <div class="flex items-end flex-wrap gap-x-3 gap-y-1">
            <span class="text-2xl font-bold text-gray-900">${esc(timeWithDay(journey.departureTime, journey.departureDayOffset))}</span>
            <span class="text-gray-400">→</span>
            <span class="text-2xl font-bold text-purple-700">${esc(timeWithDay(journey.arrivalTime, journey.arrivalDayOffset))}</span>
            <span class="text-sm font-bold text-gray-500">${journey.durationMinutes}分</span>
            <span class="ml-auto text-lg font-bold text-gray-900">${esc(fareText)}</span>
          </div>
          ${renderDurationBar(journey)}
        </div>
        <div class="p-4">
          ${renderTimeline(journey, index)}
        </div>
      </article>
    `;
  }

  /** 区間ごとの所要時間を路線カラーで塗った帯（仕様書 6.3）。 */
  function renderDurationBar(journey) {
    const total = journey.legs.reduce(
      (sum, leg) => sum + Math.max(1, (leg.arrivalSeconds - leg.departureSeconds) / 60), 0
    );
    if (!total) return '';
    const segments = journey.legs.map((leg) => {
      const minutes = Math.max(1, (leg.arrivalSeconds - leg.departureSeconds) / 60);
      const width = (minutes / total) * 100;
      if (leg.type === 'walk') {
        return `<span title="徒歩${leg.walkMinutes}分" style="width:${width}%;background:repeating-linear-gradient(45deg,#cbd5e1,#cbd5e1 3px,#e2e8f0 3px,#e2e8f0 6px)"></span>`;
      }
      const style = routeColorStyle(leg.routeColor);
      return `<span title="${esc(leg.routeName)}" style="width:${width}%;background:${esc(style.hasColor ? style.hex : '#94a3b8')}"></span>`;
    });
    return `<div class="flex h-2 rounded-full overflow-hidden mt-3 bg-gray-100">${segments.join('')}</div>`;
  }

  /* ---------- 経路の縦タイムライン ---------- */
  function renderTimeline(journey, journeyIndex) {
    const rows = [];
    const firstLeg = journey.legs[0];
    rows.push(renderStopNode(firstLeg.fromStop, {
      departureTime: firstLeg.departureTime,
      departureDayOffset: firstLeg.departureDayOffset ?? journey.departureDayOffset,
      isTerminal: true,
      color: firstLeg.type === 'bus' ? routeColorStyle(firstLeg.routeColor).hex : '#94a3b8',
      predicted: firstLeg.realtime ? firstLeg.realtime.predictedDepartureTime : null
    }));

    journey.legs.forEach((leg, legIndex) => {
      rows.push(leg.type === 'walk' ? renderWalkLeg(leg) : renderBusLeg(leg, `${journeyIndex}-${legIndex}`));
      const nextLeg = journey.legs[legIndex + 1];
      rows.push(renderStopNode(leg.toStop, {
        arrivalTime: leg.arrivalTime,
        arrivalDayOffset: leg.arrivalDayOffset,
        departureTime: nextLeg ? nextLeg.departureTime : null,
        departureDayOffset: nextLeg ? nextLeg.departureDayOffset : 0,
        isTerminal: !nextLeg,
        color: leg.type === 'bus' ? routeColorStyle(leg.routeColor).hex : '#94a3b8',
        predicted: leg.realtime ? leg.realtime.predictedArrivalTime : null
      }));
    });

    return `<div class="space-y-0">${rows.join('')}</div>`;
  }

  function renderStopNode(stop, options) {
    const times = [];
    if (options.arrivalTime) times.push(`<span class="font-bold text-gray-900">${esc(timeWithDay(options.arrivalTime, options.arrivalDayOffset))}</span><span class="text-[10px] text-gray-500">着</span>`);
    if (options.departureTime) times.push(`<span class="font-bold text-gray-900">${esc(timeWithDay(options.departureTime, options.departureDayOffset))}</span><span class="text-[10px] text-gray-500">発</span>`);
    // リアルタイム予測が定刻と違うときだけ添える
    if (options.predicted && options.predicted !== options.arrivalTime && options.predicted !== options.departureTime) {
      times.push(`<span class="font-bold text-green-700">予測 ${esc(options.predicted)}</span>`);
    }

    const link = stop.busstopUrl
      ? `<a href="${esc(stop.busstopUrl)}" data-spa class="font-bold text-gray-900 underline decoration-dotted underline-offset-2 hover:text-purple-700">${esc(stop.name)}</a>`
      : `<span class="font-bold text-gray-900">${esc(stop.name)}</span>`;

    return `
      <div class="flex items-start gap-3">
        <div class="w-4 flex justify-center pt-1 shrink-0">
          <span class="block w-3.5 h-3.5 rounded-full border-[3px] bg-white" style="border-color:${esc(options.color || '#94a3b8')}"></span>
        </div>
        <div class="flex-1 min-w-0 pb-1">
          <div class="flex flex-wrap items-baseline gap-x-2">
            ${link}
            ${platformLabel(stop) ? `<span class="text-[10px] font-bold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">${esc(platformLabel(stop))}</span>` : ''}
          </div>
          <div class="flex flex-wrap items-baseline gap-x-2 text-sm">${times.join('<span class="text-gray-300">/</span>')}</div>
        </div>
      </div>
    `;
  }

  function renderBusLeg(leg, legKey) {
    const style = routeColorStyle(leg.routeColor);
    const barColor = style.hasColor ? style.hex : '#cbd5e1';
    const isOpen = openLegKeys.has(legKey);

    const realtimeHtml = leg.realtime
      ? `<div class="text-[11px] font-bold text-green-800 bg-green-50 border border-green-200 rounded-lg px-2 py-1 mt-2">
           ● 運行中${leg.realtime.currentStopName ? `：${esc(leg.realtime.currentStopName)}を発車` : ''}
           ${leg.realtime.predictedArrivalDelayMinutes > 1 ? ` ／ 約${leg.realtime.predictedArrivalDelayMinutes}分遅れ` : ' ／ ほぼ定刻'}
           ${leg.realtime.departed ? ' ／ この便は乗車バス停を発車済みです' : ''}
         </div>`
      : '';

    const tripUrl = `/timetable/trips/${encodeURIComponent(leg.feedId)}/${encodeURIComponent(leg.routeId)}/${encodeURIComponent(leg.tripId)}/${encodeURIComponent(leg.tripDepartureTime)}`;

    return `
      <div class="flex items-stretch gap-3">
        <div class="w-4 flex justify-center shrink-0">
          <span class="block w-1.5 rounded-full" style="background:${esc(barColor)}"></span>
        </div>
        <div class="flex-1 min-w-0 py-2">
          <div class="flex flex-wrap items-center gap-2">
            ${routeChip(leg)}
            <span class="text-sm font-bold" style="color:${esc(style.textOnWhite)}">${esc(leg.headsign ? `${leg.headsign} ゆき` : leg.routeName)}</span>
          </div>
          <p class="text-[11px] font-bold text-gray-500 mt-1">
            ${esc(leg.routeName)} ／ ${leg.stopCount}停留所 ／ 約${leg.rideMinutes}分
            ${leg.fare ? ` ／ ${esc(yen(leg.fare.price))}` : ' ／ 運賃不明'}
          </p>
          ${realtimeHtml}
          <div class="flex flex-wrap gap-3 mt-2">
            <button type="button" data-role="rs-toggle-stops" data-leg="${esc(legKey)}"
                    class="text-[11px] font-bold text-purple-700">
              ${isOpen ? '通過するバス停を閉じる ▴' : '通過するバス停を見る ▾'}
            </button>
            <a href="${esc(tripUrl)}" data-spa class="text-[11px] font-bold text-sky-700">この便の全区間を見る</a>
          </div>
          <div data-role="rs-stops" data-leg="${esc(legKey)}" style="display:${isOpen ? 'block' : 'none'}">
            ${renderLegStops(leg, barColor)}
          </div>
        </div>
      </div>
    `;
  }

  /** 乗車から降車までの通過バス停と通過時刻（要望3・仕様書 6.4）。 */
  function renderLegStops(leg, barColor) {
    return `
      <ul class="mt-2 bg-gray-50 rounded-xl p-3 space-y-1">
        ${leg.stops.map((stop) => {
          const emphasis = stop.isBoard || stop.isAlight;
          const time = stop.departureTime || stop.arrivalTime;
          const predicted = stop.predictedTime && stop.predictedTime !== time ? stop.predictedTime : null;
          const nameHtml = stop.busstopUrl
            ? `<a href="${esc(stop.busstopUrl)}" data-spa class="${emphasis ? 'font-bold text-gray-900' : 'text-gray-700'} underline decoration-dotted underline-offset-2 hover:text-purple-700">${esc(stop.name)}</a>`
            : `<span class="${emphasis ? 'font-bold text-gray-900' : 'text-gray-700'}">${esc(stop.name)}</span>`;
          return `
            <li class="flex items-center gap-2 text-xs">
              <span class="w-2 h-2 rounded-full shrink-0" style="background:${esc(emphasis ? barColor : '#cbd5e1')}"></span>
              <span class="flex-1 min-w-0 truncate">${nameHtml}
                ${stop.isBoard ? '<span class="text-[10px] font-bold text-white bg-purple-600 px-1.5 py-0.5 rounded ml-1">乗車</span>' : ''}
                ${stop.isAlight ? '<span class="text-[10px] font-bold text-white bg-gray-700 px-1.5 py-0.5 rounded ml-1">降車</span>' : ''}
                ${stop.isThrough ? '<span class="text-[10px] font-bold text-gray-500 ml-1">（通過）</span>' : ''}
              </span>
              <span class="shrink-0 font-bold ${predicted ? 'text-gray-400 line-through' : 'text-gray-700'}">${esc(timeWithDay(time, stop.dayOffset))}</span>
              ${predicted ? `<span class="shrink-0 font-bold text-green-700">${esc(predicted)}</span>` : ''}
              ${stop.status === '到着済' ? '<span class="shrink-0 text-[10px] font-bold text-gray-400">通過済</span>' : ''}
            </li>`;
        }).join('')}
      </ul>
    `;
  }

  function renderWalkLeg(leg) {
    return `
      <div class="flex items-stretch gap-3">
        <div class="w-4 flex justify-center shrink-0">
          <span class="block w-1.5 rounded-full" style="background:repeating-linear-gradient(180deg,#cbd5e1,#cbd5e1 4px,transparent 4px,transparent 8px)"></span>
        </div>
        <div class="flex-1 min-w-0 py-2">
          <p class="text-sm font-bold text-gray-600">徒歩 約${leg.walkMinutes}分（約${leg.distanceMeters}m）</p>
          <p class="text-[11px] font-bold text-gray-400">${esc(leg.fromStop.name)} → ${esc(leg.toStop.name)}</p>
        </div>
      </div>
    `;
  }

  /* ---------- 見つからなかったとき（仕様書 6.6） ---------- */
  function renderNotFound(result) {
    // 日付表記（「8月13日（木）」）は画面側で組み立てる（サーバーの文言に日付を埋め込まない）
    const suggestionLabel = result.suggestion
      ? (result.suggestion.kind === 'first-bus'
        ? `この日の始発（${result.suggestion.time}）で検索`
        : `次の運行日（${formatDateLabel(result.suggestion.date)}）で検索`)
      : '';
    const suggestionButton = result.suggestion
      ? `<button type="button" data-role="rs-apply-suggestion"
                 data-date="${esc(result.suggestion.date)}" data-time="${esc(result.suggestion.time)}"
                 class="mt-3 w-full bg-yellow-600 text-white py-3 rounded-xl font-bold shadow hover:bg-yellow-700 active:scale-95 transition-all">
           ${esc(suggestionLabel)}
         </button>`
      : '';

    const alternatives = (result.alternatives || []).length > 0
      ? `<div class="mt-3">
           <p class="text-xs font-bold text-yellow-900 mb-2">近くのバス停</p>
           <div class="space-y-2">
             ${result.alternatives.map((stop) => `
               <button type="button" data-role="rs-use-stop" data-key="${esc(stop.stopKey)}" data-name="${esc(stop.name)}"
                       class="w-full text-left bg-white border-2 border-yellow-200 rounded-lg px-3 py-2 font-bold text-sm hover:bg-yellow-50">
                 ${esc(stop.name)}<span class="text-xs font-bold text-gray-500 ml-2">徒歩約${stop.walkMinutes}分（${stop.distanceMeters}m）</span>
               </button>`).join('')}
           </div>
         </div>`
      : '';

    const suggestions = (result.suggestions || []).length > 0
      ? `<div class="mt-3">
           <p class="text-xs font-bold text-yellow-900 mb-2">もしかして</p>
           <div class="space-y-2">
             ${result.suggestions.map((stop) => `
               <button type="button" data-role="rs-use-stop" data-key="${esc(stop.stopKey)}" data-name="${esc(stop.stopName || stop.name)}"
                       class="w-full text-left bg-white border-2 border-yellow-200 rounded-lg px-3 py-2 font-bold text-sm hover:bg-yellow-50">
                 ${esc(stop.stopName || stop.name)}
               </button>`).join('')}
           </div>
         </div>`
      : '';

    return `
      <div class="bg-yellow-50 border-2 border-yellow-300 rounded-2xl p-5">
        <p class="text-sm font-bold text-yellow-900">${esc(result.message || '経路が見つかりませんでした。')}</p>
        ${result.from && result.to ? `<p class="text-xs font-bold text-yellow-800 mt-2">${esc(result.from.name)} → ${esc(result.to.name)}（${esc(formatDateLabel(result.date))} ${esc(result.baseTime)} 以降）</p>` : ''}
        ${suggestionButton}
        ${alternatives}
        ${suggestions}
      </div>
    `;
  }

  /* ---------- 結果内の操作 ---------- */
  function bindResultEvents(container, state) {
    container.querySelectorAll('[data-role="rs-toggle-stops"]').forEach((button) => {
      button.addEventListener('click', () => {
        const legKey = button.dataset.leg;
        const panel = container.querySelector(`[data-role="rs-stops"][data-leg="${CSS.escape(legKey)}"]`);
        if (!panel) return;
        const isOpen = panel.style.display !== 'none';
        panel.style.display = isOpen ? 'none' : 'block';
        button.textContent = isOpen ? '通過するバス停を見る ▾' : '通過するバス停を閉じる ▴';
        if (isOpen) openLegKeys.delete(legKey);
        else openLegKeys.add(legKey);
      });
    });

    const suggestionButton = container.querySelector('[data-role="rs-apply-suggestion"]');
    if (suggestionButton) {
      suggestionButton.addEventListener('click', () => {
        navigate(buildUrl({ ...state, date: suggestionButton.dataset.date, time: suggestionButton.dataset.time }));
      });
    }

    container.querySelectorAll('[data-role="rs-use-stop"]').forEach((button) => {
      button.addEventListener('click', () => {
        // 見つからなかった側（目的地優先）を、提示したバス停に置き換えて再検索する
        const next = { ...state };
        if (lastResult && lastResult.reason === 'stop-not-found' && !state.fromKey) {
          next.fromText = button.dataset.name;
          next.fromKey = button.dataset.key;
        } else {
          next.toText = button.dataset.name;
          next.toKey = button.dataset.key;
        }
        navigate(buildUrl(next));
      });
    });
  }

  window.RouteSearchView = {
    isRouteSearchPath,
    render,
    navigate,
    stopPolling: stopRealtimePolling
  };
})();
