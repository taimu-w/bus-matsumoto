# バス停お知らせ配信

## 概要

バス停詳細ページ（`frontend/busstop.js`）の「このバス停でできること」セクションの下に、管理画面「バス停お知らせ」で登録したお知らせを表示する。

1件のお知らせは **見出し（任意）・画像（任意）・本文（任意）** を自由に組み合わせて持てる。画像と本文の少なくとも一方は必須。本文はトップ画面のお知らせと同じリンク記法で、リンクを含まないただの文章も入れられる。

配信範囲は `scope` で決まる。

| scope | 範囲 | 突合キー | 表示条件 |
|---|---|---|---|
| `stop` | **バス停単位** | `stop_key`（統合バス停キー＋その別名） | そのバス停ページを開いていれば、どの乗り場を見ていても表示 |
| `platform` | **乗り場（のりば）単位** | `feed_id` + `stop_id` | 乗り場が確定しているとき（乗り場別表示、または乗り場が1か所だけ）だけ表示 |

トップ画面のお知らせ（`system_settings.notices`）が路線・全体向けなのに対し、こちらは「このバス停は当面△△へ移設」（バス停単位）「◯番のりばのエレベーター工事」（乗り場単位）のような、バス停・のりばに紐づく案内に使う。

## 表示（`busstop.js`）

「このバス停でできること」の下の `#bs-notices` に、次の順で最大2枚のカードを描く。取得は `GET /api/busstop/:stopKey/notices?platform=...`（表示モード切替のたびに `renderSeq` ガード付きで取り直す）。取得に失敗してもバス停情報自体の表示は妨げない（soft-fail、何も出さない）。

1. **「このバス停のお知らせ」** … `stopNotices`（`scope='stop'`）。表示モードによらず常に描く。0件ならカードを出さない。
2. **「◯番のりばのお知らせ」／「この乗り場のお知らせ」** … `platformNotices`（`scope='platform'`）。乗り場が確定しているとき（`effectivePlatform(data)` が非null）だけ描く。すべての乗り場を統合表示しているとき（`effectivePlatform(data)` が null、`?platform=` なし）は**サーバーが空配列で返す**ので出ない。0件ならカードを出さない。

各お知らせは 見出し → 画像（`<img>`）→ 本文（`linkifyNotice()`）の順。画像・本文の両方が空の行は描画しない。

## データモデル

### `busstop_notices` テーブル

| カラム | 型 | 説明 |
|---|---|---|
| `id` | serial PK | 内部ID |
| `scope` | text | `stop` または `platform`（CHECK制約） |
| `stop_key` | text | `scope='stop'` の突合キー（統合バス停キー）。`scope='platform'` でも一覧の並び・リンク用に保存するが突合には使わない |
| `feed_id` | text | `scope='platform'` の突合キー。GTFSフィードID。`scope='stop'` では NULL |
| `stop_id` | text | `scope='platform'` の突合キー。GTFSの生 `stop_id`（座標統合後の代表標柱。`resolvePlatformRef()` が解決）。`scope='stop'` では NULL |
| `stop_name` | text | バス停名のスナップショット（管理画面一覧の可読性用） |
| `platform_code` | text | `platform_code` のスナップショット（`scope='platform'`、一覧の可読性用） |
| `title` | text | 見出し（任意、最大60文字） |
| `image_url` | text | 画像URL（`https://` のみ許可。Cloudinary等に手動アップロードしたURLを貼る） |
| `body` | text | 本文（最大1000文字、リンク記法対応）。画像・本文の少なくとも一方が必須 |
| `enabled` | boolean, default true | 一時非表示フラグ |
| `sort_order` | integer, default 0 | 同一の範囲・対象内の表示順（作成時に `MAX+1` を採番） |

`CONSTRAINT busstop_notices_platform_ref`：`scope='platform'` の行は `feed_id` と `stop_id` が非nullであること。

`stop_key` / `stop_name` / `platform_code` は**スナップショット**であり、GTFS再取込で値が変わっても行は更新しない。利用者向けの突合は `scope='platform'` なら `feed_id + stop_id`、`scope='stop'` なら `stop_key`（＋その別名）で行う。GTFS側からキーが消えれば参照時に単に一致しなくなるだけで実害はない（`tourist_spots` の「参照時に都度、緯度経度で近接解決」と同じ発想で、保存時に固い外部キーを張らない）。

### 乗り場・バス停の解決（`gtfsTimetable.resolvePlatformRef()`）

`stopKey` と `?platform=` の値（`stop_id` または `feedId_stopId`）から、バス停グループと乗り場を軽量に解決する（発車一覧は組み立てない）。返り値に `stopKey`（正キー）・`aliases`（統合されて使われなくなった旧キー）・`platform`（解決できた乗り場、または乗り場が1か所ならその1件）・`platforms` を含む。

- `scope='platform'` の突合には `platform.feedId` + `platform.stopId` を使う。乗り場が複数あって `?platform=` 未指定なら `platform: null`（＝統合表示）。
- `scope='stop'` の突合には `[stopKey, ...aliases]` を使う。座標統合で代表キーが変わっても旧キーが別名として残るため拾える。

## リンク記法

本文（`body`）は、トップ画面のお知らせ（`app.js` の `linkifyNotice`）・運行状況画面（`servicestatus.js` の `linkifyDetail`）と**同じ記法**。`busstop.js` にも同じ実装を持たせている（このリポジトリの既存方針どおり、記法の実装は各画面に複製する）。

- 裸のURL `https://example.com` … URLをそのまま表示
- `[時刻表はこちら](https://example.com)` … 表示文字列に置き換えて表示
- リンクを含まないただの文章も可

本文は先に全体をHTMLエスケープしてから `<a>` へ置換するのでXSSの心配はない。

## 画像

`tourist_spots.photo_urls` と同じ運用。アプリからアップロードAPIは持たず、Cloudinary等に手動アップロードして発行URL（`secure_url`）を貼り付ける。表示は `<img src>` で直接配信。保存時に `https://` 始まりのみ許可する（ホスト名は縛らない）。

## 管理画面「バス停お知らせ」（`frontend/admin-busstop-notices.js`）

1. 配信範囲（バス停単位／乗り場単位）を選ぶ
2. バス停名で検索（`/api/busstop/search`）→ 候補から1件選ぶ
3. 乗り場単位のときは、その乗り場一覧（`/api/timetable/stops/:stopKey` の `platforms`）から乗り場を選ぶ（1か所なら自動選択）
4. 見出し（任意）・画像URL（任意）・本文（任意）・表示ON/OFF を入力して「追加」（画像と本文の少なくとも一方が必須）
5. 一覧から各行の 表示切替（PATCH）／編集（PUT。**配信範囲・対象のバス停/乗り場は変更不可**。変えたいときは削除して追加し直す）／削除（DELETE）

## API

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/busstop/:stopKey/notices?platform=...` | 公開。`{ stopNotices, platformNotices }`。`stopNotices` は常に返す。`platformNotices` は乗り場が確定しているときだけ（統合表示なら `[]`） |
| GET | `/api/admin/busstop-notices` | 全件（無効も含む。管理画面一覧用） |
| POST | `/api/admin/busstop-notices` | 新規作成。body `{ scope, stopKey, platform, title, imageUrl, body, enabled }`。`scope='platform'` のときは `stopKey`+`platform` をサーバー側で `resolvePlatformRef()` に通し、正規の `feed_id`+`stop_id` へ落として保存（乗り場が特定できなければ400）。`scope='stop'` のときは `stopKey` を解決して正規の統合バス停キーで保存 |
| PUT | `/api/admin/busstop-notices/:id` | 内容の更新（`title`/`imageUrl`/`body`/`enabled`）。配信範囲・対象は変えない |
| PATCH | `/api/admin/busstop-notices/:id` | `enabled` の切り替えのみ |
| DELETE | `/api/admin/busstop-notices/:id` | 1件削除 |
