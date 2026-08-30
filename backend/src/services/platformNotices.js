// 乗り場（のりば）ごとのお知らせ配信（docs/platform-notices.md）
//
// バス停詳細ページ（frontend/busstop.js）の「このバス停でできること」セクションの下に、
// 「乗り場別表示」のときだけ、その乗り場に紐づくお知らせ（画像 or リンク）を出す。
//
// GTFS由来のバス停インデックス（gtfsTimetable.js）とは (feed_id, stop_id) だけで結びつく。
// stop_key / stop_name / platform_code は管理画面一覧の可読性のためのスナップショットで、
// 表示側の突合には使わない（正は feed_id + stop_id）。GTFS再取込で stop_id が消えれば
// 参照時に単に一致しなくなるだけ（実害なし。tourist_spots と同じ「参照時に都度解決」の考え方）。

const pool = require('../config/db');

const KINDS = ['image', 'link'];
const MAX_TITLE_LEN = 60;
const MAX_LINK_BODY_LEN = 1000;
const MAX_URL_LEN = 1000;

function serializeRow(row) {
  return {
    id: row.id,
    feedId: row.feed_id,
    stopId: row.stop_id,
    stopKey: row.stop_key,
    stopName: row.stop_name,
    platformCode: row.platform_code || '',
    platformKey: `${row.feed_id}_${row.stop_id}`,
    kind: row.kind,
    title: row.title || '',
    imageUrl: row.image_url || '',
    linkBody: row.link_body || '',
    enabled: row.enabled,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at
  };
}

function isHttpsUrl(value) {
  return typeof value === 'string' && /^https:\/\/\S+$/.test(value.trim());
}

/**
 * 管理画面から受け取った入力を検証・正規化する純粋関数（DBアクセスなし）。
 * @returns {{ ok: true, value: {kind,title,imageUrl,linkBody,enabled} } | { ok: false, error: string }}
 */
function normalizeNoticeInput(body) {
  const kind = typeof body?.kind === 'string' ? body.kind.trim() : '';
  if (!KINDS.includes(kind)) {
    return { ok: false, error: '種別は「画像」または「リンク」を選んでください。' };
  }

  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (title.length > MAX_TITLE_LEN) {
    return { ok: false, error: `見出しは${MAX_TITLE_LEN}文字以内で入力してください。` };
  }

  const enabled = body?.enabled === undefined ? true : Boolean(body.enabled);

  if (kind === 'image') {
    const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl.trim() : '';
    if (!imageUrl) return { ok: false, error: '画像URLを入力してください。' };
    if (!isHttpsUrl(imageUrl) || imageUrl.length > MAX_URL_LEN) {
      return { ok: false, error: '画像URLは https:// で始まる正しいURLを入力してください（CloudinaryなどにアップロードしたURL）。' };
    }
    return { ok: true, value: { kind, title, imageUrl, linkBody: '', enabled } };
  }

  // kind === 'link'
  const linkBody = typeof body?.linkBody === 'string' ? body.linkBody.trim() : '';
  if (!linkBody) return { ok: false, error: 'リンクを含む本文を入力してください。' };
  if (linkBody.length > MAX_LINK_BODY_LEN) {
    return { ok: false, error: `本文は${MAX_LINK_BODY_LEN}文字以内で入力してください。` };
  }
  if (!/https?:\/\/\S+/.test(linkBody)) {
    return { ok: false, error: '本文に https:// で始まるリンクを1つ以上含めてください（例: [時刻表はこちら](https://example.com)）。' };
  }
  return { ok: true, value: { kind, title, imageUrl: '', linkBody, enabled } };
}

/** 管理画面一覧用。全件（無効も含む）を、バス停名→乗り場→並び順の順で返す。 */
async function listAll() {
  const result = await pool.query(
    `SELECT * FROM platform_notices
     ORDER BY stop_name ASC, platform_code ASC, sort_order ASC, id ASC`
  );
  return result.rows.map(serializeRow);
}

/**
 * 公開（バス停詳細ページ）用。指定の乗り場（feedId + stopId）に紐づく enabled=true の
 * お知らせを並び順で返す。
 */
async function getActiveNoticesForPlatform(feedId, stopId) {
  const result = await pool.query(
    `SELECT * FROM platform_notices
     WHERE feed_id = $1 AND stop_id = $2 AND enabled = TRUE
     ORDER BY sort_order ASC, id ASC`,
    [feedId, stopId]
  );
  return result.rows.map(serializeRow);
}

/**
 * 新規作成。platformRef は gtfsTimetable.resolvePlatformRef() で解決した乗り場
 * （feedId / stopId / platformCode）＋ stopKey / stopName。
 */
async function createNotice(platformRef, input) {
  const normalized = normalizeNoticeInput(input);
  if (!normalized.ok) return normalized;
  const v = normalized.value;

  const result = await pool.query(
    `INSERT INTO platform_notices
       (feed_id, stop_id, stop_key, stop_name, platform_code, kind, title, image_url, link_body, enabled, sort_order, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             COALESCE((SELECT MAX(sort_order) + 1 FROM platform_notices WHERE feed_id = $1 AND stop_id = $2), 0),
             now())
     RETURNING *`,
    [
      platformRef.feedId, platformRef.stopId, platformRef.stopKey, platformRef.stopName,
      platformRef.platformCode || null, v.kind, v.title || null, v.imageUrl || null, v.linkBody || null, v.enabled
    ]
  );
  return { ok: true, notice: serializeRow(result.rows[0]) };
}

/** 内容の更新（対象の乗り場は変更しない）。該当行が無ければ ok:false。 */
async function updateNotice(id, input) {
  const normalized = normalizeNoticeInput(input);
  if (!normalized.ok) return normalized;
  const v = normalized.value;

  const result = await pool.query(
    `UPDATE platform_notices
       SET kind = $2, title = $3, image_url = $4, link_body = $5, enabled = $6, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, v.kind, v.title || null, v.imageUrl || null, v.linkBody || null, v.enabled]
  );
  if (result.rowCount === 0) return { ok: false, error: '指定のお知らせが見つかりませんでした。' };
  return { ok: true, notice: serializeRow(result.rows[0]) };
}

/** 有効/無効の切り替えのみ。該当行が無ければ false。 */
async function setNoticeEnabled(id, enabled) {
  const result = await pool.query(
    'UPDATE platform_notices SET enabled = $2, updated_at = now() WHERE id = $1',
    [id, Boolean(enabled)]
  );
  return result.rowCount > 0;
}

/** 1件削除。 */
async function deleteNotice(id) {
  await pool.query('DELETE FROM platform_notices WHERE id = $1', [id]);
}

module.exports = {
  listAll,
  getActiveNoticesForPlatform,
  createNotice,
  updateNotice,
  setNoticeEnabled,
  deleteNotice,
  normalizeNoticeInput
};
