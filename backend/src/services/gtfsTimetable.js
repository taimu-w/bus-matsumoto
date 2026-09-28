// 時刻表検索機能のデータ基盤。
//
// GTFSファイル（stops / routes / trips / stop_times / calendar / translations …）を
// そのままの粒度でメモリ上にインデックス化し、
//   ・バス停名の検索（漢字・ひらがな・カタカナ・ローマ字）
//   ・バス停ごとの時刻表（標柱統合／標柱別、日付指定）
//   ・便ごとの通過時刻一覧
// を提供する。
//
// なぜDBではなくインメモリなのか:
//   既存の stops テーブルは「路線×方向×順序」で正規化されており、GTFSの stop_id を
//   保持していない（seed.js 参照）。時刻表検索は stop_id・parent/標柱・stop_headsign を
//   そのまま扱う必要があるため、既存テーブルからは復元できない。
//   GTFSファイル自体はディスク上に常に展開されている（gtfsFeedManager）ので、
//   そこから読み直す方が既存スキーマを壊さずに済み、データ量も小さい（全フィードで数万行）。
//   GTFS更新時は gtfsFeedManager が invalidateTimetableIndex() を呼んで作り直す。
const fs = require('fs');
const { getGtfsDir } = require('./gtfsFeedManager');
const { getEnabledGtfsFeedIds, getPlatformDisplayNameFeedPriority } = require('../config/feeds');
const { readCsv, readCsvIfExists } = require('../utils/csv');
const { readShapePointsByShapeId, resolveTripShapeId } = require('./gtfsShapes');
const { readFrequenciesByTripId, expandFrequencies } = require('./gtfsFrequencies');
const { haversineDistanceMeters, estimateWalkMinutes } = require('../utils/geo');
const {
  toHiragana,
  toKatakana,
  isKanaOnly,
  hasLatin,
  kanaToRomaji,
  kanaToRomajiVariants,
  normalizeSearchText,
  capitalizeRomaji
} = require('../utils/kana');

// フィードIDとGTFS内IDを連結する区切り。GTFSのID内には出現し得ない制御文字
// U+001F（Unit Separator）を使う。以前はNUL文字(U+0000)だったが、NULを含むと
// このファイルがripgrep等から「バイナリファイル」とみなされ通常のgrep検索が
// ヒットしなくなるため、検索を壊さない制御文字へ変更した。
// このキーはプロセス内のインメモリインデックス専用で、DB・URL・APIレスポンスには
// 一切出ない（外部に出る stopKey/groupKey は buildGroups() が "_" で構成する）。
const SEP = '';
// 同名のバス停を「同じバス停」とみなす距離の上限。
// これを超えて離れている同名バス停（例: 別地区の「市役所前」）は統合しない。
const SAME_NAME_MERGE_RADIUS_METERS = 400;
// 「同じ物理のりば（標柱）」とみなす座標差の上限。
// 2つのGTFSフィードが同一の物理のりばをそれぞれ別 stop_id で登録しているため、
// バス停統合（SAME_NAME_MERGE_RADIUS_METERS）とは別レイヤーで、標柱そのものを畳む。
// 詳細は docs/timetable-search.md「のりばの座標統合」。
const PLATFORM_MERGE_RADIUS_METERS = 0.1;
// インデックスの再構築間隔。GTFS更新時は invalidateTimetableIndex() で即時無効化される。
const INDEX_TTL_MS = 30 * 60 * 1000;

let cachedIndex = null;
let buildingPromise = null;

function makeKey(feedId, id) {
  return `${feedId}${SEP}${id}`;
}

/**
 * 有効なGTFSフィードID一覧。取得元は config/feeds.js（コード上の定数）。
 *
 * DB障害時のディスク走査フォールバックは、コード側が常に正しい一覧を返せるので撤去した。
 *
 * ⚠️ `fs.existsSync()` によるフィルタは残すこと。これはDB障害対策ではなく
 * 「設定にはあるが、まだZIPを展開していないフィード」（初回起動時など）を
 * 除外するためのものである。撤去すると存在しないディレクトリを読みに行き、
 * 時刻表インデックスの構築が落ちる。
 */
async function listFeedIds() {
  return getEnabledGtfsFeedIds().filter((id) => fs.existsSync(getGtfsDir(id)));
}

/* ==========================================================
 * 時刻ユーティリティ（GTFSの24時超え表記をそのまま扱う）
 * ========================================================== */

/** "07:05:00" → 25500（秒）。24時超え（"25:10:00"）もそのまま扱う。 */
function parseGtfsTime(value) {
  if (!value) return NaN;
  const parts = String(value).trim().split(':');
  if (parts.length < 2) return NaN;
  const h = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  const s = parts.length > 2 ? Number.parseInt(parts[2], 10) || 0 : 0;
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 3600 + m * 60 + s;
}

/** 秒 → "H:mm"（24時超えは 25:10 のまま表示する） */
function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** 秒 → "0805"（便詳細URLの departure_time 部分） */
function formatHhmm(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

/** "0805" / "08:05" → 秒。 */
function parseHhmm(value) {
  if (!value) return NaN;
  const s = String(value).trim();
  if (s.includes(':')) return parseGtfsTime(s);
  if (!/^\d{3,4}$/.test(s)) return NaN;
  const padded = s.padStart(4, '0');
  return Number.parseInt(padded.slice(0, 2), 10) * 3600 + Number.parseInt(padded.slice(2), 10) * 60;
}

/** "YYYY-MM-DD" → "YYYYMMDD"。不正な場合はnull。 */
function toCompactDate(dateStr) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(dateStr || '').trim());
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

/** "YYYYMMDD" → "YYYY-MM-DD"。不正な場合はnull。 */
function fromCompactDate(compact) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(compact || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "YYYY-MM-DD" の曜日（0=日）。 */
function dayOfWeekOf(dateStr) {
  const compact = toCompactDate(dateStr);
  if (!compact) return NaN;
  const y = Number.parseInt(compact.slice(0, 4), 10);
  const mo = Number.parseInt(compact.slice(4, 6), 10);
  const d = Number.parseInt(compact.slice(6, 8), 10);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/* ==========================================================
 * インデックス構築
 * ========================================================== */

const DAY_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * calendar.txt の1行から「平日」「土曜」などの表示ラベルを作る。
 * service_id の文字列（"平日"など）に依存しないよう、曜日フラグから機械的に決める。
 */
function serviceLabelFromDays(days) {
  const active = days.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
  if (active.length === 0) return '特定日';
  if (active.length === 7) return '毎日';
  const key = active.join(',');
  if (key === '1,2,3,4,5') return '平日';
  if (key === '6') return '土曜';
  if (key === '0') return '日曜・祝日';
  if (key === '0,6') return '土曜・日曜・祝日';
  if (key === '1,2,3,4,5,6') return '平日・土曜';
  return `${active.map((i) => DAY_LABELS[i]).join('・')}曜`;
}

/**
 * フィード1件の「GTFSデータが有効な期間」（"YYYYMMDD"）を求める純粋関数。
 *
 * 優先度:
 *   1. feed_info.txt の feed_start_date / feed_end_date（あれば最優先）
 *   2. calendar.txt の全サービスの start_date / end_date にわたる最小〜最大
 *   3. calendar_dates.txt の運行追加日（exception_type=1）
 * feed_info.txt に片方だけあれば、欠けている側だけを 2・3 から補う。
 * いずれからも期間が定まらなければ null。
 *
 * @param {{feedStartDate?:string, feedEndDate?:string}} feedInfo
 * @param {Array<{startDate?:string, endDate?:string}>} calendarRanges
 * @param {string[]} additionDates calendar_dates.txt の exception_type=1 の日付
 * @returns {{startDate:string|null, endDate:string|null}|null}
 */
function computeFeedValidity(feedInfo, calendarRanges, additionDates) {
  const isYmd = (v) => /^\d{8}$/.test(String(v || '').trim());
  const fi = feedInfo || {};

  let start = isYmd(fi.feedStartDate) ? fi.feedStartDate.trim() : null;
  let end = isYmd(fi.feedEndDate) ? fi.feedEndDate.trim() : null;

  const dates = [];
  for (const range of calendarRanges || []) {
    if (isYmd(range.startDate)) dates.push(range.startDate.trim());
    if (isYmd(range.endDate)) dates.push(range.endDate.trim());
  }
  for (const date of additionDates || []) {
    if (isYmd(date)) dates.push(String(date).trim());
  }

  if (!start && dates.length > 0) start = dates.reduce((a, b) => (a < b ? a : b));
  if (!end && dates.length > 0) end = dates.reduce((a, b) => (a > b ? a : b));

  if (!start && !end) return null;
  return { startDate: start || null, endDate: end || null };
}

/**
 * インデックス全体（有効な全フィード）の有効期間を union で求める。
 * 「最も早い start」〜「最も遅い end」。ある日付が範囲外と判定されるのは、
 * どのフィードの有効期間にも入っていないときだけ（＝誤検知を最小化する）。
 */
function getIndexValidity(index) {
  let start = null;
  let end = null;
  for (const validity of index.feedValidity.values()) {
    if (!validity) continue;
    if (validity.startDate && (start === null || validity.startDate < start)) start = validity.startDate;
    if (validity.endDate && (end === null || validity.endDate > end)) end = validity.endDate;
  }
  if (start === null && end === null) return null;
  return { startDate: start, endDate: end };
}

/**
 * 指定日が現在のGTFSデータの有効期間に対してどの位置にあるかを返す。
 * 経路検索・時刻表検索が「期限外の日付ではダイヤが変わる可能性がある」旨を
 * 画面に出すために使う。
 *
 * @returns {{available:boolean, outOfRange:boolean, position:'before'|'within'|'after'|null,
 *            periodStart:string|null, periodEnd:string|null, date:string|null}}
 */
function describeDateValidity(index, dateStr) {
  const compact = toCompactDate(dateStr);
  const bounds = getIndexValidity(index);
  if (!compact || !bounds) {
    return { available: false, outOfRange: false, position: null, periodStart: null, periodEnd: null, date: fromCompactDate(compact) };
  }
  const before = Boolean(bounds.startDate && compact < bounds.startDate);
  const after = Boolean(bounds.endDate && compact > bounds.endDate);
  return {
    available: true,
    outOfRange: before || after,
    position: before ? 'before' : after ? 'after' : 'within',
    periodStart: fromCompactDate(bounds.startDate),
    periodEnd: fromCompactDate(bounds.endDate),
    date: fromCompactDate(compact)
  };
}

/** describeDateValidity の非同期ラッパー（インデックスを自前で取得する）。 */
async function getDateValidity(dateStr) {
  const index = await getIndex();
  return describeDateValidity(index, dateStr);
}

/**
 * translations.txt を読み込み、バス停名のよみがな・ローマ字を引けるようにする。
 *
 * 2つの書式に対応する:
 *   - 現行GTFS: table_name, field_name, language, translation, record_id, field_value
 *   - GTFS-JP旧書式: trans_id, lang, translation（trans_id が原文の日本語）
 * language の値（ja-Hrkt / en など）は事業者ごとにゆれるため、
 * 「かなだけならよみがな」「ラテン文字を含むならローマ字」と内容で判定する。
 */
function loadTranslations(feedId) {
  const rows = readCsvIfExists('translations.txt', feedId);
  const byRecordId = new Map();
  const byName = new Map();
  if (rows.length === 0) return { byRecordId, byName };

  const put = (map, key, value) => {
    if (!key || !value) return;
    const entry = map.get(key) || {};
    if (isKanaOnly(value)) {
      if (!entry.kana) entry.kana = value;
    } else if (hasLatin(value)) {
      if (!entry.romaji) entry.romaji = value;
    }
    map.set(key, entry);
  };

  for (const row of rows) {
    const tableName = (row.table_name || '').trim();
    const fieldName = (row.field_name || '').trim();
    const translation = (row.translation || '').trim();
    if (!translation) continue;

    if (tableName || fieldName) {
      // 現行書式。stops.stop_name 以外は使わない。
      if (tableName !== 'stops') continue;
      if (fieldName && fieldName !== 'stop_name') continue;
      put(byRecordId, (row.record_id || '').trim(), translation);
      put(byName, (row.field_value || '').trim(), translation);
    } else {
      // 旧書式（trans_id が原文）
      put(byName, (row.trans_id || '').trim(), translation);
    }
  }

  return { byRecordId, byName };
}

/**
 * バス停名のよみがな・ローマ字を決める。
 * translations.txt に無い場合、よみがなからローマ字（ヘボン式）を自動生成する（仕様書 3.1）。
 * よみがな自体が無い場合は空のままとし、漢字表記での検索にフォールバックする。
 */
function resolveStopReading(stopName, translations, stopId) {
  const fromId = translations.byRecordId.get(stopId) || {};
  const fromName = translations.byName.get(stopName) || {};
  const rawKana = fromId.kana || fromName.kana || (isKanaOnly(stopName) ? stopName : '');
  const rawRomaji = fromId.romaji || fromName.romaji || '';

  const hiragana = rawKana ? toHiragana(rawKana) : '';
  const katakana = rawKana ? toKatakana(rawKana) : '';
  // ローマ字が無ければフリガナから生成する。フリガナも無ければ空。
  const romaji = rawRomaji || (hiragana ? capitalizeRomaji(kanaToRomaji(hiragana)) : '');

  const searchTexts = new Set();
  searchTexts.add(normalizeSearchText(stopName));
  if (hiragana) searchTexts.add(normalizeSearchText(hiragana));
  if (rawRomaji) searchTexts.add(normalizeSearchText(rawRomaji));
  for (const variant of kanaToRomajiVariants(hiragana)) {
    searchTexts.add(normalizeSearchText(variant));
  }
  searchTexts.delete('');

  return { hiragana, katakana, romaji, searchTexts: Array.from(searchTexts) };
}

/**
 * 標柱（stop）のベースIDを求める。
 *  1. parent_station が実在すればそれを使う
 *  2. stop_id が "100_03" のように枝番付きなら "100"
 *  3. どちらでもなければ stop_id そのもの
 */
function computeBaseId(stop, stopIdsInFeed) {
  if (stop.parentStation && stopIdsInFeed.has(stop.parentStation)) return stop.parentStation;
  const m = /^(.+)_([^_]+)$/.exec(stop.stopId);
  if (m) return m[1];
  return stop.stopId;
}

function loadFeed(index, feedId) {
  // --- agency ---
  const agencyRows = readCsv('agency.txt', feedId);
  const agencyNameById = new Map();
  for (const row of agencyRows) {
    agencyNameById.set((row.agency_id || '').trim(), (row.agency_name || '').trim());
  }
  const defaultAgencyName = agencyRows.length > 0 ? (agencyRows[0].agency_name || '').trim() : '';

  // --- routes ---
  for (const row of readCsv('routes.txt', feedId)) {
    const routeId = (row.route_id || '').trim();
    if (!routeId) continue;
    const agencyId = (row.agency_id || '').trim();
    index.routes.set(makeKey(feedId, routeId), {
      feedId,
      routeId,
      routeKey: makeKey(feedId, routeId),
      shortName: (row.route_short_name || '').trim(),
      longName: (row.route_long_name || '').trim(),
      name: (row.route_long_name || row.route_short_name || routeId).trim(),
      color: (row.route_color || '').trim(),
      textColor: (row.route_text_color || '').trim(),
      agencyName: agencyNameById.get(agencyId) || defaultAgencyName || ''
    });
  }

  // --- stops ---
  const translations = loadTranslations(feedId);
  const stopRows = readCsv('stops.txt', feedId);
  const stopIdsInFeed = new Set(stopRows.map((row) => (row.stop_id || '').trim()));
  const feedStops = [];
  for (const row of stopRows) {
    const stopId = (row.stop_id || '').trim();
    if (!stopId) continue;
    const name = (row.stop_name || '').trim();
    const reading = resolveStopReading(name, translations, stopId);
    const stop = {
      feedId,
      stopId,
      stopKey: makeKey(feedId, stopId),
      stopCode: (row.stop_code || '').trim(),
      name,
      lat: Number.parseFloat(row.stop_lat),
      lon: Number.parseFloat(row.stop_lon),
      locationType: Number.parseInt(row.location_type || '0', 10) || 0,
      parentStation: (row.parent_station || '').trim(),
      platformCode: (row.platform_code || '').trim(),
      // 運賃ルール（fare_rules.txt の origin_id / destination_id）が参照する運賃エリア。
      // 経路検索の運賃表示（gtfsFare.js）でだけ使う。
      zoneId: (row.zone_id || '').trim(),
      hiragana: reading.hiragana,
      katakana: reading.katakana,
      romaji: reading.romaji,
      searchTexts: reading.searchTexts,
      groupKey: null
    };
    stop.baseId = computeBaseId(stop, stopIdsInFeed);
    index.stops.set(stop.stopKey, stop);
    feedStops.push(stop);
  }

  // --- shapes（任意ファイル。便詳細「地図で表示」に重ねる線形の供給元） ---
  // 無いフィードでは空のMapが返り、便の shapeId が全部 null になるだけ。
  const shapePointsByShapeId = readShapePointsByShapeId(feedId, readCsv);
  for (const [shapeId, points] of shapePointsByShapeId.entries()) {
    // 2点未満は線にならないので索引に入れない。
    if (points.length >= 2) index.shapes.set(makeKey(feedId, shapeId), points);
  }

  // --- trips ---
  for (const row of readCsv('trips.txt', feedId)) {
    const tripId = (row.trip_id || '').trim();
    if (!tripId) continue;
    const routeId = (row.route_id || '').trim();
    // shape_id 列が空のフィードでは jp_pattern_id へフォールバックする（services/gtfsShapes.js）。
    const shapeId = resolveTripShapeId(row, shapePointsByShapeId);
    index.trips.set(makeKey(feedId, tripId), {
      feedId,
      tripId,
      tripKey: makeKey(feedId, tripId),
      routeId,
      routeKey: makeKey(feedId, routeId),
      serviceId: (row.service_id || '').trim(),
      serviceKey: makeKey(feedId, (row.service_id || '').trim()),
      directionId: Number.parseInt(row.direction_id || '0', 10) || 0,
      headsign: (row.trip_headsign || '').trim(),
      shapeId,
      shapeKey: shapeId ? makeKey(feedId, shapeId) : null,
      firstDepartureSeconds: NaN,
      frequencies: null
    });
  }

  // --- stop_times ---
  for (const row of readCsv('stop_times.txt', feedId)) {
    const tripId = (row.trip_id || '').trim();
    const stopId = (row.stop_id || '').trim();
    if (!tripId || !stopId) continue;
    const tripKey = makeKey(feedId, tripId);
    if (!index.trips.has(tripKey)) continue;

    const entry = {
      tripKey,
      stopKey: makeKey(feedId, stopId),
      stopId,
      sequence: Number.parseInt(row.stop_sequence, 10),
      arrivalSeconds: parseGtfsTime(row.arrival_time),
      departureSeconds: parseGtfsTime(row.departure_time || row.arrival_time),
      stopHeadsign: (row.stop_headsign || '').trim(),
      pickupType: Number.parseInt(row.pickup_type || '0', 10) || 0,
      dropOffType: Number.parseInt(row.drop_off_type || '0', 10) || 0
    };
    if (!index.stopTimesByTrip.has(tripKey)) index.stopTimesByTrip.set(tripKey, []);
    index.stopTimesByTrip.get(tripKey).push(entry);
  }

  // --- calendar / calendar_dates ---
  const services = new Map();
  for (const row of readCsv('calendar.txt', feedId)) {
    const serviceId = (row.service_id || '').trim();
    if (!serviceId) continue;
    const days = DAY_COLUMNS.map((col) => row[col] === '1');
    services.set(serviceId, {
      feedId,
      serviceId,
      days,
      startDate: (row.start_date || '').trim(),
      endDate: (row.end_date || '').trim(),
      label: serviceLabelFromDays(days),
      exceptions: new Map()
    });
  }
  const additionDates = [];
  for (const row of readCsvIfExists('calendar_dates.txt', feedId)) {
    const serviceId = (row.service_id || '').trim();
    const date = (row.date || '').trim();
    if (!serviceId || !date) continue;
    if ((Number.parseInt(row.exception_type, 10) || 0) === 1) additionDates.push(date);
    if (!services.has(serviceId)) {
      // calendar.txt に無く calendar_dates.txt にだけ現れる運行日（特定日ダイヤ）
      services.set(serviceId, {
        feedId,
        serviceId,
        days: [false, false, false, false, false, false, false],
        startDate: '',
        endDate: '',
        label: '特定日',
        exceptions: new Map()
      });
    }
    services.get(serviceId).exceptions.set(date, Number.parseInt(row.exception_type, 10) || 0);
  }
  index.services.set(feedId, services);

  // --- feed_info（任意ファイル）＋ GTFSデータの有効期間 ---
  const feedInfoRow = readCsvIfExists('feed_info.txt', feedId)[0] || {};
  const calendarRanges = Array.from(services.values()).map((s) => ({
    startDate: s.startDate,
    endDate: s.endDate
  }));
  index.feedValidity.set(
    feedId,
    computeFeedValidity(
      { feedStartDate: feedInfoRow.feed_start_date, feedEndDate: feedInfoRow.feed_end_date },
      calendarRanges,
      additionDates
    )
  );

  // --- frequencies（任意ファイル） ---
  const frequenciesByTripId = readFrequenciesByTripId(feedId, readCsv);
  if (frequenciesByTripId.size > 0) {
    for (const [tripId, rows] of frequenciesByTripId.entries()) {
      const trip = index.trips.get(makeKey(feedId, tripId));
      if (trip) trip.frequencies = rows;
    }
  }

  return feedStops;
}

/**
 * バス停（標柱の集合）を組み立てる。仕様書 3.1 の統合ルールを実装する。
 *  1. stop_id（ベースID）が同じで stop_name も一致 → 同一バス停として統合（キー = ベースID）
 *  2. stop_id が同じで stop_name が異なる → 別バス停（キー = {gtfs_id}_{stop_id}）
 *  3. さらに、同名かつ SAME_NAME_MERGE_RADIUS_METERS 以内のバス停同士を1件に統合する。
 *     検索結果を「重複のないユニークなバス停名」で出す（仕様書 3.3）ために必要で、
 *     事業者をまたいで同じ物理バス停が別IDで登録されているケース
 *     （例: 松本バスターミナルが gtfs_1 と gtfs_2 の双方に存在する）を吸収する。
 *     統合されて使われなくなったキーは alias として残し、古いURLでも開けるようにする。
 */
function buildGroups(index, stopsByFeed) {
  // --- 1. フィード内で「ベースID × バス停名」ごとにまとめる ---
  const buckets = new Map();
  for (const stops of stopsByFeed.values()) {
    for (const stop of stops) {
      if (stop.locationType === 1) continue; // 親停留所そのものは標柱ではない
      const bucketKey = `${stop.feedId}${SEP}${stop.baseId}${SEP}${stop.name}`;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, {
          feedId: stop.feedId,
          baseId: stop.baseId,
          name: stop.name,
          platforms: []
        });
      }
      buckets.get(bucketKey).platforms.push(stop);
    }
  }

  // --- 2. ベースIDごとに、名前が一致するかどうかで統合/分離を決める ---
  const bucketsByBaseId = new Map();
  for (const bucket of buckets.values()) {
    if (!bucketsByBaseId.has(bucket.baseId)) bucketsByBaseId.set(bucket.baseId, []);
    bucketsByBaseId.get(bucket.baseId).push(bucket);
  }

  const groups = [];
  const usedKeys = new Set();
  // 万一キーが衝突した場合でも別バス停として区別できるよう連番を付ける
  const uniqueKey = (candidate) => {
    let key = candidate;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${candidate}-${suffix}`;
      suffix += 1;
    }
    usedKeys.add(key);
    return key;
  };

  for (const [baseId, list] of bucketsByBaseId.entries()) {
    const names = new Set(list.map((bucket) => bucket.name));
    if (names.size === 1) {
      // 完全一致（同一IDかつ同一名）→ 全フィードぶんを1つのバス停として統合
      groups.push(createGroup(uniqueKey(baseId), list));
    } else {
      // ID重複・名前相違 → {gtfs_id}_{stop_id} で分離する
      for (const bucket of list) {
        groups.push(createGroup(uniqueKey(`${bucket.feedId}_${baseId}`), [bucket]));
      }
    }
  }

  // --- 3. 同名・近接のバス停を統合する ---
  const groupsByName = new Map();
  for (const group of groups) {
    const nameKey = normalizeSearchText(group.name);
    if (!groupsByName.has(nameKey)) groupsByName.set(nameKey, []);
    groupsByName.get(nameKey).push(group);
  }

  for (const sameName of groupsByName.values()) {
    if (sameName.length === 1) {
      registerGroup(index, sameName[0], []);
      continue;
    }
    // 近接クラスタごとにまとめる（距離が離れている同名バス停は別扱いのまま）
    const clusters = [];
    for (const group of sameName) {
      const target = clusters.find((cluster) =>
        cluster.some((member) => distanceBetween(member, group) <= SAME_NAME_MERGE_RADIUS_METERS)
      );
      if (target) target.push(group);
      else clusters.push([group]);
    }

    for (const cluster of clusters) {
      // 標柱数が多いものを代表にする（同数ならキー順で安定させる）
      const sorted = cluster
        .slice()
        .sort((a, b) => b.platforms.length - a.platforms.length || (a.groupKey < b.groupKey ? -1 : 1));
      const primary = sorted[0];
      const merged = sorted.slice(1);
      for (const other of merged) {
        primary.platforms.push(...other.platforms);
      }
      recalcGroupCenter(primary);
      registerGroup(index, primary, merged.map((other) => other.groupKey));
    }
  }
}

function createGroup(groupKey, buckets) {
  const platforms = [];
  for (const bucket of buckets) platforms.push(...bucket.platforms);
  const group = {
    groupKey,
    name: buckets[0].name,
    platforms,
    lat: 0,
    lon: 0
  };
  recalcGroupCenter(group);
  return group;
}

function recalcGroupCenter(group) {
  const valid = group.platforms.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (valid.length === 0) return;
  group.lat = valid.reduce((sum, p) => sum + p.lat, 0) / valid.length;
  group.lon = valid.reduce((sum, p) => sum + p.lon, 0) / valid.length;
}

function distanceBetween(a, b) {
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  return haversineDistanceMeters(a.lat, a.lon, b.lat, b.lon);
}

/**
 * 標柱（のりば）を座標の近さでクラスタリングする純粋関数。
 * `points[i]` は `{ lat, lon }` を持つ任意のオブジェクト。返り値は入力オブジェクトの
 * 配列（クラスタ）の配列で、同じクラスタ内の点はいずれかの点から radiusMeters 以内にある。
 * 座標を持たない点は必ず単独クラスタになる。
 *
 * 単リンク（single-linkage）でまとめる。radiusMeters が 0.1m と極小のため
 * 連鎖的な膨張は起きず、実データでは「同一地点に置かれた2フィードの標柱」だけが1つになる。
 */
function clusterByProximity(points, radiusMeters) {
  const clusters = [];
  for (const point of points) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      clusters.push([point]);
      continue;
    }
    const target = clusters.find((cluster) =>
      cluster.some(
        (member) =>
          Number.isFinite(member.lat) &&
          Number.isFinite(member.lon) &&
          haversineDistanceMeters(member.lat, member.lon, point.lat, point.lon) <= radiusMeters
      )
    );
    if (target) target.push(point);
    else clusters.push([point]);
  }
  return clusters;
}

/**
 * バス停グループ内の標柱のうち、座標が PLATFORM_MERGE_RADIUS_METERS 以内のものどうしを
 * 「同じ物理のりば」として1本に畳む（docs/timetable-search.md「のりばの座標統合」）。
 *
 * 2つのGTFSフィードは同一の物理のりばをそれぞれ別 stop_id で登録しているため、
 * これをやらないと「乗り場別」表示で同じのりばが2枚のカードに割れ、時刻表も
 * フィードごとに分断される。バス停の統合（buildGroups 手順3）が「バス停＝標柱の集合」を
 * 束ねるのに対し、こちらは「標柱そのもの」を束ねる別レイヤーである。
 *
 * 代表標柱は getPlatformDisplayNameFeedPriority() の順（既定でぐるっと松本バス1）で選び、
 * 表示名・よみがな・platform_code・URL上のキーは代表標柱のものを使う。畳まれた標柱は
 * `mergedInto` で代表を指し、`resolvePlatform` が旧 ?platform= でも引けるようにする。
 * 代表標柱には `mergedPlatforms`（畳まれた標柱の配列）をぶら下げ、時刻表・停車路線の
 * 集計時に畳まれた側の stop_times も合算する（platformStopTimes 参照）。
 */
function mergeCoincidentPlatforms(group) {
  if (group.platforms.length < 2) return;

  const priority = getPlatformDisplayNameFeedPriority();
  const feedRank = (platform) => {
    const i = priority.indexOf(platform.feedId);
    return i === -1 ? priority.length : i;
  };

  const clusters = clusterByProximity(group.platforms, PLATFORM_MERGE_RADIUS_METERS);
  if (clusters.length === group.platforms.length) return; // 畳むものが無い

  const kept = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      kept.push(cluster[0]);
      continue;
    }
    // 代表標柱: 表示名を採るフィードの優先順 → stop_id の安定順
    const sorted = cluster
      .slice()
      .sort((a, b) => feedRank(a) - feedRank(b) || a.stopKey.localeCompare(b.stopKey));
    const primary = sorted[0];
    const mergedAway = sorted.slice(1);

    primary.mergedPlatforms = [...(primary.mergedPlatforms || []), ...mergedAway];
    for (const other of mergedAway) {
      other.mergedInto = primary.stopKey;
      // 畳まれた側の groupKey は既に同じグループを指すが、buildGroups 手順3で
      // 別グループから寄せられた直後でも確実に一致させておく。
      other.groupKey = group.groupKey;
    }
    kept.push(primary);
  }

  group.platforms = kept;
  recalcGroupCenter(group);
}

/**
 * 標柱1本ぶんの stop_times を返す。座標統合で畳まれた標柱があれば、その stop_times も
 * 合算する（mergeCoincidentPlatforms 参照）。並び順は呼び出し側の既存挙動に委ねる。
 */
function platformStopTimes(index, platform) {
  const own = index.stopTimeIndex.get(platform.stopKey) || [];
  if (!platform.mergedPlatforms || platform.mergedPlatforms.length === 0) return own;
  const all = own.slice();
  for (const merged of platform.mergedPlatforms) {
    all.push(...(index.stopTimeIndex.get(merged.stopKey) || []));
  }
  return all;
}

/**
 * 完成したバス停をインデックスへ登録し、検索用テキストと標柱の並び順を確定させる。
 */
function registerGroup(index, group, aliasKeys) {
  // 同一物理地点の標柱（2フィードの重複登録など）を先に1本へ畳む。
  mergeCoincidentPlatforms(group);

  group.platforms.sort((a, b) => {
    const ac = a.platformCode || '';
    const bc = b.platformCode || '';
    if (ac !== bc) return ac.localeCompare(bc, 'ja', { numeric: true });
    return a.stopId.localeCompare(b.stopId, 'ja', { numeric: true });
  });

  // 検索テキスト・所属フィードは、畳まれた標柱ぶんも含めて集める
  // （表記のゆれる別フィードの名前でも同じバス停に辿り着けるようにするため）。
  const allPlatforms = group.platforms.flatMap((p) => [p, ...(p.mergedPlatforms || [])]);

  const reading = group.platforms.find((p) => p.hiragana) || group.platforms[0] || {};
  group.hiragana = reading.hiragana || '';
  group.katakana = reading.katakana || '';
  group.romaji = reading.romaji || '';

  const searchTexts = new Set();
  for (const platform of allPlatforms) {
    for (const text of platform.searchTexts) searchTexts.add(text);
    platform.groupKey = group.groupKey;
  }
  group.searchTexts = Array.from(searchTexts);
  group.aliases = aliasKeys;
  group.feedIds = Array.from(new Set(allPlatforms.map((p) => p.feedId)));

  index.groups.set(group.groupKey, group);
  for (const alias of aliasKeys) {
    index.groupAliases.set(alias, group.groupKey);
  }
}

/**
 * バス停ごとに「どの路線が停車するか」を集計する（検索結果・凡例で使う）。
 */
function attachRoutesToGroups(index) {
  const routeKeysByStopKey = new Map();
  for (const [tripKey, stopTimes] of index.stopTimesByTrip.entries()) {
    const trip = index.trips.get(tripKey);
    if (!trip) continue;
    for (const stopTime of stopTimes) {
      if (!routeKeysByStopKey.has(stopTime.stopKey)) routeKeysByStopKey.set(stopTime.stopKey, new Set());
      routeKeysByStopKey.get(stopTime.stopKey).add(trip.routeKey);
    }
  }

  for (const group of index.groups.values()) {
    const routeKeys = new Set();
    for (const platform of group.platforms) {
      // 座標統合で畳まれた標柱の停車路線も合算する（mergeCoincidentPlatforms 参照）。
      for (const stop of [platform, ...(platform.mergedPlatforms || [])]) {
        const keys = routeKeysByStopKey.get(stop.stopKey);
        if (keys) for (const key of keys) routeKeys.add(key);
      }
    }
    group.routeKeys = Array.from(routeKeys);
  }
}

async function buildIndex() {
  const startedAt = Date.now();
  const feedIds = await listFeedIds();

  const index = {
    builtAt: Date.now(),
    feedIds: [],
    routes: new Map(),
    stops: new Map(),
    trips: new Map(),
    // 線形（shapes.txt）。makeKey(feedId, shapeId) → [[lat, lon], ...]。
    // 便詳細「地図で表示」にその便の経路を重ねるためだけに持つ（描画専用）。
    shapes: new Map(),
    stopTimesByTrip: new Map(),
    // 標柱(stop_id)ごとの stop_times。バス停の時刻表を組むときの入口になる。
    stopTimeIndex: new Map(),
    services: new Map(),
    // フィードID → { startDate, endDate }（"YYYYMMDD"）または null。GTFSデータの有効期間。
    feedValidity: new Map(),
    groups: new Map(),
    groupAliases: new Map()
  };

  const stopsByFeed = new Map();
  for (const feedId of feedIds) {
    try {
      stopsByFeed.set(feedId, loadFeed(index, feedId));
      index.feedIds.push(feedId);
    } catch (err) {
      console.error(`[gtfsTimetable] feed=${feedId} の読み込みに失敗（このフィードを除外して継続）:`, err.message);
    }
  }

  // 便ごとの stop_times を順序どおりに整え、始発時刻を確定させたうえで、
  // 標柱ごとの逆引き（stopTimeIndex）を作る。
  for (const [tripKey, stopTimes] of index.stopTimesByTrip.entries()) {
    stopTimes.sort((a, b) => a.sequence - b.sequence);
    const trip = index.trips.get(tripKey);
    if (!trip) continue;
    const first = stopTimes.find((st) => Number.isFinite(st.departureSeconds));
    trip.firstDepartureSeconds = first ? first.departureSeconds : NaN;

    // 便の中での位置（0起点）。経路検索（gtfsRouteSearch.js）が
    // 「乗車したバス停から先だけを走査する」ために使う。
    stopTimes.forEach((stopTime, i) => { stopTime.tripIndex = i; });

    for (const stopTime of stopTimes) {
      if (!index.stopTimeIndex.has(stopTime.stopKey)) index.stopTimeIndex.set(stopTime.stopKey, []);
      index.stopTimeIndex.get(stopTime.stopKey).push(stopTime);
    }
  }

  buildGroups(index, stopsByFeed);
  attachRoutesToGroups(index);

  // 座標統合（mergeCoincidentPlatforms）で畳まれた標柱数
  let foldedPlatforms = 0;
  for (const group of index.groups.values()) {
    for (const platform of group.platforms) foldedPlatforms += (platform.mergedPlatforms || []).length;
  }

  console.log(
    `[gtfsTimetable] インデックス構築完了: ${index.feedIds.length}フィード / ` +
    `バス停${index.groups.size}件 / 標柱${index.stops.size - foldedPlatforms}件` +
    `（座標統合で${foldedPlatforms}件を畳込）/ 便${index.trips.size}件 ` +
    `(${Date.now() - startedAt}ms)`
  );
  return index;
}

/**
 * インデックスを取得する（未構築・期限切れなら構築する）。
 * 同時に複数リクエストが来ても構築は1回だけ走らせる。
 */
async function getIndex() {
  if (cachedIndex && Date.now() - cachedIndex.builtAt < INDEX_TTL_MS) return cachedIndex;
  if (buildingPromise) return buildingPromise;

  buildingPromise = buildIndex()
    .then((index) => {
      cachedIndex = index;
      return index;
    })
    .finally(() => {
      buildingPromise = null;
    });

  return buildingPromise;
}

/** GTFS更新後にインデックスを作り直させる（gtfsFeedManager から呼ばれる）。 */
function invalidateTimetableIndex() {
  cachedIndex = null;
}

/* ==========================================================
 * 運行日（カレンダー）
 * ========================================================== */

/**
 * 指定日に有効な service を、フィードごとに返す。
 *
 * ※ gtfsCalendar.js の getActiveServiceIds() とは別実装である。
 *    あちらは「当日便の生成」専用で、DB保存形式（feedId:service_id）の文字列を返す。
 *    こちらは任意の日付を指定でき、start_date/end_date の有効期間チェックと
 *    表示用ラベル（平日/土曜…）を持つ。用途が違うので統合しないこと。
 */
function getActiveServices(index, dateStr) {
  const compact = toCompactDate(dateStr);
  const dow = dayOfWeekOf(dateStr);
  const active = new Map();
  if (!compact || Number.isNaN(dow)) return active;

  for (const [feedId, services] of index.services.entries()) {
    const activeInFeed = new Map();
    for (const service of services.values()) {
      const exception = service.exceptions.get(compact);
      let isActive;
      if (exception === 1) {
        isActive = true;
      } else if (exception === 2) {
        isActive = false;
      } else {
        const inPeriod =
          (!service.startDate || compact >= service.startDate) &&
          (!service.endDate || compact <= service.endDate);
        isActive = inPeriod && service.days[dow] === true;
      }
      if (isActive) {
        activeInFeed.set(service.serviceId, {
          feedId,
          serviceId: service.serviceId,
          label: service.label,
          isException: exception === 1
        });
      }
    }
    active.set(feedId, activeInFeed);
  }
  return active;
}

/* ==========================================================
 * 検索（仕様書 3.3）
 * ========================================================== */

/**
 * バス停名の検索。漢字・ひらがな・カタカナ・ローマ字（大文字小文字/全半角不問）に対応し、
 * 前方一致を優先しつつ部分一致も返す。結果はバス停単位（＝ユニークな名前）で重複しない。
 */
async function searchStops(query, limit = 20) {
  const index = await getIndex();
  const q = normalizeSearchText(query);
  if (!q) return [];

  const matches = [];
  for (const group of index.groups.values()) {
    let best = null;
    for (const text of group.searchTexts) {
      if (text.startsWith(q)) {
        best = 0;
        break;
      }
      if (text.includes(q)) best = best === null ? 1 : best;
    }
    if (best === null) continue;
    matches.push({ group, rank: best });
  }

  matches.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.group.name.length !== b.group.name.length) return a.group.name.length - b.group.name.length;
    return a.group.name.localeCompare(b.group.name, 'ja');
  });

  return matches.slice(0, limit).map(({ group }) => serializeStopSummary(index, group));
}

/**
 * バス停マップ用の全バス停一覧。groupsは既に「同名で標柱違いは代表点1件」に
 * 統合済み（このファイル冒頭の説明・buildGroups参照）なので、そのまま返せばよい。
 */
async function listStopsForMap() {
  const index = await getIndex();
  return Array.from(index.groups.values()).map((group) => serializeStopSummary(index, group));
}

/**
 * 指定した緯度経度から近い順にバス停を返す（バス停検索・経路検索画面の「近くのバス停」候補用）。
 * 座標を持たないバス停は対象外。
 */
async function searchNearbyStops(lat, lon, limit = 5) {
  const index = await getIndex();
  const candidates = [];
  for (const group of index.groups.values()) {
    if (!Number.isFinite(group.lat) || !Number.isFinite(group.lon)) continue;
    candidates.push({ group, distanceMeters: haversineDistanceMeters(lat, lon, group.lat, group.lon) });
  }
  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return candidates.slice(0, limit).map(({ group, distanceMeters }) => ({
    ...serializeStopSummary(index, group),
    distanceMeters: Math.round(distanceMeters),
    // 表示する距離は直線距離のまま。徒歩分数だけ迂回・信号待ちを織り込んだ推定にする（utils/geo.js）。
    walkMinutes: estimateWalkMinutes(distanceMeters)
  }));
}

/**
 * stopKeyの配列から、それぞれが属するバス停グループのサマリーを返す
 * （お気に入りバス停の候補表示用）。別名キー・標柱のstop_idどちらでも解決できる
 * よう resolveGroup を使う。重複するグループは1件にまとめ、渡した順序を保つ。
 */
async function getStopSummariesByKeys(stopKeys) {
  const index = await getIndex();
  const seen = new Set();
  const result = [];
  for (const stopKey of stopKeys) {
    const group = resolveGroup(index, stopKey);
    if (!group || seen.has(group.groupKey)) continue;
    seen.add(group.groupKey);
    result.push(serializeStopSummary(index, group));
  }
  return result;
}

function serializeStopSummary(index, group) {
  return {
    stopKey: group.groupKey,
    stopName: group.name,
    nameHiragana: group.hiragana || null,
    nameKatakana: group.katakana || null,
    nameRomaji: group.romaji || null,
    lat: group.lat,
    lon: group.lon,
    platformCount: group.platforms.length,
    feedIds: group.feedIds,
    routes: (group.routeKeys || [])
      .map((routeKey) => index.routes.get(routeKey))
      .filter(Boolean)
      .map((route) => ({
        routeId: route.routeId,
        feedId: route.feedId,
        name: route.name,
        shortName: route.shortName,
        color: route.color,
        textColor: route.textColor
      }))
  };
}

/* ==========================================================
 * バス停詳細・時刻表（仕様書 3.4）
 * ========================================================== */

/** URLのstop_key（別名を含む）からバス停を解決する。 */
function resolveGroup(index, stopKey) {
  if (!stopKey) return null;
  const direct = index.groups.get(stopKey);
  if (direct) return direct;
  const canonical = index.groupAliases.get(stopKey);
  if (canonical) return index.groups.get(canonical) || null;

  // stop_id（標柱）で指定された場合は、その標柱が属するバス停を返す
  for (const stop of index.stops.values()) {
    if (stop.stopId === stopKey && stop.groupKey) return index.groups.get(stop.groupKey) || null;
  }
  return null;
}

/**
 * platform クエリの解決。
 * 原則は stop_id（例: 100_01）だが、複数フィードにまたがるバス停では
 * stop_id が衝突しうるため {feed_id}_{stop_id} 形式も受け付ける。
 */
function resolvePlatform(group, platformParam) {
  if (!platformParam) return null;
  const exact = group.platforms.filter((p) => p.stopId === platformParam);
  if (exact.length === 1) return exact[0];
  const prefixed = group.platforms.find((p) => `${p.feedId}_${p.stopId}` === platformParam);
  if (prefixed) return prefixed;
  // 座標統合で畳まれた標柱の旧 ?platform=（stop_id / feedId_stop_id 両形式）でも
  // 代表標柱を返す（mergeCoincidentPlatforms 参照）。
  const viaMerged = group.platforms.find((p) =>
    (p.mergedPlatforms || []).some(
      (m) => m.stopId === platformParam || `${m.feedId}_${m.stopId}` === platformParam
    )
  );
  if (viaMerged) return viaMerged;
  return exact[0] || null;
}

/**
 * 便の stop_headsign（無ければ trip_headsign）を返す（仕様書 3.4 A）。
 */
function resolveHeadsign(stopTime, trip) {
  return stopTime.stopHeadsign || trip.headsign || '';
}

/**
 * URLの stop_key（別名可）と ?platform= の値から、乗り場（のりば）を軽量に解決する。
 * 時刻表（発車一覧）は組み立てないので getStopTimetable より安い。
 * バス停お知らせ配信（services/busstopNotices.js）の突合キー
 * （乗り場単位＝feedId + stopId、バス停単位＝stopKey + aliases）を得るのに使う。
 *
 * @returns {null | {
 *   stopKey: string, stopName: string, aliases: string[], hasMultiplePlatforms: boolean,
 *   platform: null | { feedId, stopId, platformKey, platformCode },
 *   platforms: Array<{ feedId, stopId, platformKey, platformCode }>
 * }}
 *   バス停が見つからなければ null。platform は、?platform= が解決できたとき、または
 *   乗り場が1か所だけのときにその1件（＝「全乗り場統合表示」でも実体は1のりば）。
 *   乗り場が複数あって未指定なら platform は null（統合表示）。
 */
async function resolvePlatformRef(stopKey, platformParam) {
  const index = await getIndex();
  const group = resolveGroup(index, stopKey);
  if (!group) return null;

  let platform = resolvePlatform(group, platformParam);
  if (!platform && group.platforms.length === 1) platform = group.platforms[0];

  const toRef = (p) => ({
    feedId: p.feedId,
    stopId: p.stopId,
    platformKey: `${p.feedId}_${p.stopId}`,
    platformCode: p.platformCode || ''
  });

  return {
    stopKey: group.groupKey,
    stopName: group.name,
    // 統合されて使われなくなった旧キー。バス停単位お知らせ（scope='stop'）の突合で
    // 正キーと一緒に照合し、GTFS再取込で代表キーが変わっても拾えるようにする。
    aliases: group.aliases || [],
    hasMultiplePlatforms: group.platforms.length > 1,
    platform: platform ? toRef(platform) : null,
    platforms: group.platforms.map(toRef)
  };
}

/**
 * リアルタイムDB側のバス停識別子（feedId + 生のGTFS stop_id。リアルタイムDBの`stops`テーブルが
 * そのまま保持している値）から、時刻表検索用GTFSインデックスの乗り場（のりば）を解決する。
 *
 * resolveGroup()の「stopKeyとして生のstop_idを渡されたときのフォールバック」（stopの
 * groupKeyの再スキャン）はraw stop_idだけでの線形探索でフィード横断の衝突リスクがあるため、
 * こちらは index.stops のキー（makeKey(feedId, stopId)）で feedId込みの一意なキーとして
 * 直接引く。座標統合で畳まれた標柱（mergeCoincidentPlatforms）でも、その標柱自身の
 * feedId_stopIdをplatformParamとしてresolvePlatform()に渡すことで、既存の
 * 「畳まれた側のキーからでも代表標柱を引ける」フォールバックがそのまま効く。
 * リアルタイム運行状況画面（カード表示・基本表示共通）のバス停タップから使う。
 */
async function resolvePlatformByFeedStop(feedId, gtfsStopId) {
  const index = await getIndex();
  const stop = index.stops.get(makeKey(feedId, String(gtfsStopId)));
  if (!stop || !stop.groupKey) return null;
  const group = index.groups.get(stop.groupKey);
  if (!group) return null;

  let platform = resolvePlatform(group, `${stop.feedId}_${stop.stopId}`);
  if (!platform && group.platforms.length === 1) platform = group.platforms[0];

  return {
    stopKey: group.groupKey,
    stopName: group.name,
    platformKey: platform ? `${platform.feedId}_${platform.stopId}` : null
  };
}

/**
 * バス停の時刻表を組み立てる。
 * @param {string} stopKey URLのバス停キー
 * @param {{date?: string, platform?: string}} options
 */
async function getStopTimetable(stopKey, { date, platform } = {}) {
  const index = await getIndex();
  const group = resolveGroup(index, stopKey);
  if (!group) return null;

  const serviceDate = toCompactDate(date) ? date : todayString();
  const activeServices = getActiveServices(index, serviceDate);
  const selectedPlatform = resolvePlatform(group, platform);
  const targetPlatforms = selectedPlatform ? [selectedPlatform] : group.platforms;

  const departures = [];
  const legend = new Map();

  for (const stop of targetPlatforms) {
    const entries = platformStopTimes(index, stop);
    for (const stopTime of entries) {
      const trip = index.trips.get(stopTime.tripKey);
      if (!trip) continue;
      const feedServices = activeServices.get(trip.feedId);
      if (!feedServices || !feedServices.has(trip.serviceId)) continue;
      // 乗車できない停車（終点や通過扱いの停車）は発車時刻表に載せない
      if (stopTime.pickupType === 1) continue;
      if (!Number.isFinite(stopTime.departureSeconds)) continue;

      const route = index.routes.get(trip.routeKey) || null;
      // 循環路線などで同じ「バス停グループ」（＝表示名。実体は複数標柱の統合）を
      // 1便の中で複数回通る場合、この便の中でこのstopTimeが何回目の通過か（0始まり）
      // を求めておく。リアルタイム突合時に「同名バス停の何回目の通過に対応する定刻か」
      // を一致させるために使う（busStopApproaching.js / realtimeTripLookup.js参照。
      // DB側は標柱を持たずバス停名でしか突き合わせられないため、通過回数という
      // 両者に共通する単位に変換して橋渡しする）。
      // ⚠️ groupKey（統合後のバス停）単位で数えること。生のGTFS stop_id単位で数えると、
      // 往路・復路で道路の反対側など別の標柱（＝別stop_id、同名で統合されグループは同じ）
      // を1回ずつ通る一般的なケースを「どちらも0回目」と誤判定し、DB側の名前一致と
      // 噛み合わなくなる（実データで確認済みの不具合）。
      const tripStopTimes = index.stopTimesByTrip.get(trip.tripKey) || [];
      const stopVisitIndex = tripStopTimes.filter((st) => {
        const stStop = index.stops.get(st.stopKey);
        return stStop && stStop.groupKey === stop.groupKey && st.sequence <= stopTime.sequence;
      }).length - 1;
      for (const instance of expandTripInstances(trip, stopTime)) {
        departures.push({
          seconds: instance.departureSeconds,
          time: formatClock(instance.departureSeconds),
          hour: Math.floor(instance.departureSeconds / 3600),
          minute: Math.floor((instance.departureSeconds % 3600) / 60),
          feedId: trip.feedId,
          routeId: trip.routeId,
          tripId: trip.tripId,
          tripDepartureTime: formatHhmm(instance.tripStartSeconds),
          serviceId: trip.serviceId,
          directionId: trip.directionId,
          headsign: resolveHeadsign(stopTime, trip),
          routeName: route ? route.name : trip.routeId,
          routeShortName: route ? route.shortName : '',
          routeColor: route ? route.color : '',
          routeTextColor: route ? route.textColor : '',
          agencyName: route ? route.agencyName : '',
          platformStopId: stop.stopId,
          platformKey: `${stop.feedId}_${stop.stopId}`,
          platformCode: stop.platformCode || '',
          stopVisitIndex,
          isFrequency: instance.isFrequency
        });

        if (route && !legend.has(route.routeKey)) {
          legend.set(route.routeKey, {
            routeId: route.routeId,
            feedId: route.feedId,
            name: route.name,
            shortName: route.shortName,
            color: route.color,
            textColor: route.textColor,
            agencyName: route.agencyName,
            headsigns: new Set()
          });
        }
        if (route) legend.get(route.routeKey).headsigns.add(resolveHeadsign(stopTime, trip));
      }
    }
  }

  departures.sort((a, b) => a.seconds - b.seconds || a.routeId.localeCompare(b.routeId));

  // 時（縦軸）ごとに分（横軸）をまとめる
  const hours = [];
  const hourMap = new Map();
  for (const departure of departures) {
    if (!hourMap.has(departure.hour)) {
      const block = { hour: departure.hour, departures: [] };
      hourMap.set(departure.hour, block);
      hours.push(block);
    }
    hourMap.get(departure.hour).departures.push(departure);
  }
  hours.sort((a, b) => a.hour - b.hour);

  return {
    stop: {
      stopKey: group.groupKey,
      stopName: group.name,
      nameHiragana: group.hiragana || null,
      nameKatakana: group.katakana || null,
      nameRomaji: group.romaji || null,
      lat: group.lat,
      lon: group.lon,
      aliases: group.aliases
    },
    requestedStopKey: stopKey,
    // 標柱が複数ある場合のみ表示モード切替を出す（仕様書 3.4 A）
    hasMultiplePlatforms: group.platforms.length > 1,
    platforms: group.platforms.map((stop) => serializePlatform(index, stop, activeServices)),
    selectedPlatform: selectedPlatform
      ? { stopId: selectedPlatform.stopId, platformKey: `${selectedPlatform.feedId}_${selectedPlatform.stopId}`, platformCode: selectedPlatform.platformCode }
      : null,
    date: serviceDate,
    dayOfWeek: dayOfWeekOf(serviceDate),
    // 選択された日付が現在のGTFSデータの有効期間外かどうか（画面で注意喚起する）
    gtfsValidity: describeDateValidity(index, serviceDate),
    services: collectServiceLabels(activeServices, departures),
    legend: Array.from(legend.values()).map((entry) => ({
      ...entry,
      headsigns: Array.from(entry.headsigns).filter(Boolean)
    })),
    hours,
    totalDepartures: departures.length
  };
}

/**
 * 標柱1本ぶんの情報（地図ピン・方面リスト用）。
 * stop_headsign を路線カラー付きで列挙する（仕様書 3.4 A「方面から選ぶ」）。
 */
function serializePlatform(index, stop, activeServices) {
  const headsigns = new Map();
  const entries = platformStopTimes(index, stop);
  for (const stopTime of entries) {
    const trip = index.trips.get(stopTime.tripKey);
    if (!trip) continue;
    if (stopTime.pickupType === 1) continue;
    if (activeServices) {
      const feedServices = activeServices.get(trip.feedId);
      if (!feedServices || !feedServices.has(trip.serviceId)) continue;
    }
    const route = index.routes.get(trip.routeKey);
    const headsign = resolveHeadsign(stopTime, trip);
    const key = `${trip.routeKey}${SEP}${headsign}`;
    if (!headsigns.has(key)) {
      headsigns.set(key, {
        headsign,
        routeId: trip.routeId,
        feedId: trip.feedId,
        routeName: route ? route.name : trip.routeId,
        routeShortName: route ? route.shortName : '',
        color: route ? route.color : '',
        textColor: route ? route.textColor : '',
        tripCount: 0
      });
    }
    headsigns.get(key).tripCount += 1;
  }

  return {
    stopId: stop.stopId,
    feedId: stop.feedId,
    platformKey: `${stop.feedId}_${stop.stopId}`,
    platformCode: stop.platformCode || '',
    stopName: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    headsigns: Array.from(headsigns.values()).sort((a, b) => b.tripCount - a.tripCount)
  };
}

/** 実際に発車がある service だけを運行区分タグとして返す。 */
function collectServiceLabels(activeServices, departures) {
  const used = new Set(departures.map((d) => `${d.feedId}${SEP}${d.serviceId}`));
  const labels = [];
  for (const [feedId, services] of activeServices.entries()) {
    for (const service of services.values()) {
      if (!used.has(`${feedId}${SEP}${service.serviceId}`)) continue;
      labels.push(service);
    }
  }
  return labels;
}

/**
 * 1つの stop_time から、実際の発車インスタンスを列挙する。
 * frequencies.txt を持つ便は仮想便へ展開する（持たない便は1件だけ返す）。
 */
function expandTripInstances(trip, stopTime) {
  if (!trip.frequencies || trip.frequencies.length === 0 || !Number.isFinite(trip.firstDepartureSeconds)) {
    return [
      {
        departureSeconds: stopTime.departureSeconds,
        tripStartSeconds: Number.isFinite(trip.firstDepartureSeconds)
          ? trip.firstDepartureSeconds
          : stopTime.departureSeconds,
        isFrequency: false
      }
    ];
  }

  return expandFrequencies(trip.frequencies, trip.firstDepartureSeconds).map((instance) => ({
    departureSeconds: stopTime.departureSeconds + (instance.startSeconds - trip.firstDepartureSeconds),
    tripStartSeconds: instance.startSeconds,
    isFrequency: true
  }));
}

/* ==========================================================
 * 便詳細（通過時刻一覧・仕様書 3.5）
 * ========================================================== */

async function getTripDetail(feedId, routeId, tripId, departureTime, { stopId } = {}) {
  const index = await getIndex();
  const trip = index.trips.get(makeKey(feedId, tripId));
  if (!trip) return null;

  const stopTimes = index.stopTimesByTrip.get(trip.tripKey) || [];
  if (stopTimes.length === 0) return null;

  const route = index.routes.get(trip.routeKey) || null;
  const requestedSeconds = parseHhmm(departureTime);
  // frequencies由来の仮想便は、URLの departure_time との差分だけ全体をずらす
  let offsetSeconds = 0;
  if (
    trip.frequencies &&
    trip.frequencies.length > 0 &&
    Number.isFinite(requestedSeconds) &&
    Number.isFinite(trip.firstDepartureSeconds)
  ) {
    offsetSeconds = requestedSeconds - trip.firstDepartureSeconds;
  }

  // 便が通る標柱が座標統合で畳まれている場合、表示名・のりばキー・座標は代表標柱のものを使う
  // （このバス停で ?platform= に載るのは常に代表標柱のため。mergeCoincidentPlatforms 参照）。
  const displayStopFor = (stop) =>
    (stop && stop.mergedInto && index.stops.get(stop.mergedInto)) || stop;
  // 閲覧元 stopId は、この便の実 stop_id でも代表標柱の stop_id（新旧の ?platform= 由来）でも一致させる。
  const matchesRequestedStop = (rawStop) => {
    if (!stopId) return false;
    const display = displayStopFor(rawStop);
    for (const s of new Set([rawStop, display].filter(Boolean))) {
      if (s.stopId === stopId || `${s.feedId}_${s.stopId}` === stopId) return true;
    }
    return false;
  };

  const stops = stopTimes.map((stopTime) => {
    const rawStop = index.stops.get(stopTime.stopKey);
    const stop = displayStopFor(rawStop);
    const isThrough = stopTime.pickupType === 1 && stopTime.dropOffType === 1;
    return {
      sequence: stopTime.sequence,
      stopId: stopTime.stopId,
      stopKey: stop ? stop.groupKey : null,
      platformKey: stop ? `${stop.feedId}_${stop.stopId}` : null,
      stopName: stop ? stop.name : stopTime.stopId,
      platformCode: stop ? stop.platformCode : '',
      lat: stop ? stop.lat : null,
      lon: stop ? stop.lon : null,
      arrivalTime: formatClock(stopTime.arrivalSeconds + offsetSeconds),
      departureTime: formatClock(stopTime.departureSeconds + offsetSeconds),
      isThrough,
      noPickup: stopTime.pickupType === 1,
      noDropOff: stopTime.dropOffType === 1,
      headsign: resolveHeadsign(stopTime, trip),
      // 閲覧元のバス停をハイライトする（仕様書 3.5）
      isCurrent: matchesRequestedStop(rawStop)
    };
  });

  const first = stopTimes.find((st) => Number.isFinite(st.departureSeconds));
  const actualDeparture = first ? formatHhmm(first.departureSeconds + offsetSeconds) : null;

  // 閲覧元バス停の stop_headsign（例:「松本城経由美ヶ原温泉」）があればそれを見出しに使う。
  // 時刻表の分タイルに出ていた行先と、便詳細の見出しが食い違わないようにするため。
  const currentStopTime = stopId
    ? stopTimes.find((st) => matchesRequestedStop(index.stops.get(st.stopKey)))
    : null;
  const displayHeadsign = (currentStopTime && resolveHeadsign(currentStopTime, trip)) || trip.headsign || '';

  return {
    feedId,
    routeId: trip.routeId,
    requestedRouteId: routeId,
    tripId: trip.tripId,
    departureTime: actualDeparture,
    requestedDepartureTime: departureTime || null,
    // URLの時刻と実データがずれている場合（GTFS改訂後の古いURLなど）はフロントで注意表示する
    departureTimeMismatch: Boolean(departureTime) && actualDeparture !== String(departureTime),
    routeName: route ? route.name : trip.routeId,
    routeShortName: route ? route.shortName : '',
    routeColor: route ? route.color : '',
    routeTextColor: route ? route.textColor : '',
    agencyName: route ? route.agencyName : '',
    headsign: displayHeadsign,
    tripHeadsign: trip.headsign || '',
    serviceId: trip.serviceId,
    directionId: trip.directionId,
    // この便が走る経路の線形（GTFS shapes.txt 由来、`[[lat, lon], ...]`）。
    // 便詳細の「地図で表示」に路線カラーで重ねる**描画専用**のデータで、
    // 停車バス停（stops）とは別物。線形を持たない便では null。
    // 路線の全線形ではなくこの便の1本だけを返すこと（往路・復路や枝分かれを
    // まとめて重ねると、この便が通らない道まで経路として見えてしまう）。
    shapeId: trip.shapeId || null,
    shapePoints: (trip.shapeKey && index.shapes.get(trip.shapeKey)) || null,
    stops
  };
}

/** JSTの本日（"YYYY-MM-DD"）。 */
function todayString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

module.exports = {
  getIndex,
  invalidateTimetableIndex,
  searchStops,
  listStopsForMap,
  searchNearbyStops,
  getStopSummariesByKeys,
  getStopTimetable,
  getTripDetail,
  todayString,
  // 経路検索（gtfsRouteSearch.js）が同じインデックス上で探索するために使う。
  // 時刻表検索側の挙動は変えず、参照だけを共有する。
  getActiveServices,
  resolveGroup,
  resolvePlatformRef,
  resolvePlatformByFeedStop,
  resolveHeadsign,
  // 経路検索（gtfsRouteSearch.js）がインデックスから直接判定するのに使う。
  describeDateValidity,
  getDateValidity,
  // テスト・調査用
  parseGtfsTime,
  formatClock,
  formatHhmm,
  parseHhmm,
  clusterByProximity,
  computeFeedValidity,
  PLATFORM_MERGE_RADIUS_METERS
};
