// 位置情報CSVの外部ID → GTFS route_id の対応を、コードで管理する。
//
// 以前は route_external_ids（DB）に路線名経由で投入する方式だったが、
// 表記ゆれによる欠落が黙って発生するため、qualified route id の直接指定に一本化した。
// 旧方式のテーブル・seed初期値・管理画面の編集UIはすべて削除済みで、
// **このファイルが対応関係の唯一の情報源**である。
//
// キーは外部ID、値は routes.id と同じ「feedId:routeId」形式の qualified route id。
// 1つの route_id に複数の外部IDが対応してよい（事業者が系統ごとに別IDを振るため）。
// 路線名はコメントとしてのみ残す。**コードは路線名を参照しない。**

const ROUTE_EXTERNAL_ID_MAP = {
  // --- guruttomatsumotobus1 ---
  '01h9j04qf5pfg6za7eg0c4wqea': 'guruttomatsumotobus1:10', // 信大横田循環線
  '01h9j06f82mw3wvnddsbs4z7fs': 'guruttomatsumotobus1:11', // 横田信大循環線
  '01h9j07mcq8yvmvcepyyetchhh': 'guruttomatsumotobus1:12', // 浅間線
  '01h9j099yhcqm8h414kwmenm5p': 'guruttomatsumotobus1:13', // 新浅間線
  // 旧方式では seed の路線名が「美ケ原温泉線」、GTFSが「美ヶ原温泉線」で
  // 「ケ / ヶ」1文字の表記ゆれのため名前解決が空振りし、黙って捨てられていた。
  '01h9j0aq0jnyqd6bnce5tdshsx': 'guruttomatsumotobus1:14', // 美ヶ原温泉線
  '01h9j0bk8t8qxpk23m4bqmeaqf': 'guruttomatsumotobus1:15', // 北市内線
  '01h9j0cgk3qvw6t8j9z5kp50bg': 'guruttomatsumotobus1:16', // 岡田線
  '01h9j0dfrkbgq5srqsstmb87zr': 'guruttomatsumotobus1:17', // アルプス公園線
  '01h9j0eaxbqfgeapy0wcyff5cg': 'guruttomatsumotobus1:18', // 鹿教湯温泉線
  '01h9j0f842rq9nvmc1f0hr615a': 'guruttomatsumotobus1:19', // 空港今井線
  // 旧方式では seed の路線名が「大久保工場団地線・神林線」、GTFSが「大久保工場団地・神林線」で
  // 「線」1文字の表記ゆれのため名前解決が空振りし、黙って捨てられていた（下の1件も同じ）。
  '01h9j0g3wfs5j4jnfm0w3q0mq9': 'guruttomatsumotobus1:20', // 大久保工場団地・神林線
  '01h9pfrv7rm8dwfb97y4nptdxv': 'guruttomatsumotobus1:20', // 大久保工場団地・神林線
  '01h9j0h2f2zey9px0ek9brh1m6': 'guruttomatsumotobus1:21', // 山形線
  '01h9j0hym391fkbt20ffchkame': 'guruttomatsumotobus1:22', // 寿台線
  '01h9j0jyc4x4nrc0y859nxpkhy': 'guruttomatsumotobus1:23', // 松原線
  '01h9j0kxkm4x90ffdxsk0mbznh': 'guruttomatsumotobus1:24', // 内田線
  '01gtk2gfphyzgzm7mb0pwn8eqp': 'guruttomatsumotobus1:25', // 並柳団地線
  '01ha922g5tvbnnkmmcvna9524w': 'guruttomatsumotobus1:25', // 並柳団地線（系統違いの別ID）
  '01h9j0msfjw147rc5ky4thtrt7': 'guruttomatsumotobus1:26', // 四賀線

  // --- guruttomatsumotobus2 ---
  '01fsp3daby2y055rwgx9w1nk5j': 'guruttomatsumotobus2:10', // タウンスニーカー北コース
  '01fsp3dym3e1mhg5wpze8ykbmn': 'guruttomatsumotobus2:11', // タウンスニーカー東コース
  '01fsp3ee248pz8pgmaq32x639a': 'guruttomatsumotobus2:12', // タウンスニーカー南コース
  '01ft4y663269mwmtjft8bb2gc6': 'guruttomatsumotobus2:13', // 南部循環線
  '01gtx3caern3gv4z2rhkzba9f4': 'guruttomatsumotobus2:14', // 合庁ライナー
  '01hcv1n381vs9r0j6d297xepg2': 'guruttomatsumotobus2:16', // 松本・島内線
  '01hdj79wsrrz2n9ee0vq01e6k2': 'guruttomatsumotobus2:16', // 松本・島内線（系統違いの別ID）
  '01hcv1ny46af2pagpysazrbrz7': 'guruttomatsumotobus2:17', // 南松本・山形線
  '01hcv1p87398b578fghsmy2wjh': 'guruttomatsumotobus2:18', // 梓川・波田線
  '01hcv1pnxzz3s3zc9hxpgm3h4n': 'guruttomatsumotobus2:19', // 村井・山形線
  '01hcv1q1zs8av0kszg6a74rtnp': 'guruttomatsumotobus2:20', // 朝日・波田線
  '01hd0f1s4vkm0qm6061mvq79fm': 'guruttomatsumotobus2:23', // 奈川・安曇線
  '01hd0f04bm9e9x0hf196k5e3r2': 'guruttomatsumotobus2:24', // 四賀循環線
  '01hd0f0m9bdf4xatjaknthjjjb': 'guruttomatsumotobus2:24', // 四賀循環線（系統違いの別ID）
  '01hd0f12fbb55tmydz5n9cs79k': 'guruttomatsumotobus2:24', // 四賀循環線（系統違いの別ID）
  '01hd0f1fzc3903rx7ncp0jrevq': 'guruttomatsumotobus2:24', // 四賀循環線（系統違いの別ID）

  // --- 対応するGTFS路線が存在しないため無効化中 ---
  // 旧 route_external_ids テーブルを削除した以上、これらの外部IDの記録はここにしか残らない。
  // 消してしまうと、後で該当路線がGTFSに追加された際に外部IDを再調査する羽目になる。
  // 該当路線がGTFSに現れたら、qualified route id を書いてコメントアウトを外すこと。
  // '01kkdhrxy2vtnqs4dzedzdkf2e': '???', // 第一高校スクール（GTFSに該当路線なし）
  // '01hcv1qc4k73nr6hav35kaz57q': '???', // 南松本・平田線（GTFSに該当路線なし）
  // '01hcv1qnjyrb99ph8m0zb1hpra': '???', // 平田・村井線（GTFSに該当路線なし）
};

/**
 * 外部IDから qualified route id を引く。未登録なら null。
 */
function resolveRouteIdByExternalId(externalId) {
  if (!externalId) return null;
  return ROUTE_EXTERNAL_ID_MAP[externalId] || null;
}

/**
 * 指定GTFSフィードに属する外部IDだけを抜き出した Map（外部ID → route_id）を返す。
 * 位置情報フィードごとの絞り込みに使う。
 */
function getExternalIdsForFeed(gtfsFeedId) {
  const result = new Map();
  if (!gtfsFeedId) return result;
  const prefix = `${gtfsFeedId}:`;
  for (const [externalId, routeId] of Object.entries(ROUTE_EXTERNAL_ID_MAP)) {
    if (routeId.startsWith(prefix)) {
      result.set(externalId, routeId);
    }
  }
  return result;
}

/**
 * 複数のGTFSフィードに属する外部IDをまとめた Map を返す。
 * 配列が空の場合は「絞り込みなし」として全件を返す。
 * 1つの位置情報フィードが複数のGTFSフィードにまたがるケース（アルピコ交通）のためのもの。
 */
function getExternalIdsForFeeds(gtfsFeedIds) {
  const ids = Array.isArray(gtfsFeedIds) ? gtfsFeedIds : [];
  if (ids.length === 0) return getAllExternalIds();

  const result = new Map();
  for (const [externalId, routeId] of Object.entries(ROUTE_EXTERNAL_ID_MAP)) {
    if (ids.some((feedId) => routeId.startsWith(`${feedId}:`))) {
      result.set(externalId, routeId);
    }
  }
  // 設定漏れで位置情報が全滅しないよう、1件も一致しなければ絞り込みを行わない
  // （旧実装の「マッチが0件なら絞り込み前のマップに戻す」フォールバックと同じ結果）。
  return result.size > 0 ? result : getAllExternalIds();
}

/**
 * 全エントリの Map（外部ID → route_id）。
 */
function getAllExternalIds() {
  return new Map(Object.entries(ROUTE_EXTERNAL_ID_MAP));
}

/**
 * 対応表の整合性を検証する（仕様書 4.2）。
 *
 * 起動を止めないのは意図的である。GTFS更新でフィード側の route_id が一時的に
 * 消えたときに、システム全体が起動不能になることを避けるため。
 *
 * @param {Set<string>|string[]|null} knownRouteIds 実在する qualified route id の集合。
 *   省略した場合は形式チェックとフィードIDの実在チェックだけを行う。
 * @returns {string[]} 検出した問題の説明（問題がなければ空配列）
 */
function validateRouteExternalIdMap(knownRouteIds = null) {
  const { GTFS_FEEDS } = require('./feeds');
  const knownFeedIds = new Set(GTFS_FEEDS.map((feed) => feed.id));
  const routeIdSet = knownRouteIds
    ? (knownRouteIds instanceof Set ? knownRouteIds : new Set(knownRouteIds))
    : null;

  const problems = [];
  for (const [externalId, routeId] of Object.entries(ROUTE_EXTERNAL_ID_MAP)) {
    if (typeof routeId !== 'string' || !routeId.includes(':')) {
      problems.push(`外部ID ${externalId} の値 "${routeId}" が feedId:routeId 形式ではありません。`);
      continue;
    }
    const feedId = routeId.slice(0, routeId.indexOf(':'));
    if (!knownFeedIds.has(feedId)) {
      problems.push(`外部ID ${externalId} が未定義のGTFSフィード ${feedId} を参照しています。`);
      continue;
    }
    if (routeIdSet && !routeIdSet.has(routeId)) {
      problems.push(`外部ID ${externalId} の参照先 route_id ${routeId} がGTFSデータに存在しません。`);
    }
  }
  return problems;
}

module.exports = {
  ROUTE_EXTERNAL_ID_MAP,
  resolveRouteIdByExternalId,
  getExternalIdsForFeed,
  getExternalIdsForFeeds,
  getAllExternalIds,
  validateRouteExternalIdMap
};
