// 運用チューニング値（判定半径・タイムアウト・しきい値など）のメモリキャッシュ層。
//
// 優先順位: 管理画面での上書き値(DB, system_settingsテーブル) > 環境変数 > コード既定値
// （config/runtimeSettingsCatalog.js の default）。管理画面で一切編集しなければ、
// これまでどおり環境変数（未設定ならコード既定値）だけで動く＝既存の挙動と完全に同じ。
//
// 上書き値は system_settings テーブル（既存の「お知らせ」設定と同じテーブル。
// キー名の名前空間が異なるため衝突しない）に保存する。route_external_ids・holidays と
// 同じ流儀のTTL付きメモリキャッシュだが、この設定値は tripAssignment.js・passDetection.js
// など多数の同期関数から参照されるため、getRuntimeSetting() 自体は同期関数にしてある。
// 実際のDB読み込み（非同期）は refreshRuntimeSettingsCache() が担い、パイプライン
// （jobs/pipeline.js、既定60秒間隔）・運行終了バッチ（services/finishService.js、1分間隔）の
// 先頭と、サーバー起動直後（server.js）、管理画面からの更新直後に呼ばれる。
// 呼ばれる前・DB接続不可時は overrides が空のままなので、環境変数/コード既定値へ
// 自動的にフォールバックする。
const pool = require('../config/db');
const { SETTINGS_CATALOG, SETTINGS_BY_KEY } = require('../config/runtimeSettingsCatalog');

const TTL_MS = 30 * 1000; // パイプラインの既定ポーリング間隔(60秒)より短くし、次回tickで確実に反映する

let overrides = {}; // key -> system_settings.value（文字列。パース前）
let cachedAt = 0;

function parseByType(raw, type) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (type === 'integer') {
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  if (type === 'number') {
    const n = parseFloat(raw);
    return Number.isNaN(n) ? undefined : n;
  }
  return raw; // 'time' 等の文字列型はそのまま
}

/**
 * DBから上書き値を読み込む。TTL内であれば何もしない（force=trueで強制再読込）。
 * 失敗時は既存キャッシュを保持したまま（環境変数/既定値へのフォールバックで動作継続する）。
 */
async function refreshRuntimeSettingsCache(force = false) {
  const now = Date.now();
  if (!force && (now - cachedAt) < TTL_MS) return;

  try {
    const keys = SETTINGS_CATALOG.map((def) => def.key);
    const res = await pool.query(
      `SELECT key, value FROM system_settings WHERE key = ANY($1::text[])`,
      [keys]
    );
    const next = {};
    for (const row of res.rows) {
      if (row.value !== null && row.value !== '') next[row.key] = row.value;
    }
    overrides = next;
    cachedAt = now;
  } catch (err) {
    console.error('[runtimeSettings] 運用設定の読み込みに失敗しました（環境変数/既定値で継続します）:', err.message);
  }
}

/** 次回参照時にDBから再読込させる。管理画面からの保存・削除直後に呼ぶ。 */
function invalidateRuntimeSettingsCache() {
  cachedAt = 0;
}

/**
 * 設定値を解決する（同期）。管理画面での上書き値 > 環境変数 > コード既定値。
 */
function getRuntimeSetting(key) {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) throw new Error(`未知の運用設定キーです: ${key}`);

  const overrideValue = parseByType(overrides[key], def.type);
  if (overrideValue !== undefined) return overrideValue;

  const envValue = parseByType(process.env[key], def.type);
  if (envValue !== undefined) return envValue;

  return def.default;
}

/** 管理画面の一覧表示用に、その設定が現在どこから値を得ているかを返す。 */
function getRuntimeSettingSource(key) {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) return 'default';
  if (parseByType(overrides[key], def.type) !== undefined) return 'override';
  if (parseByType(process.env[key], def.type) !== undefined) return 'env';
  return 'default';
}

module.exports = {
  refreshRuntimeSettingsCache,
  invalidateRuntimeSettingsCache,
  getRuntimeSetting,
  getRuntimeSettingSource
};
