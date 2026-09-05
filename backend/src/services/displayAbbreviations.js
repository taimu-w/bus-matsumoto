// 表示テキスト（系統名・行き先）の略称辞書のメモリキャッシュ層。
//
// display_abbreviations テーブルは高々数十件程度で、利用者向け画面（バスマップ・
// バス停時刻表・接近中のバスパネル）からポーリングのたび読まれる想定のため、
// TTL付きでメモリにキャッシュし、管理画面から追加・変更・削除したときだけ
// invalidateDisplayAbbreviationsCache() で破棄する（routeExternalIdMapping.js と同じ流儀）。
//
// 部分文字列の入れ子（例:「バスターミナル」と「ターミナル」が両方登録されている）で
// 短い方が先に置換されて長い方が一致しなくなる事故を防ぐため、original の文字数が
// 長い順に並べて返す。実際の置換順序はフロントエンド（text-abbrev.js）の責務。

const pool = require('../config/db');

const TTL_MS = 60 * 60 * 1000; // 1時間

let cache = null; // [{ original, abbreviation }, ...]（original文字数の降順）
let cachedAt = 0;

async function loadAbbreviations() {
  const now = Date.now();
  if (cache && (now - cachedAt) < TTL_MS) return cache;

  const res = await pool.query(
    `SELECT original, abbreviation FROM display_abbreviations ORDER BY length(original) DESC, original ASC`
  );
  cache = res.rows.map((row) => ({ original: row.original, abbreviation: row.abbreviation }));
  cachedAt = now;
  return cache;
}

function invalidateDisplayAbbreviationsCache() {
  cache = null;
}

module.exports = { loadAbbreviations, invalidateDisplayAbbreviationsCache };
