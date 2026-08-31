// バス停お知らせ配信（docs/busstop-notices.md）
//
// バス停詳細ページ（frontend/busstop.js）の「このバス停でできること」セクションの下に、
// 管理画面「バス停お知らせ」で登録したお知らせ（見出し・画像・本文を任意に組み合わせ）を出す。
//
// 配信範囲は scope で決まる：
//   - scope='platform' … 乗り場（のりば）単位。突合キーは (feed_id, stop_id)。
//                        利用者が乗り場を確定しているとき（乗り場別表示 or 乗り場が1か所）だけ出す。
//   - scope='stop'     … バス停単位。突合キーは stop_key（統合バス停キー＋その別名）。表示モードによらず常に出す。
//
// GTFS由来のバス停インデックス（gtfsTimetable.js）とは上記のキーだけで結びつく。
// stop_name / platform_code は管理画面一覧の可読性のためのスナップショットで、表示側の突合には使わない。
// GTFS再取込で stop_id / stop_key が変わっても行は更新しない（参照時に一致しなくなるだけ。実害なし）。

const pool = require('../config/db');

const SCOPES = ['stop', 'platform'];
const MAX_TITLE_LEN = 60;
const MAX_BODY_LEN = 1000;
const MAX_URL_LEN = 1000;

function serializeRow(row) {
  return {
    id: row.id,
    scope: row.scope,
    stopKey: row.stop_key,
    feedId: row.feed_id || '',
    stopId: row.stop_id || '',
    stopName: row.stop_name,
    platformCode: row.platform_code || '',
    platformKey: row.feed_id && row.stop_id ? `${row.feed_id}_${row.stop_id}` : '',
    title: row.title || '',
    imageUrl: row.image_url || '',
    body: row.body || '',
    enabled: row.enabled,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at
  };
}

function isHttpsUrl(value) {
  return typeof value === 'string' && /^https:\/\/\S+$/.test(value.trim());
}

/**
 * 管理画面から受け取った内容（見出し・画像・本文・表示ON/OFF）を検証・正規化する純粋関数（DBアクセスなし）。
 * 画像URLと本文の少なくとも一方は必須。本文はトップ画面のお知らせと同じリンク記法（リンクを含まない
 * ただのテキストも可）。
 * @returns {{ ok: true, value: {title,imageUrl,body,enabled} } | { ok: false, error: string }}
 */
function normalizeNoticeContent(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (title.length > MAX_TITLE_LEN) {
    return { ok: false, error: `見出しは${MAX_TITLE_LEN}文字以内で入力してください。` };
  }

  const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl.trim() : '';
  if (imageUrl) {
    if (!isHttpsUrl(imageUrl) || imageUrl.length > MAX_URL_LEN) {
      return { ok: false, error: '画像URLは https:// で始まる正しいURLを入力してください（CloudinaryなどにアップロードしたURL）。' };
    }
  }

  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (text.length > MAX_BODY_LEN) {
    return { ok: false, error: `本文は${MAX_BODY_LEN}文字以内で入力してください。` };
  }

  if (!imageUrl && !text) {
    return { ok: false, error: '画像URLと本文の少なくとも一方を入力してください。' };
  }

  const enabled = body?.enabled === undefined ? true : Boolean(body.enabled);
  return { ok: true, value: { title, imageUrl, body: text, enabled } };
}

/** 管理画面一覧用。全件（無効も含む）を、バス停名→範囲→乗り場→並び順の順で返す。 */
async function listAll() {
  const result = await pool.query(
    `SELECT * FROM busstop_notices
     ORDER BY stop_name ASC, scope ASC, platform_code ASC NULLS FIRST, sort_order ASC, id ASC`
  );
  return result.rows.map(serializeRow);
}

/**
 * 公開（バス停詳細ページ）用。指定の乗り場（feedId + stopId）に紐づく
 * scope='platform' かつ enabled=true のお知らせを並び順で返す。
 */
async function getActivePlatformNotices(feedId, stopId) {
  const result = await pool.query(
    `SELECT * FROM busstop_notices
     WHERE scope = 'platform' AND feed_id = $1 AND stop_id = $2 AND enabled = TRUE
     ORDER BY sort_order ASC, id ASC`,
    [feedId, stopId]
  );
  return result.rows.map(serializeRow);
}

/**
 * 公開（バス停詳細ページ）用。指定のバス停キー群（正キー＋別名）に紐づく
 * scope='stop' かつ enabled=true のお知らせを並び順で返す。
 */
async function getActiveStopNotices(stopKeys) {
  const keys = (stopKeys || []).filter((k) => typeof k === 'string' && k);
  if (keys.length === 0) return [];
  const result = await pool.query(
    `SELECT * FROM busstop_notices
     WHERE scope = 'stop' AND stop_key = ANY($1) AND enabled = TRUE
     ORDER BY sort_order ASC, id ASC`,
    [keys]
  );
  return result.rows.map(serializeRow);
}

/**
 * 新規作成。
 * scope='platform' のとき target は resolvePlatformRef().platform（feedId/stopId/platformCode）＋ stopKey/stopName。
 * scope='stop'     のとき target は { stopKey, stopName }。
 */
async function createNotice(scope, target, input) {
  if (!SCOPES.includes(scope)) {
    return { ok: false, error: '配信範囲が不正です。' };
  }
  const normalized = normalizeNoticeContent(input);
  if (!normalized.ok) return normalized;
  const v = normalized.value;

  const feedId = scope === 'platform' ? target.feedId : null;
  const stopId = scope === 'platform' ? target.stopId : null;
  const platformCode = scope === 'platform' ? (target.platformCode || null) : null;

  const result = await pool.query(
    `INSERT INTO busstop_notices
       (scope, stop_key, feed_id, stop_id, stop_name, platform_code, title, image_url, body, enabled, sort_order, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             COALESCE((SELECT MAX(sort_order) + 1 FROM busstop_notices
                       WHERE scope = $1
                         AND stop_key = $2
                         AND feed_id IS NOT DISTINCT FROM $3
                         AND stop_id IS NOT DISTINCT FROM $4), 0),
             now())
     RETURNING *`,
    [
      scope, target.stopKey, feedId, stopId, target.stopName, platformCode,
      v.title || null, v.imageUrl || null, v.body || null, v.enabled
    ]
  );
  return { ok: true, notice: serializeRow(result.rows[0]) };
}

/** 内容の更新（配信範囲・対象のバス停/乗り場は変更しない）。該当行が無ければ ok:false。 */
async function updateNotice(id, input) {
  const normalized = normalizeNoticeContent(input);
  if (!normalized.ok) return normalized;
  const v = normalized.value;

  const result = await pool.query(
    `UPDATE busstop_notices
       SET title = $2, image_url = $3, body = $4, enabled = $5, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, v.title || null, v.imageUrl || null, v.body || null, v.enabled]
  );
  if (result.rowCount === 0) return { ok: false, error: '指定のお知らせが見つかりませんでした。' };
  return { ok: true, notice: serializeRow(result.rows[0]) };
}

/** 有効/無効の切り替えのみ。該当行が無ければ false。 */
async function setNoticeEnabled(id, enabled) {
  const result = await pool.query(
    'UPDATE busstop_notices SET enabled = $2, updated_at = now() WHERE id = $1',
    [id, Boolean(enabled)]
  );
  return result.rowCount > 0;
}

/** 1件削除。 */
async function deleteNotice(id) {
  await pool.query('DELETE FROM busstop_notices WHERE id = $1', [id]);
}

module.exports = {
  listAll,
  getActivePlatformNotices,
  getActiveStopNotices,
  createNotice,
  updateNotice,
  setNoticeEnabled,
  deleteNotice,
  normalizeNoticeContent
};
