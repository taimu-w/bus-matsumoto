// GTFSのCSV（*.txt）を読み込む共通ユーティリティ。
//
// 既存の gtfsData.js / seed.js / gtfsCalendar.js にも同種のCSVパーサがあるが、
// それらは「必ず存在するファイルを同期的に読む」前提で書かれている。
// 時刻表検索機能は translations.txt のような任意ファイルも扱うため、
// 「無ければ空配列」を返す readCsvIfExists を含むこのモジュールを新設した。
// （既存モジュール側のパーサは挙動を変えないためそのまま残してある）
const fs = require('fs');
const path = require('path');
const { getGtfsDir } = require('../services/gtfsFeedManager');

/**
 * CSVの1行をパースする。ダブルクォート内のカンマ・エスケープ("")に対応。
 */
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

/**
 * CSVテキストをレコード配列へ変換する。
 * 先頭のBOM（GTFS-JPのファイルには付いていることが多い）は取り除く。
 */
function parseCsv(text) {
  const normalized = text.replace(/^﻿/, '');
  const rows = normalized.split(/\r?\n/).filter((line) => line.trim().length > 0);
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
 * 指定フィードのGTFSファイルを読み込む。ファイルが無い場合は例外。
 */
function readCsv(fileName, feedId = null) {
  const filePath = path.join(getGtfsDir(feedId), fileName);
  return parseCsv(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 任意ファイル用。存在しない・読めない場合は空配列を返す（エラーにしない）。
 */
function readCsvIfExists(fileName, feedId = null) {
  const filePath = path.join(getGtfsDir(feedId), fileName);
  if (!fs.existsSync(filePath)) return [];
  try {
    return parseCsv(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[csv] ${fileName} (feed=${feedId}) の読み込みに失敗したため空として扱います:`, err.message);
    return [];
  }
}

module.exports = {
  parseCsvLine,
  parseCsv,
  readCsv,
  readCsvIfExists
};
