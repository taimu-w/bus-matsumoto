/* ==========================================================
 * 観光スポットの写真表示（共通モジュール／カルーセル）
 *
 * バス停ページの周辺観光スポット（busstop.js）・経路検索のスポット詳細ポップアップ
 * （routesearch.js）・スポット検索のスポット情報カード（spotsearch.js）は、いずれも
 * ここが提供する SpotPhotos.markup(spot, opts) でHTMLを描画し、DOMへ挿入したあとに
 * SpotPhotos.hydrate(scope) を呼ぶだけでよい。
 *
 * 仕様:
 *   - 1回に表示するのは1枚だけ（従来は横スクロールで複数枚を並べていた）。
 *   - 写真が2枚以上あるときだけ 5秒間隔で次の写真へ自動送りする。
 *   - スワイプ／左右の矢印ボタン／下部インジケーターで手動切り替えできる。
 *   - 自動送りは「画面内に見えている」「タブがアクティブ」「操作中でない」ときだけ進む。
 *     手動操作の直後は次の自動送りまで5秒の間隔を置き直す。
 *   - prefers-reduced-motion のときは自動送りしない（手動操作は可能）。
 *   - 写真が1枚だけのときは従来どおり全幅の静止画で、操作要素は出さない。
 *
 * 自動送りは「1本の共有タイマー＋レジストリ」で回す。DOMから外れたカルーセルは
 * タイマーの各tickで検出して登録解除するため、画面の再描画でタイマーが漏れ残らない。
 * ========================================================== */
(function () {
  const AUTOPLAY_MS = 5000;
  const TICK_MS = 1000;
  const SWIPE_THRESHOLD_PX = 40;
  const READY_ATTR = 'data-spot-carousel-ready';

  const prefersReducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function photoList(spot) {
    const photos = spot && Array.isArray(spot.photoUrls) ? spot.photoUrls : [];
    return photos.filter((u) => typeof u === 'string' && u.trim() !== '');
  }

  /**
   * @param {object} spot  photoUrls（配列）と name を持つスポット
   * @param {object} [opts]
   * @param {string} [opts.height]     スライドの高さ（CSS長さ。既定 '10rem'）
   * @param {string} [opts.wrapClass]  ルート要素へ足すクラス（角丸・余白など）
   * @returns {string} HTML（写真が無ければ空文字）
   */
  function markup(spot, opts) {
    const options = opts || {};
    const photos = photoList(spot);
    if (photos.length === 0) return '';

    const height = options.height || '10rem';
    const wrapClass = options.wrapClass ? ` ${options.wrapClass}` : '';
    const name = spot && spot.name ? String(spot.name) : '';
    const styleAttr = ` style="--spot-carousel-h:${esc(height)}"`;

    // 1枚だけなら従来どおり全幅の静止画（操作要素なし）。
    if (photos.length === 1) {
      return (
        `<div class="spot-carousel spot-carousel--single${wrapClass}"${styleAttr}>` +
        `<img class="spot-carousel-slide" src="${esc(photos[0])}" alt="${esc(name)}" loading="lazy" draggable="false">` +
        '</div>'
      );
    }

    const slides = photos
      .map(
        (url, i) =>
          `<img class="spot-carousel-slide" src="${esc(url)}" alt="${esc(name)}（${i + 1}/${photos.length}）"` +
          `${i === 0 ? '' : ' loading="lazy"'} draggable="false">`
      )
      .join('');

    const dots = photos
      .map(
        (_, i) =>
          `<button type="button" class="spot-carousel-dot${i === 0 ? ' is-active' : ''}" ` +
          `data-spot-carousel-goto="${i}" aria-label="${i + 1}枚目を表示"></button>`
      )
      .join('');

    const prevIcon =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
    const nextIcon =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

    return (
      `<div class="spot-carousel${wrapClass}"${styleAttr} data-spot-carousel ` +
      `role="group" aria-roledescription="カルーセル"${name ? ` aria-label="${esc(name)}の写真"` : ''}>` +
      `<div class="spot-carousel-viewport"><div class="spot-carousel-track">${slides}</div></div>` +
      `<button type="button" class="spot-carousel-nav spot-carousel-prev" data-spot-carousel-dir="-1" aria-label="前の写真">${prevIcon}</button>` +
      `<button type="button" class="spot-carousel-nav spot-carousel-next" data-spot-carousel-dir="1" aria-label="次の写真">${nextIcon}</button>` +
      `<div class="spot-carousel-dots">${dots}</div>` +
      '</div>'
    );
  }

  /* ---------- 自動送り用の共有タイマー ---------- */
  const registry = [];
  let sharedTimer = null;

  function startSharedTimer() {
    if (sharedTimer !== null) return;
    sharedTimer = window.setInterval(tickAll, TICK_MS);
  }

  function tickAll() {
    const now = Date.now();
    for (let i = registry.length - 1; i >= 0; i -= 1) {
      const c = registry[i];
      if (!c.root.isConnected) {
        c.dispose();
        registry.splice(i, 1);
        continue;
      }
      if (document.hidden || !c.visible || c.isHeld()) continue;
      if (now - c.lastInteraction >= AUTOPLAY_MS) {
        c.go(c.index + 1);
        c.lastInteraction = now;
      }
    }
    if (registry.length === 0 && sharedTimer !== null) {
      window.clearInterval(sharedTimer);
      sharedTimer = null;
    }
  }

  /* ---------- 1つのカルーセルの初期化 ---------- */
  function setup(root) {
    if (!root || root.hasAttribute(READY_ATTR)) return;
    root.setAttribute(READY_ATTR, '');

    const track = root.querySelector('.spot-carousel-track');
    const slides = Array.prototype.slice.call(root.querySelectorAll('.spot-carousel-slide'));
    const dots = Array.prototype.slice.call(root.querySelectorAll('.spot-carousel-dot'));
    const count = slides.length;
    if (!track || count <= 1) return;

    // 自動送りを止める要因（マウスホバー・ポインタ押下・キーボードフォーカス）。
    // どれか1つでも立っていれば止める。1本のフラグで set/clear すると
    // 「押下中なのに pointerleave で解除」といった取りこぼしが起きるため分けて持つ。
    const hold = { hover: false, press: false, focus: false };

    const state = {
      root,
      index: 0,
      visible: true,
      lastInteraction: Date.now(),
      isHeld: () => hold.hover || hold.press || hold.focus,
      go: goTo,
      dispose: dispose
    };

    function render() {
      track.style.transform = `translateX(-${state.index * 100}%)`;
      dots.forEach((dot, i) => {
        const active = i === state.index;
        dot.classList.toggle('is-active', active);
        if (active) dot.setAttribute('aria-current', 'true');
        else dot.removeAttribute('aria-current');
      });
    }

    function goTo(to) {
      state.index = ((to % count) + count) % count;
      render();
    }

    // 手動操作: 位置を進め、次の自動送りまでの間隔を置き直す。
    function step(delta) {
      goTo(state.index + delta);
      state.lastInteraction = Date.now();
    }

    root.querySelectorAll('[data-spot-carousel-dir]').forEach((btn) => {
      btn.addEventListener('click', () => step(Number(btn.dataset.spotCarouselDir) || 1));
    });
    dots.forEach((dot, i) => {
      dot.addEventListener('click', () => {
        goTo(i);
        state.lastInteraction = Date.now();
      });
    });

    // スワイプ（指を離した時点の移動量で判定。ドラッグ追従はしない）。
    // ポインタ捕捉（setPointerCapture）は使わない。矢印・ドットの click をルート側へ
    // 奪ってしまう実装差があるため。代わりにジェスチャ中だけ window で pointerup を拾い、
    // 要素外で指を離しても取りこぼさないようにする。
    let startX = 0;
    let startY = 0;
    let activePointerId = null;

    function endPointer(e) {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      window.removeEventListener('pointerup', endPointer);
      window.removeEventListener('pointercancel', endPointer);
      activePointerId = null;
      hold.press = false;
      state.lastInteraction = Date.now();
      if (e.type !== 'pointerup') return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
        step(dx < 0 ? 1 : -1);
      }
    }

    root.addEventListener(
      'pointerdown',
      (e) => {
        if (activePointerId !== null) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        activePointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        hold.press = true;
        window.addEventListener('pointerup', endPointer, { passive: true });
        window.addEventListener('pointercancel', endPointer, { passive: true });
      },
      { passive: true }
    );

    // デスクトップのマウスホバー中・キーボードフォーカス中は自動送りを止める
    // （タッチ操作で pointerleave が来ない端末で止まりっぱなしにならないよう mouse のみ）。
    root.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') hold.hover = true;
    });
    root.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') hold.hover = false;
    });
    root.addEventListener('focusin', () => {
      hold.focus = true;
    });
    root.addEventListener('focusout', () => {
      hold.focus = false;
    });

    let observer = null;
    function dispose() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (activePointerId !== null) {
        window.removeEventListener('pointerup', endPointer);
        window.removeEventListener('pointercancel', endPointer);
        activePointerId = null;
      }
    }

    render();

    // prefers-reduced-motion のときは自動送りせず、手動操作だけ受け付ける。
    if (prefersReducedMotion) return;

    // 画面内に見えているときだけ自動送りする。
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            state.visible = entry.isIntersecting;
            if (entry.isIntersecting) state.lastInteraction = Date.now();
          });
        },
        { threshold: 0.35 }
      );
      observer.observe(root);
    }

    registry.push(state);
    startSharedTimer();
  }

  /**
   * scope 配下の未初期化カルーセルを初期化する。DOMへ挿入した直後に呼ぶ。
   * @param {ParentNode} [scope]
   */
  function hydrate(scope) {
    const targets = (scope || document).querySelectorAll(`[data-spot-carousel]:not([${READY_ATTR}])`);
    Array.prototype.forEach.call(targets, setup);
  }

  window.SpotPhotos = { markup, hydrate };
})();
