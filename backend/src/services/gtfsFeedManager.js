// GTFSフィード管理モジュール
// 複数のGTFS ZIPフィードを自動ダウンロードし、フィードIDごとのディレクトリに展開する。
// 各フィードは独立して管理され、1つのフィードの失敗が他に影響しない。
// 対象フィードの一覧は config/feeds.js（コード上の定数）から取得する。
// feeds テーブルへの書き込みは last_fetched_at / last_status / last_error の
// 稼働状態のみで、構成そのものはDBに持たない。
const fs = require('fs');
const path = require('path');
const fetch = require('cross-fetch');
const AdmZip = require('adm-zip');
const pool = require('../config/db');
const { getEnabledGtfsFeeds } = require('../config/feeds');
const { getRuntimeSetting } = require('./runtimeSettings');

const GTFS_BASE_DIR = path.join(__dirname, '..', '..', '..', 'data gtfs');
const REQUIRED_GTFS_FILES = [
  'agency.txt',
  'routes.txt',
  'trips.txt',
  'stops.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt'
];

// 任意ファイル: ZIPに含まれていれば展開先へ配置するが、無くてもフィードは有効とする。
// frequencies.txt を REQUIRED 側に足してはいけない。現在有効なフィードはいずれも
// このファイルを持たないため、必須にするとGTFS更新が全フィードで失敗する。
//
// translations.txt はバス停名のよみがな・ローマ字（時刻表検索機能で使う）の供給元だが、
// 同じ理由で必須にはしない。無い場合の扱いは gtfsTimetable.js 側で吸収している。
//
// fare_attributes.txt / fare_rules.txt は経路検索の運賃表示（gtfsFare.js）で使う。
// これらも同じ理由で REQUIRED にはしない。無い場合は「運賃不明」として扱い、
// 経路検索自体は成立させる（経路検索機能_改善仕様書 4.1）。
const OPTIONAL_GTFS_FILES = [
  'frequencies.txt',
  'translations.txt',
  'fare_attributes.txt',
  'fare_rules.txt'
];

const MANAGED_GTFS_FILES = [...REQUIRED_GTFS_FILES, ...OPTIONAL_GTFS_FILES];

// 前回のGTFS更新時刻（プロセス内キャッシュ）
let lastGtfsUpdateAt = 0;

/**
 * フィードIDのディレクトリパスを取得する。
 */
function getGtfsDir(feedId) {
  if (!feedId) return GTFS_BASE_DIR;
  return path.join(GTFS_BASE_DIR, feedId);
}

/**
 * フィードIDをroute_idのプレフィックスとして使うためのヘルパー
 * route_idを「feedId:originalRouteId」形式にする
 */
function qualifyRouteId(routeId, feedId) {
  if (!feedId) return routeId;
  // 既にプレフィックス済みならそのまま
  if (typeof routeId === 'string' && routeId.includes(':')) {
    const [prefix] = routeId.split(':');
    if (prefix === feedId) return routeId;
  }
  return `${feedId}:${routeId}`;
}

/**
 * プレフィックス済みroute_idから元のroute_idを復元する
 */
function unqualifyRouteId(qualifiedRouteId, feedId) {
  if (!feedId || !qualifiedRouteId) return qualifiedRouteId;
  const prefix = `${feedId}:`;
  if (typeof qualifiedRouteId === 'string' && qualifiedRouteId.startsWith(prefix)) {
    return qualifiedRouteId.slice(prefix.length);
  }
  return qualifiedRouteId;
}

/**
 * 単一のGTFSフィードをダウンロードして展開する。
 * 失敗してもthrowせず、feedsテーブルにエラー情報を記録してfalseを返す。
 */
async function downloadAndExtractGtfsFeed(client, feed) {
  const feedId = feed.id;
  const feedDir = getGtfsDir(feedId);
  const tmpZipPath = path.join(feedDir, `.tmp_${feedId}.zip`);

  try {
    // フィードディレクトリを作成
    fs.mkdirSync(feedDir, { recursive: true });

    console.log(`[gtfsFeedManager] GTFSダウンロード開始: ${feed.name} (${feed.url})`);

    // ダウンロード
    const response = await fetch(feed.url.trim(), {
      redirect: 'follow',
      timeout: 60000 // 60秒タイムアウト
    });

    if ([429, 502, 503].includes(response.status) || response.status >= 500) {
      const msg = `サーバー負荷または障害。ステータス: ${response.status}`;
      console.warn(`[gtfsFeedManager] ${msg} feed=${feedId}`);
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
        [feedId, msg]
      );
      return false;
    }
    if (response.status !== 200) {
      const msg = `予期しないステータスコード: ${response.status}`;
      console.warn(`[gtfsFeedManager] ${msg} feed=${feedId}`);
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
        [feedId, msg]
      );
      return false;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      const msg = 'ダウンロードデータが空です';
      console.warn(`[gtfsFeedManager] ${msg} feed=${feedId}`);
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
        [feedId, msg]
      );
      return false;
    }

    // 一時ZIPファイルとして保存
    fs.writeFileSync(tmpZipPath, buffer);

    // ZIP展開
    const zip = new AdmZip(tmpZipPath);
    const entries = zip.getEntries();
    const entryNames = new Set(entries.map((e) => e.entryName.replace(/\\/g, '/').split('/').pop()));

    // 必須ファイルの存在チェック
    const missing = REQUIRED_GTFS_FILES.filter((f) => !entryNames.has(f));
    if (missing.length > 0) {
      const msg = `GTFS必須ファイルの欠損: ${missing.join(', ')}`;
      console.error(`[gtfsFeedManager] ${msg} feed=${feedId}`);
      fs.unlinkSync(tmpZipPath);
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
        [feedId, msg]
      );
      return false;
    }

    // 一時ディレクトリに展開してから、成功した場合のみ現在のディレクトリと置き換える
    // （展開途中で失敗しても既存データを壊さないための安全設計）
    const tmpExtractDir = path.join(feedDir, `.tmp_extract_${feedId}`);
    if (fs.existsSync(tmpExtractDir)) {
      fs.rmSync(tmpExtractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpExtractDir, { recursive: true });
    zip.extractAllTo(tmpExtractDir, true);

    // 現在のGTFSファイルを退避
    const backupDir = path.join(feedDir, `.backup_${feedId}`);
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    fs.mkdirSync(backupDir, { recursive: true });

    // 既存のGTFSファイルをバックアップへ移動
    for (const f of MANAGED_GTFS_FILES) {
      const existingPath = path.join(feedDir, f);
      if (fs.existsSync(existingPath)) {
        fs.renameSync(existingPath, path.join(backupDir, f));
      }
    }

    // 新規ファイルを配置
    for (const entry of entries) {
      const entryPath = entry.entryName.replace(/\\/g, '/');
      const fileName = entryPath.split('/').pop();
      if (!fileName) continue;
      // 必須ファイル＋任意ファイルのみ配置（余計なファイルは展開しない）
      if (MANAGED_GTFS_FILES.includes(fileName)) {
        fs.copyFileSync(path.join(tmpExtractDir, entryPath), path.join(feedDir, fileName));
      }
    }

    // 一時ファイル・バックアップをクリーンアップ
    fs.rmSync(tmpExtractDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
    if (fs.existsSync(tmpZipPath)) {
      fs.unlinkSync(tmpZipPath);
    }

    await client.query(
      `UPDATE feeds SET last_fetched_at = now(), last_status = 'ok', last_error = NULL WHERE id = $1`,
      [feedId]
    );

    console.log(`[gtfsFeedManager] GTFS更新完了: ${feed.name} (${feedId})`);
    return true;
  } catch (err) {
    const msg = `GTFS展開エラー: ${err.message}`;
    console.error(`[gtfsFeedManager] ${msg} feed=${feedId}`);
    try {
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
        [feedId, msg]
      );
    } catch (dbErr) {
      console.error(`[gtfsFeedManager] feedsテーブル更新エラー: ${dbErr.message}`);
    }
    // 一時ファイルをクリーンアップ
    try {
      if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath);
    } catch (cleanupErr) {
      // 無視
    }
    return false;
  }
}

/**
 * 指定フィードのGTFSファイルがディスク上に揃っているか確認し、
 * 1つでも欠けていれば（コンテナ再作成等でdata gtfs/を失った場合など）
 * 更新間隔に関係なく強制的に再取得する。
 * @returns {boolean} ダウンロードを実行したか（何もしなければfalse）
 */
async function ensureGtfsFilesPresent(client, feed) {
  const feedDir = getGtfsDir(feed.id);
  const missing = REQUIRED_GTFS_FILES.some((f) => !fs.existsSync(path.join(feedDir, f)));
  if (!missing) return false;

  console.log(`[gtfsFeedManager] GTFSファイル欠損を検知、再取得します: ${feed.name} (${feed.id})`);
  await downloadAndExtractGtfsFeed(client, feed);
  return true;
}

/**
 * 全GTFSフィードを更新する。
 * 各フィードは独立して処理され、1つの失敗が他に影響しない。
 * GTFS_UPDATE_INTERVAL_MIN（分）で更新間隔を制御する。0以下の場合は毎回更新する。
 * @returns {{updated: number, failed: number, skipped: boolean}}
 */
async function updateAllGtfsFeeds() {
  const updateIntervalMin = getRuntimeSetting('GTFS_UPDATE_INTERVAL_MIN');
  const now = Date.now();

  // 更新間隔チェック（0以下の場合は毎回更新）
  if (updateIntervalMin > 0 && lastGtfsUpdateAt > 0) {
    const elapsedMin = (now - lastGtfsUpdateAt) / 60000;
    if (elapsedMin < updateIntervalMin) {
      return { updated: 0, failed: 0, skipped: true };
    }
  }

  const client = await pool.connect();
  let updated = 0;
  let failed = 0;
  try {
    const feeds = getEnabledGtfsFeeds();
    if (feeds.length === 0) {
      console.log('[gtfsFeedManager] 有効なGTFSフィードがありません。');
      return { updated: 0, failed: 0 };
    }

    for (const feed of feeds) {
      const success = await downloadAndExtractGtfsFeed(client, feed);
      if (success) {
        updated++;
      } else {
        failed++;
      }
    }
  } catch (err) {
    console.error('[gtfsFeedManager] 全GTFSフィード更新エラー:', err.message);
    failed++;
  } finally {
    client.release();
  }

  // ファイル更新に成功したフィードが1件でもあれば、DB側のGTFS由来マスタ
  // （stops/schedule_trips/schedule_stop_times等）をseed.jsで再投入して同期する。
  // これを怠るとファイルだけ新しくなりDBが古いままになる。
  if (updated > 0) {
    try {
      const seed = require('../db/seed');
      await seed();
      // マスタが入れ替わったので、当日便を作り直せるようキャッシュを無効化する。
      // （既に車両を割り当て済みの便は dailyTripBuilder 側で保護される）
      require('./dailyTripBuilder').invalidateDailyTripCache();
      // 時刻表検索用のインメモリインデックスもGTFSファイル由来なので作り直す。
      require('./gtfsTimetable').invalidateTimetableIndex();
      // 運賃インデックス（経路検索の運賃表示）も同じくGTFSファイル由来。
      require('./gtfsFare').invalidateFareIndex();
      console.log('[gtfsFeedManager] GTFS更新に伴いDBへ再投入しました。');
    } catch (err) {
      console.error('[gtfsFeedManager] DB再投入エラー:', err.message);
    }
  }

  lastGtfsUpdateAt = now;
  console.log(`[gtfsFeedManager] GTFSフィード更新結果: ${updated}件成功 / ${failed}件失敗`);
  return { updated, failed, skipped: false };
}

module.exports = {
  getGtfsDir,
  updateAllGtfsFeeds,
  downloadAndExtractGtfsFeed,
  ensureGtfsFilesPresent,
  qualifyRouteId,
  unqualifyRouteId,
  REQUIRED_GTFS_FILES,
  OPTIONAL_GTFS_FILES,
  MANAGED_GTFS_FILES,
  GTFS_BASE_DIR
};