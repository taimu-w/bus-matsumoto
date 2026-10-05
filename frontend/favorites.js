/* ==========================================================
 * お気に入り機能（共通モジュール／localStorage連携）
 *
 * バス路線・ルート検索・便・時刻表・バス停（すべての乗り場／乗り場別の両方）を
 * 同じ仕組みで登録できるようにする。各画面（app.js・busstop.js・timetable.js・
 * routesearch.js）はここが提供する starButtonHtml() でボタンを描画するだけでよく、
 * トグル処理・永続化・ボタンの見た目更新は本ファイルに一本化する。
 *
 * お気に入り1件は { id, type, title, subtitle, url, addedAt, titleI18n?, subtitleI18n? } の形。
 * - title / subtitle: 登録時点の日本語の表示文字列（日本語表示ではこれをそのまま出す）。
 * - titleI18n / subtitleI18n（任意）: 日本語以外で表示するときの組み立て方（docs/i18n.md）。
 *   [種別, ...] の配列を並べたもので、種別は
 *     ['name', 日本語名, kind]  … バス停名・路線名などの固有名詞（I18n.nameHtml で訳＋日本語併記）
 *     ['t', 文言キー, params]   … UI文言（params の値にも ['name', …] を入れられる）
 *     ['s', 文字列]             … そのまま出す文字列
 *   無い場合（単純な名前だけのお気に入り・この仕組みより前に登録したもの）は、
 *   title を固有名詞として、subtitle をUI文言として訳せるだけ訳す。
 * - id: 種別ごとに一意な文字列（例: "busstop|{stopKey}|{platform}"）。
 *   同じ対象を指すidで登録し直すと addedAt を保った上で内容だけ更新する（名前変更等に利用）。
 * - url: タップ時の遷移先。ハッシュ（#/realtime/...）とパス（/busstop/...）の
 *   どちらもあり得るため、遷移側（app.jsのgoToFavoriteUrl）で振り分ける。
 * ========================================================== */
(function () {
  const STORAGE_KEY = 'busTimeFavoritesV2';

  function escAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function list() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return [];
    }
  }

  function saveAll(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  function isFavorite(id) {
    return list().some((item) => item.id === id);
  }

  function get(id) {
    return list().find((item) => item.id === id) || null;
  }

  /** 登録・更新（同じidが既にあれば addedAt を保ったまま内容を上書きする＝名前変更などに使う）。 */
  function add(fav) {
    const items = list();
    const idx = items.findIndex((item) => item.id === fav.id);
    if (idx >= 0) {
      items[idx] = { ...items[idx], ...fav };
    } else {
      items.unshift({ ...fav, addedAt: Date.now() });
    }
    saveAll(items);
  }

  function remove(id) {
    saveAll(list().filter((item) => item.id !== id));
  }

  /** 既に登録済みなら解除、未登録なら登録する。登録後の状態（true/false）を返す。 */
  function toggle(fav) {
    if (isFavorite(fav.id)) {
      remove(fav.id);
      return false;
    }
    add(fav);
    return true;
  }

  /**
   * お気に入り登録済みバス停のstopKey一覧（重複なし・登録が新しい順）。
   * type 'busstop'（バス停検索）・'timetable'（時刻表検索）どちらも対象。
   * id は "busstop|{stopKey}|{platformId}" 形式（platformIdは「すべての乗り場」なら空文字）
   * なので、特定の乗り場のみお気に入りでもstopKey単位で1件にまとめる
   * （経路検索・バス停検索の候補には常に「すべての乗り場」として出す）。
   */
  function favoriteBusStopKeys() {
    const keys = [];
    const seen = new Set();
    list().forEach((item) => {
      if (item.type !== 'busstop' && item.type !== 'timetable') return;
      const stopKey = String(item.id).split('|')[1];
      if (!stopKey || seen.has(stopKey)) return;
      seen.add(stopKey);
      keys.push(stopKey);
    });
    return keys;
  }

  /* ---------- 表示言語に合わせた題名・副題 ---------- */
  function renderSegment(seg, html) {
    const I = window.I18n;
    if (!Array.isArray(seg)) return html ? I.escapeHtml(seg) : String(seg);
    const [type, a, b] = seg;
    if (type === 'name') return html ? I.nameHtml(a, b) : I.nameText(a, b);
    if (type === 't') {
      const params = {};
      Object.keys(b || {}).forEach((key) => {
        const v = b[key];
        params[key] = typeof v === 'number' ? v : renderSegment(v, html);
      });
      return html ? I.tHtml(a, params) : I.t(a, params);
    }
    return html ? I.escapeHtml(a) : String(a === undefined ? '' : a);
  }

  function renderSpec(spec, html) {
    return spec.map((seg) => renderSegment(seg, html)).join('');
  }

  /** お気に入り一覧の題名（HTML）。 */
  function titleHtml(fav) {
    const I = window.I18n;
    if (!I || I.isJa) return escAttr(fav.title || '');
    if (Array.isArray(fav.titleI18n)) return renderSpec(fav.titleI18n, true);
    return I.nameHtml(fav.title || '', 'any');
  }

  /** お気に入り一覧の副題（HTML）。 */
  function subtitleHtml(fav) {
    const I = window.I18n;
    if (!I || I.isJa) return escAttr(fav.subtitle || '');
    if (Array.isArray(fav.subtitleI18n)) return renderSpec(fav.subtitleI18n, true);
    const subtitle = fav.subtitle || '';
    return I.has(subtitle) ? I.escapeHtml(I.t(subtitle)) : I.nameHtml(subtitle, 'any');
  }

  function starTitle(active) {
    const t = window.I18n ? window.I18n.t : (s) => s;
    return active ? t('お気に入り解除') : t('お気に入りに登録');
  }

  function starIconSvg(active) {
    const path = 'M12 3.5l2.6 5.4 5.9.7-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.7 1.1-5.9-4.3-4.1 5.9-.7L12 3.5z';
    return active
      ? `<svg viewBox="0 0 24 24" class="w-full h-full" fill="#f59e0b" stroke="#f59e0b" stroke-width="1.3" stroke-linejoin="round"><path d="${path}"/></svg>`
      : `<svg viewBox="0 0 24 24" class="w-full h-full" fill="none" stroke="#94a3b8" stroke-width="1.8" stroke-linejoin="round"><path d="${path}"/></svg>`;
  }

  /**
   * トグル式のお気に入り★ボタンのHTMLを返す（バス路線・便・時刻表・バス停の各画面で使う）。
   * favにはid/type/title/subtitle/urlを渡す（addedAtは不要、add()側で付与する）。
   */
  function starButtonHtml(fav, { size = 'w-10 h-10', extraClass = '' } = {}) {
    const active = isFavorite(fav.id);
    return `<button type="button" data-fav-star data-fav="${escAttr(JSON.stringify(fav))}"
              class="${size} shrink-0 flex items-center justify-center rounded-full border-2 p-1.5 transition-all active:scale-90 ${active ? 'bg-amber-50 border-amber-300' : 'bg-white border-gray-200'} ${extraClass}"
              aria-pressed="${active}" title="${escAttr(starTitle(active))}">${starIconSvg(active)}</button>`;
  }

  function applyButtonState(btn, active) {
    btn.setAttribute('aria-pressed', String(active));
    btn.title = starTitle(active);
    btn.classList.toggle('bg-amber-50', active);
    btn.classList.toggle('border-amber-300', active);
    btn.classList.toggle('bg-white', !active);
    btn.classList.toggle('border-gray-200', !active);
    btn.innerHTML = starIconSvg(active);
  }

  // starButtonHtml()で描画したボタン全てに委任リスナーで対応する（動的に挿入されるDOMのため）。
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-fav-star]');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    let fav;
    try {
      fav = JSON.parse(btn.dataset.fav);
    } catch (err) {
      return;
    }
    const active = toggle(fav);
    applyButtonState(btn, active);
    if (typeof window.onFavoritesChanged === 'function') window.onFavoritesChanged();
  });

  window.Favorites = { list, get, add, remove, toggle, isFavorite, starButtonHtml, favoriteBusStopKeys, titleHtml, subtitleHtml };
})();
