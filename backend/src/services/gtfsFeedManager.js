// GTFSフィード管理モジュール
// 複数のGTFS ZIPフィードを自動ダウンロードし、フィードIDごとのディレクトリに展開する。
// 各フィードは独立して管理され、1つのフィードの失敗が他に影響しない。
// 対象フィードの一覧は config/feeds.js（コード上の定数）から取得する。
// feeds テーブルへの書き込みは last_fetched_at / last_status / last_error の稼働状態と、
// content_hash / last_etag / last_modified（前回DBへ取り込んだZIPの指紋）だけで、
// 構成そのものはDBに持たない。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
//
// feed_info.txt は「GTFSデータの有効期間」（feed_start_date / feed_end_date）の
// 供給元。経路検索・時刻表検索で「選択された日付が有効期間外」の注意喚起に使う。
// 持たないフィードでは calendar.txt の期間から推定するため、これも REQUIRED にはしない。
const OPTIONAL_GTFS_FILES = [
  'frequencies.txt',
  'translations.txt',
  'fare_attributes.txt',
  'fare_rules.txt',
  'feed_info.txt'
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
 * 前回DBへ取り込んだZIPの指紋（content_hash / last_etag / last_modified）を
 * feeds テーブルへ確定させる。
 *
 * **必ず seed() が成功した後に呼ぶこと。** ダウンロード直後に書いてしまうと、
 * seed() が失敗した回の指紋が残り、以降ずっと「内容不変」と判定されてDBが
 * 古いまま固定される（次回以降のリトライ経路が消える）。
 */
async function commitFeedFingerprint(dbClient, feedId, fingerprint) {
  if (!fingerprint) return;
  await dbClient.query(
    `UPDATE feeds SET content_hash = $2, last_etag = $3, last_modified = $4 WHERE id = $1`,
    [feedId, fingerprint.contentHash, fingerprint.etag, fingerprint.lastModified]
  );
}

/**
 * 単一のGTFSフィードをダウンロードして展開する。
 * 失敗してもthrowせず、feedsテーブルにエラー情報を記録して `ok: false` を返す。
 *
 * 内容が前回取り込んだZIPと同一（HTTP 304、またはSHA-256一致）で、かつ必須ファイルが
 * ディスク上に揃っている場合は展開自体をスキップし、`{ ok: true, changed: false }` を
 * 返す。呼び出し側はこれを見て seed()（＝全マスタの書き換え）を省ける。
 *
 * @param {object} client - PostgreSQLクライアント
 * @param {object} feed - config/feeds.js のフィード定義
 * @param {{force?: boolean}} [options] - force=true で内容不変の判定を行わず必ず展開する
 *   （管理画面の手動再取得など、「とにかく取り直したい」経路用）
 * @returns {Promise<{ok: boolean, changed: boolean, fingerprint: object|null}>}
 *   fingerprint は展開に成功した場合だけ入る。seed() 成功後に
 *   commitFeedFingerprint() へ渡すこと。
 */
async function downloadAndExtractGtfsFeed(client, feed, options = {}) {
  const force = options.force === true;
  const feedId = feed.id;
  const feedDir = getGtfsDir(feedId);
  const tmpZipPath = path.join(feedDir, `.tmp_${feedId}.zip`);

  try {
    // フィードディレクトリを作成
    fs.mkdirSync(feedDir, { recursive: true });

    // 内容不変のスキップ判定は「必須ファイルがディスク上に揃っている」ときだけ許す。
    // ファイルが欠けている状態（コンテナ再作成直後など）でスキップすると、
    // 時刻表インデックスの構築が復旧できないまま固定される。
    const filesPresent = REQUIRED_GTFS_FILES.every((f) => fs.existsSync(path.join(feedDir, f)));
    const canSkipUnchanged = !force && filesPresent;

    let previous = { content_hash: null, last_etag: null, last_modified: null };
    if (canSkipUnchanged) {
      const prevRes = await client.query(
        `SELECT content_hash, last_etag, last_modified FROM feeds WHERE id = $1`,
        [feedId]
      );
      if (prevRes.rows.length > 0) previous = prevRes.rows[0];
    }

    console.log(`[gtfsFeedManager] GTFSダウンロード開始: ${feed.name} (${feed.url})`);

    // 条件付きGET。配信元が対応していれば本体の転送自体が起きない。
    const requestHeaders = {};
    if (canSkipUnchanged && previous.last_etag) requestHeaders['If-None-Match'] = previous.last_etag;
    if (canSkipUnchanged && previous.last_modified) {
      requestHeaders['If-Modified-Since'] = previous.last_modified;
    }

    // ダウンロード
    const response = await fetch(feed.url.trim(), {
      redirect: 'follow',
      timeout: 60000, // 60秒タイムアウト
      headers: requestHeaders
    });

    if (response.status === 304) {
      console.log(`[gtfsFeedManager] 内容に変更なし（304）。展開・DB再投入をスキップ: ${feed.name} (${feedId})`);
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'ok', last_error = NULL WHERE id = $1`,
        [feedId]
      );
      return { ok: true, changed: false, fingerprint: null };
    }

    if ([429, 502, 503].includes(response.status) || response.status >= 500) {
      const msg = `サーバー負荷または障害。ステータス: ${response.status}`;
      console.warn(`[gtfsFeedManager] ${msg} feed=${feedId}`);
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
        [feedId, msg]
      );
      return { ok: false, changed: false, fingerprint: null };
    }
    if (response.status !== 200) {
      const msg = `予期しないステータスコード: ${response.status}`;
      console.warn(`[gtfsFeedManager] ${msg} feed=${feedId}`);
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
        [feedId, msg]
      );
      return { ok: false, changed: false, fingerprint: null };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      const msg = 'ダウンロードデータが空です';
      console.warn(`[gtfsFeedManager] ${msg} feed=${feedId}`);
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`,
        [feedId, msg]
      );
      return { ok: false, changed: false, fingerprint: null };
    }

    // 今回ダウンロードしたZIPの指紋。展開に成功したら呼び出し側へ返し、
    // seed() が成功した後に commitFeedFingerprint() で確定させる。
    const fingerprint = {
      contentHash: crypto.createHash('sha256').update(buffer).digest('hex'),
      etag: response.headers.get('etag') || null,
      lastModified: response.headers.get('last-modified') || null
    };

    // 配信元が条件付きGETに対応していない場合でも、ここで内容が同一と分かれば
    // 展開・DB再投入を省ける（ダウンロードは走るが、全マスタの書き換えは起きない）。
    if (canSkipUnchanged && previous.content_hash && previous.content_hash === fingerprint.contentHash) {
      console.log(`[gtfsFeedManager] 内容に変更なし（ハッシュ一致）。展開・DB再投入をスキップ: ${feed.name} (${feedId})`);
      await client.query(
        `UPDATE feeds SET last_fetched_at = now(), last_status = 'ok', last_error = NULL,
                          last_etag = $2, last_modified = $3
          WHERE id = $1`,
        [feedId, fingerprint.etag, fingerprint.lastModified]
      );
      return { ok: true, changed: false, fingerprint: null };
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
      return { ok: false, changed: false, fingerprint: null };
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
    return { ok: true, changed: true, fingerprint };
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
    return { ok: false, changed: false, fingerprint: null };
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
  // 欠損の復旧なので内容不変の判定は挟まず必ず展開する（force）。
  // ここは seed() のトランザクション内から呼ばれるため、指紋の確定も同じ
  // トランザクションで行ってよい（seed()がROLLBACKすれば指紋も戻る）。
  const result = await downloadAndExtractGtfsFeed(client, feed, { force: true });
  if (result.ok && result.fingerprint) {
    await commitFeedFingerprint(client, feed.id, result.fingerprint);
  }
  return true;
}

/**
 * 全GTFSフィードを更新する。
 * 各フィードは独立して処理され、1つの失敗が他に影響しない。
 * GTFS_UPDATE_INTERVAL_MIN（分）で更新間隔を制御する。0以下の場合は毎回更新する。
 *
 * 内容が前回取り込んだZIPと同一だったフィードは `unchanged` に数え、`updated` には
 * 入れない。1件も内容が変わっていなければ seed()（全マスタの書き換え）は走らない。
 * @returns {{updated: number, unchanged: number, failed: number, skipped: boolean}}
 */
async function updateAllGtfsFeeds() {
  const updateIntervalMin = getRuntimeSetting('GTFS_UPDATE_INTERVAL_MIN');
  const now = Date.now();

  // 更新間隔チェック（0以下の場合は毎回更新）
  if (updateIntervalMin > 0 && lastGtfsUpdateAt > 0) {
    const elapsedMin = (now - lastGtfsUpdateAt) / 60000;
    if (elapsedMin < updateIntervalMin) {
      return { updated: 0, unchanged: 0, failed: 0, skipped: true };
    }
  }

  // 有効なGTFSフィードが1件も無ければ、DB接続を取らずにここで抜ける。
  // このとき lastGtfsUpdateAt を進めておかないと、次回以降も更新間隔チェックが
  // 素通りし（lastGtfsUpdateAt === 0 のまま）、全フィードを enabled:false にした
  // 運用でポーリングのたびに pool.connect() とログ出力だけが空回りする（既知 L-9）。
  const feeds = getEnabledGtfsFeeds();
  if (feeds.length === 0) {
    lastGtfsUpdateAt = now;
    console.log('[gtfsFeedManager] 有効なGTFSフィードがありません。');
    return { updated: 0, unchanged: 0, failed: 0, skipped: false };
  }

  const client = await pool.connect();
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  // 展開に成功したフィードの指紋。seed() が成功した後にまとめて確定させる。
  const pendingFingerprints = [];
  try {
    for (const feed of feeds) {
      const result = await downloadAndExtractGtfsFeed(client, feed);
      if (!result.ok) {
        failed++;
      } else if (result.changed) {
        updated++;
        if (result.fingerprint) pendingFingerprints.push({ feedId: feed.id, fingerprint: result.fingerprint });
      } else {
        unchanged++;
      }
    }
  } catch (err) {
    console.error('[gtfsFeedManager] 全GTFSフィード更新エラー:', err.message);
    failed++;
  } finally {
    client.release();
  }

  // 内容が実際に変わったフィードが1件でもあれば、DB側のGTFS由来マスタ
  // （stops/schedule_trips/schedule_stop_times等）をseed.jsで再投入して同期する。
  // これを怠るとファイルだけ新しくなりDBが古いままになる。
  // 逆に1件も変わっていなければ、全マスタのUPDATEは無駄なので走らせない。
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

      // 指紋の確定は seed() 成功後。ここより手前で書くと、seed() が失敗した回の
      // 指紋が残り、以降ずっと「内容不変」と判定されてDBが古いまま固定される。
      for (const { feedId, fingerprint } of pendingFingerprints) {
        await commitFeedFingerprint(pool, feedId, fingerprint);
      }
    } catch (err) {
      console.error('[gtfsFeedManager] DB再投入エラー:', err.message);
    }
  }

  lastGtfsUpdateAt = now;
  console.log(
    `[gtfsFeedManager] GTFSフィード更新結果: ${updated}件更新 / ${unchanged}件変更なし / ${failed}件失敗`
  );
  return { updated, unchanged, failed, skipped: false };
}

module.exports = {
  getGtfsDir,
  updateAllGtfsFeeds,
  downloadAndExtractGtfsFeed,
  commitFeedFingerprint,
  ensureGtfsFilesPresent,
  qualifyRouteId,
  unqualifyRouteId,
  REQUIRED_GTFS_FILES,
  OPTIONAL_GTFS_FILES,
  MANAGED_GTFS_FILES,
  GTFS_BASE_DIR
};