// 路線お知らせ配信（docs/route-notices.md）
//
// リアルタイム時刻表（frontend/app.js の #/realtime/...）の上部に、管理画面「路線お知らせ」で
// 登録したお知らせの題名だけを並べ、タップで詳細（画像＋本文）をポップアップ表示する。
// リアルタイム運行情報の表示領域を狭めないよう、画面に常時出すのは題名だけ。そのため題名は必須、
// さらに詳細が空にならないよう画像と本文の少なくとも一方も必須とする。
//
// 突合キーは route_id（routes.id と同じ「feedId:routeId」形式）。保存時に routes の実在は確かめるが
// 外部キーは張らない（GTFS再取込で路線が消えても行は残り、参照時に一致しなくなるだけ。実害なし）。
// route_name は管理画面一覧の可読性のためのスナップショットで、表示側の突合には使わない。

const pool = require('../config/db');

const MAX_TITLE_LEN = 60;
const MAX_BODY_LEN = 1000;
const MAX_URL_LEN = 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// DATE列は pg の既定パーサだとローカルタイムゾーンの Date になりずれるため、文字列で取り出す。
const SELECT_COLUMNS = `id, route_id, route_name, title, image_url, body,
  to_char(start_date, 'YYYY-MM-DD') AS start_date,
  to_char(end_date, 'YYYY-MM-DD') AS end_date,
  enabled, sort_order, updated_at`;

function serializeRow(row) {
  return {
    id: row.id,
    routeId: row.route_id,
    routeName: row.route_name,
    title: row.title || '',
    imageUrl: row.image_url || '',
    body: row.body || '',
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    enabled: row.enabled,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at
  };
}

function isHttpsUrl(value) {
  return typeof value === 'string' && /^https:\/\/\S+$/.test(value.trim());
}

// "YYYY-MM-DD" として実在する日付か（2026-02-30 のような値を弾く）。
function isValidDateString(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * 管理画面から受け取った内容（題名・画像・本文・配信期間・表示ON/OFF）を検証・正規化する純粋関数（DBアクセスなし）。
 * 題名は必須。画像URLと本文の少なくとも一方も必須。本文はトップ画面のお知らせと同じリンク記法
 * （リンクを含まないただのテキストも可）。配信期間は "YYYY-MM-DD" または空（無期限）。
 * @returns {{ ok: true, value: {title,imageUrl,body,startDate,endDate,enabled} } | { ok: false, error: string }}
 */
function normalizeRouteNoticeContent(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return { ok: false, error: '題名を入力してください（リアルタイム時刻表には題名だけが表示されます）。' };
  }
  if (title.length > MAX_TITLE_LEN) {
    return { ok: false, error: `題名は${MAX_TITLE_LEN}文字以内で入力してください。` };
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
    return { ok: false, error: '画像URLと本文の少なくとも一方を入力してください（題名をタップしたときの詳細になります）。' };
  }

  const startDate = typeof body?.startDate === 'string' ? body.startDate.trim() : '';
  const endDate = typeof body?.endDate === 'string' ? body.endDate.trim() : '';
  if (startDate && !isValidDateString(startDate)) {
    return { ok: false, error: '配信開始日が不正です。' };
  }
  if (endDate && !isValidDateString(endDate)) {
    return { ok: false, error: '配信終了日が不正です。' };
  }
  if (startDate && endDate && startDate > endDate) {
    return { ok: false, error: '配信開始日が配信終了日より後になっています。' };
  }

  const enabled = body?.enabled === undefined ? true : Boolean(body.enabled);
  return { ok: true, value: { title, imageUrl, body: text, startDate, endDate, enabled } };
}

/** 管理画面一覧用。全件（無効・期間外も含む）を、路線名→並び順の順で返す。 */
async function listAll() {
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM route_notices
     ORDER BY route_name ASC, route_id ASC, sort_order ASC, id ASC`
  );
  return result.rows.map(serializeRow);
}

/**
 * 公開（リアルタイム時刻表）用。指定路線の enabled=true かつ serviceDate（"YYYY-MM-DD"）が
 * 配信期間内のお知らせを並び順で返す。
 */
async function getActiveRouteNotices(routeId, serviceDate) {
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM route_notices
     WHERE route_id = $1 AND enabled = TRUE
       AND (start_date IS NULL OR start_date <= $2::date)
       AND (end_date IS NULL OR end_date >= $2::date)
     ORDER BY sort_order ASC, id ASC`,
    [routeId, serviceDate]
  );
  return result.rows.map(serializeRow);
}

/** 新規作成。route は { id, name }（呼び出し側で routes の実在を確認済みのもの）。 */
async function createNotice(route, input) {
  const normalized = normalizeRouteNoticeContent(input);
  if (!normalized.ok) return normalized;
  const v = normalized.value;

  const result = await pool.query(
    `INSERT INTO route_notices
       (route_id, route_name, title, image_url, body, start_date, end_date, enabled, sort_order, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             COALESCE((SELECT MAX(sort_order) + 1 FROM route_notices WHERE route_id = $1), 0),
             now())
     RETURNING ${SELECT_COLUMNS}`,
    [
      route.id, route.name, v.title, v.imageUrl || null, v.body || null,
      v.startDate || null, v.endDate || null, v.enabled
    ]
  );
  return { ok: true, notice: serializeRow(result.rows[0]) };
}

/**
 * 内容の更新。route は { id, name }（呼び出し側で routes の実在を確認済みのもの）。
 * 路線を付け替えた場合も sort_order はそのまま。該当行が無ければ ok:false。
 */
async function updateNotice(id, route, input) {
  const normalized = normalizeRouteNoticeContent(input);
  if (!normalized.ok) return normalized;
  const v = normalized.value;

  const result = await pool.query(
    `UPDATE route_notices
       SET route_id = $2, route_name = $3, title = $4, image_url = $5, body = $6,
           start_date = $7, end_date = $8, enabled = $9, updated_at = now()
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [
      id, route.id, route.name, v.title, v.imageUrl || null, v.body || null,
      v.startDate || null, v.endDate || null, v.enabled
    ]
  );
  if (result.rowCount === 0) return { ok: false, error: '指定のお知らせが見つかりませんでした。' };
  return { ok: true, notice: serializeRow(result.rows[0]) };
}

/** 有効/無効の切り替えのみ。該当行が無ければ false。 */
async function setNoticeEnabled(id, enabled) {
  const result = await pool.query(
    'UPDATE route_notices SET enabled = $2, updated_at = now() WHERE id = $1',
    [id, Boolean(enabled)]
  );
  return result.rowCount > 0;
}

/** 1件削除。 */
async function deleteNotice(id) {
  await pool.query('DELETE FROM route_notices WHERE id = $1', [id]);
}

module.exports = {
  listAll,
  getActiveRouteNotices,
  createNotice,
  updateNotice,
  setNoticeEnabled,
  deleteNotice,
  normalizeRouteNoticeContent
};
