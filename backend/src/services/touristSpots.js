// 観光スポット情報機能（観光スポット情報_仕様書）
//
// GTFS由来データ（stops/schedule_*等）とは完全独立の tourist_spots テーブルを扱う。
// バス停との関連付けは保存時ではなく参照時に緯度経度の近接検索（ハバーサイン距離）で
// 都度解決するため、このファイルはバス停側のテーブル・インデックスを一切参照しない。

const pool = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');
const { kanaToRomaji, capitalizeRomaji, normalizeSearchText } = require('../utils/kana');

const DEFAULT_NEARBY_RADIUS_METERS = 500; // バス停統合しきい値400mを参考にした初期値
const DEFAULT_NEARBY_LIMIT = 5;
const WALK_SPEED_METERS_PER_MIN = 80; // gtfsTimetable.js / gtfsRouteSearch.js と同値

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
    photoUrl: row.photo_url,
    category: row.category,
    displayTag: row.display_tag,
    enabled: row.enabled
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
 * バス停ページ用の近接検索。enabled=trueかつisVisibleOnBusStopPageのみ対象、半径内・距離昇順で最大limit件。
 * 各要素に最寄りバス停までの徒歩距離の概算（distanceMeters・walkMinutes）を付与する。
 */
async function findNearbySpots(lat, lon, { radiusMeters = DEFAULT_NEARBY_RADIUS_METERS, limit = DEFAULT_NEARBY_LIMIT } = {}) {
  const result = await pool.query('SELECT * FROM tourist_spots WHERE enabled = TRUE');
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
    distanceMeters: Math.round(distanceMeters),
    walkMinutes: Math.max(1, Math.round(distanceMeters / WALK_SPEED_METERS_PER_MIN))
  }));
}

/**
 * 経路検索・地点名検索の候補用。name/kana/romajiの部分一致（normalizeSearchTextで正規化）。
 * 前方一致を優先し、次に部分一致（gtfsTimetable.searchStops()と同じ考え方）。enabled=trueのみ。
 */
async function searchTouristSpots(query, limit = 10) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const result = await pool.query('SELECT * FROM tourist_spots WHERE enabled = TRUE');
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

/** 経路検索：観光スポットIDから確定した1件を取得する（enabled=trueのみ）。 */
async function getEnabledSpotById(id) {
  const result = await pool.query('SELECT * FROM tourist_spots WHERE id = $1 AND enabled = TRUE', [id]);
  if (result.rows.length === 0) return null;
  return serializeRow(result.rows[0]);
}

/** 管理画面一覧用。includeDisabled=falseならenabled=trueのみ、trueなら全件。name昇順。 */
async function listTouristSpots({ includeDisabled = false } = {}) {
  const query = includeDisabled
    ? 'SELECT * FROM tourist_spots ORDER BY name'
    : 'SELECT * FROM tourist_spots WHERE enabled = TRUE ORDER BY name';
  const result = await pool.query(query);
  return result.rows.map(serializeRow);
}

function splitLine(line) {
  const cols = line.split('\t');
  const [
    name, kana, romaji, latStr, lngStr, url, hours, stayDuration, description,
    hoursEn, stayDurationEn, descriptionEn, photoUrl, category, displayTag
  ] = cols;
  return {
    colCount: cols.length,
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
    photoUrl: (photoUrl || '').trim(),
    category: (category || '').trim(),
    displayTag: (displayTag || '').trim()
  };
}

function isHttpsUrl(value) {
  return value.startsWith('https://');
}

/**
 * タブ区切りテキスト（1行1件、15列）をパース・バリデーションする純粋関数（DBアクセスなし）。
 * ローマ字が空欄でkanaが入力されていれば自動生成する。
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
  const seenNames = new Map(); // name -> 最初に出現した行番号

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line) return; // 空行はスキップ

    const parsed = splitLine(rawLine);

    if (parsed.colCount > 15) {
      errors.push({ line: lineNo, reason: '列数が多すぎます（15列を超えています）。' });
      return;
    }
    if (!parsed.name) {
      errors.push({ line: lineNo, reason: '名称は必須です。' });
      return;
    }
    if (seenNames.has(parsed.name)) {
      errors.push({ line: lineNo, reason: `名称が重複しています（${seenNames.get(parsed.name)}行目と同名）。` });
      return;
    }
    seenNames.set(parsed.name, lineNo);

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
    if (parsed.photoUrl && !isHttpsUrl(parsed.photoUrl)) {
      errors.push({ line: lineNo, reason: '写真URLはhttps://で始めてください。' });
      return;
    }

    let romaji = parsed.romaji;
    if (!romaji && parsed.kana) {
      romaji = capitalizeRomaji(kanaToRomaji(parsed.kana));
    }

    spots.push({
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
      photoUrl: parsed.photoUrl || null,
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
 * 名称キーでON CONFLICT UPDATEするため、変更のない行はidが変わらない。
 * enabledはUPDATE時に更新しない（INSERT時のみdefault true。簡易UIでの一時非表示を、
 * 無関係な再貼り付けで巻き戻さないため）。
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
           name, kana, romaji, lat, lng, url, hours, stay_duration, description,
           hours_en, stay_duration_en, description_en, photo_url, category, display_tag, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
         ON CONFLICT (name) DO UPDATE SET
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
           photo_url = EXCLUDED.photo_url,
           category = EXCLUDED.category,
           display_tag = EXCLUDED.display_tag,
           updated_at = now()`,
        [
          spot.name, spot.kana, spot.romaji, spot.lat, spot.lng, spot.url, spot.hours, spot.stayDuration, spot.description,
          spot.hoursEn, spot.stayDurationEn, spot.descriptionEn, spot.photoUrl, spot.category, spot.displayTag
        ]
      );
    }
    const names = parsed.spots.map((s) => s.name);
    await client.query('DELETE FROM tourist_spots WHERE NOT (name = ANY($1::text[]))', [names]);
    await client.query('COMMIT');
    return { ok: true, count: parsed.spots.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 簡易UI：有効/無効切り替え。該当行が無ければfalseを返す。 */
async function setSpotEnabled(id, enabled) {
  const result = await pool.query('UPDATE tourist_spots SET enabled = $2, updated_at = now() WHERE id = $1', [id, enabled]);
  return result.rowCount > 0;
}

/** 簡易UI：1件削除。 */
async function deleteSpot(id) {
  await pool.query('DELETE FROM tourist_spots WHERE id = $1', [id]);
}

module.exports = {
  findNearbySpots,
  searchTouristSpots,
  getEnabledSpotById,
  listTouristSpots,
  replaceAllTouristSpots,
  setSpotEnabled,
  deleteSpot,
  parseTouristSpotsText
};
