// かな・カタカナ・ローマ字の相互変換と、バス停名検索用の正規化を行うユーティリティ。
//
// 仕様書 3.1 の「GTFS内にローマ字・フリガナが存在しない場合は、取り込み処理(ETL)時に
// 自動でフリガナからローマ字（ヘボン式）に変換して検索用インデックスに登録する」を担う。
//
// 注意: 漢字→よみがな の変換は行わない（形態素解析が必要で、GTFSの範囲外）。
//       よみがなは translations.txt から取得し、無い場合はローマ字も生成できない。
//       その場合でも漢字表記そのものでは検索できる（normalizeSearchText 参照）。

// ひらがな2文字（拗音・外来音）→ ヘボン式ローマ字
const DIGRAPHS = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', きぇ: 'kye',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che',
  ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', ふゅ: 'fyu',
  てぃ: 'ti', てゅ: 'tyu', でぃ: 'di', でゅ: 'dyu',
  とぅ: 'tu', どぅ: 'du',
  つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo', ゔゅ: 'vyu'
};

// ひらがな1文字 → ヘボン式ローマ字
const MONOGRAPHS = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o',
  ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa'
};

const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);

/**
 * Unicode正規化（NFKC）。全角英数字→半角、半角カタカナ→全角カタカナに揃える。
 */
function normalizeWidth(str) {
  if (str === null || str === undefined) return '';
  return String(str).normalize('NFKC');
}

/**
 * カタカナをひらがなへ変換する（長音符「ー」はそのまま残す）。
 */
function toHiragana(str) {
  return normalizeWidth(str).replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

/**
 * ひらがなをカタカナへ変換する。
 */
function toKatakana(str) {
  return normalizeWidth(str).replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

/** 文字列がかな（ひらがな・カタカナ・長音符・中黒・空白）だけで構成されているか。 */
function isKanaOnly(str) {
  const s = normalizeWidth(str).trim();
  if (!s) return false;
  return /^[ぁ-ゖァ-ヺー・\s]+$/.test(s);
}

/** 文字列にラテン文字が含まれているか（ローマ字表記の判定に使う）。 */
function hasLatin(str) {
  return /[A-Za-z]/.test(normalizeWidth(str));
}

/** 文字列に漢字が含まれているか。 */
function hasKanji(str) {
  return /[一-鿿㐀-䶿]/.test(normalizeWidth(str));
}

/**
 * かな文字列をローマ字へ変換する（内部用。長音の畳み込みは行わない）。
 * - 促音「っ」は次の子音を重ねる（ちゃ行の前は t + ch）
 * - 長音符「ー」は直前の母音を繰り返す
 * - 撥音「ん」は n（useMForLabial=true のとき b/m/p の前で m）
 */
function kanaToRomajiRaw(kana, { useMForLabial = false } = {}) {
  const src = toHiragana(kana).replace(/[\s・]/g, '');
  let out = '';
  let pendingSokuon = false;

  const append = (romaji) => {
    let value = romaji;
    if (pendingSokuon) {
      // 「っち」→ tchi（ヘボン式）。それ以外は先頭子音を重ねる。
      value = value.startsWith('ch') ? `t${value}` : `${value[0]}${value}`;
      pendingSokuon = false;
    }
    out += value;
  };

  for (let i = 0; i < src.length; i += 1) {
    const pair = src.slice(i, i + 2);
    const ch = src[i];

    if (DIGRAPHS[pair]) {
      append(DIGRAPHS[pair]);
      i += 1;
      continue;
    }
    if (ch === 'っ') {
      pendingSokuon = true;
      continue;
    }
    if (ch === 'ん') {
      const nextRomaji = DIGRAPHS[src.slice(i + 1, i + 3)] || MONOGRAPHS[src[i + 1]] || '';
      if (useMForLabial && /^[bmp]/.test(nextRomaji)) {
        append('m');
      } else {
        append('n');
      }
      continue;
    }
    if (ch === 'ー') {
      // 長音符は直前の母音を伸ばす
      const last = out[out.length - 1];
      if (VOWELS.has(last)) out += last;
      continue;
    }
    if (MONOGRAPHS[ch]) {
      append(MONOGRAPHS[ch]);
      continue;
    }
    // かな以外（漢字・英数字など）はそのまま残す
    if (pendingSokuon) pendingSokuon = false;
    out += ch.toLowerCase();
  }

  return out;
}

/**
 * 長音（ou/oo/uu/aa）を1文字に畳み込む。
 * ヘボン式のマクロン表記（ō, ū）をASCIIで表す際の一般的な扱いに合わせる。
 * 例: とうきょう → toukyou → tokyo
 */
function collapseLongVowels(romaji) {
  return romaji
    .replace(/ou/g, 'o')
    .replace(/oo/g, 'o')
    .replace(/uu/g, 'u')
    .replace(/aa/g, 'a');
}

/**
 * かな（ひらがな/カタカナ）→ ヘボン式ローマ字。
 * 長音を畳み込んだ標準的な表記を返す（例: まつもと → matsumoto）。
 */
function kanaToRomaji(kana) {
  if (!kana) return '';
  return collapseLongVowels(kanaToRomajiRaw(kana));
}

/**
 * 検索インデックス用に、1つのかな文字列から複数のローマ字表記ゆれを生成する。
 * 「とうきょう」に対して tokyo / toukyou の両方を登録し、
 * 「しんばし」に対して shinbashi / shimbashi の両方を登録する。
 */
function kanaToRomajiVariants(kana) {
  if (!kana) return [];
  const plain = kanaToRomajiRaw(kana);
  const labial = kanaToRomajiRaw(kana, { useMForLabial: true });
  const variants = new Set([
    plain,
    collapseLongVowels(plain),
    labial,
    collapseLongVowels(labial)
  ]);
  return Array.from(variants).filter(Boolean);
}

/**
 * 検索用の正規化。表記ゆれを吸収してから比較するために使う。
 * - NFKC（全角英数→半角、半角カナ→全角カナ）
 * - 小文字化
 * - カタカナ→ひらがな
 * - 空白・記号・長音符の除去（「ばすたーみなる」と「ばすたみなる」を同一視する）
 */
function normalizeSearchText(str) {
  if (!str) return '';
  return toHiragana(normalizeWidth(str))
    .toLowerCase()
    .replace(/ー/g, '')
    .replace(/[\s　・･,.'"()（）\[\]「」【】\-‐−–—_/\\]/g, '');
}

/**
 * 表示用にローマ字の先頭を大文字にする。
 */
function capitalizeRomaji(romaji) {
  if (!romaji) return '';
  return romaji
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

module.exports = {
  normalizeWidth,
  toHiragana,
  toKatakana,
  isKanaOnly,
  hasLatin,
  hasKanji,
  kanaToRomaji,
  kanaToRomajiVariants,
  normalizeSearchText,
  capitalizeRomaji
};
