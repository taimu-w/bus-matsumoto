# 乗り場（のりば）お知らせ配信

## 概要

バス停詳細ページ（`frontend/busstop.js`）の「このバス停でできること」セクションの下に、**乗り場ごと**に登録した画像またはリンクのお知らせを表示する。管理画面「乗り場お知らせ」で編集する。

トップ画面のお知らせ（`system_settings.notices`）が路線・全体向けなのに対し、こちらは「◯番のりばのエレベーター工事」「この乗り場は当面△△バス停へ移設」のような**のりば単位の案内**に使う。

## 表示条件（`busstop.js`）

3つすべてを満たすときだけ「乗り場お知らせ」セクションを出す。1つでも欠ければセクションごと描画しない。

1. **乗り場が確定している**こと。すなわち利用者が乗り場別表示を選んでいるか、そのバス停の乗り場が1か所だけ（＝統合表示でも実体は1のりば）であること。`effectivePlatform(data)` が非nullのとき。
2. すべての乗り場を統合して表示しているとき（`effectivePlatform(data)` が null）は**出さない**。乗り場単位の案内なので、どの乗り場の話か特定できない画面には載せない。
3. その乗り場に `enabled = true` のお知らせが**1件以上ある**こと。0件ならセクションを描画しない。

取得は `GET /api/busstop/:stopKey/platform-notice?platform=...` で、失敗してもバス停情報自体の表示は妨げない（soft-fail、何も出さない）。表示モード切替のたびに `renderSeq` ガード付きで取り直す。

## データモデル

### `platform_notices` テーブル（新規）

| カラム | 型 | 説明 |
|---|---|---|
| `id` | serial PK | 内部ID |
| `feed_id` | text | GTFSフィードID。`stop_id` と合わせて乗り場を一意に指す（**表示側の突合キーはこの2つだけ**） |
| `stop_id` | text | GTFSの生 `stop_id`（座標統合後の代表標柱。`gtfsTimetable.resolvePlatformRef()` が解決したもの） |
| `stop_key` | text | 統合バス停キーのスナップショット（管理画面一覧の並び・リンク用。突合には使わない） |
| `stop_name` | text | バス停名のスナップショット（管理画面一覧の可読性用） |
| `platform_code` | text | `platform_code` のスナップショット（管理画面一覧の可読性用） |
| `kind` | text | `image` または `link`（CHECK制約） |
| `title` | text | 見出し（任意、最大60文字） |
| `image_url` | text | `kind='image'` のときの画像URL（`https://` のみ許可。Cloudinary等に手動アップロードしたURLを貼る） |
| `link_body` | text | `kind='link'` のときの本文。トップ画面のお知らせ本文と同じリンク記法 |
| `enabled` | boolean, default true | 一時非表示フラグ |
| `sort_order` | integer, default 0 | 同一乗り場内の表示順（作成時に `MAX+1` を採番） |

`stop_key` / `stop_name` / `platform_code` は**スナップショット**であり、GTFS再取込で値が変わっても行は更新しない。あくまで管理画面一覧を読みやすくするためのもので、利用者向けの突合は常に `feed_id + stop_id` で行う。GTFS側から `stop_id` が消えれば、その行は参照時に単に一致しなくなるだけで実害はない（`tourist_spots` の「参照時に都度、緯度経度で近接解決」と同じ発想で、保存時に固い外部キーを張らない）。

### 乗り場の解決（`gtfsTimetable.resolvePlatformRef()`）

`stopKey` と `?platform=` の値（`stop_id` または `feedId_stopId`）から乗り場を軽量に解決する。`getStopTimetable()` と違い発車一覧は組み立てない。座標統合で畳まれた標柱の旧 `stop_id` を渡しても代表標柱を返す（`resolvePlatform` に委譲）。乗り場が複数あって `?platform=` 未指定なら `platform: null`（＝統合表示）を返す。

## リンク記法

`kind='link'` の本文は、トップ画面のお知らせ（`app.js` の `linkifyNotice`）・運行状況画面（`servicestatus.js` の `linkifyDetail`）と**同じ記法**。`busstop.js` にも同じ実装を持たせている（このリポジトリの既存方針どおり、記法の実装は各画面に複製する）。

- 裸のURL `https://example.com` … URLをそのまま表示
- `[時刻表はこちら](https://example.com)` … 表示文字列に置き換えて表示

本文は先に全体をHTMLエスケープしてから `<a>` へ置換するのでXSSの心配はない。保存時に「`https://` で始まるリンクを1つ以上含むこと」を検証する。

## 画像

`tourist_spots.photo_urls` と同じ運用。アプリからアップロードAPIは持たず、Cloudinary等に手動アップロードして発行URL（`secure_url`）を貼り付ける。表示は `<img src>` で直接配信。保存時に `https://` 始まりのみ許可する（ホスト名は縛らない）。

## 管理画面「乗り場お知らせ」（`frontend/admin-platform-notices.js`）

1. バス停名で検索（`/api/busstop/search`）→ 候補から1件選ぶ
2. その乗り場一覧（`/api/timetable/stops/:stopKey` の `platforms`）から乗り場を選ぶ。乗り場が1か所なら自動選択
3. 種別（画像／リンク）・見出し（任意）・内容・表示ON/OFF を入力して「追加」
4. 一覧から各行の 表示切替（PATCH）／編集（PUT。**対象の乗り場は変更不可**。変えたいときは削除して追加し直す）／削除（DELETE）

## API

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/busstop/:stopKey/platform-notice?platform=...` | その乗り場の `enabled=true` のお知らせ一覧（公開）。乗り場が複数あって `platform` 未指定なら `notices: []` |
| GET | `/api/admin/platform-notices` | 全件（無効も含む。管理画面一覧用） |
| POST | `/api/admin/platform-notices` | 新規作成。body `{ stopKey, platform, kind, title, imageUrl, linkBody, enabled }`。`stopKey`+`platform` をサーバー側で `resolvePlatformRef()` に通し、正規の `feed_id`+`stop_id` へ落として保存する。乗り場が特定できなければ400 |
| PUT | `/api/admin/platform-notices/:id` | 内容の更新（`kind`/`title`/`imageUrl`/`linkBody`/`enabled`）。対象の乗り場は変えない |
| PATCH | `/api/admin/platform-notices/:id` | `enabled` の切り替えのみ |
| DELETE | `/api/admin/platform-notices/:id` | 1件削除 |
