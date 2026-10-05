// 車両詳細情報（公開用）。docs/vehicle-profiles.md
//
// 車両ID（car_id）ごとに、利用者向け画面へ出す「バスアイコン（車両の外観画像）」と
// 「設備・お支払い情報（ノンステップ・車いす対応・支払い方法）」を持つ。
// 管理画面「車両詳細情報」で編集し、リアルタイム時刻表（カード表示・基本表示）・バスマップ・
// 便詳細ページの「車両詳細」ポップアップで使う。
//
// 管理画面専用の車両名・メモ（vehicle_labels、利用者には出さない）とはテーブルも画面も分けてある。
// 片方を他方へ流用しないこと（運用メモが公開画面に漏れる／公開情報の編集で管理用の名前が消える）。
// キーは vehicle_labels と同じく car_id（1事業者内では car_id が物理車両を一意に指す）。
//
// バスアイコンの選択肢はコードに列挙せず、frontend/images/ に置かれた画像ファイルを都度読む
// （画像を置くだけで管理画面の選択肢に増える）。保存時と公開APIでの読み出し時の両方で
// 「そのファイルが今も存在するか」を確かめ、消えたアイコンは未設定扱いにする
// （画像のリンク切れを利用者画面に出さないため）。

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const BUS_ICON_DIR = path.join(__dirname, '..', '..', '..', 'frontend', 'images');
const BUS_ICON_URL_PREFIX = '/images/';
const BUS_ICON_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
// 公開APIは20秒ポーリングのホットパスから呼ばれるため、ディレクトリの読み直しは間隔を空ける。
const ICON_LIST_TTL_MS = 60 * 1000;

const MAX_PAYMENT_NOTE_LEN = 200;

// 支払い方法の選択肢（表示順もこの順）。増やすときはここに足すだけでよい（DBは key の配列で持つ）。
const PAYMENT_METHODS = [
  { key: 'cash', label: '現金' },
  { key: 'transit_ic', label: '交通系ICカード' },
  { key: 'credit_touch', label: 'クレジットカードのタッチ決済' },
  { key: 'qr', label: 'QRコード決済' }
];
const PAYMENT_METHOD_KEYS = PAYMENT_METHODS.map((m) => m.key);
const PAYMENT_LABEL_BY_KEY = new Map(PAYMENT_METHODS.map((m) => [m.key, m.label]));

let iconCache = { at: 0, files: [] };

/** frontend/images/ にあるバスアイコン画像のファイル名一覧（名前順）。読めなければ空配列。 */
function listBusIconFiles({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && now - iconCache.at < ICON_LIST_TTL_MS) return iconCache.files;
  let files = [];
  try {
    files = fs.readdirSync(BUS_ICON_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && BUS_ICON_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'ja'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[vehicleProfiles] バスアイコン一覧の読み込みに失敗:', err.message);
  }
  iconCache = { at: now, files };
  return files;
}

function busIconUrl(file) {
  return `${BUS_ICON_URL_PREFIX}${encodeURIComponent(file)}`;
}

/** 管理画面の選択肢用。 */
function listBusIcons() {
  return listBusIconFiles({ fresh: true }).map((file) => ({ file, url: busIconUrl(file) }));
}

/** 現存するアイコンならURL、未設定・ファイルが消えていればnull。 */
function resolveBusIconUrl(file) {
  if (!file) return null;
  return listBusIconFiles().includes(file) ? busIconUrl(file) : null;
}

function normalizeTriState(value, label) {
  if (value === true || value === false || value === null || value === undefined) {
    return { ok: true, value: value === undefined ? null : value };
  }
  return { ok: false, error: `${label}の値が不正です。` };
}

/**
 * 管理画面から受け取った車両詳細情報を検証・正規化する純粋関数（DB・ファイルI/Oなし）。
 * availableIcons は現存するアイコンのファイル名一覧（呼び出し側が listBusIconFiles() で渡す）。
 * nonStep / wheelchair は true（対応）・false（非対応）・null（未登録＝画面に出さない）の3値。
 * empty は「すべて未設定」＝行を削除してよい状態か。
 * @returns {{ ok: true, value: {icon,nonStep,wheelchair,paymentMethods,paymentNote}, empty: boolean } | { ok: false, error: string }}
 */
function normalizeVehicleProfileInput(body, availableIcons) {
  const icon = typeof body?.icon === 'string' ? body.icon.trim() : '';
  if (icon && !(availableIcons || []).includes(icon)) {
    return { ok: false, error: '選択されたバスアイコンが見つかりません。画像ファイルが削除された可能性があります。' };
  }

  const nonStep = normalizeTriState(body?.nonStep, 'ノンステップ');
  if (!nonStep.ok) return nonStep;
  const wheelchair = normalizeTriState(body?.wheelchair, '車いす対応');
  if (!wheelchair.ok) return wheelchair;

  const rawMethods = body?.paymentMethods === undefined || body?.paymentMethods === null ? [] : body.paymentMethods;
  if (!Array.isArray(rawMethods) || rawMethods.some((key) => typeof key !== 'string')) {
    return { ok: false, error: '支払い方法の値が不正です。' };
  }
  const unknown = rawMethods.find((key) => !PAYMENT_LABEL_BY_KEY.has(key));
  if (unknown !== undefined) {
    return { ok: false, error: `未知の支払い方法です: ${unknown}` };
  }
  // 重複を落とし、選択肢の定義順に揃える（画面での並びを入力順に左右されないようにする）。
  const paymentMethods = PAYMENT_METHOD_KEYS.filter((key) => rawMethods.includes(key));

  const paymentNote = typeof body?.paymentNote === 'string' ? body.paymentNote.trim() : '';
  if (paymentNote.length > MAX_PAYMENT_NOTE_LEN) {
    return { ok: false, error: `支払い方法の補足は${MAX_PAYMENT_NOTE_LEN}文字以内で入力してください。` };
  }

  const value = {
    icon,
    nonStep: nonStep.value,
    wheelchair: wheelchair.value,
    paymentMethods,
    paymentNote
  };
  const empty = !icon && value.nonStep === null && value.wheelchair === null &&
    paymentMethods.length === 0 && !paymentNote;
  return { ok: true, value, empty };
}

/**
 * 利用者向けAPIに載せる形（行が無ければnull）。iconUrl はファイルが現存するときだけ入る。
 * 支払い方法は表示ラベル付きで返し、フロントに選択肢の定義を持たせない。
 */
function serializePublicProfile(row) {
  if (!row) return null;
  const methods = (row.payment_methods || []).filter((key) => PAYMENT_LABEL_BY_KEY.has(key));
  return {
    iconUrl: resolveBusIconUrl(row.icon),
    nonStep: row.non_step === null || row.non_step === undefined ? null : row.non_step,
    wheelchair: row.wheelchair === null || row.wheelchair === undefined ? null : row.wheelchair,
    paymentMethods: PAYMENT_METHOD_KEYS
      .filter((key) => methods.includes(key))
      .map((key) => ({ key, label: PAYMENT_LABEL_BY_KEY.get(key) })),
    paymentNote: row.payment_note || ''
  };
}

/**
 * car_id の配列 → Map(car_id → 公開用プロフィール)。登録の無い車両はMapに入らない。
 * /api/buses 等のホットパスから呼ばれるため soft-fail（失敗時は空Map＝全車両「未登録」の表示）にし、
 * 付加情報の取得失敗でリアルタイム運行情報そのものを落とさない。
 */
async function getPublicProfilesByCarIds(db, carIds) {
  const ids = [...new Set((carIds || []).filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return new Map();
  try {
    const result = await (db || pool).query(
      `SELECT car_id, icon, non_step, wheelchair, payment_methods, payment_note
       FROM vehicle_profiles
       WHERE car_id = ANY($1::text[])`,
      [ids]
    );
    return new Map(result.rows.map((row) => [row.car_id, serializePublicProfile(row)]));
  } catch (err) {
    console.warn('[vehicleProfiles] 車両詳細情報の取得に失敗（未登録として扱います）:', err.message);
    return new Map();
  }
}

/** 管理画面の一覧用（管理用の車両名も識別の補助として添える。公開APIには載せない）。 */
async function listProfilesForAdmin() {
  const result = await pool.query(
    `SELECT vp.car_id, vp.icon, vp.non_step, vp.wheelchair, vp.payment_methods, vp.payment_note,
            vp.updated_at, vl.name AS label_name
     FROM vehicle_profiles vp
     LEFT JOIN vehicle_labels vl ON vl.car_id = vp.car_id
     ORDER BY vp.car_id ASC`
  );
  return result.rows.map((row) => ({
    carId: row.car_id,
    labelName: row.label_name || null,
    icon: row.icon || '',
    iconUrl: resolveBusIconUrl(row.icon),
    nonStep: row.non_step,
    wheelchair: row.wheelchair,
    paymentMethods: row.payment_methods || [],
    paymentNote: row.payment_note || '',
    updatedAt: row.updated_at
  }));
}

async function upsertProfile(carId, value) {
  await pool.query(
    `INSERT INTO vehicle_profiles (car_id, icon, non_step, wheelchair, payment_methods, payment_note, updated_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6, now())
     ON CONFLICT (car_id) DO UPDATE
       SET icon = EXCLUDED.icon,
           non_step = EXCLUDED.non_step,
           wheelchair = EXCLUDED.wheelchair,
           payment_methods = EXCLUDED.payment_methods,
           payment_note = EXCLUDED.payment_note,
           updated_at = now()`,
    [carId, value.icon || null, value.nonStep, value.wheelchair, value.paymentMethods, value.paymentNote || null]
  );
}

async function deleteProfile(carId) {
  await pool.query('DELETE FROM vehicle_profiles WHERE car_id = $1', [carId]);
}

module.exports = {
  PAYMENT_METHODS,
  listBusIconFiles,
  listBusIcons,
  normalizeVehicleProfileInput,
  serializePublicProfile,
  getPublicProfilesByCarIds,
  listProfilesForAdmin,
  upsertProfile,
  deleteProfile
};
