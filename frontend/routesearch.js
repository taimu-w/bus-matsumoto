/* ==========================================================
 * 経路検索機能（SPA） / docs/経路検索機能_改善仕様書.md
 *
 * 画面とURL（仕様書 6.1）:
 *   /routesearch                                              検索フォーム
 *   /routesearch?from=…&fromKey=…&to=…&toKey=…&date=…&time=…  検索結果（経路一覧）
 *   /routesearch?…&journey=N                                  経路詳細（一覧のN番目）
 *
 * 経路一覧は「出発／到着時刻・所要時間・運賃・乗換回数・徒歩・路線カラーのバー」だけの
 * シンプル表示にし、乗り換え時刻や通過バス停といった詳しい情報は詳細画面に置く。
 * 詳細も検索条件と同じくURL（journey）で表現するので、リロード・共有・ブラウザの
 * 戻るがそのまま効く（一覧→詳細はpushState、詳細内の「前後の経路」はreplaceStateで
 * 移動するため、詳細のどこからでもブラウザの戻るで一覧に帰れる）。
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
  // 「近くのバス停」候補（出発地・目的地欄で共用）。位置情報の許可ダイアログを毎回出さないよう使い回す。
  let nearbyStopsCache = null;
  let nearbyStopsPromise = null;
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

  /** 通算秒（検索日の0時起点。翌日にまたがると86400以上、前日だと負にもなる）を "HH:MM" にする。
   *  「1本前／1本後」の再検索でアンカー秒を時刻欄・URLの値へ戻すのに使う。 */
  function secondsToHhmm(totalSeconds) {
    const s = ((Math.round(totalSeconds) % 86400) + 86400) % 86400;
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
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
  // dayOffset が負になるのは到着時刻指定のとき（指定時刻までに着く便が前日の深夜便だった場合）。
  function timeWithDay(time, dayOffset) {
    if (!time) return '';
    if (dayOffset > 0) return `翌日 ${time}`;
    if (dayOffset < 0) return `前日 ${time}`;
    return time;
  }

  /** 検索条件の説明文（出発時刻指定／到着時刻指定）。結果ヘッダーと「見つからない」表示で共用する。 */
  function baseTimeLabel(result) {
    return result.timeMode === 'arrival'
      ? `${result.baseTime} までに到着`
      : `${result.baseTime} 以降に出発`;
  }

  function yen(value) {
    return `¥${Number(value).toLocaleString('ja-JP')}`;
  }

  function platformLabel(stop) {
    if (!stop || !stop.platformCode) return '';
    return /^\d+$/.test(stop.platformCode) ? `${stop.platformCode}番のりば` : stop.platformCode;
  }

  /* ---------- 観光スポット詳細ポップアップ（観光スポット情報_仕様書） ---------- */
  // 出発地/目的地が観光スポットのとき、タイムライン側のスポット名をタップ可能にする。
  function spotNameButtonHtml(spot) {
    return `<button type="button" data-role="rs-spot-name" data-spot-id="${esc(spot.spotId)}"
                    class="font-bold text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-800">${esc(spot.name)}</button>`;
  }

  /** 生URLをそのまま出さず、ドメイン名のみを見せる表示ラベルにする（busstop.jsと同じ考え方）。 */
  function spotLinkLabel(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return `公式サイト（${host}）を見る`;
    } catch {
      return '公式サイトを見る';
    }
  }

  function renderSpotModalBody(spot) {
    return `
      ${spot.photoUrl ? `<img src="${esc(spot.photoUrl)}" alt="${esc(spot.name)}" class="w-full h-40 object-contain bg-gray-100 rounded-xl mb-3">` : ''}
      <p class="text-lg font-bold text-gray-900">${esc(spot.name)}</p>
      ${spot.kana ? `<p class="text-xs text-gray-400 mt-0.5">${esc(spot.kana)}${spot.romaji ? ` / ${esc(spot.romaji)}` : ''}</p>` : ''}
      ${spot.hours ? `<p class="text-xs text-gray-500 mt-2">営業時間：${esc(spot.hours)}</p>` : ''}
      ${spot.stayDuration ? `<p class="text-xs text-gray-500">滞在目安：${esc(spot.stayDuration)}</p>` : ''}
      ${spot.description ? `<p class="text-sm text-gray-700 mt-2 leading-relaxed">${esc(spot.description)}</p>` : ''}
      ${spot.url ? `
        <a href="${esc(spot.url)}" target="_blank" rel="noopener noreferrer"
           class="inline-flex items-center gap-1 mt-3 text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-3 py-1 hover:bg-indigo-100">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          ${esc(spotLinkLabel(spot.url))}
        </a>` : ''}
    `;
  }

  async function openSpotModal(spotId) {
    const body = document.getElementById('rs-spot-modal-body');
    if (!body || typeof window.openModal !== 'function') return;
    body.innerHTML = '<p class="text-sm font-bold text-gray-400 py-6 text-center">読み込み中...</p>';
    window.openModal('rs-spot-modal');
    try {
      const res = await fetchJson(`${API_BASE}/tourist-spots/${encodeURIComponent(spotId)}`);
      body.innerHTML = renderSpotModalBody(res.spot);
    } catch (err) {
      // 取得失敗はポップアップ内にエラー文言を出すだけに留める（soft-fail）
      body.innerHTML = '<p class="text-sm font-bold text-gray-400 py-6 text-center">観光スポット情報を取得できませんでした。</p>';
    }
  }

  /* ---------- お気に入りルート（名前付きで登録する。日付・時刻はurlに含めず開いた時点で検索し直す） ---------- */
  // 観光スポット起点/終点（観光スポット情報_仕様書）とバス停で名称が衝突しないよう、
  // 識別子にkindを含める。
  function routeSearchFavoriteId(state) {
    const fromId = state.fromSpotId ? `spot:${state.fromSpotId}` : (state.fromKey || state.fromText);
    const toId = state.toSpotId ? `spot:${state.toSpotId}` : (state.toKey || state.toText);
    return `routesearch|${fromId}|${toId}`;
  }

  function buildRouteSearchFavorite(state, name) {
    const query = new URLSearchParams();
    if (state.fromText) query.set('from', state.fromText);
    if (state.fromKey) query.set('fromKey', state.fromKey);
    if (state.fromSpotId) query.set('fromSpotId', state.fromSpotId);
    if (state.toText) query.set('to', state.toText);
    if (state.toKey) query.set('toKey', state.toKey);
    if (state.toSpotId) query.set('toSpotId', state.toSpotId);
    // 詳細設定は検索条件の一部なので保存する（日付・時刻と違い、開くたびに変わるものではない）。
    // 既定のままなら何も付かないので、従来登録したお気に入りのURLと同じ形のままになる。
    appendPreferenceParams(query, state);
    const qs = query.toString();
    return {
      id: routeSearchFavoriteId(state),
      type: 'routesearch',
      title: name,
      subtitle: `${state.fromText} → ${state.toText}`,
      url: `/routesearch${qs ? `?${qs}` : ''}`
    };
  }

  function paintFavRow(state) {
    const row = document.getElementById('rs-fav-row');
    if (!row || !window.Favorites) return;
    const id = routeSearchFavoriteId(state);
    const existing = window.Favorites.get(id);

    row.innerHTML = existing
      ? `<div class="flex items-center gap-2 bg-amber-50 border-2 border-amber-200 rounded-xl px-3 py-2">
           <span class="text-amber-500 text-lg leading-none shrink-0">★</span>
           <span class="flex-1 min-w-0 text-xs font-bold text-amber-900 truncate">「${esc(existing.title)}」として登録済み</span>
           <button type="button" data-role="rs-fav-rename" class="text-[11px] font-bold text-amber-800 underline shrink-0">名前を変更</button>
           <button type="button" data-role="rs-fav-remove" class="text-[11px] font-bold text-red-600 underline shrink-0">解除</button>
         </div>`
      : `<button type="button" data-role="rs-fav-add"
                class="w-full flex items-center justify-center gap-2 bg-white border-2 border-purple-200 text-purple-700 rounded-xl px-3 py-2.5 text-sm font-bold hover:bg-purple-50 active:scale-[0.99] transition-all">
           <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.7-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.7 1.1-5.9-4.3-4.1 5.9-.7L12 3.5z"/></svg>
           この検索をお気に入りルートに登録（通勤など名前を付けて保存）
         </button>`;

    const addBtn = row.querySelector('[data-role="rs-fav-add"]');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const name = window.prompt('お気に入りルートの名前を入力してください（例：通勤）', `${state.fromText} → ${state.toText}`);
        if (!name || !name.trim()) return;
        window.Favorites.add(buildRouteSearchFavorite(state, name.trim()));
        paintFavRow(state);
      });
    }
    const renameBtn = row.querySelector('[data-role="rs-fav-rename"]');
    if (renameBtn) {
      renameBtn.addEventListener('click', () => {
        const current = window.Favorites.get(id);
        const name = window.prompt('お気に入りルートの名前を変更', current ? current.title : '');
        if (!name || !name.trim()) return;
        window.Favorites.add(buildRouteSearchFavorite(state, name.trim()));
        paintFavRow(state);
      });
    }
    const removeBtn = row.querySelector('[data-role="rs-fav-remove"]');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        window.Favorites.remove(id);
        paintFavRow(state);
      });
    }
  }

  /* ==========================================================
   * 詳細設定（乗り換えなしで探す、など）
   *
   * 既定値は「これまでどおり」の検索条件そのもの。既定のままなら
   * URLにもAPIクエリにも載せないので、既存のURL・お気に入り・共有リンクの
   * 挙動は一切変わらない（サーバー側も未指定は既定に落とす）。
   * ========================================================== */
  const PREFERENCE_DEFAULTS = { maxTransfers: null, allowWalkTransfer: true, minTransferMinutes: 1 };
  // サーバー側（gtfsRouteSearch.js）の上限と揃える
  const MAX_TRANSFERS_LIMIT = 3;
  const TRANSFER_MARGIN_MIN_MINUTES = 1;
  const TRANSFER_MARGIN_MAX_MINUTES = 15;

  const MAX_TRANSFER_OPTIONS = [
    { value: '', label: '指定なし' },
    { value: '0', label: '乗り換えなし' },
    { value: '1', label: '1回まで' },
    { value: '2', label: '2回まで' }
  ];
  const WALK_TRANSFER_OPTIONS = [
    { value: 'true', label: '使う' },
    { value: 'false', label: '使わない' }
  ];
  const TRANSFER_MARGIN_OPTIONS = [
    { value: '1', label: '標準' },
    { value: '3', label: '3分' },
    { value: '5', label: '5分' },
    { value: '10', label: '10分' }
  ];

  // 詳細設定パネルの開閉。再描画（検索のたびに起きる）をまたいで維持する。
  // null＝利用者がまだ触っていない（条件が入っていれば自動で開く）。
  let advancedOpen = null;

  /** 乗換回数の上限。null＝指定なし（＝従来どおり）。 */
  function parseMaxTransfers(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(Math.max(parsed, 0), MAX_TRANSFERS_LIMIT);
  }

  function parseTransferMargin(raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return PREFERENCE_DEFAULTS.minTransferMinutes;
    return Math.min(Math.max(parsed, TRANSFER_MARGIN_MIN_MINUTES), TRANSFER_MARGIN_MAX_MINUTES);
  }

  /** state / APIレスポンスの preferences のどちらにも使える（フィールド名を揃えてある）。 */
  function isDefaultPreferences(prefs) {
    if (!prefs) return true;
    return prefs.maxTransfers === null
      && prefs.allowWalkTransfer !== false
      && (prefs.minTransferMinutes || PREFERENCE_DEFAULTS.minTransferMinutes) === PREFERENCE_DEFAULTS.minTransferMinutes;
  }

  /** 適用中の条件を短い言葉にする（フォームの見出し・結果ヘッダーで共用）。 */
  function preferenceLabels(prefs) {
    if (!prefs) return [];
    const labels = [];
    if (prefs.maxTransfers === 0) labels.push('乗り換えなし');
    else if (prefs.maxTransfers !== null && prefs.maxTransfers !== undefined) labels.push(`乗換${prefs.maxTransfers}回まで`);
    if (prefs.allowWalkTransfer === false) labels.push('徒歩での乗り継ぎなし');
    if (prefs.minTransferMinutes && prefs.minTransferMinutes !== PREFERENCE_DEFAULTS.minTransferMinutes) {
      labels.push(`乗換余裕${prefs.minTransferMinutes}分`);
    }
    return labels;
  }

  /**
   * 詳細設定をクエリへ載せる。**既定値のものは載せない**（URL・お気に入り・APIリクエストを
   * 従来とまったく同じ形に保ち、旧いリンクとの往復で条件が増えないようにするため）。
   * URLパラメータ名はAPIのクエリ名と同じにしてある。
   */
  function appendPreferenceParams(query, prefs) {
    if (prefs.maxTransfers !== null && prefs.maxTransfers !== undefined) {
      query.set('maxTransfers', String(prefs.maxTransfers));
    }
    if (prefs.allowWalkTransfer === false) query.set('allowWalkTransfer', 'false');
    if (prefs.minTransferMinutes && prefs.minTransferMinutes !== PREFERENCE_DEFAULTS.minTransferMinutes) {
      query.set('minTransferMinutes', String(prefs.minTransferMinutes));
    }
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
    if (state.fromSpotId) query.set('fromSpotId', state.fromSpotId);
    if (state.toText) query.set('to', state.toText);
    if (state.toKey) query.set('toKey', state.toKey);
    if (state.toSpotId) query.set('toSpotId', state.toSpotId);
    if (state.date) query.set('date', state.date);
    if (state.time) query.set('time', state.time);
    // 既定（出発時刻指定）のときはURLに載せない。従来のURL・お気に入りをそのまま活かすため。
    if (state.timeMode === 'arrival') query.set('timeMode', 'arrival');
    appendPreferenceParams(query, state);
    // 経路詳細を開いているときだけ載せる（一覧のURLは従来と同じ形のまま）。
    if (state.journeyIndex !== null && state.journeyIndex !== undefined && state.journeyIndex !== '') {
      query.set('journey', String(state.journeyIndex));
    }
    const qs = query.toString();
    return `/routesearch${qs ? `?${qs}` : ''}`;
  }

  /**
   * 画面遷移。既定はpushState（ブラウザの戻るで直前の画面に帰れる）。
   * `replace:true`は経路詳細内での「前の経路／次の経路」用で、履歴を積まずに
   * 現在のエントリを差し替える（詳細を何件たどっても戻る操作で一覧に帰れるようにする）。
   */
  function navigate(url, { replace = false } = {}) {
    if (replace) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);
    if (typeof window.renderCurrentRoute === 'function') window.renderCurrentRoute();
    else render();
    window.scrollTo(0, 0);
  }

  function readState() {
    const params = currentParams();
    const journeyParam = params.get('journey');
    return {
      fromText: params.get('from') || '',
      fromKey: params.get('fromKey') || '',
      fromSpotId: params.get('fromSpotId') || '',
      toText: params.get('to') || '',
      toKey: params.get('toKey') || '',
      toSpotId: params.get('toSpotId') || '',
      date: params.get('date') || todayString(),
      time: params.get('time') || nowHhmm(),
      // timeMode=arrival なら「この時刻までに到着」。未指定は従来どおり出発時刻指定。
      timeMode: params.get('timeMode') === 'arrival' ? 'arrival' : 'departure',
      // 詳細設定。いずれも未指定なら既定（＝これまでどおりの検索条件）。
      maxTransfers: parseMaxTransfers(params.get('maxTransfers')),
      allowWalkTransfer: params.get('allowWalkTransfer') !== 'false',
      minTransferMinutes: parseTransferMargin(params.get('minTransferMinutes')),
      // journey=N が付いていれば経路一覧のN件目（0始まり）の詳細画面。無ければ一覧。
      journeyIndex: /^\d+$/.test(journeyParam || '') ? Number(journeyParam) : null
    };
  }

  /** selected.from / selected.to の同一判定用キー（バス停/観光スポットの混在に対応）。 */
  function endpointIdentity(item) {
    if (!item) return null;
    return item.kind === 'spot' ? `spot:${item.spotId}` : `stop:${item.stopKey}`;
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

    const hasEndpoints = (state.fromKey || state.fromText) && (state.toKey || state.toText);

    // 経路詳細（?journey=N）は検索フォームを出さず、その経路1件の情報に集中させる。
    // 「経路一覧へ戻る」は読み込み中・エラー時にも押せるよう結果の外（root直下）に置く。
    if (hasEndpoints && state.journeyIndex !== null) {
      root().innerHTML = `
        <div class="flex items-center justify-between mb-4">
          <button type="button" data-role="rs-back-to-list" class="inline-flex items-center gap-1 text-sm font-bold text-purple-700">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>
            </svg>
            経路一覧へ戻る
          </button>
          <a href="/" data-spa class="text-sm font-bold text-purple-700">メニューへ戻る</a>
        </div>
        <div id="rs-result"></div>
      `;
      bindBackToList(root(), state);
      await runSearch(state, seq);
      return;
    }

    root().innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-purple-900">経路検索</h2>
        <a href="/" data-spa class="text-sm font-bold text-purple-700">メニューへ戻る</a>
      </div>
      ${renderForm(state)}
      <div id="rs-result" class="mt-6"></div>
    `;
    bindFormEvents(state);

    if (!hasEndpoints) return;

    await runSearch(state, seq);
  }

  /* ---------- 出発時刻指定／到着時刻指定の切り替え ---------- */
  const TIME_MODES = [
    { key: 'departure', label: '出発時刻', hint: '指定した時刻以降に出発する経路を探します。' },
    { key: 'arrival', label: '到着時刻', hint: '指定した時刻までに到着する経路を、遅く出発できる順に探します。' }
  ];

  function timeModeButtonClass(active) {
    return `px-3 py-2.5 rounded-xl text-sm font-bold border-2 transition-all ${
      active ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-700 border-gray-200'
    }`;
  }

  function timeModeHint(timeMode) {
    const mode = TIME_MODES.find((m) => m.key === timeMode) || TIME_MODES[0];
    return mode.hint;
  }

  function currentTimeMode() {
    const el = document.getElementById('rs-timemode');
    return el && el.value === 'arrival' ? 'arrival' : 'departure';
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
          <label class="block text-sm font-bold text-gray-700 mb-2" for="rs-time">時刻</label>
          <div class="grid grid-cols-2 gap-2 mb-2">
            ${TIME_MODES.map((mode) => `
              <button type="button" data-role="rs-timemode" data-mode="${esc(mode.key)}"
                      class="${timeModeButtonClass(state.timeMode === mode.key)}">
                ${esc(mode.label)}
              </button>`).join('')}
          </div>
          <input type="hidden" id="rs-timemode" value="${esc(state.timeMode)}">
          <div class="flex gap-2">
            <input type="time" id="rs-time" value="${esc(state.time)}"
                   class="flex-1 min-w-0 px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-500 focus:outline-none font-bold">
            <button id="rs-now" type="button"
                    class="shrink-0 px-4 py-3 border-2 border-purple-200 text-purple-700 bg-purple-50 rounded-xl font-bold text-sm hover:bg-purple-100 active:scale-95 transition-all">
              現在時刻
            </button>
          </div>
          <p id="rs-time-hint" class="text-xs text-gray-500 font-bold mt-1 px-1">${esc(timeModeHint(state.timeMode))}</p>
        </div>

        ${renderAdvancedSettings(state)}

        <div id="rs-warning" class="text-sm font-bold text-red-700 bg-red-50 border-2 border-red-200 rounded-xl px-4 py-2 mt-3" style="display:none;"></div>

        <button id="rs-search" type="button"
                class="w-full bg-purple-600 text-white py-4 rounded-xl font-bold text-lg shadow-lg hover:bg-purple-700 active:scale-95 transition-all mt-3">
          経路を検索
        </button>
      </div>
    `;
  }

  /* ---------- 詳細設定パネル ---------- */
  function optionButtonClass(active) {
    return `px-3 py-2 rounded-xl text-xs font-bold border-2 transition-all ${
      active ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-700 border-gray-200'
    }`;
  }

  function optionButtonsHtml(role, options, currentValue) {
    return options.map((option) => `
      <button type="button" data-role="${esc(role)}" data-value="${esc(option.value)}"
              class="${optionButtonClass(option.value === currentValue)}">${esc(option.label)}</button>`).join('');
  }

  /**
   * 「乗り換えなし」などの条件を指定するパネル。既定では閉じており、既定値のままなら
   * 検索条件はこれまでとまったく同じ（＝この機能を知らない利用者の体験は変わらない）。
   * 条件を指定しているときは開いた状態で描画し、見出しにも要約を出す。
   */
  function renderAdvancedSettings(state) {
    const labels = preferenceLabels(state);
    const maxTransfersValue = state.maxTransfers === null ? '' : String(state.maxTransfers);
    const walkValue = state.allowWalkTransfer ? 'true' : 'false';
    const marginValue = String(state.minTransferMinutes);
    // 条件が入っていれば既定で開く。ただし利用者が自分で閉じたならその意思を優先する。
    const shouldOpen = advancedOpen === null ? labels.length > 0 : advancedOpen;

    return `
      <details id="rs-advanced" class="pt-3" ${shouldOpen ? 'open' : ''}>
        <summary class="cursor-pointer list-none flex items-center gap-2 py-1 select-none">
          <span class="text-sm font-bold text-purple-700">詳細設定</span>
          ${labels.length > 0
            ? `<span class="text-[11px] font-bold text-purple-900 bg-purple-100 border border-purple-200 px-2 py-0.5 rounded-full">${esc(labels.join('・'))}</span>`
            : '<span class="text-[11px] font-bold text-gray-400">乗り換えなしで探す など</span>'}
          <span class="rs-adv-open ml-auto text-xs font-bold text-purple-700">開く ▾</span>
          <span class="rs-adv-close ml-auto text-xs font-bold text-purple-700">閉じる ▴</span>
        </summary>
        <div class="mt-2 bg-gray-50 border-2 border-gray-100 rounded-xl p-3 space-y-3">
          <div>
            <p class="text-xs font-bold text-gray-700 mb-1.5">乗り換え回数</p>
            <div class="flex flex-wrap gap-2">${optionButtonsHtml('rs-maxtransfers', MAX_TRANSFER_OPTIONS, maxTransfersValue)}</div>
            <p class="text-[11px] font-bold text-gray-500 mt-1">「乗り換えなし」は1本のバスで行ける経路だけを探します。</p>
          </div>
          <div>
            <p class="text-xs font-bold text-gray-700 mb-1.5">徒歩での乗り継ぎ</p>
            <div class="flex flex-wrap gap-2">${optionButtonsHtml('rs-walktransfer', WALK_TRANSFER_OPTIONS, walkValue)}</div>
            <p class="text-[11px] font-bold text-gray-500 mt-1">近くの別のバス停まで歩いて乗り継ぐ経路を候補に入れるかどうかです。</p>
          </div>
          <div>
            <p class="text-xs font-bold text-gray-700 mb-1.5">乗り換えの余裕時間</p>
            <div class="flex flex-wrap gap-2">${optionButtonsHtml('rs-transfermargin', TRANSFER_MARGIN_OPTIONS, marginValue)}</div>
            <p class="text-[11px] font-bold text-gray-500 mt-1">乗り継ぎに最低これだけの時間を空けた経路を探します。</p>
          </div>
          <input type="hidden" id="rs-maxtransfers" value="${esc(maxTransfersValue)}">
          <input type="hidden" id="rs-walktransfer" value="${esc(walkValue)}">
          <input type="hidden" id="rs-transfermargin" value="${esc(marginValue)}">
          <button type="button" data-role="rs-reset-advanced"
                  class="text-[11px] font-bold text-gray-600 underline ${labels.length > 0 ? '' : 'hidden'}">
            詳細設定をリセット
          </button>
        </div>
      </details>
    `;
  }

  /** フォームの詳細設定パネルから現在値を読む（未描画なら既定値）。 */
  function currentPreferences() {
    const maxTransfersEl = document.getElementById('rs-maxtransfers');
    const walkEl = document.getElementById('rs-walktransfer');
    const marginEl = document.getElementById('rs-transfermargin');
    if (!maxTransfersEl || !walkEl || !marginEl) return { ...PREFERENCE_DEFAULTS };
    return {
      maxTransfers: parseMaxTransfers(maxTransfersEl.value),
      allowWalkTransfer: walkEl.value !== 'false',
      minTransferMinutes: parseTransferMargin(marginEl.value)
    };
  }

  /**
   * 詳細設定の各ボタン・リセット・開閉状態を結び付ける。
   * 値は hidden input に持たせ、選択状態のスタイルだけをその場で塗り替える
   * （フォーム全体を描き直すと入力中のテキストや候補が消えてしまうため）。
   */
  function bindAdvancedSettings(container, onChange) {
    const details = container.querySelector('#rs-advanced');
    if (details) {
      // 検索のたびに再描画されるので、開閉状態は自前で覚えておく
      details.addEventListener('toggle', () => { advancedOpen = details.open; });
    }

    const groups = [
      { role: 'rs-maxtransfers', inputId: 'rs-maxtransfers' },
      { role: 'rs-walktransfer', inputId: 'rs-walktransfer' },
      { role: 'rs-transfermargin', inputId: 'rs-transfermargin' }
    ];
    const repaint = () => {
      groups.forEach(({ role, inputId }) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        container.querySelectorAll(`[data-role="${role}"]`).forEach((button) => {
          button.className = optionButtonClass(button.dataset.value === input.value);
        });
      });
      const reset = container.querySelector('[data-role="rs-reset-advanced"]');
      if (reset) reset.classList.toggle('hidden', isDefaultPreferences(currentPreferences()));
    };

    groups.forEach(({ role, inputId }) => {
      container.querySelectorAll(`[data-role="${role}"]`).forEach((button) => {
        button.addEventListener('click', () => {
          const input = document.getElementById(inputId);
          if (!input || input.value === button.dataset.value) return;
          input.value = button.dataset.value;
          repaint();
          onChange();
        });
      });
    });

    const reset = container.querySelector('[data-role="rs-reset-advanced"]');
    if (reset) {
      reset.addEventListener('click', () => {
        if (isDefaultPreferences(currentPreferences())) return;
        document.getElementById('rs-maxtransfers').value = '';
        document.getElementById('rs-walktransfer').value = 'true';
        document.getElementById('rs-transfermargin').value = String(PREFERENCE_DEFAULTS.minTransferMinutes);
        repaint();
        onChange();
      });
    }
  }

  /* ---------- フォームの操作 ---------- */
  function bindFormEvents(state) {
    setupAutocomplete('from', 'rs-from', 'rs-from-suggest', 'rs-from-meta', state);
    setupAutocomplete('to', 'rs-to', 'rs-to-suggest', 'rs-to-meta', state);

    // URLにキーが載っていれば「確定済み」として復元する（観光スポット情報_仕様書：fromSpotId/toSpotId）
    selected.from = state.fromSpotId
      ? { kind: 'spot', spotId: state.fromSpotId, name: state.fromText }
      : state.fromKey
        ? { kind: 'stop', stopKey: state.fromKey, name: state.fromText }
        : null;
    selected.to = state.toSpotId
      ? { kind: 'spot', spotId: state.toSpotId, name: state.toText }
      : state.toKey
        ? { kind: 'stop', stopKey: state.toKey, name: state.toText }
        : null;

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

    // 出発時刻／到着時刻の切り替え。日付のクイックボタンと同じく、
    // 出発地・目的地が入力済みならそのまま検索し直す。
    container.querySelectorAll('[data-role="rs-timemode"]').forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.mode === 'arrival' ? 'arrival' : 'departure';
        document.getElementById('rs-timemode').value = mode;
        container.querySelectorAll('[data-role="rs-timemode"]').forEach((other) => {
          other.className = timeModeButtonClass(other.dataset.mode === mode);
        });
        const hint = document.getElementById('rs-time-hint');
        if (hint) hint.textContent = timeModeHint(mode);
        resubmitIfReady();
      });
    });

    // 詳細設定。日付・時刻の切り替えと同じく、出発地・目的地が入力済みならその場で検索し直す。
    bindAdvancedSettings(container, resubmitIfReady);

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
    if (stop.kind === 'spot') parts.push('観光スポット（周辺のバス停から検索します）');
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

    const pick = (item) => {
      const endpoint = item.kind ? item : { ...item, kind: 'stop' };
      input.value = endpoint.name;
      selected[side] = endpoint;
      showMeta(metaId, endpoint);
      box.innerHTML = '';
    };

    // 入力欄への自動フォーカス（＝キーボードの自動表示）は廃止し、未入力のときは代わりに
    // お気に入りバス停・近くのバス停を候補として出す（出発地・目的地どちらも対象）。
    if (!input.value.trim()) showNearbyStopSuggestions(box, pick);

    input.addEventListener('input', () => {
      // テキストを編集した時点で確定を解除する（自由文字列検索へ戻す）
      selected[side] = null;
      showMeta(metaId, null);
      clearTimeout(suggestTimers[side]);
      const query = input.value.trim();
      if (!query) {
        box.innerHTML = '';
        showNearbyStopSuggestions(box, pick);
        return;
      }
      suggestTimers[side] = setTimeout(async () => {
        const seq = ++suggestSeq;
        let stops = [];
        let spots = [];
        try {
          const result = await fetchJson(`${API_BASE}/route-search/stops?q=${encodeURIComponent(query)}&limit=8`);
          stops = result.stops || [];
          spots = result.spots || [];
        } catch (err) {
          console.error('バス停候補の取得エラー:', err);
        }
        if (seq !== suggestSeq) return;
        renderMixedSuggestions(box, stops, spots, pick);
      }, 180);
    });

    input.addEventListener('blur', () => {
      // クリックを拾えるよう少し待ってから閉じる
      setTimeout(() => { box.innerHTML = ''; }, 200);
    });
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

  /**
   * お気に入り登録済みバス停のサマリー（重複なし・登録が新しい順）。
   * 特定の乗り場のみお気に入りでもバス停単位（すべての乗り場）で候補に出す。
   */
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

  function toSuggestStop(stop) {
    return {
      stopKey: stop.stopKey,
      name: stop.stopName,
      kana: stop.nameHiragana,
      romaji: stop.nameRomaji,
      platformCount: stop.platformCount,
      routes: stop.routes
    };
  }

  /** 出発地・目的地欄が空のときの初期候補（soft-fail：取得できなければ何も出さない）。
   *  お気に入りバス停を一番上、次に現在地から近いバス停を出す。 */
  async function showNearbyStopSuggestions(box, onSelect) {
    const [favoriteStops, nearbyStops] = await Promise.all([getFavoriteStops(), getNearbyStops()]);
    // 取得を待つ間に入力・フォーカス解除されていたら上書きしない
    if (box.innerHTML !== '' || !box.isConnected) return;
    const favoriteSuggestions = favoriteStops.map(toSuggestStop);
    const favoriteKeys = new Set(favoriteSuggestions.map((stop) => stop.stopKey));
    const nearbySuggestions = nearbyStops.filter((stop) => !favoriteKeys.has(stop.stopKey)).map(toSuggestStop);
    renderCategorizedSuggestions(box, [
      { label: 'お気に入りバス停', stops: favoriteSuggestions },
      { label: '近くのバス停', stops: nearbySuggestions }
    ], onSelect);
  }

  function stopSuggestionCardHtml(stop, index) {
    return `
      <button type="button" data-index="${index}"
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
      </button>`;
  }

  /** 観光スポット候補のカード（観光スポット情報_仕様書：地点名検索にバス停候補と混在させる）。 */
  function spotSuggestionCardHtml(spot, index) {
    return `
      <button type="button" data-index="${index}"
              class="w-full text-left bg-white border-2 border-emerald-100 rounded-lg p-3 hover:bg-emerald-50 active:scale-95 transition-all flex items-center gap-2">
        ${spot.photoUrl ? `<img src="${esc(spot.photoUrl)}" alt="" class="w-10 h-10 rounded-lg object-cover shrink-0">` : ''}
        <span class="min-w-0">
          <span class="flex items-center gap-1.5">
            <span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded shrink-0">観光スポット</span>
            <span class="font-bold text-gray-900 truncate">${esc(spot.name)}</span>
          </span>
          ${spot.kana ? `<span class="block text-[11px] text-gray-400">${esc(spot.kana)}${spot.romaji ? ` / ${esc(spot.romaji)}` : ''}</span>` : ''}
        </span>
      </button>`;
  }

  /** 複数グループ（お気に入り／近くのバス停など）に見出しを付けて描画する。空のグループは省く。 */
  function renderCategorizedSuggestions(box, groups, onSelect) {
    const nonEmpty = groups.filter((group) => group.stops.length > 0);
    if (nonEmpty.length === 0) {
      box.innerHTML = '';
      return;
    }
    const allStops = [];
    box.innerHTML = nonEmpty.map((group) => {
      const header = `<p class="text-[11px] font-bold text-gray-500 px-1 mb-1">${esc(group.label)}</p>`;
      const cards = group.stops.map((stop) => {
        const html = stopSuggestionCardHtml(stop, allStops.length);
        allStops.push(stop);
        return html;
      }).join('');
      return header + cards;
    }).join('');
    box.querySelectorAll('button[data-index]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => onSelect(allStops[Number(button.dataset.index)]));
    });
  }

  /** バス停候補と観光スポット候補を混在させて描画する（観光スポット情報_仕様書：出発地・目的地の入力候補）。 */
  function renderMixedSuggestions(box, stops, spots, onSelect) {
    if (stops.length === 0 && spots.length === 0) {
      box.innerHTML = '<p class="text-xs font-bold text-gray-500 px-1">一致するバス停・観光スポットがありません。</p>';
      return;
    }
    const items = [
      ...stops.map((s) => ({ ...s, kind: 'stop' })),
      ...spots.map((s) => ({ ...s, kind: 'spot' }))
    ];
    box.innerHTML = items
      .map((item, i) => (item.kind === 'spot' ? spotSuggestionCardHtml(item, i) : stopSuggestionCardHtml(item, i)))
      .join('');
    box.querySelectorAll('button[data-index]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => onSelect(items[Number(button.dataset.index)]));
    });
  }

  function submit() {
    const fromText = document.getElementById('rs-from').value.trim();
    const toText = document.getElementById('rs-to').value.trim();
    const date = document.getElementById('rs-date').value || todayString();
    const time = document.getElementById('rs-time').value || nowHhmm();
    const timeMode = currentTimeMode();
    const preferences = currentPreferences();

    if (!fromText || !toText) {
      showWarning('出発地と目的地を入力してください。');
      return;
    }
    const sameEndpoint = selected.from && selected.to && endpointIdentity(selected.from) === endpointIdentity(selected.to);
    const sameText = (!selected.from || !selected.to) && fromText === toText;
    if (sameEndpoint || sameText) {
      showWarning('出発地と目的地が同じです。目的地を変更してください。');
      return;
    }
    showWarning('');
    openLegKeys.clear();

    navigate(buildUrl({
      fromText,
      fromKey: selected.from && selected.from.kind !== 'spot' ? selected.from.stopKey : '',
      fromSpotId: selected.from && selected.from.kind === 'spot' ? selected.from.spotId : '',
      toText,
      toKey: selected.to && selected.to.kind !== 'spot' ? selected.to.stopKey : '',
      toSpotId: selected.to && selected.to.kind === 'spot' ? selected.to.spotId : '',
      date,
      time,
      timeMode,
      ...preferences
    }));
  }

  /* ==========================================================
   * 検索の実行と結果表示
   * ========================================================== */

  function buildApiUrl(state) {
    const query = new URLSearchParams();
    if (state.fromSpotId) query.set('fromSpotId', state.fromSpotId);
    else if (state.fromKey) query.set('fromStopKey', state.fromKey);
    else query.set('from', state.fromText);
    if (state.toSpotId) query.set('toSpotId', state.toSpotId);
    else if (state.toKey) query.set('toStopKey', state.toKey);
    else query.set('to', state.toText);
    query.set('date', state.date);
    query.set('time', state.time);
    if (state.timeMode === 'arrival') query.set('timeMode', 'arrival');
    appendPreferenceParams(query, state);
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

    // 経路詳細（?journey=N）。一覧と同じAPIの結果からN件目を取り出して描くだけなので、
    // 詳細専用のAPIは持たない（リアルタイムの重ね合わせも一覧とまったく同じ結果になる）。
    if (state.journeyIndex !== null) {
      const journey = result.found ? result.journeys[state.journeyIndex] : null;
      if (!journey) {
        // 件数が変わって指定の経路が無くなった場合（古いURLを開いた・リアルタイム更新で
        // 経路が減った）は、履歴を増やさずに一覧へ戻す。
        window.history.replaceState({}, '', buildUrl({ ...state, journeyIndex: null }));
        await render();
        return;
      }
      container.innerHTML = renderJourneyDetail(result, journey, state.journeyIndex);
      bindResultEvents(container, state);
      if (result.isToday) startRealtimePolling(state, seq);
      return;
    }

    container.innerHTML = result.found ? renderResults(result) : renderNotFound(result);
    bindResultEvents(container, state);

    // 検索を実行した直後（お気に入りからの直接遷移も含む）は、フォーム入力の下にある
    // 結果まで自動でスクロールする。リアルタイム追随のサイレント更新では動かさない。
    if (!silent) container.scrollIntoView({ behavior: 'smooth', block: 'start' });

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
      if (!autoRefreshEnabled()) return;
      runSearch(state, seq, { silent: true });
    }, REALTIME_POLL_MS);
  }

  function stopRealtimePolling() {
    if (realtimeTimer) {
      clearInterval(realtimeTimer);
      realtimeTimer = null;
    }
  }

  /* ==========================================================
   * 「1本前 / 1本後」（検索結果一覧のページ送り）
   *
   * 一覧の先頭（journeys[0]）を基準に、1本ぶん前／後の便で検索し直す。
   *   1本後: 先頭経路の「最初のバス区間の発車」の1分後以降を、出発時刻指定で再検索。
   *   1本前: 先頭経路の「到着」の1分前までに到着、を到着時刻指定で再検索。
   *
   * 出発時刻指定の探索は時間軸を巻き戻せない（同じ便がまた先頭に出るだけ）ため、
   * 「1本前」は到着時刻指定へ切り替える。結果ヘッダーの表記（「◯◯までに到着」）と
   * 並び順もそれに追従する（時刻表アプリの「前の時刻」と同じ挙動）。
   * 日付・時刻・timeMode はURLに載るので、リロード・共有・ブラウザの戻るはそのまま効く
   * （ブラウザの戻るで直前の検索結果へ帰れる）。
   * ========================================================== */

  /**
   * 現在の結果から「1本前 / 1本後」の再検索条件（date / time / timeMode）を作る。
   * バス区間を1つも含まない結果（理論上は無い）や未確定の結果では null。
   * @param {'prev'|'next'} dir
   */
  function nudgeTarget(result, dir) {
    if (!result || !result.found || !result.journeys || result.journeys.length === 0) return null;
    const journey = result.journeys[0];
    const busLegs = (journey.legs || []).filter((leg) => leg.type === 'bus');
    if (busLegs.length === 0) return null;
    // 先頭のバス区間の発車 / 経路全体の到着（いずれも定刻ベースの通算秒。日跨ぎ込み）。
    const anchorSeconds = dir === 'next'
      ? busLegs[0].departureSeconds + 60
      : journey.arrivalSeconds - 60;
    if (!Number.isFinite(anchorSeconds)) return null;
    return {
      date: shiftDate(result.date, Math.floor(anchorSeconds / 86400)),
      time: secondsToHhmm(anchorSeconds),
      timeMode: dir === 'next' ? 'departure' : 'arrival'
    };
  }

  /** 「1本前 / 1本後」ボタンの行（一覧の上下に同じものを置く。イベントは data-role で拾う）。 */
  function nudgeRowHtml(position) {
    const cls = 'flex-1 flex items-center justify-center gap-1.5 bg-white border-2 border-purple-200 '
      + 'text-purple-700 rounded-xl px-3 py-2.5 text-sm font-bold hover:bg-purple-50 active:scale-95 transition-all';
    return `
      <div class="flex gap-2 ${position === 'top' ? 'mb-3' : 'mt-4'}">
        <button type="button" data-role="rs-nudge" data-dir="prev" class="${cls}">
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
          1本前
        </button>
        <button type="button" data-role="rs-nudge" data-dir="next" class="${cls}">
          1本後
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>
      </div>`;
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
    // 観光スポットを起点/終点にした場合の注記（観光スポット情報_仕様書）。
    // 実際に採用されたバス停までの徒歩距離・目安分数が分かる場合は併記する。
    if (result.viaSpotFrom) {
      const walk = result.viaSpotFrom.walkMinutes != null
        ? `（徒歩約${result.viaSpotFrom.walkMinutes}分・約${result.viaSpotFrom.distanceMeters}m）`
        : '';
      notes.push(`「${result.viaSpotFrom.name}」から${walk}のバス停を出発地として検索しています。`);
    }
    if (result.viaSpotTo) {
      const walk = result.viaSpotTo.walkMinutes != null
        ? `（徒歩約${result.viaSpotTo.walkMinutes}分・約${result.viaSpotTo.distanceMeters}m）`
        : '';
      notes.push(`「${result.viaSpotTo.name}」まで${walk}のバス停を目的地として検索しています。`);
    }

    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-100 p-4 mb-4">
        <p class="text-sm font-bold text-gray-900">${endpointHeadingHtml(result)}</p>
        <p class="text-xs font-bold text-gray-500 mt-1">
          ${esc(formatDateLabel(result.date))} ${esc(baseTimeLabel(result))} ／ ${result.journeys.length}件
        </p>
        ${preferenceNoticeHtml(result.preferences)}
        ${notes.map((note) => `<p class="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">${esc(note)}</p>`).join('')}
      </div>
      <div id="rs-fav-row" class="mb-4"></div>
      <p class="text-[11px] font-bold text-gray-500 mb-2 px-1">経路をタップすると、乗り換え時刻や通過するバス停を表示します。</p>
      ${nudgeRowHtml('top')}
      <div class="space-y-3">
        ${result.journeys.map((journey, index) => renderJourneyListItem(journey, index)).join('')}
      </div>
      ${nudgeRowHtml('bottom')}
      <p class="text-[11px] text-gray-500 font-bold mt-4 px-1">
        運賃・時刻はGTFSデータに基づく目安です。実際の運賃・ダイヤは事業者にご確認ください。
      </p>
    `;
  }

  /**
   * 詳細設定が効いていることを結果ヘッダーに明示する（一覧・詳細・見つからない表示で共用）。
   * 「乗り換えなしで探したから候補が少ない」のか「そもそも便が無い」のかを取り違えないようにするため。
   * 既定の条件なら何も出さない（従来の画面とまったく同じ見た目になる）。
   */
  function preferenceNoticeHtml(preferences) {
    const labels = preferenceLabels(preferences);
    if (labels.length === 0) return '';
    return `<p class="text-xs font-bold text-purple-800 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 mt-2">
              詳細設定：${esc(labels.join('・'))}
            </p>`;
  }

  /** 結果ヘッダーの「出発地 → 目的地」。観光スポット詳細ポップアップはタイムライン側のスポット名から開く。 */
  function endpointHeadingHtml(result) {
    return `${esc(result.from.name)} <span class="text-gray-400">→</span> ${esc(result.to.name)}`;
  }

  /** 経路の性質を表すバッジ（一覧・詳細で共用。同じ経路が同じ見た目になるようにする）。 */
  function journeyBadges(journey) {
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
    // 到着時刻指定では、指定時刻までに着く便が前日の深夜便になることがある
    if (journey.departureDayOffset < 0) {
      badges.push('<span class="text-[11px] font-bold text-indigo-800 bg-indigo-100 border border-indigo-300 px-2 py-1 rounded">前日発</span>');
    }
    if (journey.transferAtRisk) {
      badges.push('<span class="text-[11px] font-bold text-red-800 bg-red-100 border border-red-300 px-2 py-1 rounded">⚠ 乗換に間に合わない可能性</span>');
    }
    return badges;
  }

  function journeyFareText(journey) {
    if (journey.fare.unknown) return '運賃不明';
    return `${yen(journey.fare.total)}${journey.fare.partial ? '〜（一部不明）' : ''}`;
  }

  /** 一覧で乗車する路線をひと目で分かるようにするチップ列（路線カラー・徒歩は分数のみ）。 */
  function journeyRouteChips(journey) {
    return journey.legs
      .map((leg) => (
        leg.type === 'walk'
          ? `<span class="text-[10px] font-bold text-gray-400 shrink-0">徒歩${leg.walkMinutes}分</span>`
          : routeChip(leg)
      ))
      .join('<span class="text-[10px] text-gray-300 shrink-0">›</span>');
  }

  /**
   * 経路一覧の1件。出発／到着時刻・所要時間・運賃・乗換回数・徒歩・おすすめ・直通と
   * 路線カラーのバーだけのシンプル表示にして、タップで詳細（乗り換え時刻など）へ送る。
   */
  function renderJourneyListItem(journey, index) {
    return `
      <button type="button" data-role="rs-open-journey" data-index="${index}"
              class="w-full text-left bg-white rounded-2xl shadow-sm border-2 ${journey.isRecommended ? 'border-amber-300' : 'border-gray-100'} p-4 hover:border-purple-300 active:scale-[0.99] transition-all">
        <div class="flex flex-wrap gap-1 mb-2">${journeyBadges(journey).join(' ')}</div>
        <div class="flex items-end flex-wrap gap-x-2 gap-y-1">
          <span class="text-xl font-bold text-gray-900">${esc(timeWithDay(journey.departureTime, journey.departureDayOffset))}</span>
          <span class="text-sm text-gray-400">→</span>
          <span class="text-xl font-bold text-purple-700">${esc(timeWithDay(journey.arrivalTime, journey.arrivalDayOffset))}</span>
          <span class="text-xs font-bold text-gray-500">${journey.durationMinutes}分</span>
          <span class="ml-auto text-base font-bold text-gray-900">${esc(journeyFareText(journey))}</span>
        </div>
        ${renderDurationBar(journey)}
        <div class="flex items-center flex-wrap gap-1.5 mt-2">
          ${journeyRouteChips(journey)}
          <span class="ml-auto text-[11px] font-bold text-purple-700 shrink-0">詳細 ›</span>
        </div>
      </button>
    `;
  }

  /* ---------- 経路詳細（一覧でタップした1件） ---------- */
  /** 乗り換え時刻・通過バス停・リアルタイム・便詳細への導線はこの画面に置く。 */
  function renderJourneyDetail(result, journey, index) {
    const total = result.journeys.length;
    const prev = index > 0 ? result.journeys[index - 1] : null;
    const next = index < total - 1 ? result.journeys[index + 1] : null;
    const navButtonClass = 'flex-1 bg-white border-2 border-purple-200 text-purple-700 rounded-xl px-3 py-3 text-xs font-bold hover:bg-purple-50 active:scale-95 transition-all';

    const navHtml = prev || next
      ? `<div class="flex gap-2 mt-4">
           ${prev ? `<button type="button" data-role="rs-open-journey" data-index="${index - 1}" class="${navButtonClass}">‹ 前の経路（${esc(timeWithDay(prev.departureTime, prev.departureDayOffset))}発）</button>` : ''}
           ${next ? `<button type="button" data-role="rs-open-journey" data-index="${index + 1}" class="${navButtonClass}">次の経路（${esc(timeWithDay(next.departureTime, next.departureDayOffset))}発）›</button>` : ''}
         </div>`
      : '';

    return `
      <div class="bg-white rounded-2xl shadow-sm border-2 border-gray-100 p-4 mb-4">
        <p class="text-sm font-bold text-gray-900">${endpointHeadingHtml(result)}</p>
        <p class="text-xs font-bold text-gray-500 mt-1">
          ${esc(formatDateLabel(result.date))} ${esc(baseTimeLabel(result))} ／ ${total}件中${index + 1}件目
        </p>
        ${preferenceNoticeHtml(result.preferences)}
      </div>
      <article class="bg-white rounded-2xl shadow-sm border-2 ${journey.isRecommended ? 'border-amber-300' : 'border-gray-100'} overflow-hidden">
        <div class="px-4 pt-4 pb-3 border-b border-gray-100">
          <div class="flex flex-wrap gap-1 mb-2">${journeyBadges(journey).join(' ')}</div>
          <div class="flex items-end flex-wrap gap-x-3 gap-y-1">
            <span class="text-2xl font-bold text-gray-900">${esc(timeWithDay(journey.departureTime, journey.departureDayOffset))}</span>
            <span class="text-gray-400">→</span>
            <span class="text-2xl font-bold text-purple-700">${esc(timeWithDay(journey.arrivalTime, journey.arrivalDayOffset))}</span>
            <span class="text-sm font-bold text-gray-500">${journey.durationMinutes}分</span>
            <span class="ml-auto text-lg font-bold text-gray-900">${esc(journeyFareText(journey))}</span>
          </div>
          ${renderDurationBar(journey)}
        </div>
        <div class="p-4">
          ${renderTimeline(journey, index)}
        </div>
      </article>
      ${navHtml}
      <p class="text-[11px] text-gray-500 font-bold mt-4 px-1">
        運賃・時刻はGTFSデータに基づく目安です。実際の運賃・ダイヤは事業者にご確認ください。
      </p>
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
    const timeLines = [];
    if (options.arrivalTime) {
      timeLines.push(`<div><span class="font-bold text-gray-900">${esc(timeWithDay(options.arrivalTime, options.arrivalDayOffset))}</span><span class="text-[10px] text-gray-500 ml-0.5">着</span></div>`);
    }
    if (options.departureTime) {
      timeLines.push(`<div><span class="font-bold text-gray-900">${esc(timeWithDay(options.departureTime, options.departureDayOffset))}</span><span class="text-[10px] text-gray-500 ml-0.5">発</span></div>`);
    }
    // リアルタイム予測が定刻と違うときだけ添える
    if (options.predicted && options.predicted !== options.arrivalTime && options.predicted !== options.departureTime) {
      timeLines.push(`<div><span class="font-bold text-green-700">予測 ${esc(options.predicted)}</span></div>`);
    }

    // 出発地/目的地が観光スポットのとき、タイムライン側のスポット名をタップ可能にする（観光スポット情報_仕様書）。
    const link = stop.spotId
      ? spotNameButtonHtml(stop)
      : stop.busstopUrl
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
          <div class="flex flex-col text-sm">${timeLines.join('')}</div>
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

    const transferRiskHtml = leg.transferRisk
      ? `<div class="text-[11px] font-bold text-red-800 bg-red-50 border border-red-200 rounded-lg px-2 py-1 mt-2">
           ⚠ ${esc(leg.transferRisk.atStopName)}での乗り換えは、遅延の影響で約${leg.transferRisk.shortByMinutes}分間に合わない見込みです
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
          ${transferRiskHtml}
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
    const suggestionLabels = {
      'first-bus': (s) => `この日の始発（${s.time}）で検索`,
      'first-arrival': (s) => `この日の最も早い到着（${s.time}）で検索`,
      'next-service-day': (s) => `次の運行日（${formatDateLabel(s.date)}）で検索`
    };
    const suggestionLabel = result.suggestion
      ? (suggestionLabels[result.suggestion.kind] || suggestionLabels['next-service-day'])(result.suggestion)
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

    // 詳細設定が原因で0件だったとき（サーバー側で「設定を外せば見つかる」と判定済み）。
    // 日付・時刻を変えさせるより、設定を外す導線を出す方が正しい案内になる。
    const clearPreferencesButton = result.canRelaxPreferences
      ? `<button type="button" data-role="rs-clear-preferences"
                 class="mt-3 w-full bg-purple-600 text-white py-3 rounded-xl font-bold shadow hover:bg-purple-700 active:scale-95 transition-all">
           詳細設定を解除して検索
         </button>`
      : '';

    return `
      <div class="bg-yellow-50 border-2 border-yellow-300 rounded-2xl p-5">
        <p class="text-sm font-bold text-yellow-900">${esc(result.message || '経路が見つかりませんでした。')}</p>
        ${result.from && result.to ? `<p class="text-xs font-bold text-yellow-800 mt-2">${esc(result.from.name)} → ${esc(result.to.name)}（${esc(formatDateLabel(result.date))} ${esc(baseTimeLabel(result))}）</p>` : ''}
        ${preferenceNoticeHtml(result.preferences)}
        ${clearPreferencesButton}
        ${suggestionButton}
        ${alternatives}
        ${suggestions}
      </div>
    `;
  }

  /**
   * 経路詳細の「経路一覧へ戻る」。一覧→詳細はpushStateなので、通常はブラウザの戻ると
   * 同じ動き（一覧のスクロール位置・検索フォームの入力がそのまま戻る）にする。
   * 詳細URLを直接開いた・リロードした場合だけ一覧URLへ遷移する（smartBackの判定）。
   */
  function bindBackToList(scope, state) {
    const button = scope.querySelector('[data-role="rs-back-to-list"]');
    if (!button) return;
    button.addEventListener('click', () => {
      const listUrl = buildUrl({ ...state, journeyIndex: null });
      if (typeof window.smartBack === 'function') window.smartBack(listUrl);
      else navigate(listUrl);
    });
  }

  /* ---------- 結果内の操作 ---------- */
  function bindResultEvents(container, state) {
    paintFavRow(state);

    container.querySelectorAll('[data-role="rs-spot-name"]').forEach((button) => {
      button.addEventListener('click', () => openSpotModal(button.dataset.spotId));
    });

    // 一覧のカード（＝詳細を開く）と、詳細内の「前の経路／次の経路」。
    // 詳細から詳細への移動だけは履歴を積まない（戻るで必ず一覧に帰れるようにする）。
    container.querySelectorAll('[data-role="rs-open-journey"]').forEach((button) => {
      button.addEventListener('click', () => {
        navigate(
          buildUrl({ ...state, journeyIndex: Number(button.dataset.index) }),
          { replace: state.journeyIndex !== null }
        );
      });
    });

    // 一覧の「1本前 / 1本後」。先頭経路を基準に1本ぶんずらして検索し直す（pushState＝戻るで元の結果へ）。
    container.querySelectorAll('[data-role="rs-nudge"]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = nudgeTarget(lastResult, button.dataset.dir);
        if (!target) return;
        navigate(buildUrl({ ...state, journeyIndex: null, ...target }));
      });
    });

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

    const clearPreferencesButton = container.querySelector('[data-role="rs-clear-preferences"]');
    if (clearPreferencesButton) {
      clearPreferencesButton.addEventListener('click', () => {
        navigate(buildUrl({ ...state, journeyIndex: null, ...PREFERENCE_DEFAULTS }));
      });
    }

    const suggestionButton = container.querySelector('[data-role="rs-apply-suggestion"]');
    if (suggestionButton) {
      suggestionButton.addEventListener('click', () => {
        // 条件を変えた再検索なので、開いていた経路（journey）は必ず外して一覧から始める
        navigate(buildUrl({
          ...state, journeyIndex: null, date: suggestionButton.dataset.date, time: suggestionButton.dataset.time
        }));
      });
    }

    container.querySelectorAll('[data-role="rs-use-stop"]').forEach((button) => {
      button.addEventListener('click', () => {
        // 見つからなかった側（目的地優先）を、提示したバス停に置き換えて再検索する
        const next = { ...state, journeyIndex: null };
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
