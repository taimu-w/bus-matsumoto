// スポット検索の「タグ検索」で使うタグ（docs/spot-search.md）。
//
// タグの実体は tourist_spots.tags（"," 区切り）。この表（spot_tags）は
// 「タグ検索のタグ一覧に出す順序」だけを持つレジストリで、全件洗い替え
// （touristSpots.replaceAllTouristSpots）のたびに syncTagRegistry() で
// 「1件以上のスポットが付けているタグ」へ同期する（新規タグは末尾へ、
// どのスポットも付けなくなったタグは削除）。管理画面「タグ管理」は
// sort_order だけを編集する（reorderTags）。
//
// 「近い」は現在地から半径500m以内を絞り込む予約タグで、DBのタグとしては
// 扱わない（parseTouristSpotsText がタグ名としての登録を弾く。タグ検索側は
// spotSearch.searchByTags が現在地フィルタとして解釈する）。

const pool = require('../config/db');

// 現在地から半径 NEAR_TAG_RADIUS_METERS 以内を絞り込む予約タグ。
const NEAR_TAG = '近い';
const NEAR_TAG_RADIUS_METERS = 500;

/** "," 区切りのタグ文字列を配列へ分解する（前後空白・空要素を落とす）。aliases/photo_urls と同じ考え方。 */
function splitTags(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** parsed spot 群から、予約タグを除いた distinct なタグ名の配列を返す（純粋関数）。 */
function collectDistinctTags(spots) {
  const set = new Set();
  for (const spot of spots || []) {
    for (const tag of splitTags(spot && spot.tags)) {
      if (tag !== NEAR_TAG) set.add(tag);
    }
  }
  return Array.from(set);
}

/**
 * 全件洗い替えのトランザクション内から呼ぶ。渡した spots が付けているタグへ spot_tags を同期する。
 * 新規タグは既存の最大 sort_order の後ろへ名前順で採番し、どのスポットも付けていないタグは削除する。
 * client は touristSpots.replaceAllTouristSpots が握っているトランザクション接続。
 */
async function syncTagRegistry(client, spots) {
  const tags = collectDistinctTags(spots);
  await client.query('DELETE FROM spot_tags WHERE NOT (name = ANY($1::text[]))', [tags]);
  if (tags.length === 0) return;
  await client.query(
    `INSERT INTO spot_tags (name, sort_order)
     SELECT t.name,
            (SELECT COALESCE(MAX(sort_order), 0) FROM spot_tags) + row_number() OVER (ORDER BY t.name)
       FROM unnest($1::text[]) AS t(name)
     ON CONFLICT (name) DO NOTHING`,
    [tags]
  );
}

/** タグ名 → そのタグを付けているスポット件数の Map（tourist_spots.tags を JS 側で集計する）。 */
async function tagSpotCounts() {
  const { rows } = await pool.query('SELECT tags FROM tourist_spots');
  const counts = new Map();
  for (const row of rows) {
    for (const tag of splitTags(row.tags)) {
      if (tag === NEAR_TAG) continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return counts;
}

/** 管理画面「タグ管理」・タグ検索のタグ一覧用。sort_order→名前順で {name, sortOrder, spotCount} を返す。 */
async function listTagsWithCounts() {
  const [{ rows }, counts] = await Promise.all([
    pool.query('SELECT name, sort_order FROM spot_tags ORDER BY sort_order, name'),
    tagSpotCounts()
  ]);
  return rows.map((row) => ({
    name: row.name,
    sortOrder: row.sort_order,
    spotCount: counts.get(row.name) || 0
  }));
}

/**
 * 管理画面「タグ管理」の並び順保存。orderedNames は spot_tags に実在する全タグを
 * 表示順に並べた配列。1件でも未知・欠落・重複があれば何も更新せずエラーを返す
 * （画面が古い一覧のまま保存して並びが壊れるのを防ぐ）。
 */
async function reorderTags(orderedNames) {
  const names = Array.isArray(orderedNames) ? orderedNames.map((s) => String(s || '').trim()) : [];
  if (names.some((n) => !n) || new Set(names).size !== names.length) {
    return { ok: false, error: 'タグ名が空・重複しています。' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT name FROM spot_tags');
    const known = new Set(rows.map((r) => r.name));
    if (names.length !== known.size || names.some((n) => !known.has(n))) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'タグ一覧が変更されています。画面を再読み込みしてからやり直してください。' };
    }
    for (let i = 0; i < names.length; i += 1) {
      await client.query(
        'UPDATE spot_tags SET sort_order = $2, updated_at = now() WHERE name = $1',
        [names[i], i + 1]
      );
    }
    await client.query('COMMIT');
    return { ok: true, count: names.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  NEAR_TAG,
  NEAR_TAG_RADIUS_METERS,
  splitTags,
  collectDistinctTags,
  syncTagRegistry,
  listTagsWithCounts,
  reorderTags
};
