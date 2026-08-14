/* ==========================================================
 * お気に入り機能（共通モジュール／localStorage連携）
 *
 * バス路線・ルート検索・便・時刻表・バス停（すべての乗り場／乗り場別の両方）を
 * 同じ仕組みで登録できるようにする。各画面（app.js・busstop.js・timetable.js・
 * routesearch.js）はここが提供する starButtonHtml() でボタンを描画するだけでよく、
 * トグル処理・永続化・ボタンの見た目更新は本ファイルに一本化する。
 *
 * お気に入り1件は { id, type, title, subtitle, url, addedAt } の形。
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
              aria-pressed="${active}" title="${active ? 'お気に入り解除' : 'お気に入りに登録'}">${starIconSvg(active)}</button>`;
  }

  function applyButtonState(btn, active) {
    btn.setAttribute('aria-pressed', String(active));
    btn.title = active ? 'お気に入り解除' : 'お気に入りに登録';
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

  window.Favorites = { list, get, add, remove, toggle, isFavorite, starButtonHtml };
})();
