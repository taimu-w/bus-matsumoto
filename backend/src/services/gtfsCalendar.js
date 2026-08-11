const fs = require('fs');
const path = require('path');
const { getGtfsDir } = require('./gtfsFeedManager');
const { getEnabledGtfsFeedIds } = require('../config/feeds');

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

// calendar.txt と calendar_dates.txt を読み込んで、
// 指定日付に有効な、DB保存形式の service_id の配列を返す。
// feedId が未指定の場合は全有効フィードを対象にする。
async function getActiveServiceIds(date, feedId = null) {
  const yyyymmdd = formatDate(date);
  const feedIds = feedId ? [feedId] : await getEnabledFeedIds();

  // フィード未設定の旧構成では data gtfs 直下の静的GTFSを使う。
  const targetFeedIds = feedIds.length > 0 ? feedIds : [null];
  const activeServiceIds = [];

  for (const currentFeedId of targetFeedIds) {
    let calendarRows;
    let calendarDatesRows;
    try {
      calendarRows = readCsv('calendar.txt', currentFeedId);
      calendarDatesRows = readCsv('calendar_dates.txt', currentFeedId);
    } catch (err) {
      const source = currentFeedId ? `feed=${currentFeedId}` : 'static GTFS';
      console.warn(`[gtfsCalendar] ${source} のカレンダー読み込みをスキップ:`, err.message);
      continue;
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

  return activeServiceIds;
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

function getDayOfWeek(date) {
  const d = new Date(date);
  return d.getDay();
}

function formatDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

module.exports = {
  getActiveServiceIds
};
