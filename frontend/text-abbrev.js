// 系統名・行き先などの表示テキストに対する略称の適用（管理画面「表示略称設定」で編集）。
//
// バスマップのバスラベル・バス停時刻表・接近中のバスパネルは、表示領域の幅が固定のため
// 長い行き先テキストがCSSの省略記号（…）で中途半端に切れることがある。ここでは、
// 実際にはみ出しているとき（scrollWidth > clientWidth）だけ、対応する略称に置き換える。
// はみ出していない場合や、該当する略称が無い場合は何もしない（＝これまで通りの表示）。
//
// 辞書（GET /api/display-abbreviations）はページ内で一度だけ取得してメモリに持つ
// （frontend/admin-core.js の getRoutesList() と同じ「読んだら使い回す」方式）。
(function () {
  let cache = null; // [{ original, abbreviation }, ...]（original文字数の降順）
  let loadPromise = null;

  async function load() {
    if (cache) return cache;
    if (!loadPromise) {
      loadPromise = fetch('/api/display-abbreviations')
        .then((res) => (res.ok ? res.json() : { abbreviations: [] }))
        .then((data) => {
          cache = Array.isArray(data.abbreviations) ? data.abbreviations : [];
        })
        .catch(() => {
          cache = [];
        });
    }
    await loadPromise;
    return cache;
  }

  // 同期関数。キャッシュ未ロード時・辞書が空のときは text をそのまま返す（安全側フォールバック）。
  function apply(text) {
    if (!text || !cache || cache.length === 0) return text;
    let result = text;
    for (const { original, abbreviation } of cache) {
      if (original && result.includes(original)) {
        result = result.split(original).join(abbreviation);
      }
    }
    return result;
  }

  // root配下の [data-abbrev-fit] 要素のうち、実際にはみ出しているものだけを略称表示に切り替える。
  // CSSの省略記号（ellipsis）はそのまま残すため、略称を適用してもなおはみ出す場合はellipsisが効く。
  function fitAll(root) {
    if (!cache || cache.length === 0) return;
    const scope = root || document;
    const targets = scope.querySelectorAll ? scope.querySelectorAll('[data-abbrev-fit]') : [];
    targets.forEach((el) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const fullText = el.textContent;
      const abbreviated = apply(fullText);
      if (abbreviated !== fullText) {
        el.textContent = abbreviated;
      }
    });
  }

  window.TextAbbrev = { load, apply, fitAll };

  // ページ読み込み時に一度だけ取得しておく。各描画関数は自分の描画直後に fitAll() を
  // 呼ぶが、その時点で辞書がまだ届いていなければ何もしない（空辞書扱い）ため、
  // 辞書到着後にページ全体へもう一度 fitAll() を掛けて、初回描画分にも反映させる。
  load().then(() => fitAll(document));
})();
