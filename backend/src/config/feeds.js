// 位置情報フィード・GTFSフィードの構成と、両者の対応をコードで管理する。
//
// 以前は feeds / feed_mappings（DB）で管理し、対応は confidence（信頼度）の
// 降順で1件を選ぶ推測方式だったが、対応は運用者が知っている確定事実であり
// 推測する必要がない。同値 confidence で選択が不定になる問題もあったため全廃した。
// 稼働状態（last_fetched_at / last_status / last_error）のみ feeds テーブルに残る。
//
// ⚠️ 有効フィード一覧の取得口はこのファイルだけである。
// 各サービスが独自に `SELECT ... FROM feeds` を書いてはいけない
// （移行前は同じSQLが4箇所に重複し、サービス間で「有効なフィード」の認識がずれる温床だった）。
// フィード一覧が欲しくなったら、このファイルに関数を足すこと。
//
// feeds テーブルの id / feed_type / name / url / enabled は**このファイルが正**である。
// DBを直接編集しても、次回起動時の seed() によるUPSERTで上書きされる。

const GTFS_FEEDS = [
  {
    id: 'guruttomatsumotobus1',
    name: 'ぐるっと松本バス1',
    url: 'https://api.gtfs-data.jp/v2/organizations/matsumotocity/feeds/guruttomatsumotobus1/files/feed.zip?rid=current',
    enabled: true
  },
  {
    id: 'guruttomatsumotobus2',
    name: 'ぐるっと松本バス2',
    url: 'https://api.gtfs-data.jp/v2/organizations/matsumotocity/feeds/guruttomatsumotobus2/files/feed.zip?rid=current',
    enabled: true
  }
];

const LOCATION_FEEDS = [
  {
    id: 'matsumotoshicombus',
    name: '松本市民バス',
    url: 'https://dashboard.wakoticket.net/information/matsumotoshicombus/latlon.csv',
    enabled: true,
    // このCSVに現れる外部IDが属するGTFSフィード
    gtfsFeedIds: ['guruttomatsumotobus2']
  },
  {
    id: 'alpicokotsu',
    name: 'アルピコ交通',
    url: 'https://dashboard.wakoticket.net/information/alpicokotsu/latlon.csv',
    enabled: true,
    // 旧: 1と2が同値 confidence 0.5 で、どちらが選ばれるか不定だった（仕様書 問題E）。
    // 実際は両方にまたがるため、両方を明示する。これは推測ではなく
    // 「絞り込みで落とさない」という安全側の明示である（仕様書 4.3.1）。
    gtfsFeedIds: ['guruttomatsumotobus1', 'guruttomatsumotobus2']
  },
  {
    id: 'matsumotoshiei',
    name: '松本市営',
    url: 'https://dashboard.wakoticket.net/information/matsumotoshiei/latlon.csv',
    enabled: true,
    gtfsFeedIds: ['guruttomatsumotobus2']
  }
];

/**
 * 有効なGTFSフィード一覧。`{ id, name, url }` の配列を返す。
 * DBを引かないので失敗しえない。
 */
function getEnabledGtfsFeeds() {
  return GTFS_FEEDS.filter((feed) => feed.enabled !== false).map((feed) => ({
    id: feed.id,
    name: feed.name,
    url: feed.url
  }));
}

/**
 * 有効なGTFSフィードのID一覧。
 */
function getEnabledGtfsFeedIds() {
  return getEnabledGtfsFeeds().map((feed) => feed.id);
}

/**
 * 有効な位置情報フィード一覧。`{ id, name, url }` の配列を返す。
 */
function getEnabledLocationFeeds() {
  return LOCATION_FEEDS.filter((feed) => feed.enabled !== false).map((feed) => ({
    id: feed.id,
    name: feed.name,
    url: feed.url
  }));
}

/**
 * 位置情報フィードに対応するGTFSフィードIDの配列を返す。
 *
 * 1件に畳まず配列のまま返すのが要点である。アルピコ交通のように
 * 複数のGTFSフィードにまたがる事業者を、推測で片方に決めてしまわないため。
 * 未設定・未知のフィードでは空配列を返す（呼び出し側は絞り込みを行わない）。
 */
function getGtfsFeedIdsFor(locationFeedId) {
  const feed = LOCATION_FEEDS.find((f) => f.id === locationFeedId);
  if (!feed) return [];
  return Array.isArray(feed.gtfsFeedIds) ? feed.gtfsFeedIds.slice() : [];
}

/**
 * feeds テーブルへのUPSERT用に、全フィードを `feed_type` 付きで返す。
 */
function getAllFeedsForDb() {
  return [
    ...GTFS_FEEDS.map((feed) => ({
      id: feed.id,
      feedType: 'gtfs',
      name: feed.name,
      url: feed.url,
      enabled: feed.enabled !== false
    })),
    ...LOCATION_FEEDS.map((feed) => ({
      id: feed.id,
      feedType: 'location',
      name: feed.name,
      url: feed.url,
      enabled: feed.enabled !== false
    }))
  ];
}

/**
 * フィード構成の整合性を検証する（仕様書 4.4）。
 *
 * 起動を止めないのは意図的である。GTFS更新でフィード側の route_id が一時的に
 * 消えたときに、システム全体が起動不能になることを避けるため
 * （REQUIRED_GTFS_FILES に関する既知の注意点と同じ考え方）。
 *
 * @returns {string[]} 検出した問題の説明（問題がなければ空配列）
 */
function validateFeedConfig() {
  const problems = [];

  const seenIds = new Set();
  for (const feed of [...GTFS_FEEDS, ...LOCATION_FEEDS]) {
    if (seenIds.has(feed.id)) {
      problems.push(`フィードIDが重複しています: ${feed.id}`);
    }
    seenIds.add(feed.id);
  }

  const gtfsFeedIds = new Set(GTFS_FEEDS.map((feed) => feed.id));
  const referencedGtfsFeedIds = new Set();
  for (const feed of LOCATION_FEEDS) {
    const ids = Array.isArray(feed.gtfsFeedIds) ? feed.gtfsFeedIds : [];
    if (ids.length === 0) {
      problems.push(`位置情報フィード ${feed.id} に gtfsFeedIds が設定されていません。`);
    }
    for (const gtfsFeedId of ids) {
      referencedGtfsFeedIds.add(gtfsFeedId);
      if (!gtfsFeedIds.has(gtfsFeedId)) {
        problems.push(`位置情報フィード ${feed.id} が未定義のGTFSフィード ${gtfsFeedId} を参照しています。`);
      }
    }
  }

  for (const gtfsFeedId of gtfsFeedIds) {
    if (!referencedGtfsFeedIds.has(gtfsFeedId)) {
      problems.push(`GTFSフィード ${gtfsFeedId} はどの位置情報フィードからも参照されていません。`);
    }
  }

  return problems;
}

module.exports = {
  GTFS_FEEDS,
  LOCATION_FEEDS,
  getEnabledGtfsFeeds,
  getEnabledGtfsFeedIds,
  getEnabledLocationFeeds,
  getGtfsFeedIdsFor,
  getAllFeedsForDb,
  validateFeedConfig
};
