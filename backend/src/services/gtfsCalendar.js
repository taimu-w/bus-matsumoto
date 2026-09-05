const fs = require('fs');
const path = require('path');
const { getGtfsDir } = require('./gtfsFeedManager');
const { getEnabledGtfsFeedIds } = require('../config/feeds');
const { getServiceDateString, getDayOfWeek: getDayOfWeekJST } = require('../utils/time');

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function readCsv(fileName, feedId = null) {
  const filePath = path.join(getGtfsDir(feedId), fileName);
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (rows.length === 0) return [];

  const headers = parseCsvLine(rows[0]);
  return rows.slice(1).map((row) => {
    const values = parseCsvLine(row);
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });
    return record;
  });
}

/**
 * 有効なGTFSフィードID一覧。取得元は config/feeds.js（コード上の定数）。
 *
 * 旧実装はDBを引き、障害時に `data gtfs/` のディレクトリ名をフィードIDとみなす
 * フォールバックを持っていたが、`.tmp_*` の残骸や無効化したはずの古いフィードを
 * 拾ってしまう「コード上の定義より信頼できない推測」だったため撤去した。
 */
async function getEnabledFeedIds() {
  return getEnabledGtfsFeedIds();
}

/**
 * calendar.txt と calendar_dates.txt を読み込んで、指定日付に有効な
 * DB保存形式の service_id と、フィードごとの読み込み結果を返す。
 * feedId が未指定の場合は全有効フィードを対象にする。
 *
 * 「1件も無い」には2つの意味がある:
 *   (a) カレンダーは読めたが、その日は本当に運行が無い（年末年始の特定日など）
 *   (b) カレンダーが読めなかった（GTFS差し替え中のファイル入れ替え窓・ディスクの瞬断など）
 * 両者を配列の長さだけで区別することはできない。(b) を「運行なし」と確定させると
 * 当日便が0件のまま固定されるため（dailyTripBuilder.ensureDailyTrips）、
 * 呼び出し側が判断できるよう failedFeedIds / complete を返す。
 *
 * calendar_dates.txt はGTFS上の任意ファイルなので、存在しない（ENOENT）だけなら
 * 「例外日なし」として扱い、フィードの失敗にはしない。
 *
 * @returns {{serviceIds: string[], feedsTotal: number, failedFeedIds: string[], complete: boolean}}
 */
async function getActiveServiceIdsWithStatus(date, feedId = null) {
  const yyyymmdd = formatDate(date);
  const feedIds = feedId ? [feedId] : await getEnabledFeedIds();

  // フィード未設定の旧構成では data gtfs 直下の静的GTFSを使う。
  const targetFeedIds = feedIds.length > 0 ? feedIds : [null];
  const activeServiceIds = [];
  const failedFeedIds = [];

  for (const currentFeedId of targetFeedIds) {
    const source = currentFeedId ? `feed=${currentFeedId}` : 'static GTFS';
    let calendarRows;
    let calendarDatesRows;
    try {
      calendarRows = readCsv('calendar.txt', currentFeedId);
    } catch (err) {
      console.warn(`[gtfsCalendar] ${source} の calendar.txt を読めませんでした:`, err.message);
      failedFeedIds.push(currentFeedId === null ? '(static)' : currentFeedId);
      continue;
    }
    try {
      calendarDatesRows = readCsv('calendar_dates.txt', currentFeedId);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // 任意ファイル。無いフィードは「例外日なし」として通常どおり処理する。
        calendarDatesRows = [];
      } else {
        console.warn(`[gtfsCalendar] ${source} の calendar_dates.txt を読めませんでした:`, err.message);
        failedFeedIds.push(currentFeedId === null ? '(static)' : currentFeedId);
        continue;
      }
    }

    const calendarByServiceId = new Map();
    for (const row of calendarRows) {
      calendarByServiceId.set(row.service_id, row);
    }

    const exceptionDates = new Map();
    for (const row of calendarDatesRows) {
      if (row.date !== yyyymmdd) continue;
      if (!exceptionDates.has(row.service_id)) {
        exceptionDates.set(row.service_id, []);
      }
      exceptionDates.get(row.service_id).push(Number.parseInt(row.exception_type, 10));
    }

    for (const [serviceId, calRow] of calendarByServiceId.entries()) {
      const exceptions = exceptionDates.get(serviceId) || [];
      const hasException = exceptions.length > 0;
      let isActive = false;

      if (!hasException) {
        isActive = isServiceActiveOnDayOfWeek(calRow, getDayOfWeek(date));
      } else {
        isActive = exceptions.includes(1) && !exceptions.includes(2);
      }

      if (isActive) {
        // seed.js が複数フィード時に付与する接頭辞に揃える。
        activeServiceIds.push(currentFeedId ? `${currentFeedId}:${serviceId}` : serviceId);
      }
    }
  }

  return {
    serviceIds: activeServiceIds,
    feedsTotal: targetFeedIds.length,
    failedFeedIds,
    complete: failedFeedIds.length === 0
  };
}

/**
 * 有効な service_id の配列だけを返す従来どおりの入口。
 * 読み込み失敗と「本当に運行なし」を区別する必要がある呼び出し側は
 * getActiveServiceIdsWithStatus() を使うこと。
 */
async function getActiveServiceIds(date, feedId = null) {
  const { serviceIds } = await getActiveServiceIdsWithStatus(date, feedId);
  return serviceIds;
}

function isServiceActiveOnDayOfWeek(calRow, dayOfWeek) {
  const dayMap = {
    0: calRow.sunday === '1',
    1: calRow.monday === '1',
    2: calRow.tuesday === '1',
    3: calRow.wednesday === '1',
    4: calRow.thursday === '1',
    5: calRow.friday === '1',
    6: calRow.saturday === '1'
  };
  return dayMap[dayOfWeek] === true;
}

// 曜日・日付はサーバのローカルタイムゾーンに関わらずAsia/Tokyo(JST)で判定する
// （utils/time.jsの実装に委譲）。コンテナがUTCで動く場合、ローカル系メソッド
// （getDay()・getFullYear()等）だとJST 00:00〜09:00に前日の曜日・日付を返し、
// 運行日判定が丸ごと1日ずれるため、JST固定のヘルパーに委譲する。
function getDayOfWeek(date) {
  return getDayOfWeekJST(date);
}

function formatDate(date) {
  return getServiceDateString(date).replace(/-/g, '');
}

module.exports = {
  getActiveServiceIds,
  getActiveServiceIdsWithStatus,
  getDayOfWeek,
  formatDate
};
