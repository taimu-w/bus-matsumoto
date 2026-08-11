# フィード構成・外部IDマッピングのコード化 仕様書

作成日：2026-08-11

## 1. 目的

位置情報とGTFSを結びつける設定を、DB管理・名前解決・確度による推測から、
**すべてコード上の明示的な記述**へ移行する。対象は次の2つである。

**(1) 外部ID ⇔ GTFS route_id の対応**
現在の「路線名（`routeName`）を経由してDBで解決する方式」から、
`backend/src/config/directionMapping.js` と同じく
**コード上に qualified route id（`feedId:routeId`）を明記する方式**へ移行する。

**(2) 位置情報フィード ⇔ GTFSフィードの対応**
現在の「`feed_mappings` テーブルに複数の候補を持ち、`confidence`（信頼度）の
降順で1件を選ぶ推測方式」を廃止し、**どのURLから取得した位置情報が
どのGTFSフィードに対応するかをコードに1対1で明記する**。

この2つは「位置情報の行を、どのGTFSの路線に結びつけるか」という
同じ解決経路の別々の段であり、いずれも**確定している事実を、確定していないかのように
扱っている**点が共通の問題である。まとめて修正する。

先行事例として、方向値の対応（`direction_mapping`）は仕様書 6.1 により既にDB管理からコード管理へ移行済みである。
本件はその続きであり、**同じ設計方針・同じ移行手順を踏襲する**。

## 2. 現状

### 2.1 データの流れ

```
feeds（DB）から有効な位置情報フィードのURL一覧を取得
  └─ feed_mappings（DB）で 位置情報フィード → GTFSフィード を confidence 降順で1件選ぶ ← (2)
       └─ 各URLからCSVを取得
            └─ 行のどこかに externalId が含まれる
                 └─ route_external_ids（DB）で externalId → route_id を解決 ← (1)
                      └─ 上で選んだGTFSフィードのプレフィックスで絞り込み
                           └─ vehicle_positions_raw.route_id（qualified route id）
                                └─ vehicles.route_id → tripAssignment.js の路線一致判定
```

### 2.2 現状 (1)：外部ID ⇔ route_id

- 初期値：`backend/src/db/seed.js` の `DEFAULT_ROUTE_EXTERNAL_ID_MAPPINGS`（38件）
- 初期値は **`{ externalId, routeName }`** の形で持ち、`seedRouteExternalIds()` が
  `routes.name` を引いて route_id へ解決してからDBへ投入する
- 実行時の参照：`services/locationFetcher.js` の `fetchLocation()` が
  `SELECT route_id, external_id FROM route_external_ids` で全件読み出し、
  `fetchLocationFeed()` が `feed_mappings` に基づきフィード単位に絞り込んで突合する
- 編集経路：管理画面 `GET/PUT /api/admin/route-mappings`

### 2.3 現状 (2)：位置情報フィード ⇔ GTFSフィード

- URL定義：`seed.js` の `DEFAULT_FEEDS`。GTFS 2件・位置情報 3件を `feeds` テーブルへ投入する

| 位置情報フィードID | 事業者名 | URL |
|---|---|---|
| `matsumotoshicombus` | 松本市民バス | `https://dashboard.wakoticket.net/information/matsumotoshicombus/latlon.csv` |
| `alpicokotsu` | アルピコ交通 | `https://dashboard.wakoticket.net/information/alpicokotsu/latlon.csv` |
| `matsumotoshiei` | 松本市営 | `https://dashboard.wakoticket.net/information/matsumotoshiei/latlon.csv` |

- 対応関係：`seed.js` の `DEFAULT_FEED_MAPPINGS`。コメントに
  **「（推測値）実際の対応は管理画面や自動推測で更新可能」**と明記されている

| 位置情報フィード | GTFSフィード | confidence |
|---|---|---|
| `matsumotoshicombus` | `guruttomatsumotobus2` | 0.5 |
| `alpicokotsu` | `guruttomatsumotobus1` | 0.5 |
| `alpicokotsu` | `guruttomatsumotobus2` | 0.5 |
| `matsumotoshiei` | `guruttomatsumotobus1` | 0.3 |

- 実行時の参照：`getFeedMappings()` が `ORDER BY confidence DESC` で全件読み、
  **位置情報フィードごとに最初の1件だけを採用**して残りを捨てる（`locationFetcher.js` 52〜63行目）

### 2.4 現状の問題点（実データで確認済み）

`data gtfs/*/routes.txt` と `DEFAULT_ROUTE_EXTERNAL_ID_MAPPINGS` を突合した結果、以下を確認した。

**(A) 路線名がGTFSに存在せず、初期値が黙って捨てられている（6件）**

`seedRouteExternalIds()` は `routeIdByName.get()` が空振りすると `continue` するだけで、
警告も出さずスキップする。以下は現在まったく登録されていない。

| externalId | seed の routeName | GTFS routes.txt の実際の名前 |
|---|---|---|
| `01h9j0aq0jnyqd6bnce5tdshsx` | 美**ケ**原温泉線 | 美**ヶ**原温泉線（`guruttomatsumotobus1:14`） |
| `01h9j0g3wfs5j4jnfm0w3q0mq9` | 大久保工場団地**線**・神林線 | 大久保工場団地・神林線（`guruttomatsumotobus1:20`） |
| `01h9pfrv7rm8dwfb97y4nptdxv` | 大久保工場団地**線**・神林線 | 同上 |
| `01kkdhrxy2vtnqs4dzedzdkf2e` | 第一高校スクール | 該当なし |
| `01hcv1qc4k73nr6hav35kaz57q` | 南松本・平田線 | 該当なし |
| `01hcv1qnjyrb99ph8m0zb1hpra` | 平田・村井線 | 該当なし |

上2件は「ケ / ヶ」「線」の**表記ゆれ1文字**が原因である。
文字列完全一致に依存する設計のため、GTFS側の軽微な改称でいつでも再発する。

**(B) GTFS側に存在するが対応表に無い路線（7件）**

`guruttomatsumotobus1:14`（美ヶ原温泉線）、`1:20`（大久保工場団地・神林線）、
`2:25`（波田循環バス）、`2:26`（ほしみ線）、`2:27`（入山辺線）、`2:28`（中山線）、`2:29`（浅間・大村線）。
これらは位置情報が来ても路線を解決できず、`fetchLocationFeed()` の
`if (!matchedRouteId) continue;` で破棄される。

**(C) 名前解決が構造的に曖昧**

`routeIdByName` は `Map(routes.name → id)` であり、**同名路線があれば後勝ちで潰れる**。
現時点の2フィードでは同名の衝突は発生していないが、
フィードを追加した時点で警告なく誤った路線に紐づく。
`qualifyRouteId` でIDをフィード単位に一意化した設計意図が、名前解決の層で失われている。

**(D) 1つの route_id に複数の externalId が正当にぶら下がる**

並柳団地線（2件）、松本・島内線（2件）、四賀循環線（4件）。
これは**仕様として正しい**（事業者側が系統ごとに別IDを振っている）。
新方式でも必ず「多対1」を表現できる必要がある。

**(E) `alpicokotsu` は confidence が同値で、採用されるGTFSフィードが不定**

`alpicokotsu` には `guruttomatsumotobus1` と `guruttomatsumotobus2` の2件が
**どちらも confidence 0.5** で登録されている。`getFeedMappings()` は
`ORDER BY confidence DESC` の先頭1件を採るため、同値の場合に
**どちらが選ばれるかはPostgreSQLの行の返却順しだい**になる。
タイブレークの第2キーが指定されていないため、これは保証されない順序である。

つまり、アルピコ交通の位置情報が `guruttomatsumotobus1` と `2` の
どちらの路線集合に絞り込まれるかが、**実行のたびに変わりうる**。
これは推測方式そのものではなく、推測を確定に落とす段の設計不備である。

**(F) 「1つの位置情報フィードは1つのGTFSフィードに対応する」という前提が誤り**

`getFeedMappings()` が `Map(location_feed_id → gtfs_feed_id)` で
**1対1に畳んでいる**のが問題の本質である。
実際にはアルピコ交通は2つのGTFSフィード両方に路線を持ちうるため、
どちらか一方を選んだ時点で、もう一方の路線の位置情報は解決できなくなる。

現状これが破綻していないのは、`fetchLocationFeed()` に
「プレフィックスなしの旧ルートをフォールバックとして含める」互換分岐があり、
かつ外部IDの突合が**フィード横断で行われても実害が出ないよう
外部IDが全体で一意**だからである。つまり、**絞り込みは実質的に効いていない**。

**(G) 「自動推測で更新可能」という仕組みは実装されていない**

`DEFAULT_FEED_MAPPINGS` のコメントは「管理画面や自動推測で更新可能」と述べているが、
`confidence` を更新するコードも、対応を推測するコードも**リポジトリ内に存在しない**
（`confidence` の出現箇所は seed.js・schema.sql・migrate.js・`getFeedMappings()` の
読み出しのみ）。管理画面にもフィード対応の編集UIは無い。
したがって `confidence` は **投入時の値のまま一生変わらない定数**であり、
「信頼度」という名前だけが残った実質的な優先順位フィールドになっている。

## 3. 方針

### 3.1 基本方針

**(1) 外部ID ⇔ route_id**

- 対応を **`backend/src/config/routeExternalIdMapping.js`** に新設し、
  **qualified route id（`feedId:routeId`）を直接記述する**。路線名は解決に使わない。
- 路線名は**コメントとしてのみ**残す（人間の可読性のため。コードは名前を参照しない）。

**(2) フィード構成とフィード対応**

- 位置情報フィードのURL・GTFSフィードのURL・両者の対応を
  **`backend/src/config/feeds.js`** に新設し、**1対1で明記する**（§4.3）。
- **`confidence` による推測を全廃する。** 対応は事実として確定しているので、
  確度という概念自体を持たない。
- 1つの位置情報フィードが複数のGTFSフィードに対応する場合は、
  **推測で1件に畳まず、複数を明示的に列挙する**（問題(E)(F)への対処）。

**共通：旧方式は残さず完全に削除する。**

- `route_external_ids` テーブル（およびその `direction_mapping` / `feed_id` 列）
- `feed_mappings` テーブル（`confidence` 列を含む）
- `feeds` テーブルの**静的設定部分**（`id` / `feed_type` / `name` / `url` / `enabled`）
  ※ 稼働状態を記録する列は残す。§3.3 を参照
- `seed.js` の `DEFAULT_ROUTE_EXTERNAL_ID_MAPPINGS` / `DEFAULT_FEEDS` /
  `DEFAULT_FEED_MAPPINGS` と、対応する `seedXxx()` 関数
- 管理画面の `GET/PUT /api/admin/route-mappings` と、対応表の編集UI

### 3.2 なぜDBではなくコードなのか

- 対応は事業者の系統IDに紐づく**静的な設定**であり、運用中に頻繁には変わらない。
- DB経由だと、表記ゆれによる欠落（問題A）や、同値 confidence による
  不定な選択（問題E）が**起動時に黙って発生し、誰も気づかない**。
  コードに書けば diff に現れ、レビュー対象になる。
- `directionMapping.js` が同じ理由で既にコード化されており、
  「路線・フィードに関する静的設定はコード、観測データはDB」という一貫した切り分けになる。
- **推測の仕組みは、推測が必要な場合にだけ正当化される。** 本件では
  どのURLがどの事業者のもので、どのGTFSに対応するかは**運用者が知っている確定事実**である。
  確定事実に確度を付けると、誤りが「低い確度」として正当化され、修正されないまま残る。

### 3.2.1 「互換のため残す」を選ばない理由

`direction_mapping` 列は移行時に互換のため残したが、本件では残さない。

- `route_external_ids` を読んでいるコードは、調査の結果 **`locationFetcher.js` と
  管理画面API の2箇所だけ**である。他のサービス（`gtfsData.js`・`busStopApproaching.js`・
  `realtimeTripLookup.js`・`gtfsRouteSearch.js`・`gtfsFeedManager.js`）はいずれも参照していない。
  `feed_mappings` は `locationFetcher.js` の1箇所だけである。
  依存が閉じているため、削除の影響範囲を完全に把握できる。
- テーブルを残すと「DBに値があるのに使われていない」状態になり、
  障害調査のときに**誤った情報源を読んでしまう**。表記ゆれによる欠落（問題A）が
  長期間気づかれなかったのは、まさに設定の所在が分散していたためである。
- 編集UIを残すと「保存できるのに反映されない」という最悪の挙動になる。

### 3.3 `feeds` テーブルは全廃しない（重要）

`feeds` テーブルは**性質の異なる2種類の情報を1つの表に混在させている**。

| 列 | 性質 | 移行後 |
|---|---|---|
| `id` / `feed_type` / `name` / `url` / `enabled` | 静的な構成設定 | **コードへ移す** |
| `last_fetched_at` / `last_status` / `last_error` | 実行時に書き込まれる稼働状態 | **DBに残す** |

稼働状態の列は `locationFetcher.js` と `gtfsFeedManager.js` の**計14箇所から
`UPDATE feeds SET last_fetched_at = ...` で書き込まれており**、
管理画面のフィード状態表示や障害調査に使われる。これは観測データであってコード化できない。

したがって `feeds` は**残すが、意味を変える**：
構成マスタではなく、**コードで定義されたフィードの稼働状態を記録するテーブル**にする。
行はコード側の定義から起動時に用意する（§5.3）。

### 3.4 トレードオフ（明記）

管理画面から対応を編集する運用ができなくなる。変更にはデプロイが必要になる。
これは `directionMapping.js` の移行時と同じ判断であり、
静的設定であること・誤設定が黙って通るリスクの方が大きいことから許容する。

また、テーブルを削除するため**DB上の既存の編集内容は失われる**。
移行前に現在の `route_external_ids` の内容をダンプし、
コード側の初期値と差分がないか確認すること（§7.1 手順1）。

## 4. 新設ファイルの仕様

`backend/src/config/routeExternalIdMapping.js`

```js
// 位置情報CSVの外部ID → GTFS route_id の対応を、コードで管理する。
//
// 以前は route_external_ids（DB）に路線名経由で投入する方式だったが、
// 表記ゆれによる欠落が黙って発生するため、qualified route id の直接指定に一本化した。
// 旧方式のテーブル・seed初期値・管理画面の編集UIはすべて削除済みで、
// **このファイルが対応関係の唯一の情報源**である。
//
// キーは外部ID、値は routes.id と同じ「feedId:routeId」形式の qualified route id。
// 1つの route_id に複数の外部IDが対応してよい（事業者が系統ごとに別IDを振るため）。

const ROUTE_EXTERNAL_ID_MAP = {
  // --- guruttomatsumotobus1 ---
  '01h9j04qf5pfg6za7eg0c4wqea': 'guruttomatsumotobus1:10', // 信大横田循環線
  '01h9j06f82mw3wvnddsbs4z7fs': 'guruttomatsumotobus1:11', // 横田信大循環線
  // ...
  '01h9j0aq0jnyqd6bnce5tdshsx': 'guruttomatsumotobus1:14', // 美ヶ原温泉線（旧: 表記ゆれで欠落していた）
  // ...
  // --- guruttomatsumotobus2 ---
  '01fsp3daby2y055rwgx9w1nk5j': 'guruttomatsumotobus2:10', // タウンスニーカー北コース
  // ...
};

function resolveRouteIdByExternalId(externalId) { /* ... */ }
function getExternalIdsForFeed(gtfsFeedId) { /* ... */ }

module.exports = { ROUTE_EXTERNAL_ID_MAP, resolveRouteIdByExternalId, getExternalIdsForFeed };
```

### 4.1 収録内容

- 現行38件のうち、GTFSに実在する route_id へ解決できる32件をそのまま移植する。
- 問題(A)の6件のうち、表記ゆれが原因の3件は**正しい route_id を明記して復活させる**。
  - `01h9j0aq0jnyqd6bnce5tdshsx` → `guruttomatsumotobus1:14`（美ヶ原温泉線）
  - `01h9j0g3wfs5j4jnfm0w3q0mq9` → `guruttomatsumotobus1:20`（大久保工場団地・神林線）
  - `01h9pfrv7rm8dwfb97y4nptdxv` → `guruttomatsumotobus1:20`（同上）
- 対応するGTFS路線が存在しない3件（第一高校スクール／南松本・平田線／平田・村井線）は、
  **コメントアウトした状態で理由を添えて残す**。旧テーブルを削除する以上、
  この外部IDの記録はここにしか残らない。消すと、後で路線が追加された際に
  外部IDを再調査する羽目になる。
- 問題(B)の未対応7路線は、**外部IDが判明していないため本仕様の対象外**とする。
  対応する外部IDが判明した時点で追記する（§7.2 参照）。

### 4.2 検証関数

起動時に一度だけ、設定と実際のGTFSデータの整合を検証する。

- 値がすべて `feedId:routeId` 形式であること
- 参照先の route_id が `routes` テーブル（またはGTFSインデックス）に実在すること
- 実在しない route_id を指すエントリがあれば**警告ログを出す**（起動は止めない）

**起動を止めない理由**：GTFS更新でフィード側の route_id が一時的に消えたときに、
システム全体が起動不能になることを避けるため。`REQUIRED_GTFS_FILES` に関する
既知の注意点と同じ考え方である。

### 4.3 フィード構成ファイル

`backend/src/config/feeds.js`（新規作成）

`confidence` を持たず、位置情報フィードごとに対応するGTFSフィードを**配列で明記**する。
配列にするのは、アルピコ交通のように複数のGTFSフィードにまたがる事業者を、
推測で1件へ畳まずに表現するためである（問題(F)）。

```js
// 位置情報フィード・GTFSフィードの構成と、両者の対応をコードで管理する。
//
// 以前は feeds / feed_mappings（DB）で管理し、対応は confidence（信頼度）の
// 降順で1件を選ぶ推測方式だったが、対応は運用者が知っている確定事実であり
// 推測する必要がない。同値 confidence で選択が不定になる問題もあったため全廃した。
// 稼働状態（last_status 等）のみ feeds テーブルに残る。

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
    // 旧: 1と2が同値 confidence 0.5 で、どちらが選ばれるか不定だった（問題E）。
    // 実際は両方にまたがるため、両方を明示する。
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

function getEnabledLocationFeeds() { /* ... */ }
function getEnabledGtfsFeeds() { /* ... */ }
function getGtfsFeedIdsFor(locationFeedId) { /* ... */ }

module.exports = { GTFS_FEEDS, LOCATION_FEEDS, getEnabledLocationFeeds, getEnabledGtfsFeeds, getGtfsFeedIdsFor };
```

#### 4.3.1 `alpicokotsu` を両方対応にする判断について

現行は同値 confidence のため**どちらが選ばれるか不定**であり、
「現在どちらで動いているか」を根拠にできない。
一方、外部IDは全体で一意であり、絞り込みは実質的に効いていない（問題F）ため、
**両方を許可しても、片方だけを選ぶ現状より解決範囲が狭まることはない**。

したがって両方を列挙する。これは推測ではなく、
**「絞り込みで落とさない」という安全側の明示**である。
仮に一方のみが正しいと判明した場合は、この配列を1件に減らせばよく、
その判断はコード上の diff として残る。

### 4.4 フィード構成の検証

起動時に一度だけ検証する（§4.2 と同じく**警告ログのみ、起動は止めない**）。

- `id` の重複が無いこと
- `gtfsFeedIds` の各要素が `GTFS_FEEDS` に実在すること
- `LOCATION_FEEDS` のいずれからも参照されないGTFSフィードがあれば警告
- `routeExternalIdMapping.js` の各 route_id のフィード部分が
  `GTFS_FEEDS` に実在すること（2つの設定ファイル間の整合確認）

## 5. 変更対象

| ファイル | 変更内容 |
|---|---|
| `config/routeExternalIdMapping.js` | **新規作成**。§4 の内容 |
| `config/feeds.js` | **新規作成**。§4.3 の内容 |
| `services/locationFetcher.js` | `fetchLocation()` のDB読み出しを廃止し、コード設定を参照する。`getEnabledLocationFeeds()`（41〜46行目）と `getFeedMappings()`（52〜63行目）を**削除**し `config/feeds.js` に置き換える。`fetchLocationFeed()` のCSV突合ロジックは変更しない（§5.1） |
| `services/gtfsFeedManager.js` | `getEnabledGtfsFeeds()`（54〜57行目）のDB読み出しを `config/feeds.js` 参照に変更。`UPDATE feeds SET last_status = ...` は**そのまま残す**（§3.3） |
| `services/gtfsData.js` | `getActiveGtfsFeedIds()`（21行目〜）を `config/feeds.js` 参照に変更。TTLキャッシュとDB障害フォールバックを撤去（§9.2） |
| `services/gtfsCalendar.js` | `getEnabledFeedIds()`（50行目〜）を `config/feeds.js` 参照に変更。ディスク走査フォールバックを撤去（§9.2） |
| `services/gtfsTimetable.js` | `listFeedIds()`（52行目〜）を `config/feeds.js` 参照に変更。**`fs.existsSync()` による実在チェックは残す**（§9.2） |
| `db/seed.js` | `DEFAULT_ROUTE_EXTERNAL_ID_MAPPINGS`（8〜47行目）・`DEFAULT_FEEDS`（50〜58行目）・`DEFAULT_FEED_MAPPINGS`（62〜67行目）と、`seedRouteExternalIds()`（224行目〜）・`seedFeeds()`（124行目〜）・`seedFeedMappings()`（142行目〜）を**削除**。`seed()` 内の各呼び出しも削除し、フィード一覧は `config/feeds.js` から取得する（494行目付近） |
| `routes/api.js` | `GET /api/admin/route-mappings`（185行目〜）と `PUT /api/admin/route-mappings`（201行目〜）を**削除** |
| `frontend/admin.html` | 「外部ID ↔ GTFS路線ID 対応表」セクション（79〜96行目付近）と、`loadMappings()` / `saveMappings()` / `renderMappingTable()` / `state.mappingRows` / 行追加・保存ボタンのハンドラを**削除** |
| `db/schema.sql` | `CREATE TABLE route_external_ids`（39〜45行目）と `CREATE TABLE feed_mappings`（32〜37行目）を**削除**。`feeds` は稼働状態テーブルとして残す（§3.3・§5.3） |
| `db/migrate.js` | ステップ8（`direction_mapping` 追加）・ステップ8.5（`feed_id` 追加）・ステップ12（`feed_mappings` 作成、135行目〜）を**削除**し、代わりに `DROP TABLE` を追加（§5.2） |
| `CLAUDE.md` / `README.md` | §7.1 の記述更新 |

⚠️ `routes/api.js` の `resolveRouteId` は他の多数のエンドポイントでも使われている共通関数である。
`PUT /api/admin/route-mappings` の削除に伴って**import ごと消さないこと**。

⚠️ `feeds` テーブルへの `UPDATE ... SET last_fetched_at / last_status / last_error` は
`locationFetcher.js`・`gtfsFeedManager.js` の**計14箇所**にある。
これらは稼働状態の記録であり、**1つも消さないこと**（§3.3）。

### 5.1 locationFetcher.js の変更詳細

現行の `fetchLocation()` 内のDB読み出し（`route_external_ids` の SELECT）を削除し、
`externalIdMap` を `ROUTE_EXTERNAL_ID_MAP` から構築した `Map` に置き換える。

`fetchLocationFeed()` の**CSV突合・`resolveDirectionId()` 呼び出しは一切変更しない**。
フィード絞り込み部分（73〜97行目）のみ、以下のとおり変更する。

- 現行：`feedMappings.get(feedId)` で**単一の** `gtfsFeedId` を得て、
  `routeId.startsWith(gtfsFeedId + ':')` で絞り込む。
- 新方式：`getGtfsFeedIdsFor(feedId)` で**配列**を得て、
  **いずれかのプレフィックスに一致すれば採用**する。

配列が空（対応するGTFSフィードが未設定）の場合は、絞り込みを行わず全件を対象とする。
現行の「マッチが0件なら絞り込み前のマップに戻す」フォールバック挙動と同じ結果になり、
設定漏れで位置情報が全滅することを防ぐ。

なお、現行の絞り込みには「プレフィックスなしの旧ルートをフォールバックとして含める」
既存DB互換の分岐があるが、新方式では全エントリが必ず qualified route id になるため
この分岐は到達不能になる。**削除する**。

### 5.2 テーブル削除の手順

`migrate.js` は毎回起動時に実行されるため、テーブル削除もここで行う。

```sql
DROP TABLE IF EXISTS route_external_ids;
DROP TABLE IF EXISTS feed_mappings;
```

- 両テーブルとも**参照している外部キーは存在しない**
  （いずれも `routes` / `feeds` を参照する側であり、参照される側ではない）。
  そのため `CASCADE` は不要で、他テーブルへの波及もない。
- `schema.sql` からも `CREATE TABLE` を削除するため、新規構築時は最初から作られない。
- migrate.js の既存ステップ8 / 8.5（`route_external_ids` への `ALTER TABLE`）と
  ステップ12（`feed_mappings` の作成）は、対象テーブルが無くなるので
  **必ず一緒に削除する**。残すとマイグレーションが落ちる。
- **`feeds` は DROP しない。**（§3.3・§5.3）

### 5.3 `feeds` テーブルの扱い

`feeds` は稼働状態の記録先として残るが、行の供給元がコードに変わる。

- 起動時（`migrate.js` の後）に、`config/feeds.js` の全フィードについて
  行の存在を保証する（UPSERT）。稼働状態の列は上書きしない。

```sql
INSERT INTO feeds (id, feed_type, name, url, enabled)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (id) DO UPDATE
  SET feed_type = EXCLUDED.feed_type,
      name      = EXCLUDED.name,
      url       = EXCLUDED.url,
      enabled   = EXCLUDED.enabled;
```

- ⚠️ `ON CONFLICT DO UPDATE` の SET句に
  **`last_fetched_at` / `last_status` / `last_error` を含めないこと。**
  含めると再起動のたびに稼働状態がリセットされ、
  「最後に取得に成功したのはいつか」が失われる。
- コード側から削除されたフィードの行は、DBに残しても実害がない
  （どこからも参照されなくなるだけ）ため、**自動削除はしない**。
  行が増えて困る規模ではなく、誤削除の方が危険である。
- `feeds` の `id` / `url` 等は**コードが正**である。DBを直接編集しても
  次回起動時に上書きされる。この点を列コメントか `schema.sql` に明記すること。

## 6. 管理画面の扱い

対応表の編集機能は**不要のため完全に削除する**。

- `GET /api/admin/route-mappings`・`PUT /api/admin/route-mappings` をいずれも削除する。
- 管理画面から「外部ID ↔ GTFS路線ID 対応表」セクションを丸ごと削除する
  （見出し・テーブル・「行追加」ボタン・「対応表を保存」ボタン、および対応するJS）。
- 画面冒頭の説明文（`admin.html` 15行目）が
  「外部IDマッピング・バス停座標・時刻表・バス位置情報を確認できます」となっているので、
  **「外部IDマッピング・」を削る**こと。
- 管理画面に残る他の機能（お知らせ編集・路線データ編集・直近車両位置）には影響しない。

⚠️ 同じファイルにある `PUT /api/admin/route-data`（**路線データ編集**）は別機能である。
名前が似ているが**消さないこと**。こちらは既知の注意点にあるとおり、
`router` が `/api` 配下にマウントされている都合で実際のパスが
`/api/api/admin/route-data` と二重になっており、フロントエンドもそれに合わせてある。

## 7. 移行手順と影響

### 7.1 手順

**削除を含むため、この順序を守ること。**
コード側の切り替え（1〜2）を先に完了させてから、旧方式を落とす（3〜6）。
逆順にすると、切り替え途中で位置情報の路線解決が全滅する。

1. 現在のDB内容を退避し、コード側の記述と差分がないか確認する
   - `SELECT route_id, external_id FROM route_external_ids ORDER BY external_id;`
   - `SELECT * FROM feed_mappings ORDER BY location_feed_id, confidence DESC;`
   - `SELECT id, feed_type, name, url, enabled FROM feeds ORDER BY id;`

   （管理画面や手作業で編集された設定が残っていないかの確認。差分があればコードに取り込む）
2. `config/feeds.js` を作成（§4.3）
3. `config/routeExternalIdMapping.js` を作成（§4）
4. フィード一覧を引いている**5サービスすべて**をコード設定参照に切り替える（§5.1・§9）
   — `locationFetcher.js`・`gtfsFeedManager.js`・`gtfsData.js`・`gtfsCalendar.js`・`gtfsTimetable.js`
   — フォールバック処理の扱いは §9.2 に従う（`gtfsTimetable.js` の `fs.existsSync` は残す）
   — **ここで §9.5 の動作確認を行う**
5. `seed.js` から3つの `DEFAULT_*` と3つの `seedXxx()`・呼び出しを削除し、
   `feeds` の行供給を `config/feeds.js` からのUPSERTに置き換え（§5.3）
6. 管理画面のAPI・UIを削除（§6）
7. `schema.sql` から2つの `CREATE TABLE` を削除、`migrate.js` のステップ8/8.5/12を削除し
   `DROP TABLE` を追加（§5.2）
8. `CLAUDE.md` の「複数フィード対応の設計」節と「既知の注意点」を更新
9. `README.md` の該当節を更新

### 7.1.1 CLAUDE.md の更新箇所

- 「複数フィード対応の設計」節：現在の
  「GTFSフィード・位置情報フィードのいずれもハードコードではなくDB駆動（`feeds`テーブル）」
  という記述は**方針が逆転するため全面的に書き換える**。
  新しい記述は「フィード構成と対応はコード（`config/feeds.js`）で管理し、
  `feeds` テーブルは稼働状態の記録のみを担う」とする。
- 同節の `feed_mappings` に関する記述（位置情報フィードがどのGTFSフィードの
  `route_external_ids` を使って路線を解決するか）を、
  **`config/feeds.js` の `gtfsFeedIds` と `config/routeExternalIdMapping.js`** に基づく記述へ改める。
- 「既知の注意点」：`route_external_ids` の `ON CONFLICT` に関する警告
  （UNIQUE(external_id) を対象にしないとseedごと落ちる、という項目）は、
  テーブルごと無くなるため**削除する**。
- 「既知の注意点」に、§5.3 の警告
  （`feeds` のUPSERTで稼働状態の列を上書きしてはいけない）を**追記する**。
- 「既知の注意点」に、§9.4 の方針を**追記する**：
  有効フィード一覧は `config/feeds.js` が唯一の取得口であり、
  各サービスが独自に `SELECT ... FROM feeds` を書いてはいけない
  （移行前は同じSQLが4箇所に重複し、認識のずれを生む温床になっていた）。
- 併せて、フィード構成・外部ID対応の追加・変更はコード側を編集する旨を追記する。

### 7.2 今後の運用

- 外部IDと路線の対応を追加・変更する場合は `config/routeExternalIdMapping.js` を編集する。
  新しい外部IDは、`vehicle_positions_raw` に入らなかったCSV行、または
  位置情報CSVを直接確認して特定する。**路線名では引かない。**
- 位置情報フィードのURL追加・事業者追加・GTFSフィードの追加は `config/feeds.js` を編集する。
  新しい位置情報フィードを足すときは `gtfsFeedIds` を必ず指定する。
  **対応が分からない場合に「とりあえず低い確度で入れておく」ことはできない。**
  これは意図した制約であり、対応を確認してから追加する運用にする。

### 7.3 影響範囲

- **走行中の便への影響なし。** 変更されるのは位置情報→route_id の解決経路のみで、
  `vehicle_positions_raw` 以降のパイプライン（③〜⑧）は一切変わらない。
- **問題(A)の3路線が新たに解決されるようになる。** これは意図した改善だが、
  これまで位置情報が捨てられていた路線に車両が現れるため、
  移行直後は該当路線の割り当て状況を確認すること。
- **`alpicokotsu` の絞り込みが「不定の1件」から「明示的な2件」に変わる。**
  外部IDは全体で一意なため解決結果は実質変わらないはずだが、
  従来 `guruttomatsumotobus2` 側が選ばれていた場合に、
  これまで落ちていた `guruttomatsumotobus1` 側の路線が通るようになる可能性がある。
  移行直後はアルピコ交通の車両数を確認すること。
- **`route_external_ids` / `feed_mappings` テーブルは削除され、DB上の編集内容は失われる。**
  手順1の退避で差分を取り込んでいれば実害はない。
- **`feeds` の稼働状態（`last_status` 等）は維持される。**
  管理画面のフィード状態表示に影響はない。
- 管理画面から対応表の編集セクションが消える。他の管理機能には影響しない。
- **ロールバックはコードのリバートだけでは完結しない。** テーブルを落とすため、
  戻す場合は `schema.sql` / `migrate.js` の復元に加えて `seed()` の再実行が必要になる。
  手順4の時点で一度動作確認を挟むのは、この不可逆な削除に進む前に
  切り替えの成否を確認するためである。

## 8. 非対象

- **`feeds` テーブルそのものは削除しない。** 稼働状態（`last_fetched_at` /
  `last_status` / `last_error`）は実行時に書き込まれる観測データであり、
  コード化できない。詳細は §3.3。
- `qualifyRouteId` / `unqualifyRouteId` の仕様は変更しない。
- `service_id` のプレフィックス規約（`feedId:service_id`）は変更しない。
- GTFS ZIPの取得・展開処理（`gtfsFeedManager.js` の更新ロジック）は変更しない。
  変更するのは「どのフィードを対象にするか」の取得元だけである。

## 9. 他サービスへの影響と同時修正

「有効なGTFSフィード一覧」を取得する処理は、**同じSQLが4箇所に重複実装されている**。
`feeds` テーブルの意味を変える以上、これらは**すべて同時に修正しなければならない**。
1箇所でも取り残すと、コード側で無効にしたフィードがそのサービスだけ有効なまま残り、
**サービス間で「有効なフィード」の認識がずれる**。

### 9.1 影響を受けるサービス一覧

| サービス | 関数 | 現在の実装 | 影響 |
|---|---|---|---|
| `gtfsFeedManager.js` | `getEnabledGtfsFeeds()`（54行目） | DB直読み（`id, name, url`） | **必須**。GTFS更新の対象決定 |
| `gtfsData.js` | `getActiveGtfsFeedIds()`（21行目） | DB直読み＋TTLキャッシュ＋障害時フォールバック | **必須**。リアルタイム運行状況 |
| `gtfsCalendar.js` | `getEnabledFeedIds()`（50行目） | DB直読み＋障害時ディスク走査 | **必須**。当日便生成の運行日判定 |
| `gtfsTimetable.js` | `listFeedIds()`（52行目） | DB直読み＋実在チェック＋障害時ディスク走査 | **必須**。時刻表・経路検索 |
| `locationFetcher.js` | `getEnabledLocationFeeds()`（41行目） | DB直読み（location） | **必須**。位置情報取得 |

**間接的に影響を受けるが、コード変更が不要なもの：**

- `gtfsFare.js` / `gtfsFrequencies.js` / `utils/csv.js` / `gtfsRouteSearch.js`
  — いずれも `getGtfsDir(feedId)` でパスを組むだけであり、**フィード一覧をDBから引いていない**。
  呼び出し元から渡される `feedId` が変わらなければ挙動も変わらない。**変更不要**。
- `dailyTripBuilder.js` / `tripAssignment.js` / `delayCalc.js` / `etaPredictor.js` /
  `passDetection.js` / `finishService.js`
  — `routes` / `daily_trips` 等のDBテーブルを見ており、フィード構成には触れない。**変更不要**。

### 9.2 各サービスのフォールバック処理の扱い（重要）

4箇所はいずれも「**DBが落ちていても動くように**」というフォールバックを持っている。
移行後はフィード一覧がコード上の定数になり、**取得が失敗しえなくなる**ため、
これらのフォールバックは**存在意義が変わる**。取り扱いを個別に決める。

**(1) `gtfsData.js` — TTLキャッシュとフォールバックを撤去する**

```js
// 現在：DB障害時は前回キャッシュを返す
gtfsFeedIdCache = { feeds: [...], fetchedAt: now };
```

コード上の配列を返すだけになるため、TTLキャッシュ（`GTFS_FEED_CACHE_TTL_MS`）も
`catch` によるキャッシュ返却も**不要になる**。
キャッシュ変数ごと削除してよい。**関数は同期化できるが、呼び出し元が `await` しているため
`async` のまま残すのが安全**（呼び出し側の変更を最小化する）。

**(2) `gtfsCalendar.js` — ディスク走査フォールバックを撤去する**

DB障害時に `fs.readdirSync(GTFS_DIR)` でディレクトリ名をフィードIDとみなす処理があるが、
これは**コード上の定義より信頼できない推測**である（`.tmp_*` の残骸や、
無効化したはずの古いフィードのディレクトリを拾ってしまう）。
コード側が常に正しい一覧を返せるので**削除する**。

**(3) `gtfsTimetable.js` — 実在チェックは残し、ディスク走査は撤去する**

```js
const ids = result.rows.map((row) => row.id).filter((id) => fs.existsSync(getGtfsDir(id)));
```

この `fs.existsSync()` は「**DBで有効だが、まだZIPを展開していないフィード**」を
除外するためのものであり、DB障害対策とは別の目的を持つ。
コード化後も「設定にはあるが未ダウンロード」という状態は起こりうる（初回起動時など）ため、
**このフィルタは必ず残すこと**。撤去すると、存在しないディレクトリを読みに行って
時刻表インデックスの構築が落ちる。

一方、`catch` 節のディスク走査フォールバックは (2) と同じ理由で削除する。

**(4) `locationFetcher.js` / `gtfsFeedManager.js` — 単純置換**

フォールバック処理を持たないため、`config/feeds.js` の参照に置き換えるだけでよい。

### 9.3 同時修正を怠った場合に起きること

- **`gtfsData.js` だけ古いまま**：利用者向け `/api/buses` が、コードで無効にしたフィードの
  路線を返し続ける。位置情報側は既に取得を止めているため、
  **「路線は表示されるが永久にバスが来ない」**状態になる。
- **`gtfsCalendar.js` だけ古いまま**：`ensureDailyTrips()`（パイプライン①）が
  無効フィードの `service_id` を有効と判定し、**運行しない便が当日便として生成される**。
  その便には車両が割り当たらないので、遅延も到着予測も出ないゴースト便になる。
- **`gtfsTimetable.js` だけ古いまま**：時刻表検索・経路検索・バス停検索が、
  リアルタイム画面と**異なるフィード集合**を見る。同じバス停なのに画面によって
  出てくる便が違う、という再現しにくい不整合になる。

いずれも**エラーにならず、静かなデータ不整合として現れる**ため、
移行時にまとめて直すことが必須である。

### 9.4 リファクタリングの指針

4箇所に同じSQLが重複していた事実そのものが、今回の問題の温床である。
移行後は **`config/feeds.js` の `getEnabledGtfsFeeds()` を唯一の取得口**とし、
各サービスはこれを呼ぶだけにする。

- 各サービスが独自にDBを引く実装を**復活させないこと**。
- フィード一覧が欲しくなったら `config/feeds.js` に関数を足す。
- この方針を `CLAUDE.md` の「既知の注意点」に追記する（§7.1.1）。

### 9.5 動作確認項目

§7.1 の手順4（コード切り替え後）と、全手順完了後の2回、以下を確認する。

| 確認対象 | 期待結果 |
|---|---|
| `/api/buses`（利用者画面） | 移行前と同じ台数のバスが表示される |
| アルピコ交通の車両 | 移行前と同数以上（§7.3 のとおり増える可能性がある） |
| 美ヶ原温泉線・大久保工場団地・神林線 | 位置情報が解決されるようになる（問題A） |
| 当日便生成（`daily_trips`） | 移行前と同じ便数。ゴースト便が増えていない |
| 時刻表検索 | 移行前と同じフィード・同じバス停が引ける |
| 経路検索 | 検索結果が移行前と一致する |
| 管理画面のフィード状態 | `last_status` / `last_fetched_at` が維持され、更新も継続する |
| バスマップ（`#/busmap`） | 全路線が表示される |
