// 観光スポット情報機能（観光スポット情報_仕様書）
//
// GTFS由来データ（stops/schedule_*等）とは完全独立の tourist_spots テーブルを扱う。
// バス停との関連付けは保存時ではなく参照時に緯度経度の近接検索（ハバーサイン距離）で
// 都度解決するため、このファイルはバス停側のテーブル・インデックスを一切参照しない。
//
// 観光スポットの識別子（tourist_spots.id）は、管理画面のテキスト一括入力の1列目で管理者が
// 指定する文字列。名称による名寄せはせず、IDが同じなら名称が変わっても同一スポットとして扱う。

const pool = require('../config/db');
const { haversineDistanceMeters, estimateWalkMinutes } = require('../utils/geo');
const { kanaToRomaji, capitalizeRomaji, normalizeSearchText } = require('../utils/kana');

const DEFAULT_NEARBY_RADIUS_METERS = 500; // バス停統合しきい値400mを参考にした初期値
const DEFAULT_NEARBY_LIMIT = 5;

// 公式サイトリンクのタップ数集計（tourist_spot_link_clicks）の保持日数。
// 「最大1年間」のルックバックが常に成立するよう13か月弱を確保する（visitorTracker.js と
// 同じくモジュール定数で管理。1時間掃除タイマー scheduler.js から purgeOldLinkClicks が呼ぶ）。
const LINK_CLICK_RETENTION_DAYS = 400;
const LINK_CLICK_MAX_RANGE_DAYS = 366; // 集計期間の上限（うるう年を含む1年）

/** 写真URL列（"," 区切りで複数可）を配列へ分解する。空要素・前後空白は落とす。 */
function splitPhotoUrls(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function serializeRow(row) {
  return {
    spotId: row.id,
    name: row.name,
    kana: row.kana,
    romaji: row.romaji,
    lat: Number(row.lat),
    lng: Number(row.lng),
    url: row.url,
    hours: row.hours,
    stayDuration: row.stay_duration,
    description: row.description,
    hoursEn: row.hours_en,
    stayDurationEn: row.stay_duration_en,
    descriptionEn: row.description_en,
    photoUrls: splitPhotoUrls(row.photo_urls),
    category: row.category,
    displayTag: row.display_tag
  };
}

/**
 * バス停ページの周辺観光スポット表示（findNearbySpots）にだけ効く判定。
 * display_tagが空欄、または「観光」を含まない値（例：学校・病院など経路検索の地点としては
 * 使うが観光スポットではない登録）は対象外とする。地点名検索・詳細ポップアップ取得は
 * この判定を通さない（観光スポット情報_仕様書のカテゴリ/表示タグの方針）。
 */
function isVisibleOnBusStopPage(row) {
  const tag = (row.display_tag || '').trim();
  return tag.includes('観光');
}

/**
 * バス停ページ用の近接検索。isVisibleOnBusStopPageのみ対象、半径内・距離昇順で最大limit件。
 * 各要素に最寄りバス停までの徒歩距離の概算（distanceMeters・walkMinutes）を付与する。
 */
async function findNearbySpots(lat, lon, { radiusMeters = DEFAULT_NEARBY_RADIUS_METERS, limit = DEFAULT_NEARBY_LIMIT } = {}) {
  const result = await pool.query('SELECT * FROM tourist_spots');
  const candidates = [];
  for (const row of result.rows) {
    if (!isVisibleOnBusStopPage(row)) continue;
    const distanceMeters = haversineDistanceMeters(lat, lon, Number(row.lat), Number(row.lng));
    if (distanceMeters > radiusMeters) continue;
    candidates.push({ row, distanceMeters });
  }
  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return candidates.slice(0, limit).map(({ row, distanceMeters }) => ({
    ...serializeRow(row),
    // 距離は直線距離のまま。徒歩分数だけ迂回・信号待ちを織り込んだ推定にする（utils/geo.js）。
    distanceMeters: Math.round(distanceMeters),
    walkMinutes: estimateWalkMinutes(distanceMeters)
  }));
}

/**
 * 経路検索・地点名検索の候補用。name/kana/romajiの部分一致（normalizeSearchTextで正規化）。
 * 前方一致を優先し、次に部分一致（gtfsTimetable.searchStops()と同じ考え方）。
 */
async function searchTouristSpots(query, limit = 10) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const result = await pool.query('SELECT * FROM tourist_spots');
  const scored = [];
  for (const row of result.rows) {
    const fields = [row.name, row.kana, row.romaji].filter(Boolean).map(normalizeSearchText);
    let score = -1;
    for (const field of fields) {
      if (!field) continue;
      if (field.startsWith(normalizedQuery)) {
        score = Math.max(score, 2);
      } else if (field.includes(normalizedQuery)) {
        score = Math.max(score, 1);
      }
    }
    if (score >= 0) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name, 'ja'));
  return scored.slice(0, limit).map(({ row }) => serializeRow(row));
}

/** 観光スポットのID（識別子）を正規化する（前後空白を落とすだけ）。 */
function normalizeSpotId(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * 観光スポットのIDとして使える文字列かどうか。空欄不可、64文字以内、
 * URLパスの区切り（"/"）・タブ・改行などの制御文字は使えない。
 */
function isValidSpotId(id) {
  if (id.length === 0 || id.length > 64) return false;
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || id[i] === '/') return false;
  }
  return true;
}

/** 経路検索：観光スポットIDから確定した1件を取得する。 */
async function getSpotById(id) {
  const key = normalizeSpotId(id);
  if (!key) return null;
  const result = await pool.query('SELECT * FROM tourist_spots WHERE id = $1', [key]);
  if (result.rows.length === 0) return null;
  return serializeRow(result.rows[0]);
}

/** 管理画面一覧用。全件をname昇順（同名はID昇順）で返す。 */
async function listTouristSpots() {
  const result = await pool.query('SELECT * FROM tourist_spots ORDER BY name, id');
  return result.rows.map(serializeRow);
}

function splitLine(line) {
  const cols = line.split('\t');
  const [
    id, name, kana, romaji, latStr, lngStr, url, hours, stayDuration, description,
    hoursEn, stayDurationEn, descriptionEn, photoUrls, category, displayTag
  ] = cols;
  return {
    colCount: cols.length,
    id: (id || '').trim(),
    name: (name || '').trim(),
    kana: (kana || '').trim(),
    romaji: (romaji || '').trim(),
    latStr: (latStr || '').trim(),
    lngStr: (lngStr || '').trim(),
    url: (url || '').trim(),
    hours: (hours || '').trim(),
    stayDuration: (stayDuration || '').trim(),
    description: (description || '').trim(),
    hoursEn: (hoursEn || '').trim(),
    stayDurationEn: (stayDurationEn || '').trim(),
    descriptionEn: (descriptionEn || '').trim(),
    // 写真URLは "," 区切りで複数可。ここでは生文字列のまま受け、parseTouristSpotsText で分解・検証する。
    photoUrlsRaw: (photoUrls || '').trim(),
    category: (category || '').trim(),
    displayTag: (displayTag || '').trim()
  };
}

function isHttpsUrl(value) {
  return value.startsWith('https://');
}

/**
 * タブ区切りテキスト（1行1件、16列）をパース・バリデーションする純粋関数（DBアクセスなし）。
 * 1列目のIDが観光スポットの識別子（空欄不可・重複不可）。名称による名寄せはしない
 * （同名の別スポットを登録できる。同一スポットの判定はIDの一致だけで行う）。
 * ローマ字が空欄でkanaが入力されていれば自動生成する。
 * 写真URL（14列目）は "," 区切りで複数枚指定でき、各要素が https:// 始まりかを検証する。
 * 正規化後（前後空白・空要素を除去し "," で連結した文字列）を photoUrls として持つ。
 * 英語版の営業時間・滞在時間目安・説明（hoursEn/stayDurationEn/descriptionEn）は
 * 利用者画面の英語表示には未使用（項目の登録のみに対応。将来対応時のための先行追加）。
 * category（カテゴリ）は情報のみで検索/表示のフィルタには未使用。
 * displayTag（表示）は空欄または「観光」を含まない値のとき、バス停ページの周辺観光スポット
 * 表示（isVisibleOnBusStopPage）からのみ除外される（地点名検索・詳細ポップアップは対象外）。
 * 1件でもエラーがあれば全エラーを集約して ok:false で返す（部分成功はしない）。
 */
function parseTouristSpotsText(text) {
  const lines = String(text || '').split(/\r\n|\r|\n/);
  const errors = [];
  const spots = [];
  const seenIds = new Map(); // id -> 最初に出現した行番号

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line) return; // 空行はスキップ

    const parsed = splitLine(rawLine);

    if (parsed.colCount > 16) {
      errors.push({ line: lineNo, reason: '列数が多すぎます（16列を超えています）。' });
      return;
    }
    if (!parsed.id) {
      errors.push({ line: lineNo, reason: 'IDは必須です（1列目にIDを入力してください）。' });
      return;
    }
    if (!isValidSpotId(parsed.id)) {
      errors.push({ line: lineNo, reason: 'IDは64文字以内で、「/」・タブ・改行などの制御文字を含めないでください。' });
      return;
    }
    if (seenIds.has(parsed.id)) {
      errors.push({ line: lineNo, reason: `IDが重複しています（${seenIds.get(parsed.id)}行目と同じID）。` });
      return;
    }
    seenIds.set(parsed.id, lineNo);
    if (!parsed.name) {
      errors.push({ line: lineNo, reason: '名称は必須です。' });
      return;
    }

    const lat = Number.parseFloat(parsed.latStr);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      errors.push({ line: lineNo, reason: '緯度は数値で指定してください（-90〜90）。' });
      return;
    }
    const lng = Number.parseFloat(parsed.lngStr);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      errors.push({ line: lineNo, reason: '経度は数値で指定してください（-180〜180）。' });
      return;
    }
    if (parsed.url && !isHttpsUrl(parsed.url)) {
      errors.push({ line: lineNo, reason: 'URLはhttps://で始めてください。' });
      return;
    }
    const photoUrlList = splitPhotoUrls(parsed.photoUrlsRaw);
    if (photoUrlList.some((u) => !isHttpsUrl(u))) {
      errors.push({ line: lineNo, reason: '写真URLはhttps://で始めてください（複数の場合は「,」で区切ってください）。' });
      return;
    }

    let romaji = parsed.romaji;
    if (!romaji && parsed.kana) {
      romaji = capitalizeRomaji(kanaToRomaji(parsed.kana));
    }

    spots.push({
      id: parsed.id,
      name: parsed.name,
      kana: parsed.kana || null,
      romaji: romaji || null,
      lat,
      lng,
      url: parsed.url || null,
      hours: parsed.hours || null,
      stayDuration: parsed.stayDuration || null,
      description: parsed.description || null,
      hoursEn: parsed.hoursEn || null,
      stayDurationEn: parsed.stayDurationEn || null,
      descriptionEn: parsed.descriptionEn || null,
      photoUrls: photoUrlList.join(',') || null,
      category: parsed.category || null,
      displayTag: parsed.displayTag || null
    });
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (spots.length === 0) {
    return { ok: false, errors: [{ line: 0, reason: '少なくとも1件の観光スポットを入力してください。' }] };
  }
  return { ok: true, spots };
}

/**
 * 全件洗い替え本体。parseTouristSpotsText→バリデーション→単一トランザクションでUPSERT+削除。
 * 1列目のIDをキーに ON CONFLICT UPDATE する（IDが同じなら名称の変更も同一スポットの改称として反映）。
 * テキストに無いIDの既存行は削除する。
 */
async function replaceAllTouristSpots(text) {
  const parsed = parseTouristSpotsText(text);
  if (!parsed.ok) return parsed;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const spot of parsed.spots) {
      await client.query(
        `INSERT INTO tourist_spots (
           id, name, kana, romaji, lat, lng, url, hours, stay_duration, description,
           hours_en, stay_duration_en, description_en, photo_urls, category, display_tag, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           kana = EXCLUDED.kana,
           romaji = EXCLUDED.romaji,
           lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           url = EXCLUDED.url,
           hours = EXCLUDED.hours,
           stay_duration = EXCLUDED.stay_duration,
           description = EXCLUDED.description,
           hours_en = EXCLUDED.hours_en,
           stay_duration_en = EXCLUDED.stay_duration_en,
           description_en = EXCLUDED.description_en,
           photo_urls = EXCLUDED.photo_urls,
           category = EXCLUDED.category,
           display_tag = EXCLUDED.display_tag,
           updated_at = now()`,
        [
          spot.id, spot.name, spot.kana, spot.romaji, spot.lat, spot.lng, spot.url, spot.hours, spot.stayDuration, spot.description,
          spot.hoursEn, spot.stayDurationEn, spot.descriptionEn, spot.photoUrls, spot.category, spot.displayTag
        ]
      );
    }
    const ids = parsed.spots.map((s) => s.id);
    await client.query('DELETE FROM tourist_spots WHERE NOT (id = ANY($1::text[]))', [ids]);
    await client.query('COMMIT');
    return { ok: true, count: parsed.spots.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 簡易UI：1件削除。 */
async function deleteSpot(id) {
  const key = normalizeSpotId(id);
  if (!key) return;
  await pool.query('DELETE FROM tourist_spots WHERE id = $1', [key]);
}

// ==========================================================
// 公式サイトリンクのタップ数計測（tourist_spot_link_clicks、docs/tourist-spots.md）
// 「その観光スポットの掲載が有用かどうか」を管理者が判断するための集計。
// スポットの id（管理画面で指定する識別子）を軸に Asia/Tokyo 基準で日別カウントする。
// 全件洗い替え（IDキーUPSERT＋テキストに無いIDはDELETE）でスポットが消えても集計を
// 残せるよう外部キーは張らず、記録時点の名称スナップショット（spot_name）を持つ。
// 名称を変えてもIDが同じなら集計は継続し、IDを消す／変えたときだけ履歴が分かれる。
// ==========================================================

/**
 * 利用者が観光スポットの公式サイトリンクをタップしたことを記録する（当日行を +1）。
 * URLが登録されているスポットだけを対象にし、該当が無ければ静かに 0 件で終わる
 * （存在しないID・URL未登録・sendBeaconの重複などを弾く）。
 */
async function recordLinkClick(spotId) {
  const key = normalizeSpotId(spotId);
  if (!key) return false;
  const result = await pool.query(
    `INSERT INTO tourist_spot_link_clicks (spot_id, spot_name, click_date, click_count)
     SELECT id, name, (now() AT TIME ZONE 'Asia/Tokyo')::date, 1
       FROM tourist_spots
      WHERE id = $1 AND url IS NOT NULL AND btrim(url) <> ''
     ON CONFLICT (spot_id, click_date) DO UPDATE
       SET click_count = tourist_spot_link_clicks.click_count + 1,
           spot_name   = EXCLUDED.spot_name,
           updated_at  = now()`,
    [key]
  );
  return result.rowCount > 0;
}

/**
 * 管理画面「観光スポット管理」の集計表示用。指定期間（from〜to、両端含む・"YYYY-MM-DD"）の
 * タップ回数をスポットごとに合計する。現在掲載中のスポットは 0 回でも行に含め（listed:true）、
 * 集計にしか残っていない（＝掲載終了した）スポットは記録時の名称スナップショットで
 * listed:false として返す。clicks 降順→名称昇順。
 */
async function getLinkClickStats({ from, to }) {
  const [aggResult, spots] = await Promise.all([
    pool.query(
      `SELECT c.spot_id,
              SUM(c.click_count)::int AS clicks,
              (ARRAY_AGG(c.spot_name ORDER BY c.click_date DESC))[1] AS snapshot_name
         FROM tourist_spot_link_clicks c
        WHERE c.click_date BETWEEN $1::date AND $2::date
        GROUP BY c.spot_id`,
      [from, to]
    ),
    listTouristSpots()
  ]);

  const clicksBySpotId = new Map();
  for (const row of aggResult.rows) {
    clicksBySpotId.set(row.spot_id, { clicks: row.clicks, snapshotName: row.snapshot_name });
  }

  const rows = spots.map((spot) => ({
    spotId: spot.spotId,
    name: spot.name,
    url: spot.url,
    listed: true,
    clicks: clicksBySpotId.get(spot.spotId)?.clicks || 0
  }));

  const listedIds = new Set(spots.map((s) => s.spotId));
  for (const [spotId, agg] of clicksBySpotId) {
    if (listedIds.has(spotId)) continue;
    rows.push({ spotId, name: agg.snapshotName, url: null, listed: false, clicks: agg.clicks });
  }

  rows.sort((a, b) => b.clicks - a.clicks || String(a.name).localeCompare(String(b.name), 'ja'));
  const totalClicks = rows.reduce((sum, r) => sum + r.clicks, 0);
  return { from, to, totalClicks, rows };
}

/** 保持期間（既定 LINK_CLICK_RETENTION_DAYS 日）を過ぎたタップ集計を掃除する（scheduler.js の1時間掃除から）。 */
async function purgeOldLinkClicks(retentionDays = LINK_CLICK_RETENTION_DAYS) {
  const result = await pool.query(
    `DELETE FROM tourist_spot_link_clicks
      WHERE click_date < ((now() AT TIME ZONE 'Asia/Tokyo')::date - $1::int)`,
    [retentionDays]
  );
  return result.rowCount;
}

module.exports = {
  findNearbySpots,
  searchTouristSpots,
  getSpotById,
  listTouristSpots,
  replaceAllTouristSpots,
  deleteSpot,
  parseTouristSpotsText,
  recordLinkClick,
  getLinkClickStats,
  purgeOldLinkClicks,
  LINK_CLICK_MAX_RANGE_DAYS
};
