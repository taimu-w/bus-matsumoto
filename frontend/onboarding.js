/* ==========================================================
 * はじめての方向けチュートリアル（オンボーディング）
 *
 * - 初回訪問時（localStorage に完了フラグが無い）に、ホーム画面でだけ自動表示する。
 *   /timetable などにディープリンクで入ってきたときは邪魔しない。
 * - howto.html などからは /?tutorial=1 で明示的に開ける（完了後も見直せる）。
 * - 「スキップ」または最後まで進むと完了フラグを立て、次回以降は自動表示しない。
 * - モーダルの開閉は index.html の他モーダルと同様に style.display のみで制御する。
 *
 * index.html の #onboarding マークアップと対になっている（app.js より前に読み込む）。
 * ========================================================== */
(function () {
  // 内容を大きく変えたときはこの値を上げると、既存の利用者にも一度だけ再表示される。
  const SEEN_KEY = 'busTimeOnboardingSeen';
  const SEEN_VALUE = '1';

  const SVG_BUS =
    '<svg class="w-9 h-9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18,11H6V6h12M16.5,17A1.5,1.5 0 0,1 15,15.5A1.5,1.5 0 0,1 16.5,14A1.5,1.5 0 0,1 18,15.5A1.5,1.5 0 0,1 16.5,17M7.5,17A1.5,1.5 0 0,1 6,15.5A1.5,1.5 0 0,1 7.5,14A1.5,1.5 0 0,1 9,15.5A1.5,1.5 0 0,1 7.5,17M4,16c0,0.88 0.39,1.67 1,2.22V20a1,1 0 0,0 1,1h1a1,1 0 0,0 1-1v-1h8v1a1,1 0 0,0 1,1h1a1,1 0 0,0 1-1v-1.78c0.61-0.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8,0.5-8,4V16Z"/></svg>';
  const SVG_ROUTE =
    '<svg class="w-9 h-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6.5" r="2.25"/><circle cx="18" cy="17.5" r="2.25"/><path d="M7.6 8 16.4 16" stroke-dasharray="2.4 2.6"/></svg>';
  const SVG_CLOCK =
    '<svg class="w-9 h-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M12 7.5V12l3 2"/></svg>';
  const SVG_STAR =
    '<svg class="w-9 h-9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.7-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.7 1.1-5.9-4.3-4.1 5.9-.7L12 3.5z"/></svg>';

  const SLIDES = [
    {
      badge: 'はじめての方へ',
      title: 'バスタイムへようこそ',
      body: '松本市内の路線バスが「いま どこ？」「あと 何分？」がひと目でわかるサイトです。よく使う機能をかんたんに紹介します。',
      svg: SVG_BUS, wrap: 'bg-blue-50', fg: 'text-blue-700'
    },
    {
      badge: 'リアルタイム運行情報',
      title: '走っているバスの位置と遅れ',
      body: '路線を選ぶと、運行中のバスの現在地と遅れ具合が表示されます。バスやバス停をタップすると、停留所ごとの到着予測も確認できます。',
      svg: SVG_BUS, wrap: 'bg-blue-50', fg: 'text-blue-700'
    },
    {
      badge: '経路検索',
      title: '行き先までの行き方を調べる',
      body: '出発地と目的地を入れるだけで、乗るバス・乗り換え・所要時間・運賃を案内します。当日の検索なら、遅れも反映されます。',
      svg: SVG_ROUTE, wrap: 'bg-blue-50', fg: 'text-blue-700'
    },
    {
      badge: '時刻表・バス停・スポット',
      title: '発車時刻と近くのバス停',
      body: '「時刻表検索」でバス停ごとの発車時刻を、「バス停検索」や「マップ」で近くのバス停や乗り場を探せます。「スポット検索」なら観光地や施設の名前から、付近を通る路線とバス停を調べられます。',
      svg: SVG_CLOCK, wrap: 'bg-blue-50', fg: 'text-blue-700'
    },
    {
      badge: '便利な使い方',
      title: 'お気に入りと自動更新',
      body: '★ボタンでよく使う路線・バス停・経路を登録すると、次からすぐ開けます。画面は自動で更新されます（右上のボタンでON/OFF）。',
      svg: SVG_STAR, wrap: 'bg-amber-50', fg: 'text-amber-600'
    }
  ];

  let root = null;
  let idx = 0;

  function hasSeen() {
    try { return localStorage.getItem(SEEN_KEY) === SEEN_VALUE; } catch (e) { return false; }
  }

  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, SEEN_VALUE); } catch (e) { /* プライベートモード等では記録しない */ }
  }

  function renderSlide() {
    const s = SLIDES[idx];
    const isLast = idx === SLIDES.length - 1;

    root.querySelector('[data-role="ob-slide"]').innerHTML = `
      <div class="w-20 h-20 mx-auto rounded-2xl flex items-center justify-center ${s.wrap} ${s.fg}">${s.svg}</div>
      <p class="text-[11px] font-black tracking-widest ${s.fg} uppercase mt-4">${s.badge}</p>
      <h3 id="onboarding-title" class="text-xl font-black text-gray-900 mt-1 leading-snug">${s.title}</h3>
      <p class="text-sm text-gray-600 leading-relaxed mt-2">${s.body}</p>
      ${isLast ? '<p class="text-[11px] text-gray-400 mt-4">この案内は「使い方」ページからいつでも見直せます。</p>' : ''}
    `;

    root.querySelector('[data-role="ob-dots"]').innerHTML = SLIDES
      .map((_, i) => `<span class="h-1.5 rounded-full transition-all ${i === idx ? 'w-5 bg-blue-700' : 'w-1.5 bg-gray-300'}"></span>`)
      .join('');

    const prevBtn = root.querySelector('[data-role="ob-prev"]');
    const nextBtn = root.querySelector('[data-role="ob-next"]');
    prevBtn.style.visibility = idx === 0 ? 'hidden' : 'visible';
    nextBtn.textContent = isLast ? 'はじめる' : '次へ';
  }

  function cleanUrl() {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('tutorial')) {
        url.searchParams.delete('tutorial');
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
      }
    } catch (e) { /* 失敗しても実害はない */ }
  }

  function open() {
    if (!root) return;
    idx = 0;
    renderSlide();
    root.style.display = 'flex';
    document.addEventListener('keydown', onKey);
  }

  function finish() {
    if (!root) return;
    root.style.display = 'none';
    document.removeEventListener('keydown', onKey);
    markSeen();
    cleanUrl();
  }

  function next() {
    if (idx < SLIDES.length - 1) { idx += 1; renderSlide(); }
    else { finish(); }
  }

  function prev() {
    if (idx > 0) { idx -= 1; renderSlide(); }
  }

  function onKey(e) {
    if (e.key === 'Escape') finish();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
  }

  function shouldAutoStart() {
    let params = null;
    try { params = new URLSearchParams(window.location.search); } catch (e) { /* noop */ }
    if (params && params.get('tutorial') === '1') return true;
    if (hasSeen()) return false;
    // 初回でも、ホーム以外（/timetable などのディープリンク）では自動表示しない。
    const h = window.location.hash;
    return window.location.pathname === '/' && (h === '' || h === '#' || h === '#/');
  }

  function init() {
    root = document.getElementById('onboarding');
    if (!root) return;
    root.querySelector('[data-role="ob-skip"]').addEventListener('click', finish);
    root.querySelector('[data-role="ob-prev"]').addEventListener('click', prev);
    root.querySelector('[data-role="ob-next"]').addEventListener('click', next);
    if (shouldAutoStart()) open();
  }

  // 「使い方」ページなどから明示的に開けるよう公開する。
  window.Onboarding = { open, close: finish };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
