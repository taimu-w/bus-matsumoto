// 利用者画面の多言語表示（英語など）で使う「日本語名 → 表示言語の名称」辞書。
//
// GTFSの translations.txt（任意ファイル）から、バス停名・路線名・行き先・事業者名の
// 翻訳を集める。表示言語の名称は次の優先順位で決める（docs/i18n.md）。
//   1. translations.txt にある表示言語そのものの翻訳（例: language=en）     → source 'gtfs'
//   2. translations.txt にあるローマ字表記（language=ja-Latn）             → source 'romaji'
//   3. translations.txt にあるかな（language=ja-Hrkt）をヘボン式に変換したもの → source 'romaji'
//   4. いずれも無ければ辞書に載せない（＝画面側で日本語のまま表示する）
//
// 辞書のキーは「日本語の表示名そのもの」。リアルタイム系（DBの stops.name / routes.name）と
// 時刻表系（GTFSインメモリインデックス）のどちらも GTFS の名前文字列をそのまま返すため、
// stop_id ではなく名前で引けば、APIのレスポンス形を変えずに全画面で同じ訳を使える。
// 名前で引くので、同名の別バス停にも同じ訳が当たる（訳はバス停名の訳なので問題にならない）。
//
// 時刻表インデックス（gtfsTimetable.js）とは独立したプロセス内キャッシュを持ち、
// GTFS更新成功時に invalidateNameTranslations() で破棄する（invalidateTimetableIndex と同じ箇所）。
const fs = require('fs');
const { getGtfsDir } = require('./gtfsFeedManager');
const { getEnabledGtfsFeedIds } = require('../config/feeds');
const { readCsvIfExists } = require('../utils/csv');
const { isKanaOnly, hasLatin, kanaToRomaji, capitalizeRomaji } = require('../utils/kana');

const CACHE_TTL_MS = 30 * 60 * 1000;

// 辞書の種類。画面側は種類ごとに引き分ける（行き先は stops へもフォールバックする）。
const KINDS = ['stops', 'routes', 'headsigns', 'agencies'];

// translations.txt の (table_name, field_name) → 辞書の種類
const FIELD_KIND = {
  'stops.stop_name': 'stops',
  'routes.route_long_name': 'routes',
  'routes.route_short_name': 'routes',
  'trips.trip_headsign': 'headsigns',
  'stop_times.stop_headsign': 'headsigns',
  'agency.agency_name': 'agencies'
};

let cache = null; // { builtAt, entries: { kind: Map<ja, { byLang: Map<lang, text>, kana, latn }> } }

/** 言語タグを比較用に正規化する（"en-US" → "en"、"ja-Hrkt" はそのまま "ja-hrkt"）。 */
function normalizeLang(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s) return '';
  if (s === 'ja-hrkt' || s === 'ja-kana' || s === 'ja-hira') return 'ja-hrkt';
  if (s === 'ja-latn') return 'ja-latn';
  return s.split('-')[0];
}

/**
 * かなをヘボン式ローマ字の表示名へ変換する。
 * 空白・中黒はそのまま単語の区切りとして残し、単語ごとに先頭を大文字にする。
 */
function romanizeKana(kana) {
  return String(kana || '')
    .split(/[\s・　]+/)
    .filter(Boolean)
    .map((word) => capitalizeRomaji(kanaToRomaji(word)))
    .filter(Boolean)
    .join(' ');
}

function emptyEntries() {
  const entries = {};
  for (const kind of KINDS) entries[kind] = new Map();
  return entries;
}

function putTranslation(entries, kind, original, lang, text) {
  const ja = String(original || '').trim();
  const value = String(text || '').trim();
  if (!ja || !value || value === ja) return;
  const map = entries[kind];
  if (!map.has(ja)) map.set(ja, { byLang: new Map(), kana: '', latn: '' });
  const entry = map.get(ja);
  // 言語タグが無い・揺れているフィードもあるため、内容でかな／ローマ字を補う
  // （gtfsTimetable.js の loadTranslations と同じ考え方）。
  let effectiveLang = lang;
  if (!effectiveLang || effectiveLang === 'ja') {
    if (isKanaOnly(value)) effectiveLang = 'ja-hrkt';
    else if (hasLatin(value)) effectiveLang = 'ja-latn';
    else return;
  }
  if (effectiveLang === 'ja-hrkt') {
    if (!entry.kana && isKanaOnly(value)) entry.kana = value;
    return;
  }
  if (effectiveLang === 'ja-latn') {
    if (!entry.latn) entry.latn = value;
    return;
  }
  // 同じ日本語名に複数の訳がある（標柱ごとに訳が付いている等）ときは先勝ち。
  if (!entry.byLang.has(effectiveLang)) entry.byLang.set(effectiveLang, value);
}

/** 1フィード分の「レコードID → 日本語名」を必要な表だけ読む。 */
function buildOriginalLookup(feedId, neededTables) {
  const lookup = {};
  const read = (file) => readCsvIfExists(file, feedId);
  if (neededTables.has('stops')) {
    const m = new Map();
    for (const row of read('stops.txt')) m.set((row.stop_id || '').trim(), { stop_name: row.stop_name });
    lookup.stops = m;
  }
  if (neededTables.has('routes')) {
    const m = new Map();
    for (const row of read('routes.txt')) {
      m.set((row.route_id || '').trim(), {
        route_long_name: row.route_long_name,
        route_short_name: row.route_short_name
      });
    }
    lookup.routes = m;
  }
  if (neededTables.has('trips')) {
    const m = new Map();
    for (const row of read('trips.txt')) m.set((row.trip_id || '').trim(), { trip_headsign: row.trip_headsign });
    lookup.trips = m;
  }
  if (neededTables.has('agency')) {
    const m = new Map();
    for (const row of read('agency.txt')) m.set((row.agency_id || '').trim(), { agency_name: row.agency_name });
    lookup.agency = m;
  }
  return lookup;
}

function loadFeed(entries, feedId) {
  const rows = readCsvIfExists('translations.txt', feedId);
  if (rows.length === 0) return;

  // 現行書式で field_value が空の行は record_id から原文を引く必要がある。
  // 該当する表だけ読む（trips.txt は大きいので、要るときだけ）。
  const neededTables = new Set();
  for (const row of rows) {
    const table = (row.table_name || '').trim();
    if (table && !(row.field_value || '').trim() && (row.record_id || '').trim()) neededTables.add(table);
  }
  const lookup = buildOriginalLookup(feedId, neededTables);

  for (const row of rows) {
    const table = (row.table_name || '').trim();
    const field = (row.field_name || '').trim();
    const translation = (row.translation || '').trim();
    if (!translation) continue;

    if (table || field) {
      // 現行書式: table_name, field_name, language, translation, record_id, record_sub_id, field_value
      const kind = FIELD_KIND[`${table}.${field}`];
      if (!kind) continue;
      const lang = normalizeLang(row.language);
      let original = (row.field_value || '').trim();
      if (!original) {
        const record = lookup[table] && lookup[table].get((row.record_id || '').trim());
        original = record ? String(record[field] || '').trim() : '';
      }
      putTranslation(entries, kind, original, lang, translation);
    } else {
      // GTFS-JP旧書式: trans_id（原文の日本語）, lang, translation。
      // どの表の語かは分からないため、全種類に同じ訳を入れておく（キーが日本語名なので衝突しない）。
      const original = (row.trans_id || '').trim();
      const lang = normalizeLang(row.lang);
      for (const kind of KINDS) putTranslation(entries, kind, original, lang, translation);
    }
  }
}

function buildEntries() {
  const entries = emptyEntries();
  for (const feedId of getEnabledGtfsFeedIds()) {
    // まだZIPを展開していないフィードは飛ばす（gtfsTimetable.listFeedIds と同じ理由）。
    if (!fs.existsSync(getGtfsDir(feedId))) continue;
    try {
      loadFeed(entries, feedId);
    } catch (err) {
      console.warn(`[nameTranslations] ${feedId} の translations.txt を読めませんでした:`, err.message);
    }
  }
  return entries;
}

function getEntries() {
  if (cache && Date.now() - cache.builtAt < CACHE_TTL_MS) return cache.entries;
  cache = { builtAt: Date.now(), entries: buildEntries() };
  return cache.entries;
}

/** GTFS更新成功時に呼ぶ（gtfsFeedManager / 管理画面の手動再取得）。 */
function invalidateNameTranslations() {
  cache = null;
}

/**
 * 集めた翻訳（entries）から、指定言語の名称辞書を組み立てる純粋関数。
 * 返り値: { lang, stops: { 日本語名: [表示名, source] }, routes, headsigns, agencies }
 *   source は 'gtfs'（translations.txt の表示言語の訳）か 'romaji'（ローマ字表記・かなからの変換）。
 * 日本語（ja）が指定されたときは空の辞書を返す（画面は日本語名をそのまま出す）。
 */
function buildNameDictionary(entries, rawLang) {
  const lang = normalizeLang(rawLang);
  const result = { lang: lang || 'ja' };
  for (const kind of KINDS) result[kind] = {};
  if (!lang || lang === 'ja' || lang === 'ja-hrkt') return result;

  for (const kind of KINDS) {
    const out = result[kind];
    for (const [ja, entry] of entries[kind].entries()) {
      if (lang !== 'ja-latn' && entry.byLang.has(lang)) {
        out[ja] = [entry.byLang.get(lang), 'gtfs'];
      } else if (entry.latn) {
        out[ja] = [entry.latn, 'romaji'];
      } else if (entry.kana) {
        const romaji = romanizeKana(entry.kana);
        if (romaji) out[ja] = [romaji, 'romaji'];
      }
    }
  }
  return result;
}

/** 有効な全GTFSフィードの translations.txt から、指定言語の名称辞書を返す（API用）。 */
function getNameDictionary(rawLang) {
  const lang = normalizeLang(rawLang);
  if (!lang || lang === 'ja' || lang === 'ja-hrkt') return buildNameDictionary(emptyEntries(), lang);
  return buildNameDictionary(getEntries(), lang);
}

module.exports = {
  getNameDictionary,
  invalidateNameTranslations,
  // 以下はテスト用（DB・ファイルI/Oを伴わない部分）
  normalizeLang,
  romanizeKana,
  buildNameDictionary,
  putTranslation,
  emptyEntries
};
