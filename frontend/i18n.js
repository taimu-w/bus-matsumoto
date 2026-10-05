// 利用者画面の多言語表示（日本語／英語）の共通モジュール（docs/i18n.md）。
//
// ■ 画面の文言（UI文字列）
//   日本語の文言そのものをキーにして t('バス停') のように引く。英語辞書（i18n-en.js）に
//   無い文言は日本語のまま返すので、訳し漏れがあっても画面が壊れることはない。
//   差し込みは t('{n}分遅れ', { n: 5 }) の形（キー側にも {n} を書く）。
//
// ■ バス停名・路線名・行き先・事業者名（固有名詞）
//   APIは日本語名のまま返し、ここで /api/i18n/names の辞書を引いて表示名を決める。
//   辞書の中身はサーバー側（services/nameTranslations.js）が GTFS translations.txt から作る：
//   表示言語の訳 → ローマ字表記 → かなからのヘボン式ローマ字 → （無ければ日本語のまま）。
//   日本語以外で表示するときは、現地の案内表示と照らし合わせられるよう、
//   元の日本語表記を必ず併記する（name() が返す ja、nameHtml()/nameText() の括弧書き）。
//
// ■ 言語の決め方
//   URLの ?lang= → 保存済みの選択（localStorage）→ ブラウザの言語（日本語以外なら英語）。
//   切り替えはページを読み直す（描画済みの全画面を確実に新しい言語で描き直すため）。
//
// 読み込み順: i18n.js → i18n-en.js → 各画面のスクリプト（index.html）。
(function () {
  const SUPPORTED = ['ja', 'en'];
  const STORAGE_KEY = 'busTimeLang';
  const LANG_LABELS = { ja: '日本語', en: 'English' };
  // 名称辞書の取得を待つ上限。超えたら日本語名のまま描画を始める（表示を止めないため）。
  const NAMES_TIMEOUT_MS = 4000;

  function readStorage() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (err) { return null; }
  }
  function writeStorage(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (err) { /* 保存できなくても切替自体は行う */ }
  }

  function normalize(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    const primary = s.split(/[-_]/)[0];
    return SUPPORTED.includes(primary) ? primary : null;
  }

  function detectLang() {
    let fromQuery = null;
    try { fromQuery = normalize(new URLSearchParams(window.location.search).get('lang')); } catch (err) { /* noop */ }
    if (fromQuery) {
      writeStorage(fromQuery);
      return fromQuery;
    }
    const saved = normalize(readStorage());
    if (saved) return saved;
    const browser = (navigator.languages && navigator.languages[0]) || navigator.language || 'ja';
    return String(browser).toLowerCase().startsWith('ja') ? 'ja' : 'en';
  }

  const lang = detectLang();
  document.documentElement.lang = lang;

  const dictionaries = { ja: {} };

  /** 言語ごとの文言辞書を登録する（i18n-en.js から呼ぶ）。 */
  function register(code, dict) {
    dictionaries[code] = Object.assign(dictionaries[code] || {}, dict);
  }

  function interpolate(template, params) {
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, (m, key) =>
      (Object.prototype.hasOwnProperty.call(params, key) && params[key] !== null && params[key] !== undefined
        ? String(params[key])
        : m));
  }

  /**
   * UI文言を表示言語へ。辞書の値は文字列か、params を受け取って文字列を返す関数
   * （英語の単複など、語順・語形が変わるもの）。辞書に無ければ日本語のまま。
   */
  function t(ja, params) {
    if (ja === null || ja === undefined) return '';
    const key = String(ja);
    if (lang !== 'ja') {
      const dict = dictionaries[lang] || {};
      const value = dict[key];
      if (typeof value === 'function') return value(params || {});
      if (typeof value === 'string') return interpolate(value, params);
    }
    return interpolate(key, params);
  }

  /**
   * t() のHTML版。文言（辞書の訳）はエスケープし、params の値はエスケープ済みHTMLとしてそのまま差し込む
   * （nameHtml() の結果など）。数値はそのまま t() に渡す（英語の単複を決める関数が数値を見るため）。
   */
  function tHtml(ja, htmlParams) {
    const tokens = [];
    const params = {};
    Object.keys(htmlParams || {}).forEach((key) => {
      const value = htmlParams[key];
      if (typeof value === 'number') {
        params[key] = value;
      } else {
        params[key] = `\u0001${tokens.length}\u0001`;
        tokens.push(value === null || value === undefined ? '' : String(value));
      }
    });
    return escapeHtml(t(ja, params)).replace(/\u0001(\d+)\u0001/g, (m, i) => tokens[Number(i)]);
  }

  /** 辞書に訳があるか（サーバーから届く定型文を訳すかどうかの判定に使う）。 */
  function has(ja) {
    if (lang === 'ja') return true;
    const dict = dictionaries[lang] || {};
    return Object.prototype.hasOwnProperty.call(dict, String(ja));
  }

  /* ---------- 固有名詞（バス停名・路線名・行き先・事業者名） ---------- */

  let names = null;

  const ready = lang === 'ja'
    ? Promise.resolve()
    : Promise.race([
      fetch(`/api/i18n/names?lang=${encodeURIComponent(lang)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => { if (data) names = data; })
        .catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, NAMES_TIMEOUT_MS))
    ]);

  // kind ごとの辞書の引き順。行き先（headsign）はたいていバス停名なので stops へも落とす。
  const KIND_ORDER = {
    stop: ['stops', 'headsigns'],
    route: ['routes'],
    headsign: ['headsigns', 'stops'],
    agency: ['agencies'],
    any: ['stops', 'routes', 'headsigns', 'agencies']
  };

  function lookupExact(text, kind) {
    if (!names) return null;
    for (const table of KIND_ORDER[kind] || KIND_ORDER.any) {
      const hit = names[table] && names[table][text];
      if (hit) return hit[0];
    }
    return null;
  }

  // 「◯◯経由△△」「△△行き」「◯◯（△△）」のような組み立てられた名前を、部品ごとに訳す。
  // どの部品も訳せなければ null（＝日本語のまま）。一部だけ訳せた場合は残りを日本語で埋める。
  function lookupComposite(text, kind, depth) {
    if (depth > 2) return null;
    const part = (s) => lookup(s.trim(), kind, depth + 1);
    let m = /^(.+?)\s*経由\s*(.+)$/.exec(text);
    if (m) {
      const via = part(m[1]);
      const dest = part(m[2]);
      if (via || dest) return t('{dest}（{via} 経由）', { dest: dest || m[2].trim(), via: via || m[1].trim() });
    }
    m = /^(.+?)\s*(行き|行|方面)$/.exec(text);
    if (m) {
      const dest = part(m[1]);
      if (dest) return m[2] === '方面' ? t('{dest}方面', { dest }) : dest;
    }
    m = /^(.+?)\s*[（(](.+?)[）)]$/.exec(text);
    if (m) {
      const main = part(m[1]);
      const sub = part(m[2]);
      if (main || sub) return `${main || m[1].trim()} (${sub || m[2].trim()})`;
    }
    if (/[・→～〜\-－]/.test(text)) {
      const pieces = text.split(/\s*([・→～〜\-－])\s*/);
      let translatedAny = false;
      const out = pieces.map((piece, i) => {
        if (i % 2 === 1) {
          if (piece === '・') return ' / ';
          if (piece === '-' || piece === '－') return ' - ';
          return ` ${piece} `;
        }
        const tr = part(piece);
        if (tr) translatedAny = true;
        return tr || piece;
      });
      if (translatedAny) return out.join('').replace(/\s+/g, ' ').trim();
    }
    return null;
  }

  function lookup(text, kind, depth) {
    if (!text) return null;
    return lookupExact(text, kind) || lookupComposite(text, kind, depth || 0);
  }

  /**
   * 固有名詞を表示言語へ。
   * 返り値 { text, ja }：text は表示名、ja は併記する日本語表記（訳さなかったときは null）。
   */
  function name(ja, kind) {
    const original = ja === null || ja === undefined ? '' : String(ja).trim();
    if (lang === 'ja' || !original) return { text: original, ja: null };
    const translated = lookup(original, kind || 'any', 0);
    if (!translated || translated === original) return { text: original, ja: null };
    return { text: translated, ja: original };
  }

  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 固有名詞のHTML。訳したときは日本語表記を小さく添える。
   * opts.block=true で日本語表記を改行して出す（見出しなど幅に余裕のある所）。
   */
  function nameHtml(ja, kind, opts) {
    const n = name(ja, kind);
    if (!n.ja) return escapeHtml(n.text);
    const cls = opts && opts.block ? 'i18n-ja i18n-ja-block' : 'i18n-ja';
    return `${escapeHtml(n.text)}<span class="${cls}" lang="ja">${escapeHtml(n.ja)}</span>`;
  }

  /** 固有名詞のプレーンテキスト（select の選択肢・title属性・地図のラベル等）。「表示名 (日本語)」。 */
  function nameText(ja, kind) {
    const n = name(ja, kind);
    return n.ja ? `${n.text} (${n.ja})` : n.text;
  }

  /** 表示名だけ（日本語の併記なし）。幅が極端に狭い地図上のラベル等、併記を別の場所で出すときだけ使う。 */
  function nameOnly(ja, kind) {
    return name(ja, kind).text;
  }

  /* ---------- 観光スポット ---------- */

  /**
   * 観光スポット名。英語表示では登録済みのローマ字表記（管理画面の一括入力、無ければかなから自動生成）を使い、
   * 日本語表記を併記する。ローマ字も無ければ日本語のまま。
   */
  function spotName(spot) {
    const original = String((spot && spot.name) || '').trim();
    if (lang === 'ja' || !spot) return { text: original, ja: null };
    const romaji = String(spot.romaji || '').trim();
    if (romaji && romaji !== original) return { text: romaji, ja: original };
    return { text: original, ja: null };
  }

  function spotNameHtml(spot, opts) {
    const n = spotName(spot);
    if (!n.ja) return escapeHtml(n.text);
    const cls = opts && opts.block ? 'i18n-ja i18n-ja-block' : 'i18n-ja';
    return `${escapeHtml(n.text)}<span class="${cls}" lang="ja">${escapeHtml(n.ja)}</span>`;
  }

  function spotNameText(spot) {
    const n = spotName(spot);
    return n.ja ? `${n.text} (${n.ja})` : n.text;
  }

  /**
   * 観光スポットの説明系項目（hours / stayDuration / description）。
   * 英語表示で英語の登録（hoursEn 等）があればそれを、無ければ日本語の登録をそのまま返す。
   */
  function spotField(spot, field) {
    if (!spot) return '';
    if (lang === 'en') {
      const en = spot[`${field}En`];
      if (en && String(en).trim()) return en;
    }
    return spot[field] || '';
  }

  /* ---------- 日付・時刻 ---------- */

  const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];
  const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function weekday(index) {
    return (lang === 'ja' ? WEEKDAYS_JA : WEEKDAYS_EN)[index] || '';
  }

  /**
   * 年月日。opts.year（既定 true）・opts.weekday（曜日を添える）。
   * 日本語: 2026年10月5日（月） / 英語: Mon, Oct 5, 2026
   */
  function formatDate(y, m, d, opts) {
    const o = Object.assign({ year: true, weekday: false }, opts || {});
    const wd = o.weekday ? new Date(Date.UTC(y, m - 1, d)).getUTCDay() : null;
    if (lang === 'ja') {
      const base = `${o.year ? `${y}年` : ''}${m}月${d}日`;
      return wd === null ? base : `${base}（${WEEKDAYS_JA[wd]}）`;
    }
    const base = `${MONTHS_EN[m - 1]} ${d}${o.year ? `, ${y}` : ''}`;
    return wd === null ? base : `${WEEKDAYS_EN[wd]}, ${base}`;
  }

  /** "YYYY-MM-DD" を formatDate で。形式が違えばそのまま返す。 */
  function formatIsoDate(iso, opts) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return iso || '';
    return formatDate(Number(m[1]), Number(m[2]), Number(m[3]), opts);
  }

  /** toLocaleTimeString 等に渡すロケール。 */
  function locale() {
    return lang === 'ja' ? 'ja-JP' : 'en-US';
  }

  /* ---------- 言語の切り替え ---------- */

  function setLang(next) {
    const code = normalize(next);
    if (!code || code === lang) return;
    writeStorage(code);
    // ?lang= が残っていると読み直し後にそちらが優先されるので取り除く。
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('lang');
      window.location.replace(url.toString());
    } catch (err) {
      window.location.reload();
    }
  }

  const GLOBE_SVG = '<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/>'
    + '<path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5Z"/></svg>';

  /**
   * 言語切替ボタンのHTML（押すと反対の言語へ）。
   * opts.compact=true は幅の狭いヘッダー用（地球アイコン＋「EN」／「日本語」だけ）。
   * 英語表示のヘッダーは文言が長く幅に余裕が無いので、「日本語」側にはアイコンを付けない。
   */
  function toggleButtonHtml(className, opts) {
    const next = lang === 'ja' ? 'en' : 'ja';
    const compact = Boolean(opts && opts.compact);
    const label = next === 'en' ? (compact ? 'EN' : 'English') : '日本語';
    const aria = next === 'en' ? 'Switch to English' : '日本語に切り替え';
    const icon = compact && next === 'en' ? GLOBE_SVG : '';
    return `<button type="button" data-i18n-switch="${next}" class="${className || ''}" lang="${next}" `
      + `aria-label="${aria}" title="${aria}">${icon}<span>${label}</span></button>`;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-i18n-switch]');
    if (btn) setLang(btn.dataset.i18nSwitch);
  });

  /**
   * 静的HTML（index.html・howto.html 等）の文言を訳す。
   * テキストノードのうち前後の空白を除いた中身が辞書にあるもの、および
   * title / placeholder / aria-label / alt 属性を訳す。日本語表示では何もしない。
   */
  function translateStatic(root) {
    if (lang === 'ja') return;
    const scope = root || document.body;
    if (!scope) return;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const raw = node.nodeValue;
      const key = raw.trim().replace(/\s+/g, ' ');
      if (!has(key)) return;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      node.nodeValue = `${lead}${t(key)}${trail}`;
    });
    scope.querySelectorAll('[title],[placeholder],[aria-label],[alt]').forEach((el) => {
      ['title', 'placeholder', 'aria-label', 'alt'].forEach((attr) => {
        const value = el.getAttribute(attr);
        if (value && has(value.trim())) el.setAttribute(attr, t(value.trim()));
      });
    });
    const titleEl = document.querySelector('title');
    if (titleEl && has(titleEl.textContent.trim())) titleEl.textContent = t(titleEl.textContent.trim());
    const desc = document.querySelector('meta[name="description"]');
    if (desc && has(desc.content)) desc.content = t(desc.content);
  }

  window.I18n = {
    lang,
    isJa: lang === 'ja',
    supported: SUPPORTED.slice(),
    labels: LANG_LABELS,
    ready,
    register,
    t,
    tHtml,
    has,
    name,
    nameHtml,
    nameText,
    nameOnly,
    spotName,
    spotNameHtml,
    spotNameText,
    spotField,
    weekday,
    formatDate,
    formatIsoDate,
    locale,
    setLang,
    toggleButtonHtml,
    translateStatic,
    escapeHtml
  };
})();
