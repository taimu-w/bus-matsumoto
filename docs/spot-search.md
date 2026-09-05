# スポット検索機能の仕様（`services/spotSearch.js` / `frontend/spotsearch.js`）

## 1. 概要

スポット検索は「簡易的な路線・バス停検索」です。利用者が地名（観光スポット・その他のスポット）・
バス停・路線を **1つだけ** 入力すると、

- 観光スポット／その他のスポットに解決したときは、そのスポット情報（写真・営業時間・滞在目安・
  説明・公式サイトリンク）
- あわせて、その地点の **付近のバス停** と、それらを **通る路線**

を結果として表示します。路線名クリックでその路線のリアルタイム時刻表（`#/realtime/{feedId}/{routeId}`）、
バス停名タップでバス停ページ（`/busstop/{stopKey}`）へ遷移します。

**リアルタイム運行状況・経路検索とは探索のデータ経路が独立**しており、
GTFSインメモリインデックス（`gtfsTimetable.js`）と `tourist_spots` テーブルだけを見ます。
バス停との関連付けは保存時ではなく **参照時** に緯度経度の近接検索（ハバーサイン距離）で
都度解決します（観光スポット情報機能と同じ方針。[tourist-spots.md](tourist-spots.md)）。

経路検索（出発地→目的地の2点入力・RAPTOR探索）とは別物です。スポット検索は
「その地点の周りにどの路線・バス停があるか」を1タップで見るための軽い導線です。

## 2. 検索対象

| 種別 | 取得元 | サジェスト | 自由文字列での解決 |
|---|---|---|---|
| バス停 | `gtfsTimetable.searchStops()` | ○ | ○（結果ページ） |
| 観光スポット／その他のスポット | `touristSpots.searchTouristSpots()`（`display_tag` は問わない。名称・かな・ローマ字に加えて**別称**（`aliases`）でも一致） | ○ | ○（結果ページ） |
| 路線 | `spotSearch.searchRoutes()`（`routes` テーブルの `name` / `short_name` の正規化テキスト一致） | ○ | ○（リアルタイム時刻表へリダイレクト） |

- バス停・観光スポットの候補検索は **時刻表検索・経路検索とまったく同じ検索体験**（漢字・ひらがな・
  カタカナ・ローマ字、大文字小文字・全半角不問、1文字から、前方一致優先の部分一致）。
- 観光スポットは名称・かな・ローマ字に加えて **別称**（`tourist_spots.aliases`、「からす城」「国宝」など）
  でも一致する。別称は候補一致にだけ使い、候補ラベル・結果画面・APIレスポンスには出さない
  （`serializeRow` に含めない）。かな・ローマ字への変換はしない。詳細は
  [tourist-spots.md](tourist-spots.md) の `aliases`。
- **路線には `translations.txt` 相当のよみがな・ローマ字が無い**ため、路線名の一致は
  `utils/kana.js` の `normalizeSearchText()` を通した正規化テキストの一致のみ（実質、漢字・かな入力）。
- 路線サジェスト・路線解決が返すのは **`routes` テーブルに実在する路線だけ**なので、
  `#/realtime/{feedId}/{routeId}` が必ず開けます。
- 結果に載せる路線（周辺路線チップ・バス停ごとの路線チップ）も同じ理由で
  `routes` テーブルに実在する路線に絞ります（リアルタイム時刻表を開けない路線を出さない）。

## 3. 対象の解決（`spotSearch.search()`）

入力は `spotId` / `stopKey` / `q`（自由文字列）のいずれか。

| 入力 | 解決 | `resolvedFrom` |
|---|---|---|
| `spotId` | `touristSpots.getSpotById()` | `spot` |
| `stopKey` | `gtfsTimetable.getStopSummariesByKeys()` | `stop` |
| `q` → 観光スポットが最有力 | 上記スポット解決 | `fuzzy-spot` |
| `q` → バス停が最有力 | 上記バス停解決 | `fuzzy-stop` |
| `q` → 路線が最有力 | 解決せず `route` を返す（フロントがリアルタイム時刻表へ遷移） | `route` |
| `q` → どれも一致しない | `found:false` ＋ もしかして候補（バス停・スポット） | — |

- 自由文字列の最有力候補は `scoreNameMatch()`（完全一致3／前方一致2／部分一致1）で決め、
  **同スコアならバス停 > 観光スポット > 路線**（バス停検索が主目的のため）。
- 観光スポットは、名称・かな・ローマ字のスコアに加えて `searchTouristSpots()` が返す
  `matchScore`（別称一致を含む前方一致2／部分一致1）も取り込む。これにより
  **別称でしか一致しないスポット**（名称スコア0）も自由文字列で解決できる。
- スポット／バス停に解決したら、その座標を中心に付近のバス停を探す。

## 4. 付近のバス停と周辺路線

- `gtfsTimetable.searchNearbyStops()` で近い順に取得し、**半径内（既定500m、`?radius=` で100〜3000m）**・
  **距離昇順で最大 `?limit` 件（既定8、上限20）**。半径は観光スポット情報機能の初期値に合わせてある。
- 半径の判定・並び順・表示する `distanceMeters` はいずれも**直線距離（ハバーサイン）**。
  表示する `walkMinutes` だけは `utils/geo.js` の `estimateWalkMinutes()`（直線距離に迂回係数・
  信号待ちを織り込んだ推定。距離が伸びるほど大きくなる）で換算する。
- 対象がバス停のときは、そのバス停自身を `primaryStop`（`isPrimary: true`・距離0）として先頭に置き、
  付近のバス停一覧からは除外する。
- `routes` は「対象バス停＋付近のバス停」を通る路線を `feedId:routeId` で重複排除し、
  略称→名称の五十音順に並べたもの（`dedupeRoutes()`）。
- 半径内にバス停が1件も無くても「見つかりませんでした」だけにはせず、その旨とスポット情報は出す。

## 5. 検索回数の計測（`spot_search_counts`）

「観光スポットの掲載が有用かどうか」を、公式サイトリンクのタップ回数（`tourist_spot_link_clicks`）と
**並べて** 管理者が判断するための集計です。

- `spotSearch.search()` が対象を解決して結果を返すたびに、`spot_search_counts` の当日行を +1 する。
  - 観光スポット／その他のスポットに解決 → `spot_id` = `tourist_spots.id`（管理画面で指定する識別子）、`spot_name` に名称スナップショット
  - バス停・地名に解決 → `spot_id = ''`（空文字。`tourist_spots.id` は空でない文字列なので衝突しない）
  - 路線に解決 → **記録しない**（付近のバス停を出さずリダイレクトするため）
- `tourist_spot_link_clicks` と同じく Asia/Tokyo 基準の **日別カウント**で、生ログは持たない。
  二重カウントの厳密な排除はしない（掲載の有用性の目安のため。ブラウザの戻る等での再描画は
  再カウントされうる）。
- 外部キーは張らない（管理画面の「全件洗い替え」でテキストからIDの行が消えても集計を残すため。
  `tourist_spot_link_clicks` と同じ方針）。
- 保持は約400日（`services/spotSearch.js` の `SEARCH_COUNT_RETENTION_DAYS`。`scheduler.js` の
  1時間掃除から `purgeOldSpotSearchCounts()`）。

### 管理画面「観光スポットの検索・アクセス数」（`section-tourist-spot-clicks` / `admin-tourist-spot-clicks.js`）

`GET /api/admin/tourist-spots/link-clicks?from=YYYY-MM-DD&to=YYYY-MM-DD`（管理・最大1年・未指定は直近30日）が、
`spotSearch.getSpotEngagementStats()` 経由で **検索回数（`spot_search_counts`）とリンクタップ回数
（`tourist_spot_link_clicks`）を1つの表へマージ**して返す。行は `検索回数 + タップ回数` の降順→名称昇順。
掲載終了スポットはスナップショット名で `listed:false` として残る。合計欄には「観光スポット以外
（バス停・地名）に解決した検索」の回数（`unresolvedSearches`）も添える。

## 6. 画面仕様（`frontend/spotsearch.js`）

### 6.1 URL設計

時刻表検索・バス停検索・経路検索と同じく History API（パス）でルーティングする。

```
/spotsearch                 検索フォーム
/spotsearch?spot={id}       観光スポットを対象にした結果
/spotsearch?stop={stopKey}  バス停を対象にした結果
/spotsearch?q={文字列}       自由文字列の結果（あいまい一致）
```

- ホームメニューの「スポット検索」は `/spotsearch` へのリンク（`data-spa`）。下部タブには入れない
  （5枠が埋まっているため。時刻表検索と同じ扱いで、この画面では下部タブをどれも点灯させない）。
- 直リンク・リロードでも復帰できる（サーバーは `/api` 以外を `index.html` へフォールバック）。
- `app.js` の `renderCurrentRoute()` は、他のパスルーティング画面と同じ並びで
  `window.SpotSearchView.isSpotSearchPath()` を判定する。

### 6.2 リアルタイム時刻表への遷移

路線チップ・路線候補をタップすると `goToRealtimeTimetable(feedId, routeId)` が
`#/realtime/{feedId}/{routeId}` へ遷移する。**スポット検索はパスルーティング（`/spotsearch`）だが
リアルタイム時刻表はハッシュルーティング（`#/realtime/...`）**なので、`pushState` で
`/#/realtime/...`（pathname を `/` に戻す）としてから `window.renderCurrentRoute()` を呼ぶ。

- サジェスト・結果チップからの遷移は `pushState`（ブラウザの戻るでスポット検索へ帰れる）。
- **自由文字列が路線に解決したリダイレクト（`/spotsearch?q=浅間線`）だけは `replaceState`**。
  `?q=` のURLを履歴に残すと、戻るたびに同じリダイレクトが起きるため。

### 6.3 結果の表示

1. ヘッダー（対象名＋「観光スポット／バス停を中心に付近のバス停と路線を表示」）
2. スポット情報カード（`spot` があるとき。写真は `SpotPhotos`（`frontend/spot-photos.js`）の
   カルーセル＝1枚ずつ表示、複数枚は5秒間隔の自動送り＋スワイプ／矢印／インジケーター。
   詳細は [docs/tourist-spots.md](tourist-spots.md) の「写真表示（カルーセル）」。
   公式サイトリンクのタップは `POST /api/tourist-spots/:id/link-click` へ `sendBeacon`。
   `busstop.js` の周辺観光スポット表示と同じ考え方）
3. 「この周辺を通る路線」— 重複排除済みの路線を **1行1件で縦に並べる**（左端に路線カラーの帯。
   リアルタイム運行状況の路線選択画面〔`app.js` の `renderRouteList`〕と同じ見た目。淡い路線カラーが
   白背景に埋もれないよう帯の縁に薄い暗色の輪郭を重ねる）。タップでリアルタイム時刻表。
4. 「周辺のバス停」— `primaryStop` ＋ 付近のバス停カード。バス停名 → `/busstop/{stopKey}`（`data-spa`）、
   路線チップ → リアルタイム時刻表（こちらは省スペースのため路線カラーのチップのまま）

- 検索欄が空のときは、経路検索・バス停検索と同じくお気に入りバス停・近くのバス停を初期候補に出す
  （soft-fail：取れなければ何も出さない）。
- 路線カラー・コントラスト（`parseHexColor` / `chipTextColor`）は `timetable.js` / `busstop.js` /
  `routesearch.js` と同一ロジック。

## 7. API

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/spot-search/suggest?q=&limit=` | 入力候補。`{ stops, spots, routes }`（`stops`＝`gtfsTimetable.searchStops` の結果、`spots`＝`touristSpots.searchTouristSpots` の結果〔`serializeRow` ＋一致度 `matchScore`。別称一致のスポットも含むが別称そのものは返さない〕、`routes`＝`{ qualifiedId, feedId, routeId, name, shortName, color, textColor }`） |
| GET | `/api/spot-search?spotId=\|stopKey=\|q=&radius=&limit=` | スポット検索の実行。対象がスポットに確定したら検索回数を +1。`{ found, resolvedFrom, origin, spot, primaryStop, nearbyStops, routes, radiusMeters }`、路線解決時は `{ found:true, resolvedFrom:'route', route }`、不一致時は `{ found:false, reason, suggestions:{ stops, spots } }` |
| GET | `/api/admin/tourist-spots/link-clicks?from=&to=` | （管理）検索回数とリンクタップ回数のマージ集計。[5節](#5-検索回数の計測spot_search_counts) |

## 8. 実装上の制約

- **`gtfsTimetable.js` の公開関数のシグネチャは変えない**（時刻表検索・バス停検索・経路検索と
  インデックスを共用）。スポット検索は `searchStops` / `searchNearbyStops` /
  `getStopSummariesByKeys` を **呼ぶだけ**。
- **`spot_search_counts` に外部キーを張らない**（`tourist_spot_link_clicks` と同じ理由）。
- **`touristSpots.js` は `spot_search_counts` を参照しない**（循環参照を避けるため。
  `spotSearch.js` → `touristSpots.js` の一方向のみ。検索回数とタップ回数のマージは
  `spotSearch.getSpotEngagementStats()` が担う）。
- 検索回数の記録は「対象が観光スポット／その他のスポット／バス停に解決したとき」だけ。
  サジェスト（`/api/spot-search/suggest`）では記録しない。
- **別称（`tourist_spots.aliases`）は `serializeRow` に含めない**＝サジェスト・結果・
  単発取得（`/api/tourist-spots/:id`）のどのレスポンスにも出さない。候補一致専用。
  別称でしか一致しないスポットを自由文字列で解決できるよう、`searchTouristSpots()` は
  結果に `matchScore` を付けて返し、`chooseFreeTextTarget()` がそれを候補スコアに含める
  （この2点はセット。片方だけ外すと別称一致が黙って壊れる）。
