// GTFS frequencies.txt（頻度ベース運行）の読み込みと、仮想便への展開。
//
// 仕様書 3.4:
//   start_time から headway_secs 間隔で end_time まで仮想便を1件ずつ生成し、
//   以降の処理では通常の個別便と完全に同一に扱う。
//   exact_times（0:目安の間隔運行 / 1:厳密な時刻表運行）による扱いの差は設けない。
const fs = require('fs');
const path = require('path');
const { getGtfsDir } = require('./gtfsFeedManager');

const FREQUENCIES_FILE = 'frequencies.txt';

/**
 * GTFSの時刻表記（"07:00:00"。24時を超える "25:10:00" もあり得る）を秒に変換する。
 * @returns {number} 秒。解釈できない場合は NaN。
 */
function parseGtfsTimeToSeconds(value) {
  if (value === null || value === undefined) return NaN;
  const parts = String(value).trim().split(':');
  if (parts.length < 2) return NaN;
  const h = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  const s = parts.length > 2 ? Number.parseInt(parts[2], 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return NaN;
  return h * 3600 + m * 60 + s;
}

/**
 * frequencies.txt が存在するかどうか。
 * このファイルは任意扱いで、無いフィードでも一切のエラーにしない。
 */
function hasFrequenciesFile(feedId) {
  return fs.existsSync(path.join(getGtfsDir(feedId), FREQUENCIES_FILE));
}

/**
 * 1つの便の frequencies 定義から、当日分の仮想便（始発時刻インスタンス）を展開する。
 *
 * 終端は end_time を含まない（t < end_time）。これはGTFS標準の解釈であり、
 * 仕様書 3.4.1 の例（07:00〜09:00 / headway 600秒 → 7:00〜8:50）とも一致する。
 *
 * @param {Array<{start_time:string,end_time:string,headway_secs:number}>} frequencyRows
 * @param {number} baseStartSeconds 元trip（stop_times）の始発時刻（秒）
 * @returns {Array<{frequencyIndex:number, startSeconds:number, offsetMinutes:number}>}
 */
function expandFrequencies(frequencyRows, baseStartSeconds) {
  if (!Array.isArray(frequencyRows) || frequencyRows.length === 0) return [];
  if (!Number.isFinite(baseStartSeconds)) return [];

  const instances = [];
  const seenStartSeconds = new Set();

  // start_time順に処理し、複数行が重なっても連番が安定するようにする
  const sorted = frequencyRows
    .map((row) => ({
      startSeconds: parseGtfsTimeToSeconds(row.start_time),
      endSeconds: parseGtfsTimeToSeconds(row.end_time),
      headwaySecs: Number.parseInt(row.headway_secs, 10)
    }))
    .filter((row) =>
      Number.isFinite(row.startSeconds) &&
      Number.isFinite(row.endSeconds) &&
      Number.isFinite(row.headwaySecs) &&
      row.headwaySecs > 0 &&
      row.endSeconds > row.startSeconds
    )
    .sort((a, b) => a.startSeconds - b.startSeconds);

  for (const row of sorted) {
    for (let t = row.startSeconds; t < row.endSeconds; t += row.headwaySecs) {
      if (seenStartSeconds.has(t)) continue;
      seenStartSeconds.add(t);
      instances.push({
        startSeconds: t,
        // 定刻は分単位で保持しているため、オフセットも分に丸める
        offsetMinutes: Math.round((t - baseStartSeconds) / 60)
      });
    }
  }

  instances.sort((a, b) => a.startSeconds - b.startSeconds);
  return instances.map((inst, index) => ({ ...inst, frequencyIndex: index + 1 }));
}

/**
 * 指定フィードの frequencies.txt を読み込み、GTFS trip_id ごとに行をまとめて返す。
 * ファイルが無い場合は空のMapを返す（エラーにしない）。
 * @returns {Map<string, Array<object>>}
 */
function readFrequenciesByTripId(feedId, readCsv) {
  if (!hasFrequenciesFile(feedId)) return new Map();

  let rows;
  try {
    rows = readCsv(FREQUENCIES_FILE, feedId);
  } catch (err) {
    console.warn(`[gtfsFrequencies] feed=${feedId} frequencies.txt の読み込みに失敗（無視して継続）:`, err.message);
    return new Map();
  }

  const byTripId = new Map();
  for (const row of rows) {
    const tripId = (row.trip_id || '').trim();
    if (!tripId) continue;
    if (!byTripId.has(tripId)) byTripId.set(tripId, []);
    byTripId.get(tripId).push({
      start_time: row.start_time,
      end_time: row.end_time,
      headway_secs: Number.parseInt(row.headway_secs, 10),
      exact_times: Number.parseInt(row.exact_times || '0', 10) || 0
    });
  }
  return byTripId;
}

module.exports = {
  FREQUENCIES_FILE,
  parseGtfsTimeToSeconds,
  hasFrequenciesFile,
  expandFrequencies,
  readFrequenciesByTripId
};
