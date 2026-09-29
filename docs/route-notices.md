# 路線お知らせ配信

## 概要

路線ごとのリアルタイム時刻表（`frontend/app.js` の `#/realtime/{feedId}/{routeId}`）の上部に、管理画面「路線お知らせ」で登録したお知らせを表示する。

「◯月◯日は工事のため△△付近を迂回運行」「この路線は◯日から経路変更」のような、特定の路線に紐づく案内に使う。トップ画面のお知らせ（`system_settings.notices`）は全体向け、バス停お知らせ（[busstop-notices.md](busstop-notices.md)）はバス停・のりば向けで、それぞれ置き場が違う。

1件のお知らせは **題名（必須）・画像（任意）・本文（任意）・配信期間（任意）** を持つ。画像と本文の少なくとも一方は必須。

## 表示（`app.js`）

路線名の行（「← 路線選択へ戻る」の行）のすぐ下の `#route-notices` に描く。

- **お知らせが1件も無いときはフィールドごと出さない**（`display:none`）。
- リアルタイム運行情報の表示領域を狭めないよう、フィールドには**題名だけ**を1件1行で並べる。長い題名は1行で省略表示（`truncate`）する。
- 題名をタップすると、トップ画面のお知らせと同じ詳細モーダル（`notice-modal`／`openNoticeModal()`）を開く。モーダルの見出しに題名（全文）、本文に 画像（`<img>`）→ 本文（`linkifyNotice()`、リンク記法対応）の順で出す。
- 「本日の運行はありません／終了しました」のときも表示する（運休・経路変更の案内こそ必要なため）。

取得は `GET /api/route-notices?routeId=...`。`loadAll()`（20秒ポーリング）のたびに運行情報とは独立に取り直す。

- 内容が前回と同じなら描き直さない（ポーリングのたびにDOMを作り直さない）。
- 取得に失敗しても運行情報の表示は妨げない（soft-fail。前回の表示をそのまま残す）。
- 別の路線へ切り替えたら、前の路線のお知らせは取得完了を待たずに消す。取得中に路線が切り替わった場合は、届いた古い路線の結果を捨てる。

## データモデル

### `route_notices` テーブル

| カラム | 型 | 説明 |
|---|---|---|
| `id` | serial PK | 内部ID |
| `route_id` | text | 突合キー。`routes.id` と同じ「feedId:routeId」形式の qualified route id |
| `route_name` | text | 路線名のスナップショット（管理画面一覧の可読性用） |
| `title` | text NOT NULL | 題名（必須、最大60文字）。画面に常時出るのはこれだけ |
| `image_url` | text | 画像URL（`https://` のみ許可。Cloudinary等に手動アップロードしたURLを貼る） |
| `body` | text | 本文（最大1000文字、リンク記法対応）。画像・本文の少なくとも一方が必須 |
| `start_date` / `end_date` | date | 配信期間（両端含む）。NULLは無期限。運行日（JST、`getServiceDateString()`）で判定する |
| `enabled` | boolean, default true | 一時非表示フラグ |
| `sort_order` | integer, default 0 | 同じ路線内の表示順（作成時に `MAX+1` を採番） |

`route_id` は保存時に `routes` テーブルの実在を確かめるが、**外部キーは張らない**。GTFS再取込で路線が消えても行は残り、参照時に一致しなくなるだけで実害はない（管理画面の編集時には「現在のGTFSに存在しない」と出るので、路線を選び直すか削除する）。`route_name` はスナップショットで、GTFS側で路線名が変わっても更新しない（編集して保存し直せば取り直す）。

`start_date` / `end_date` は `DATE` 型。pg の既定パーサはDATEをローカルタイムゾーンの `Date` に変換して日付がずれうるため、`services/routeNotices.js` では `to_char(..., 'YYYY-MM-DD')` で文字列として取り出す。

## リンク記法

本文（`body`）は、トップ画面のお知らせ・バス停お知らせと**同じ記法**（`app.js` の `linkifyNotice()` をそのまま使う）。

- 裸のURL `https://example.com` … URLをそのまま表示
- `[時刻表はこちら](https://example.com)` … 表示文字列に置き換えて表示
- リンクを含まないただの文章も可

本文は先に全体をHTMLエスケープしてから `<a>` へ置換するのでXSSの心配はない。

## 画像

`tourist_spots.photo_urls`・バス停お知らせと同じ運用。アプリからアップロードAPIは持たず、Cloudinary等に手動アップロードして発行URL（`secure_url`）を貼り付ける。保存時に `https://` 始まりのみ許可する（ホスト名は縛らない）。

## 管理画面「路線お知らせ」（`frontend/admin-route-notices.js`）

1. 路線を選ぶ（`/api/routes` の候補一覧から。自由入力はさせない）
2. 題名（必須）・画像URL（任意）・本文（任意）・配信開始日／終了日（任意）・表示ON/OFF を入力して「追加」
3. 一覧から各行の 表示切替（PATCH）／編集（PUT。路線の付け替えも可）／削除（DELETE）

一覧には配信状態のバッジ（配信中／配信前／配信終了／非表示）を出す。判定はJSTの今日で行い、サーバーの配信判定と同じ基準。

## API

| メソッド | パス | 概要 |
|---|---|---|
| GET | `/api/route-notices?routeId=...` | 公開。`{ routeId, notices: [{ id, title, imageUrl, body }] }`。`enabled=true` かつ今日（運行日）が配信期間内のものだけを並び順で返す。`routeId` 未指定は400 |
| GET | `/api/admin/route-notices` | 全件（無効・期間外も含む。管理画面一覧用） |
| POST | `/api/admin/route-notices` | 新規作成。body `{ routeId, title, imageUrl, body, startDate, endDate, enabled }`。`routeId` が `routes` に無ければ400 |
| PUT | `/api/admin/route-notices/:id` | 内容の更新（POSTと同じbody。路線の付け替えも可） |
| PATCH | `/api/admin/route-notices/:id` | `enabled` の切り替えのみ |
| DELETE | `/api/admin/route-notices/:id` | 1件削除 |
