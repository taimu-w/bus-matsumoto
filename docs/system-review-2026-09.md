# システム全体レビュー（2026-09）— 問題点・バグ・欠陥・改善提案

このドキュメントは、バスロケーションシステム（`bussystem/`）のコード・アーキテクチャ・
運用面を一通り読み込んだうえでの**指摘事項の総まとめ**です。

- 対象: `backend/src/` 全体、`frontend/`（主要ファイル）、`docs/`、`Dockerfile` / `docker-compose.yml` / `schema.sql`
- 既存の [docs/known-issues.md](known-issues.md) と重複する項目には **「既知(H-2 等)」** と付記しています。
  重複項目もこのドキュメントで現状を再確認し、影響・背景を補っています。
- 重大度は known-issues.md の基準（利用者に見える誤情報を出すか／復旧に人手が要るか）に、
  **セキュリティ**と**プロダクトとしての完成度**の観点を加えています。

> **S-1〜S-7 と B-1 / B-3 / B-4 / B-7 / B-8 / B-9 / B-10 / B-12、P-1 / P-3 / P-4 / P-5 / P-6 / P-7、G-1 / G-2 / G-4 / G-5 / G-6、A-1 / A-2 / A-3 / A-4 / A-5 / A-6、F-1、D-1 / D-4 / D-5 / D-6 / D-8 / D-9、F-4、F-6、F-7 は対応済みです。** 各項目の見出しに ✅ を付け、本文を
> 「現在どうなっているか」と「それでも残っている課題」に書き換えてあります。
> F-3 は静的CSS化そのものは見送りましたが、見送りの根拠（動的なTailwindクラス構築が
> 存在しないことの確認）を追記してあります。P-2 も同様に、単一DB接続での直列処理という
> 構造そのものは変えていませんが、便あたりの所要時間を可視化する計測を追加してあります。
> それ以外の項目は指摘のままで、コードは変えていません。

---

## 0. サマリ

### 最優先で対応すべきもの

| # | 重大度 | 分類 | 概要 |
|---|---|---|---|
| ~~S-1~~ | ~~**重大**~~ | セキュリティ | ✅ **対応済み**（管理画面のデフォルト認証情報 `admin` / `admin123` → 未設定時は起動ごとにランダム生成しログへ1回だけ出力） |
| ~~S-2~~ | ~~**重大**~~ | セキュリティ | ✅ **対応済み**（管理者の資格情報を`localStorage`に平文保存 → サーバー側セッション＝httpOnly Cookie へ） |
| ~~S-3~~ | ~~高~~ | セキュリティ | ✅ **対応済み**（レートリミットが一切ない → 認証失敗・RAPTOR探索・集計カウント系に上限を追加） |
| ~~B-1~~ | ~~高~~ | バグ | ✅ **対応済み**（カレンダー読み込みの一時失敗で「当日運行なし」を確定 → 読めなかったフィードがある回は確定させず再試行） |
| B-2 | 高 | バグ | GPS途絶（既定6分）で担当終了→候補なしでクローズ。GPS復旧後も便が利用者画面に戻らない（既知 H-2） |
| ~~B-3~~ | ~~高~~ | バグ／整合性 | ✅ **対応済み**（G-1 と同一の指摘。内容不変でのマスタ全書き換えと `schedule_trips` の位置依存キー → G-1 参照） |
| ~~G-2~~ | ~~高~~ | GTFS取り込み | ✅ **対応済み**（`seed()` に排他制御がなく、毎時パイプラインと管理画面の手動再取得が同時に走るとデッドロック／部分適用の恐れ → トランザクション単位のアドバイザリロックで直列化） |
| ~~D-1~~ | ~~高~~ | 運用 | ✅ **対応済み**（パイプライン／終了バッチ／掃除バッチのスキップを jobMonitor に記録。連続スキップは異常アラートにも出す） |
| ~~P-1~~ | ~~高~~ | 性能 | ✅ **対応済み**（ETAプリコンピュートの N+1（区間統計）＋ O(便数²)（周辺実績）→ 1周期1回のまとめ読みへ） |
| ~~G-1~~ | ~~高~~ | GTFS取り込み | ✅ **対応済み**（内容不変でも毎時 `seed()` が全マスタ書き換え／ダイヤ改正で便がずれる → 内容指紋によるスキップと `gtfs_trip_id` 基準の整列） |

### 分類別の件数

- セキュリティ: 8 件（うち **S-1〜S-7 の7件は対応済み**、残り1件は S-8）
- 運行判定ロジックのバグ・弱点: 12 件（うち **B-1 / B-3 / B-4 / B-7 / B-8 / B-9 / B-10 / B-12 の8件は対応済み**）
- パイプライン／非同期／性能: 7 件（うち **P-1 / P-3 / P-4 / P-5 / P-6 / P-7 の6件は対応済み**、P-2は計測の追加のみ一部対応）
- GTFS取り込み・当日便生成: 6 件（うち **G-1 / G-2 / G-4 / G-5 / G-6 の5件は対応済み**、残り1件は G-3）
- API層: 6 件（うち **A-1 / A-2 / A-3 / A-4 / A-5 / A-6 の6件は対応済み**）
- フロントエンド: 7 件（うち **F-1 / F-4 / F-6 / F-7 の4件は対応済み**）
- デプロイ・インフラ・可観測性: 9 件（うち **D-1 / D-4 / D-5 / D-6 / D-8 / D-9 の6件は対応済み**）
- テスト・品質保証: 4 件
- プロダクトとしての欠陥: 8 件
- ドキュメントの不整合: 4 件（うち **DOC-1 / DOC-4 の2件は解消済み**）

---

## 1. セキュリティ

### S-1 ✅ 管理画面のデフォルト認証情報のまま稼働しうる（重大）— 対応済み

*場所*: [backend/src/services/adminAuth.js](../backend/src/services/adminAuth.js)、[docker-compose.yml](../docker-compose.yml)、[backend/.env.example](../backend/.env.example)、[backend/test/adminAuth.test.js](../backend/test/adminAuth.test.js)

**指摘だった状態**:

```js
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
```

運用者が明示的に設定しない限り `admin` / `admin123` という**誰でも知っている固定値**で
管理画面が開いていた。管理画面からできること（運用パラメータの変更、車両の手動割り当て・
到着時刻の書き換え、公開画面へのお知らせ配信、リアルタイム休止、GTFS手動再取得）を考えると、
乗っ取られると**利用者に誤情報を配信**でき、運行判定を破壊できる。S-3 の総当たり対策
（認証失敗10回で15分ブロック）は入っていたが、**既定値を知っている相手には1回目で通る**ため
緩和にはならなかった。

**現在**: `ADMIN_PASSWORD` が未設定のときは、固定の既定値へフォールバックする代わりに、
**起動のたびに変わるランダムなパスワード**（`crypto.randomBytes(18)`）を生成し、
起動ログに1回だけ出す。

- ユーザー名側（`ADMIN_USERNAME`）は変更していない。単独では秘匿情報ではなく、
  多くの管理画面で共通の慣習的な値のため。
- `ADMIN_PASSWORD` を設定済みの環境（本番運用を想定した構成）は**一切影響を受けない**。
  分岐は「環境変数がある/ない」だけで、既存の値を上書きすることはない。
- ランダム生成したかどうかは `adminAuth.ADMIN_PASSWORD_AUTO_GENERATED` として公開し、
  回帰テスト（[backend/test/adminAuth.test.js](../backend/test/adminAuth.test.js)）で
  「`ADMIN_PASSWORD` を設定していれば生成しない」ことを固定した。
  既存のテストも、コード既定値ではなく明示的な環境変数で資格情報を固定する形に直してある
  （ランダム値だとテストで期待値を書けないため）。
- `.env.example` と `docker-compose.yml` のコメントを、この挙動に合わせて更新した。

起動を拒否する案（もう一つの対策の方向性）は採らなかった。`ADMIN_PASSWORD` 未設定の開発環境
（`docker compose up` を素で叩く場合など）でサーバーが起動しなくなり、既存の使い方を壊すため。
ランダム値でも「固定の既知パスワードで開く」という本質的な脆弱性は塞げる。

*残っている課題*: パスワードは起動ログにしか出ないため、コンテナ再起動のたびにログを
確認し直す必要がある（本番では `ADMIN_PASSWORD` を設定して回避する運用が前提）。
また、ログ収集基盤にこのログが残る構成では、ログ自体のアクセス制御が新たな管理対象になる。

### S-2 ✅ 管理者の資格情報を localStorage に保存（重大）— 対応済み

*場所*: [backend/src/services/adminAuth.js](../backend/src/services/adminAuth.js)、[backend/src/routes/api.js](../backend/src/routes/api.js)（`isAuthenticatedAdmin` / `requireAdminAuth` / `/admin/session`）、[frontend/admin-core.js](../frontend/admin-core.js)、[frontend/admin-router.js](../frontend/admin-router.js)

**指摘だった状態**: 管理画面が `btoa("user:pass")` を `localStorage` に保存し、毎リクエストの
`Authorization` ヘッダーに載せていた。base64 は暗号化ではなく単なる可逆エンコードで、
`localStorage` は同一オリジンの任意のスクリプト（XSSが1件でもあれば）から読める。
共用PC・キオスク端末では次の利用者にも残る。

**現在**: サーバー側セッションに切り替え済み。

- `POST /api/admin/session` が資格情報を検証し、`crypto.randomBytes(32)` のトークンを
  **httpOnly・SameSite=Strict** の Cookie（`bt_admin_session`）で返す。JSからは読めない。
  資格情報がネットワークに載るのはログインの1回だけ。
- 有効期限は `ADMIN_SESSION_TTL_MIN`（既定720分）の**絶対期限**（スライド更新なし）。
  `Secure` 属性は `ADMIN_SESSION_COOKIE_SECURE=auto`（既定）ならHTTPSで届いたときに付く。
- ログアウト（`DELETE /api/admin/session`）は**サーバー側のセッションも破棄**する。
  クライアント側だけ消してもトークンが生き残る、という旧実装の弱点をなくした。
- Cookie認証のリクエストは `Origin` が自ホストと一致することも要求する（`isSameOriginRequest()`）。
  SameSite=Strict に加えたCSRFの多層防御。
- 資格情報の比較は `crypto.timingSafeEqual`（SHA-256で固定長に潰してから比較）。
  ユーザー名・パスワードの判定を `&&` で短絡させないため、どちらが外れたかも応答時間に出ない。
- **Basic認証ヘッダーの経路は残してある。** curl・監視ツール・既存の手順書が壊れないため。
  判定の入口は従来どおり `isAuthenticatedAdmin()` 1か所で、`/api/buses-for-map` の
  リアルタイム休止バイパスもそのまま動く。
- 旧実装が保存した `localStorage.adminToken` は、管理画面の起動時に無条件で `removeItem` する。

*残っている課題*: セッションはプロセス内メモリなので、**再起動・デプロイで全て失効する**
（＝再ログインが必要。D-3 の「監視データがインメモリ」と同根）。管理画面は401を受け取ると
`handleSessionExpired()` でログイン画面へ戻すようにしてあるため、黙って壊れることはない。
永続化するなら DB か外部ストアへセッションを逃がす必要がある。

### S-3 ✅ レートリミットが存在しない（高）— 対応済み

*場所*: [backend/src/middleware/rateLimit.js](../backend/src/middleware/rateLimit.js)、[backend/src/config/security.js](../backend/src/config/security.js)、[backend/src/services/visitorTracker.js](../backend/src/services/visitorTracker.js)

**指摘だった状態**: (1) `/api/admin/*` に試行回数制限がなく総当たりし放題、(2) `GET /api/route-search`
（RAPTOR探索＋段階的フォールバック）を任意の日付・時刻で叩けるため少数のクライアントでCPUを専有できる、
(3) `link-click`・スポット検索カウント・`X-Client-Id` 由来の閲覧数を無認証・無制限に増やせる。

**現在**: 依存パッケージを増やさず、プロセス内メモリの固定ウィンドウ方式レートリミッタを自前で用意した
（監視系＝`jobMonitor`・`apiMetrics`・`visitorTracker` と同じインメモリ方針）。

| 対象 | 上限（環境変数・1IPあたり） | 挙動 |
|---|---|---|
| 管理画面の認証**失敗** | `ADMIN_AUTH_MAX_FAILURES`=10 / `ADMIN_AUTH_WINDOW_MIN`=15分 | 超過でそのIPを429。ブロック中は正しいパスワードでも通さない。認証成功でカウンタ解除 |
| `GET /api/route-search` | `ROUTE_SEARCH_RATE_LIMIT_PER_MIN`=240 | 超過で429＋`Retry-After` |
| `GET /api/spot-search`・`POST /api/tourist-spots/:id/link-click` | `COUNT_RATE_LIMIT_PER_MIN`=240 | 同上 |
| サイト閲覧数（`X-Client-Id`） | `VISITOR_MAX_CLIENTS_PER_IP`=200 | 上限超過分は**数えないだけ**でリクエストは通す |

設計上の判断が3つある。

- **数えるのは認証の「失敗」だけ**（`adminAuth.hasPresentedCredentials()` ＝ Basicヘッダーがあるとき）。
  管理画面は15〜30秒間隔でポーリングするため成功まで数えると即上限に達するし、期限切れセッションの
  ポーリングを失敗として数えると**管理者が自分自身をロックアウトする**。
- **ホットパス（`/api/buses` 等、20秒ポーリング）には掛けていない。** 利用者の画面が止まる
  リスクの方が大きい。上限240件/分という水準も、攻撃の連打（毎秒数十〜数百件）は確実に止まるが
  CGNAT配下の実利用者は届かない、という判断で選んである。
- 閲覧数の上限は**過小計上に倒す**（数えないだけでリクエストは通す）。上限は `cleanup()`（60秒間隔）
  ごとにリセットされるので、実在の利用者が恒久的に締め出されることはない。

*残っている課題*: 1プロセス前提のインメモリ実装なので、APIを複数インスタンスへ水平展開する場合（X-8）は
Redis等の共有ストアかリバースプロキシ側へ移す必要がある。また**リバースプロキシ配下では
`TRUST_PROXY` の設定が必須**で、未設定だと全利用者が1つのキー（プロキシのIP）に集約される。
401に `WWW-Authenticate: Basic` は意図的に付けていない（fetchが401を受けたときにブラウザ標準の
認証ダイアログが出て、自前のログインフォーム・セッション切れ処理と二重になるため）。

### S-4 ✅ CORS 全開放（中）— 対応済み（既知 M-15）

*場所*: [backend/src/server.js](../backend/src/server.js)

**指摘だった状態**: 引数なしの `app.use(cors())` が全パスに `Access-Control-Allow-Origin: *` を付けていた。

**現在**:

- **管理API（`/api/admin/*`）にはCORSヘッダーを一切付けない。** 管理画面は同一オリジンから
  叩くのでCORSを必要とせず、別オリジンのページから管理APIのレスポンスを読むことはできない。
  S-2でCookie認証になったぶん、ここを閉じておく意味が大きい。
- 公開APIは `CORS_ALLOWED_ORIGINS`（カンマ区切り）で許可オリジンを絞れる。
  **未設定なら従来どおり全オリジン許可**（公開APIを叩いている外部利用者を黙って壊さないため）。

*残っている課題*: 本番で `CORS_ALLOWED_ORIGINS` を設定するかは運用判断。起動ログに
`cors=全オリジン許可` と出るので、設定漏れには気づける。

### S-5 ✅ HTTPS / HSTS の強制がコード・compose にない（中）— 対応済み

*場所*: [backend/src/middleware/securityHeaders.js](../backend/src/middleware/securityHeaders.js)、[backend/src/config/security.js](../backend/src/config/security.js)、[docker-compose.yml](../docker-compose.yml)、README §9

**指摘だった状態**: 平文HTTPで来ても何もしない。`docker-compose.yml` は `3000` を素で公開し、
TLS終端やリダイレクトの記述がない。READMEにも「必ずHTTPS前提」と書かれていない。

**現在**: TLS終端はリバースプロキシ側で行う前提のまま、アプリ側に次を用意した。

- `app.set('trust proxy', TRUST_PROXY)` … クライアントIP（レートリミットの単位）と
  プロトコル（`req.secure`）をプロキシ配下でも正しく判定する。**既定は false**
  （手前にプロキシが無いのに有効にすると、X-Forwarded-For詐称で上限を回避されるため）。
- `FORCE_HTTPS=true` … 平文で届いたリクエストを、GET/HEADは301でHTTPSへ、
  それ以外は403で拒否する（平文で本文＝資格情報やお知らせの更新内容を受け取らないため）。
- セキュリティヘッダーを全レスポンスに付与:
  `Strict-Transport-Security`（HTTPSで届いたときだけ。`HSTS_MAX_AGE_SEC` 既定180日、
  `includeSubDomains` は他サブドメインを巻き込むため既定OFF）・`X-Content-Type-Options: nosniff`・
  `X-Frame-Options: SAMEORIGIN`・`Referrer-Policy: strict-origin-when-cross-origin`。
  `X-Powered-By` は無効化。
- `CSP_MODE`（`off` / `report-only` / `on`、既定 `off`）でCSPも出せる。
- `docker-compose.yml` にリバースプロキシ前提と必要な環境変数をコメントで明記し、
  READMEに「本番公開時に必ず行うこと」の節を追加した。

既定値はすべて「設定しなければ従来どおり動く」側（HTTPS強制OFF・HSTSは平文HTTPには付けない・CSP無効）に
倒してあるため、ローカル開発と既存デプロイの挙動は変わらない。

*残っている課題*: TLS終端そのものは依然リバースプロキシの仕事で、compose にはプロキシを含めていない。
`CSP_MODE` を `on` にするには、事前に `report-only` で全画面を一巡してブロックが出ないことの確認が要る。

### S-6 ✅ CDN 依存にSRIがなく、Tailwind は本番非推奨のPlay CDN（中）— 対応済み

*場所*: [frontend/vendor/](../frontend/vendor/)（[README](../frontend/vendor/README.md)）、`frontend/index.html` / `admin.html` / `howto.html` / `servicestatus.html`

**指摘だった状態**:

```html
<script src="https://cdn.tailwindcss.com"></script>          <!-- Play CDN。バージョン非固定 -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```

どのタグにも `integrity=`（SRI）がなく、CDNが汚染されたら任意のJSが利用者に実行される。
`unpkg.com` は無保証の無料CDNで、障害時に地図とアイコンが丸ごと壊れる。
Tailwind の URL はバージョン非固定で、上流の更新が予告なく本番の見た目に入る。

**現在**: 3本とも `frontend/vendor/` に同梱し、**同一オリジンから配信**するようにした
（SRIは「別ホストから来たファイルが正しいか」を確かめる仕組みなので、自分で配信するなら不要になる）。

- Leaflet 1.9.4（`leaflet.css` / `leaflet.js` ＋ `images/` 5ファイル）。
  同梱した2ファイルのSHA-256は**Leaflet公式が配布ページに掲載しているSRI値と一致**することを確認済み。
- Tailwind CSS 3.4.17 Play CDN（`tailwind-3.4.17.js`）。バージョン無しの `https://cdn.tailwindcss.com`
  は取得時点で 3.4.17 へリダイレクトされていたため、**同梱前と同じバージョン＝同じ見た目**になる。
- ファイル一覧・SHA-256・更新手順は [frontend/vendor/README.md](../frontend/vendor/README.md) にまとめた。

これで「CDN汚染で任意JS実行」「unpkg障害で地図が壊れる」「上流更新が予告なく入る」
「外部CDNが読めないと画面が真っ白」（F-3）の4つが同時に消える。

*残っている課題*: Tailwind は同梱後も**ブラウザ内でCSSをコンパイルするPlay CDN版のまま**で、
初期描画のコスト（約400KBのJS＋実行時コンパイル）は変わっていない。ここを解消するには
Tailwind CLI でビルドした静的CSSへ置き換える必要がある（F-3。動的に組み立てたクラス名の
取りこぼしで見た目が変わりうるため、既存挙動を変えない範囲という制約では見送った）。
**Google Fonts**（UAごとに内容が変わるためSRIを付けられない。F-5）と
**OpenStreetMapの公式タイルサーバ**（D-7）は外部依存のまま。

### S-7 ✅ 運行実績CSVエクスポートに数式インジェクション対策がない（低）— 対応済み

*場所*: [backend/src/routes/api.js](../backend/src/routes/api.js)（`GET /api/admin/operation-records/export` 内の `csvEscape()`）

**指摘だった状態**: `csvEscape()` は `"` `,` `\n` は処理するが、`=` `+` `-` `@` で始まるセルを
Excelが数式として実行する問題（CSV Formula Injection）に未対応だった。単体の `\r` も未エスケープ。

**現在**: `csvEscape()` が、`=` `+` `-` `@` `\t` `\r` のいずれかで始まるセルの先頭に
シングルクォートを前置して無害化し、引用符で囲む条件にも `\r` を含めている。

**純粋な数値は前置の対象外**にしてある。「遅延分(符号付き)」は負値（早発・早着）を取り、
`-3` に `'` を付けるとExcel上で文字列になって集計できなくなるため。判定は
`/^-?\d+(\.\d+)?$/` で、`=` `@` などを含む文字列がこれに一致することはない。

### S-8 `express.json()` にボディサイズ上限の明示がない（低）

デフォルトの 100KB に依存。観光スポットの一括テキスト登録が大きくなると弾かれる可能性。
明示的に `express.json({ limit: '1mb' })` 等にしておくと意図が分かる。

---

## 2. 運行判定ロジックのバグ・弱点

### B-1 ✅ カレンダー読み込みの一時失敗で「当日運行なし」が確定する（高・新規）— 対応済み

*場所*: [backend/src/services/gtfsCalendar.js](../backend/src/services/gtfsCalendar.js)（`getActiveServiceIdsWithStatus`）、[backend/src/services/dailyTripBuilder.js](../backend/src/services/dailyTripBuilder.js)（`ensureDailyTrips` / `markIncomplete`）

**指摘だった状態**: `getActiveServiceIds` はフィードごとに catch して `continue` するだけで、
「本当に運行が無い日」と「カレンダーを読めなかった」を区別せず空配列を返していた。
受け側の `ensureDailyTrips` は空配列を見て `builtServiceDate = serviceDate` を立てるため、
以降のポーリングが即リターンし、当日便0件のまま固定される。復旧するのは
`invalidateDailyTripCache()` が呼ばれたとき＝**GTFS再取得が成功したとき**だけで、
配信元が落ちていれば数時間〜半日、リアルタイムも時刻表APIの当日分も空になる。

**現在**: 「1件も無い」の2つの意味を呼び出し側が区別できるようにした。

- `getActiveServiceIdsWithStatus(date, feedId)` が
  `{ serviceIds, feedsTotal, failedFeedIds, complete }` を返す。読めなかったフィードは
  `failedFeedIds` に載り `complete: false` になる。
  従来の `getActiveServiceIds()` は `serviceIds` だけを返す薄いラッパとして残してあるので、
  `/api/admin/*` 側（api.js）の呼び出しは一切変わらない。
- `calendar_dates.txt` はGTFS上の任意ファイルなので、**存在しない（ENOENT）だけならフィードの
  失敗にしない**（「例外日なし」として通常どおり処理する）。旧実装は両ファイルを1つの
  `try` で読んでいたため、`calendar_dates.txt` を持たないフィードが丸ごと落ちていた。
- `ensureDailyTrips` は `complete === false` の回では `builtServiceDate` を**更新しない**。
  代わりに `incompleteServiceDate` と `incompleteRetryAt` を立て、**5分後に再試行**する
  （毎ポーリング作り直すとDB負荷になるための間引き）。全フィードを読めた回で
  `builtServiceDate` へ移り、間引きは解除される。
- 部分失敗（一部のフィードだけ読めた）の回は、**GTFSから消えた便の掃除（DELETE）もスキップ**する。
  読めなかったフィードの便は `keptIds` に入らないため、そのまま消すと生きている便まで
  削除してしまう。
- 戻り値に `incomplete` / `failedFeedIds` を載せた。`jobMonitor.track()` が返り値を
  `lastMeta` として保持するので、管理画面の稼働監視からどのフィードが読めていないか分かる。

*残っている課題*: 読み込み失敗そのものを**能動的に通知する経路は無い**（D-2「フィード全滅の
push通知」と同根）。現状は5分ごとに再試行しつつ警告ログと `jobMonitor` の `lastMeta` に出るだけ。
また、そもそも読み込み失敗の窓を作らない対策（G-3「別ディレクトリ展開 → rename 1回」）は未実施。

### B-2 GPS途絶で担当終了→復旧しても便が戻らない（高）— 既知 H-2

*場所*: [backend/src/services/finishService.js:307-320](../backend/src/services/finishService.js#L307-L320)、[backend/src/services/tripAssignment.js:242-262](../backend/src/services/tripAssignment.js#L242-L262)

- `GPS_STALE_TIMEOUT_MIN`（既定6分）で担当割り当てを `ended` に。候補がいなければ
  `reassignOrphanTrips()` が `closeDailyTrip()` を呼ぶ。
- `assignPendingTrips()` は `assignment_state = 'pending'` の便しか見ないため、
  クローズ済みの便はGPSが復旧しても復帰経路がない。
- 山間路線（四賀・奈川・鹿教湯など）のトンネル、フィード全体の配信遅延で
  **走っているバスが利用者画面から突然消える**。フィード遅延時は全車両が一斉に `inactive`。
- `GPS_STALE_TIMEOUT_MIN`(6) が `GPS_FRESHNESS_MIN`(15) / `ADMIN_STALE_GPS_MIN`(5) と揃っておらず、
  しきい値の意味が現場で読み解きにくい。

*対策の方向性*: 途絶を「終了」ではなく中間状態にし、GPS復帰で `active` へ戻す。
フィード単位の一斉途絶を検知したら個別車両の終了判定をスキップするサーキットブレーカ。

### B-3 ✅ 早発・早着がすべて「遅延0分」に丸められる（中）— 既知 M-4 — 対応済み

*場所*: [backend/src/utils/time.js](../backend/src/utils/time.js)（`computeSignedDelayMinutes` / `computeDelayMinutes`）、[backend/src/services/delayCalc.js](../backend/src/services/delayCalc.js)、[backend/src/services/tripAssignment.js](../backend/src/services/tripAssignment.js)、[backend/src/services/finishService.js](../backend/src/services/finishService.js)、[backend/src/db/schema.sql](../backend/src/db/schema.sql)

**指摘だった状態**: `computeDelayMinutes()` の `Math.max(0, diff)` により「定刻より早い」が
完全に不可視で、`delay_minutes` もDBに0として保存されるため事後に復元できなかった。

**現在**: 符号付きの差分を別関数に分け、DBには**両方**を持たせた。

- `computeSignedDelayMinutes(scheduled, actual)` が符号付きの差分（負＝早発・早着）を返す。
  日跨ぎ補正（±720分を超える差分だけ ±1440分する）の規則は従来と同一。
- `computeDelayMinutes()` はその戻り値を `Math.max(0, …)` するだけのラッパになった。
  **既存の呼び出し元の戻り値は1つも変わっていない**（公開画面の遅延表示・遅延アラートの
  しきい値・ETA予測は従来どおり0以上）。
- 保存先の列を3つ追加した（いずれも NULL 許容の追加列。既存列・既存クエリは無変更）:
  `trip_stop_progress.signed_delay_minutes` /
  `trip_vehicle_assignments.signed_delay_minutes` /
  `completed_trip_stop_times.signed_delay_minutes`。
  `migrate.js` のステップ40が `ADD COLUMN IF NOT EXISTS` で冪等に追加する。
- 書き込み側は `delayCalc`（バス停ごと・便レベル）、`tripAssignment.openAssignment`（始発バス停＝
  早発が起きうる唯一の判定点）、管理画面の到着時刻手動編集（`PUT` 相当のAPI）、
  `finishService.archiveAssignment`（`completed_trip_stop_times` への引き継ぎ）。
- 読み出し側は、管理画面「運行ダッシュボード」のバス停別詳細（`signedDelayMinutes` を追加し、
  負のときだけ「定刻より◯分早い」バッジを出す）と、運行実績CSVの末尾列
  「遅延分(符号付き)」。**既存の列・既存の表示は変えていない**ため、負でない便の見え方は同じ。

*残っている課題*:

- **ETA予測の `predicted_delay_minutes` は0以上のまま**。ここを符号付きにすると
  `capPredictedDelay()`（B-5）やペース補正の意味が変わり、公開画面の到着予測に影響するため、
  意図的に手を付けていない。「予測が早着を表現できない」という指摘は残っている。
- **早発アラートは未実装**（X-2）。データは残るようになったが、管理画面の異常アラートに
  「定刻より早く発車した便」を出す機能はまだない。
- 符号付き列の導入前に確定した行は `NULL` のまま（遡って復元することはできない）。
  `delayCalc` も `delay_minutes` が既に入っている行は再計算しない。

### B-4 ✅ 「通過」確定バス停が「到着済」に書き換わり区間統計を汚染（中）— 既知 M-5、ドキュメント矛盾あり — 対応済み

*場所*: [backend/src/services/etaPredictor.js](../backend/src/services/etaPredictor.js)（`updateSegmentStats`）、[docs/pass-detection.md](pass-detection.md)、[docs/eta-prediction-algorithm.md](eta-prediction-algorithm.md)

**指摘だった状態**:

- `passStepEntry` の `excludedSet`（[backend/src/services/passDetection.js:247-249](../backend/src/services/passDetection.js#L247-L249)）は `到着済` / `付近` のみ除外し、`通過`（真の通過 `is_through`）は
  除外しない。GPSが120m以内を通れば `付近`→`到着済` に更新される。
- 降車できないバス停に実績時刻が付き、`completed_trip_stop_times.actual_minutes` に値が入るため
  `updateSegmentStats()` が「通過バス停を含む区間」を統計に取り込んでいた。
- **ドキュメント自体が矛盾していた**: [pass-detection.md](pass-detection.md) は
  「通過ステータスのバス停を候補から除外しない」ことを**意図的な設計**として説明していたが、
  known-issues.md M-5 は同じ挙動を**バグ**として挙げていた。

**現在**: 2つの指摘を切り分けて解決した。

- **GPS通過判定が `通過` バス停を候補から除外しない挙動は変えていない。** これは意図どおりの設計
  （真の通過バス停もGTFS上は実座標・実時刻を持つ現実の地点であり、GPSマッチ・進捗管理（`last_arrived_seq`
  の前進）・付近スタックの遡及昇格や線形補間のアンカーとしての利用・管理画面のバス停別詳細表示から
  外す理由がない）。ここを変えると既存の到着判定・ダッシュボード表示に影響するため触っていない。
- **バグだったのは、その実績時刻をETA予測の学習データに混ぜていたこと。** `updateSegmentStats()` が、
  区間の両端（`from`・`to`）のいずれかが `is_through` のバス停なら、その区間を集計対象から除外する
  ようにした。`daily_trip_stop_times.is_through`（当日分コピー）を `daily_trip_id` + `stop_id` で
  引き当てて判定する（`trip_stop_progress.status` はGPS到着確定で `'通過'` から書き換わってしまい、
  アーカイブ後の `completed_trip_stop_times` には区別が残っていないため、当日便側から引く）。
  該当便が `DAILY_TRIP_RETENTION_DAYS` 経過で既に掃除済みなら `LEFT JOIN` が不一致になり、
  **従来どおり除外しない**側へフォールバックする（集計は便のクローズ直後に行われるため実際には
  起こらない。追加列・スキーマ変更は無し）。
- **ドキュメントの矛盾を解消した**: [pass-detection.md](pass-detection.md) にETA学習データ側の
  除外を追記し、[eta-prediction-algorithm.md](eta-prediction-algorithm.md) の `updateSegmentStats()`
  の手順に `is_through` 除外を追記した。known-issues.md M-5 は解決済みのため削除した。

*残っている課題*: 過去に集計済みの `segment_travel_stats` の平均値には、修正前に混入した通過区間の
サンプルが残っている（遡って除去することはできない。指数移動平均のため新しいサンプルで徐々に薄まる）。

### B-5 ETAの遅延キャップが実際に大きく遅れている便の到着を早く見せる（中）— 既知 L-12

*場所*: [backend/src/services/etaPredictor.js:94-116](../backend/src/services/etaPredictor.js#L94-L116) `resolveDelayCeiling()` / `capPredictedDelay()`

上限は現在の遅れだけで決まり、残り区間の長さも実際の統計も参照しない。
`DELAY_RECOVERY_BOOST`（1.15）は遅れ解消方向の予測を常に1.15倍強調する。
序盤定時・途中で大きく遅れる便で終盤に過小予測へ偏りうる（要実測検証）。

### B-6 プロセス停止中に始発時刻を過ぎた便が復旧後まとめて割り当てられる（中）— 既知 M-13

*場所*: [backend/src/services/tripAssignment.js:254-262](../backend/src/services/tripAssignment.js#L254-L262)

`start_at <= evaluateBefore` のみで下限がない。GPSログは48時間保持されるため、
数時間前の便でも当時のGPSが残っていれば割り当てが成立し `/api/buses` に並ぶ。

### B-7 ✅ 候補ゼロで unassigned になった便は closed_at が立たず一日中アラートに残る（中）— 既知 M-14 — 対応済み

*場所*: [backend/src/services/tripAssignment.js](../backend/src/services/tripAssignment.js)（`closeCandidatelessTrips()`）

**指摘だった状態**: `reassignOrphanTrips()` は「割り当て行が1件以上ある」便しか対象にしない。
候補ゼロの便は `trip_vehicle_assignments` を1行も持たないため対象外で、`closed_at` を立てる経路が
翌日の運行日終了掃除しかなく、`unassignedTrip` アラートが一日中残ってノイズ化していた。

**現在**: `closeCandidatelessTrips(client)` を追加し、⑤ `reassignOrphanTrips()` の最後で呼んでいる。
対象は「`closed_at` が未設定・`assignment_state='unassigned'`・割り当て行が1件も無い」便で、
始発時刻から **`VEHICLE_MAX_AGE_MIN`（既定120分）** が経過したものを `closeDailyTrip(..., '候補なし')`
でクローズする（1回あたり200件まで）。

- 猶予に `VEHICLE_MAX_AGE_MIN` を流用したのは、担当車両が付いた便の割り当ても同じ時間で
  強制終了されるため。「便がリアルタイム運行情報の対象で居られる最大時間」の基準が両者で揃う。
- `closeDailyTrip()` は「担当を経験した割り当て」が無ければ何もアーカイブしないので、
  運行実績・区間統計には一切影響しない。無駄な `updateSegmentStats()` を起こさないよう、
  戻り値も既存の `closed` とは別の `closedCandidateless` カウンタで返す。
- 理由文字列に `'担当車両不在'` を使っていないため `assignment_state` は `'unassigned'` のまま。
  割り当て監視画面（`/api/admin/assignment-monitor`）の `outcome='unassigned'` / 理由「候補なし」も
  従来どおりで、便は時刻表上のデータとしてルート検索に出続ける（仕様書 10.4・10.5）。
- アラート自体は始発時刻から120分間は従来どおり出る。「候補ゼロだった」という運用上の事実を
  隠さずに、翌日まで残るノイズだけを消すのが狙い。

*残っている課題*: 候補ゼロになる原因そのもの（GPS途絶・系統表示の切り替わり＝M-9 など）は別問題。

### B-8 ✅ 深夜帯に車両割り当て（④）が動かないが、複数のドキュメントは「動く」と書いている（中・新規）— 対応済み

*場所*: [backend/src/jobs/pipeline.js](../backend/src/jobs/pipeline.js)、[backend/src/utils/time.js](../backend/src/utils/time.js)（`isNightTime` / `parseHHMM`）

**指摘だった状態**: 深夜帯（既定23:00〜05:00）は `②fetchLocation` 以降がスキップされ `④assignPendingTrips`
も走らないのに、[backend/.env.example](../backend/.env.example) と README §8 の表は
「**当日便の生成と車両割り当て**はこの時間帯でも動く」と書いていた。
`NIGHT_START` / `NIGHT_END` は管理画面「運用パラメータ設定」から編集できる（`requiresRestart` でもない）ため、
運用者が「GPS取得の停止時間帯」のつもりで `NIGHT_END` を 06:00 にすると
**早朝便の割り当てが黙って止まる**。加えて `isNightTime` は `parseHHMM` が `NaN` を返すと
全比較が false（＝常に非深夜）になっていた。

**現在**: 記述をコードに合わせたうえで、コード側に安全弁と入力の頑健化を入れた。

- **ドキュメントを統一**: `.env.example` / README §8 / CLAUDE.md / 運用パラメータ設定の説明文を
  「深夜帯は**①当日便の生成だけが動き、②位置情報の取得〜⑧到着予測（車両割り当て④を含む）は止まる**」
  に直した。
- **安全弁**: `countDuePendingTrips()`（tripAssignment.js）を追加し、深夜帯でも
  「始発時刻を過ぎたのに `assignment_state='pending'` の便」が1件でもあれば②以降を継続する。
  ④は②③のGPS取り込み結果を前提にしているため、深夜帯だからと一律に抜けると
  その時間帯にかかる便の割り当てが黙って行われないまま `pending` で消えてしまう。
  抽出条件は `assignPendingTrips()` と同じ（運行日・`pending`・`start_at <= now - ASSIGN_DELAY_SEC`）に
  してあるので、「継続したのに対象なし」の空回りは起きない。継続時は理由つきで `console.warn` を出す。
- **既存の挙動は不変**: 既定値（深夜帯23:00〜05:00・最早便5:40発・最終停車22:45）では
  深夜帯に `pending` の便が存在しないため、この分岐は成立せず従来どおり②以降をスキップする。
  効くのは `NIGHT_END` を早朝便の始発より後ろへ動かした場合だけ。
- **不正な設定値のフォールバック**: `parseHHMM()` を厳格化して不正値に `null` を返すようにし、
  `isNightTime()` は「上書き値 → 環境変数 → コード既定値」の順に**パースできた最初の値**を使う。
  壊れた設定が「常に非深夜」＝深夜帯を止めたい運用者に無言で反対の挙動を返す状態を無くした
  （回帰テストで固定）。管理画面からの入力は `validateSettingValue()` が HH:mm を強制するので、
  実際に不正値が届きうるのは環境変数経由だけ。
- `NIGHT_END` の説明文には「5:40より遅くすると早朝便の割り当てが停止時間帯に入る」旨を明記した。

*残っている課題*: `finishTrips()`（1分間隔の別タイマー）は従来どおり深夜帯に無条件で停止する。
`NIGHT_START` をまたいで走行中の便の割り当ては `state='active'` のまま朝まで残り、
翌日の運行日終了掃除でクローズされる。ここを直すと現行設定でも挙動が変わる（22:45着の便の
終了判定が23:00をまたぐ）ため、今回は手を入れていない。

### B-9 ✅ 早朝以降の「24時超え便」の扱いが不完全（低）— 既知（"24時以降の便"）— 対応済み

*場所*: [backend/src/utils/time.js](../backend/src/utils/time.js)（`minutesToServiceTimeStr`）、[backend/src/services/dailyTripBuilder.js](../backend/src/services/dailyTripBuilder.js)（`shiftTime` / 始発時刻文字列）

**指摘だった状態**: `minutesToTimeStr()` は `% 24` で折り返すため、frequencies由来の仮想便の
定刻・始発時刻だけが `25:00` → `"1:00"` になり、素の便（GTFSの表記をそのまま持つ）の `"25:00"` と
**同じ運行日の同じ時刻が2通りに割れていた**。便詳細URLの `departureTime` 突合が外れる。

**現在**: 用途で関数を2つに分けた。

- `minutesToTimeStr(minutes)` — **実時刻**用。従来どおり24時で折り返す（1500 → `"1:00"`）。
  ETA予測の到着時刻・通過判定の補間時刻はこちらのまま。挙動は一切変えていない。
- `minutesToServiceTimeStr(minutes)` — **運行日の0時起点表記**用。折り返さない（1500 → `"25:00"`）。
  1440分未満では `minutesToTimeStr()` と完全に同じ文字列を返すので、24時を跨がない
  既存の便には影響がない（回帰テストで固定）。
- `dailyTripBuilder` の `shiftTime()` と始発時刻文字列を `minutesToServiceTimeStr()` に切り替えた。
  これで `daily_trips.start_time` と `daily_trip_stop_times.scheduled_time` は、素の便も
  仮想便もGTFSと同じ表記に揃う。`realtimeTripLookup.findLiveAssignment()` の
  「24時跨ぎはマッチしないことがある」という注意書きも不要になったので削除した。
- `computeDelayMinutes("25:00", "1:03")` は日跨ぎ補正（差分が −720分未満なら +1440分）で
  正しく3分遅れになる。定刻が24時超え表記でも遅延計算は破綻しない（テストで固定）。

*残っている課題*: 深夜帯停止（`NIGHT_START`〜`NIGHT_END`）で GPS取り込みと運行処理自体が止まるため、
24時超え便の**リアルタイム**運行判定は依然として対象外。ここで直したのは表記の一貫性と
定刻の突合であって、深夜運行への対応ではない。

### B-10 ✅ route_id / service_id にアンダースコアがあるとグループキー分解が壊れる（低）— 既知 L-3 — 対応済み

*場所*: [backend/src/db/seed.js](../backend/src/db/seed.js) `seedStopsAndTimetable()`

**指摘だった状態**: `${route_id}_${directionId}_${serviceId}` の文字列キーでグループを作り、
`key.startsWith(`${originalRouteId}_`)` で絞って `key.split('_')` で分解していた。
GTFSのIDは任意文字列なので、アンダースコアを含むフィードでは方向・service_idが別の便へずれる。

**現在**: キーを `JSON.stringify([route_id, directionId, serviceId])` にし、**分解をやめた**。
Mapの値の側が `{ routeId, directionId, serviceId, trips }` を持つので、路線での絞り込みは
`group.routeId !== originalRouteId` の等値比較になり、区切り文字の解釈が要らない。

Mapの挿入順（＝`trips.txt` の登場順）はそのままなので、`schedule_trips.trip_index` の割り当て順は
変わらない。現在の2フィードの実データ（route_id・service_id ともアンダースコアなし）で
新旧のグループ分けが**バイト単位で一致する**ことを確認済み。

`trip_index` が `trips.txt` の**位置**に依存すること自体は G-1 で対応済み
（UPSERT前に `alignTripIndexesByGtfsTripId()` が `gtfs_trip_id` 基準で既存行を整列させる）。

### B-11 外部IDの照合がCSV行全体の部分一致（低）— 既知 L-2

*場所*: [backend/src/services/locationFetcher.js:155-166](../backend/src/services/locationFetcher.js#L155-L166) `if (joined.includes(externalId))`

行を `join(',')` した文字列に外部IDが含まれるかで路線を決めている。現在の外部IDは26文字のULIDで
誤マッチはまず起きないが、短い系統コードや備考欄へのID混入で誤解決する。列位置を固定して完全一致に。

### B-12 ✅ GPS時刻の「未来」判定と日時書式が脆い（中）— 既知 M-6 — 対応済み

*場所*: [backend/src/services/locationFetcher.js](../backend/src/services/locationFetcher.js)、[backend/src/utils/time.js](../backend/src/utils/time.js)（`parseGpsTimeToDate`）

**指摘だった状態**: `now` は `fetchLocation()` 冒頭で1度だけ取得しフィード取得中ずっと固定
（フィードごとに最大30秒）→ 処理が進むほど正常データが「未来」判定で捨てられる。
`new Date(str.replace(/-/g,'/') + ' +0900')` は V8 のパーサ依存で、フィードが ISO 8601 に変わると
全行 Invalid Date → 全件破棄。しかもフィードは `last_status='ok'` のままで、破棄は
`skippedStaleOrInvalidTime` カウンタにしか出なかった。

**現在**: 3点まとめて直した。

- **基準時刻をフィード単位に**: 鮮度・未来判定に使う `now` は、そのフィードの本文を読み終えた時点で
  取り直す。全フィード共通の1個を使い回さないので、後続フィードの正常データが「未来」で
  落ちることがなくなった。あわせて未来側に **60秒の許容幅**（`FUTURE_TOLERANCE_SEC`）を設け、
  フィード側サーバーとの時計ずれを吸収する。異常を見逃さない程度に小さく取ってある。
- **書式解釈を明示的に**: `utils/time.js` に `parseGpsTimeToDate(raw)` を追加した。
  `"YYYY-MM-DD HH:MM(:SS)"`（区切りは `-` / `/`）に加えて ISO 8601 の `T` 区切り・秒の小数部・
  `Z` / `+09:00` / `+0900` のタイムゾーン指定を受け付け、タイムゾーンが無ければ JST とみなす。
  解釈できなければ `null` を返す（Invalid Date を後段へ流さない）。
  **現行フィードの書式に対する結果は旧実装と完全に同じ**であることを回帰テストで固定した。
- **破棄が見えるように**: 「時刻異常」の内訳を `skippedInvalidTimeFormat`（書式）/
  `skippedStaleTime`（古い）/ `skippedFutureTime`（未来）に分け、書式エラーの実例を1件
  （`sampleInvalidTime`）添えて返す。管理画面「位置情報フィード監視」はこの内訳と実例を表示する
  （既存の合計 `skippedStaleOrInvalidTime` はそのまま残してあるので表示は壊れない）。
  さらに**路線が一致した行の50%以上が書式エラー**なら、そのフィードを `last_status='error'` として
  記録する。「1件も入っていないのに正常と表示される」状態が無くなる。
  未来判定での破棄は件数つきで `console.warn` に出す。

*残っている課題*: 外部IDの照合がCSV行全体の部分一致であること（B-11 / 既知 L-2）は別問題で、
ここでは直していない。

---

## 3. パイプライン／非同期処理／性能

### P-1 ✅ ETA プリコンピュートの計算量（高）— 対応済み（旧 既知 M-10）

*場所*: [backend/src/services/etaPredictor.js](../backend/src/services/etaPredictor.js)
（`buildPredictionContext` / `predictArrivals` / `computeAndStoreAllArrivals`）

**指摘だった状態**:

- `predictArrivals()` は未到着バス停ごとに `getSegmentStat()` を1クエリずつ発行（N+1）。
- 各 `predictArrivals()` で `getRecentSegmentPerformance()` を呼び、これが
  「全 active 割り当て＋直近90分に終了した割り当ての `trip_stop_progress`」を毎回スキャンする
  → 実質 O(便数²)。
- しかもこれを全 active 割り当て（**候補車両ぶんも**）に対して単一DB接続で直列に回すため、
  ⑥⑦⑧の所要時間がポーリング間隔（60秒）に近づくと次周期が `pipelineRunning` ガードで
  スキップされる（D-1）。

**現在**: `computeAndStoreAllArrivals()` が1周期の先頭で `buildPredictionContext()` を1回だけ呼び、
その結果を各 `predictArrivals(client, assignmentId, context)` へ渡して使い回す。

- **区間統計**: 対象割り当てが実際に持つ停留所どうしの組に限定して `segment_travel_stats` を
  1クエリで読み、`from|to|hour_bucket` をキーにプロセス内 Map へ載せる
  （`(from_stop_id, to_stop_id, day_type, hour_bucket)` 主キーの前半で引ける）。
  → 未到着バス停ごとのクエリが消え、1周期あたり2クエリになる。
- **周辺道路実績**: `getRecentSegmentPerformance()` を除外なしで1回だけ実行し、
  対象割り当て自身の除外（SQLの `a.id != $1`）は返り値に持たせた `assignmentId` での
  JS側フィルタで行う（同値）。→ 割り当て数ぶんの全スキャンが1回になる。

アルゴリズム本体（区間ごとの判断・フォールバックの順序）は一切変えていない。統計の参照口だけを
「ルックアップ関数」に置き換えてあり、**Mapのカバー範囲外**（別の曜日区分、共有データ作成後に
増えた停留所）を問われたときは従来どおり個別クエリへ落ちるため、結果は個別クエリと常に一致する。
`buildPredictionContext()` が失敗した回は `context = null` のまま進み、`predictArrivals()` が
従来どおり個別クエリで動く（遅くなるだけでETA配信は止まらない）。

*残っている課題*: 候補車両ぶんも計算する点（＝割り当て数そのものが2〜3倍）と、
単一DB接続での直列処理は変えていない。ここは P-2 と同じ論点。

### P-2 `pass()` が全割り当てを単一接続で直列処理（中）

*場所*: [backend/src/services/passDetection.js](../backend/src/services/passDetection.js)（`pass()`）

割り当てごとに複数クエリ＋マッチごとに `BEGIN`/`COMMIT`。候補車両で割り当て数が2〜3倍に膨らむため、
台数が増えると1周期の所要時間が線形に伸びる。

**2026-09 追記（可視化のみ対応・単一接続での直列処理そのものは変えていない）**: `pass()` の
戻り値に `assignmentCount`（今回処理した割り当て数）・`durationMs`（ループ全体の所要時間）・
`avgMsPerAssignment`（1件あたりの平均ms）を追加した。`jobMonitor` の `pipeline.pass` の
`lastMeta` から「便あたり何ms」が見えるようになり、台数増加でどこまで遅くなっているかを
数値で追えるようになった。

単一DB接続での直列処理・マッチごとの `BEGIN`/`COMMIT` そのものは変えていない。割り当てごとの
処理を並列化するには複数のDB接続を使う設計変更が要り、1台の車両が複数便の候補になりうる
（便起点方式。[CLAUDE.md](../CLAUDE.md)）前提のもとで安全に並列化できるかの検証が別途必要なため、
既存の運行処理を壊さない範囲では見送った（P-1 の残課題に書いたとおり、P-1でも同じ理由で
単一接続のままにしてある）。

### P-3 ✅ 生ログ転記が1周期500件で頭打ち（中）— 既知 M-8 — 対応済み

*場所*: [backend/src/services/vehicleAssigner.js](../backend/src/services/vehicleAssigner.js)（`sortCarId()` / `processBatch()`）

**指摘だった状態**: `sortCarId()` は1回のクエリで最大500件しか取得せず、取得件数が500を超えると
未処理行が毎周期積み上がり、GPSが古い状態で割り当て・通過判定に使われていた。滞留していること
自体も返り値に出ないため、原因が「転記の遅れ」だと分かりにくかった。

**現在**: バッチ処理をループさせ、滞留状況を返り値に出すようにした。

- 1バッチ（最大 `BATCH_LIMIT`＝500件）を処理したあと、取得件数がLIMIT未満になるまで、または
  `MAX_BATCHES_PER_CYCLE`（既定5バッチ＝2500件）に達するまで、同一周期内で `sortCarId()` の
  中でバッチを繰り返す。次のポーリング（既定60秒後）を待たずに追いつけるため、既定の運用規模
  では実質的に頭打ちが解消する。
- 1バッチあたりの処理内容（行ごとの `BEGIN`/`COMMIT`、`getOrCreateVehicle()` の呼び出し順）は
  一切変えていない。1行の失敗が他行を巻き込まないという既存の耐障害性を保つため、
  `INSERT … SELECT FROM unnest(...)` による一括化はあえて行っていない。
- 返り値に `transferred`（転記件数）・`duplicateSkipped`（P-4対応で重複スキップした件数）・
  `batches`（実施したバッチ数）・`backlogRemains`（上限に達してもまだ残っている可能性）を
  追加した。`jobMonitor` の `pipeline.sortCarId` から見えるため、「今どれだけ滞留しているか」が
  管理画面の運用者にも分かるようになった。

*残っている課題*: `MAX_BATCHES_PER_CYCLE`（既定2500件/周期）を超える滞留は次回以降の
ポーリングに持ち越される。行ごとのトランザクションのままなので、一括`INSERT`化した場合ほどの
スループットは出ない。

### P-4 ✅ 同一測位が `vehicle_gps_log` に重複蓄積（中）— 既知 M-7 — 対応済み

*場所*: [backend/src/db/schema.sql](../backend/src/db/schema.sql)（`ux_vehicle_gps_log_vehicle_time`）、
[backend/src/services/vehicleAssigner.js](../backend/src/services/vehicleAssigner.js)（`processBatch()` の `INSERT ... ON CONFLICT`）、
[backend/src/db/migrate.js](../backend/src/db/migrate.js)（ステップ42）

**指摘だった状態**: フィード更新間隔がポーリング間隔より長いと、同じ測位が `GPS_FRESHNESS_MIN`
（15分）ぶん繰り返し `vehicle_gps_log` に挿入されていた。始発待機中・終点待機中は常時発生し、
`pass()` が重複ぶんの距離計算を毎回走らせていた。

**現在**: `(vehicle_id, gps_time_ts)` にUNIQUE制約（`ux_vehicle_gps_log_vehicle_time`）を張り、
書き込み側は `ON CONFLICT DO NOTHING` で無視する。

- 新規DBはschema.sqlが直接このUNIQUEインデックスを作る（旧・非UNIQUEの `idx_gps_log_vehicle`
  と列構成は同じなので、通常のインデックスとしての役割も引き続き果たす）。
- 既存DBはmigrate.jsのステップ42が、制約を張る前に重複行を排除する。単純に最小idだけ残すと、
  重複の後発側がたまたま `trip_gps_matches`（GPSマッチの根拠）から参照されていた場合に
  CASCADEでその行ごと失われてしまうため、**グループ内に参照されている行があればそれを残し、
  無ければ最小idを残す**規則で削除している。
- `vehicleAssigner.js` の転記処理は、重複が無視された行も含めて `vehicle_positions_raw` を
  `processed = TRUE` にする（再試行してもどのみち無視されるだけのため）。転記件数
  （`transferred`）と重複スキップ件数（`duplicateSkipped`）を分けて返す。
- `vehicle_gps_log` を参照する既存クエリ（`pass()`・`tripAssignment.js`・`finishService.js`・
  `realtimeTripLookup.js`・`/api/buses-for-map` 等）はいずれも `DISTINCT ON` や時刻範囲での
  絞り込みで、行数の重複を前提にした集計を行っていないことを確認済み。重複を挿入しなくなっても
  読み出し側の挙動は変わらない。

*残っている課題*: 制約導入前に発生していた重複はmigrate.js実行時に一度だけ排除される
（今後新たに溜まることはない）。

### P-5 ✅ パイプライン多重起動ガードの初回同時開始（低）— 対応済み

*場所*: [backend/src/jobs/scheduler.js](../backend/src/jobs/scheduler.js)（`runPipelineGuarded()`）

**指摘だった状態**: `start()` の末尾は `pipelineRunning` ガードを経由せず直接 `runPipeline()` を
呼んでいた。初回実行が `pollSeconds` を超えると、`setInterval` の1発目は `pipelineRunning` が
まだ `false`（初回実行側が一度もセットしていない）のを見て多重実行を許してしまい、
「`pipelineRunning` で二重実行を防いでいる」という前提が初回だけ成立していなかった。

**現在**: ガード込みの実行を `runPipelineGuarded()` に切り出し、`setInterval` のコールバックと
起動直後の初回実行の両方から同じ関数を呼ぶようにした。初回実行中に最初のintervalが発火しても
`pipelineRunning` が既に `true` になっているため正しくスキップされ、スキップの記録
（`jobMonitor.recordSkip('scheduler.pipeline')`）も従来どおり残る。ガードの判定条件・
`jobMonitor.track()` の呼び出し方はそのままなので、初回実行が `pollSeconds` 以内に終わるときは
従来と同じくintervalの1発目まで何も起きない。

*残っている課題*: `finishTimer`（1分間隔）・`cleanupTimer`（1時間間隔）との位相が起動時刻に
揃いやすい点自体は変えていない（[trip-lifecycle.md](trip-lifecycle.md) が指摘するとおり、
対策済みだが密度は高い）。

### P-6 ✅ 予測ログの掃除が毎周期フルスキャン気味（低）— 対応済み

*場所*: [backend/src/services/etaPredictor.js](../backend/src/services/etaPredictor.js)
（`purgeOldPredictions()`）、[backend/src/jobs/scheduler.js](../backend/src/jobs/scheduler.js)（1時間掃除タイマー）

**指摘だった状態**: `DELETE FROM trip_arrival_predictions WHERE computed_at < now() - interval
'48 hours'` を、`computeAndStoreAllArrivals()` の一部として60秒ごとに実行していた。
48時間保持のデータに対して60秒間隔の削除は過剰だった。

**現在**: 削除処理を `purgeOldPredictions()` として切り出し、`computeAndStoreAllArrivals()` からは
呼ばなくなった。呼び出し元は他の保持期間ベースの掃除（GPSログ・完了便アーカイブ・検索回数集計等）
と同じ、`scheduler.js` の1時間間隔クリーンアップタイマーに揃えた。削除条件（`computed_at < now() -
interval '48 hours'`）・削除対象は変えていない。`computeAndStoreAllArrivals()` の戻り値からは
`deleted` フィールドが無くなった（このフィールドを参照している呼び出し元が無いことを確認済み）。
CASCADE削除で大半は消えるための保険的な掃除という位置づけも変わらない。

### P-7 ✅ 観光スポット系が毎回 `SELECT *` して JS でフィルタ（低）— 対応済み

*場所*: [backend/src/services/touristSpots.js](../backend/src/services/touristSpots.js)
（`findNearbySpots()` / `searchTouristSpots()` / `boundingBoxDegrees()` / `getSpotsByIds()`）

**指摘だった状態**: `findNearbySpots` / `searchTouristSpots` はいずれも `tourist_spots` の
全列・全行を取得し、距離判定・部分一致・並び替えをJS側だけで行っていた。バス停ページ表示のたびに、
サジェストのキーストロークごとに走る。

**現在**: 拡張（`earthdistance` / `pg_trgm`）は追加せず、素のSQLで候補を絞り込む形にした。

- `findNearbySpots`: 中心座標から半径を内包する緯度経度の矩形（BBox）を `boundingBoxDegrees()`
  で求め、`WHERE lat BETWEEN … AND lng BETWEEN …` でDB側から候補を絞ってから取得する。矩形は
  指定半径の円を必ず内包するため取りこぼしは無く、正確な距離判定（haversine）・並び替え・
  件数の絞り込みはこれまでどおりJS側で行う。結果は全件取得していたときと同一になる。
- `searchTouristSpots`: まずスコアリングに必要な列（`id, name, kana, romaji`）だけを取得して
  一致度を判定し、上位`limit`件が確定してから `getSpotsByIds()` で該当分だけ全列を取得する。
  写真URL・和文/英文の説明文といった重い列を、キーストロークのたびに全件ぶん転送しなくなった。
  スコアリングのロジック・優先順位（前方一致→部分一致→名称の五十音順）・結果の並び順は
  一切変えていない。
- `spotSearch.js` 側（`searchRoutes()` 等）はもともと必要な列だけを選択しており対象外。

*残っている課題*: 観光スポット件数が非常に多くなった場合、`findNearbySpots` のBBox判定・
`searchTouristSpots` の1回目の取得はいずれも `tourist_spots` 自体のテーブルスキャンを伴う
（インデックスを使った絞り込みではない）。現状の登録件数では実害はなく、より大きな効果を
狙うなら `earthdistance` / `pg_trgm` 拡張の導入が引き続き選択肢として残る。

---

## 4. GTFS取り込み・当日便生成

### G-1 ✅ 内容不変でも毎時 `seed()` が全マスタ書き換え（高）— 対応済み（旧 既知 H-6）

*場所*: [backend/src/services/gtfsFeedManager.js](../backend/src/services/gtfsFeedManager.js)
（`downloadAndExtractGtfsFeed` / `commitFeedFingerprint` / `updateAllGtfsFeeds`）、
[backend/src/db/seed.js](../backend/src/db/seed.js)（`alignTripIndexesByGtfsTripId`）

**指摘だった状態**:

- ダウンロード成功＝内容変更とみなしており、ETag / Last-Modified / 内容ハッシュの比較がない。
  同じZIPでも毎時 `seed()` が走り、全 `stops`・全 `schedule_stop_times` を UPDATE。
- `schedule_trips` の一意キー `(route_id, direction_id, service_id, trip_index)` の `trip_index` は
  **trips.txt 内の並び順依存**。ダイヤ改正で便が1本増減すると以降の便が全部ずれ、
  `ON CONFLICT` で既存行が別便の内容に更新される。
- GTFSから消えた `schedule_trips` は削除されない。
- 毎デプロイでも（`lastGtfsUpdateAt` がプロセス内変数のため）フル再ダウンロード＋`seed()`。

**現在（1）内容が変わったときだけ展開・`seed()` する**

`feeds` に `content_hash`（ZIP本体のSHA-256）・`last_etag`・`last_modified` を持たせ、
`downloadAndExtractGtfsFeed()` が2段構えで「内容不変」を判定する。

1. 条件付きGET（`If-None-Match` / `If-Modified-Since`）で **304** が返ればダウンロード本体も起きない。
2. 配信元が条件付きGETに対応していなくても、ダウンロードしたZIPのSHA-256が前回と一致すれば
   展開をスキップする。

戻り値は `{ ok, changed, fingerprint }` で、`updateAllGtfsFeeds()` は **`changed` が1件も無ければ
`seed()` を呼ばない**。プロセス内変数ではなくDBに指紋を持つので、デプロイ直後の初回実行でも
内容が同じなら `seed()` は走らない。

安全側の作りが2つある。

- **指紋の確定は `seed()` が成功した後**（`commitFeedFingerprint()`）。ダウンロード直後に書くと、
  `seed()` が失敗した回の指紋が残って以降ずっと「内容不変」と判定され、DBが古いまま固定される。
- **スキップ判定は必須ファイルがディスク上に揃っているときだけ**行う。ファイルが欠けている状態
  （コンテナ再作成直後など）でスキップすると、時刻表インデックスが復旧できないまま固定される。
  同じ理由で `ensureGtfsFilesPresent()`（欠損の復旧）と管理画面の手動再取得は `force: true` で
  判定を素通りし、従来どおり必ず展開・再投入する。

**現在（2）ダイヤ改正で便がずれない**

`seed.js` の `alignTripIndexesByGtfsTripId()` が、UPSERTの前に既存行を `gtfs_trip_id` 基準で
今回の並びへ整列させる。グループ内の全行をいったん `trip_index = -id`（必ず負・必ず一意）へ退避し、
今回のGTFSにも居る便を行き先のインデックスへ、消えた便を今回の便数より後ろの空き番号へ割り当て直す。
これでUPSERTは必ず「同じ `gtfs_trip_id` の行」に当たり、`daily_trips.schedule_trip_id` が指す先も
ずれない。並びに変化が無ければ1行も書かずに戻る。

一意キー自体を `(route_id, gtfs_trip_id)` へ移す案は採らなかった。既存DBには過去のズレで
`gtfs_trip_id` が重複した行が残っていることがあり、制約追加のために消そうとすると
`completed_trips.trip_id`（CASCADE無しの外部キー）に阻まれるか、アーカイブ済みの運行実績を
巻き添えにするため。整列で同じ結果が得られ、スキーマ変更も削除も不要。

*残っている課題*: GTFSから消えた便の `schedule_trips` 行は**削除せず後ろへ退避するだけ**
（上記の外部キーの理由）。その `service_id` が現役のままだと、`dailyTripBuilder` が
その行からも当日便を生成してしまう（実在しない便が時刻表に出る）。これは known-issues.md 側に
残してある。また `seed()` はフィード単位ではなく全フィード一括のままで、1フィードだけ変わった回でも
他フィードぶんのUPSERTは走る（G-2 で導入したアドバイザリロックも `seed()` 全体を対象とする
粗い粒度で、フィード単位に分けてはいない。細分化するならこの点と併せて検討する範囲）。

### G-2 ✅ `seed()` に排他制御がない（高・新規）— 対応済み

*場所*: [backend/src/db/seed.js](../backend/src/db/seed.js)（`seed()`）、[backend/src/services/gtfsFeedManager.js](../backend/src/services/gtfsFeedManager.js)（`updateAllGtfsFeeds()`）、[backend/src/routes/api.js](../backend/src/routes/api.js)（`POST /api/admin/gtfs-feeds/:feedId/refetch`）

**指摘だった状態**: `seed()` は (1) パイプライン⓪の `updateAllGtfsFeeds()` 成功時、(2) 管理画面
`POST /api/admin/gtfs-feeds/:feedId/refetch` 成功時、の2経路から**別接続で**呼ばれる。
`pipelineRunning` ガードは (2) をカバーしない。両者が同時に `stops` / `schedule_trips` /
`schedule_stop_times` へ大量 UPSERT すると、route ごとのロック取得順の違いでデッドロックしうる
（→片方 ROLLBACK＝そのGTFS更新が黙って失敗、次周期リトライ）。

**現在**: `seed()` 冒頭、`BEGIN` の直後で `pg_advisory_xact_lock()`（トランザクション単位の
アドバイザリロック）を取得してから本体の処理に入るようにした。

- 呼び出し経路・呼び出し側のコード（`gtfsFeedManager.js`・`api.js`）は一切変えていない。
  ロックは `seed()` 内部だけで完結するため、どちらの経路から呼んでも自動的に直列化される。
- ロックの解放は `pg_advisory_xact_lock` の仕様どおり `COMMIT` / `ROLLBACK` に伴って自動で行われる
  （明示的な `unlock` は不要、かつ既存の `try/catch/finally` の構造どおり `seed()` は必ず
  `COMMIT` か `ROLLBACK` で終わるため解放漏れも起きない）。
- 先行者がいない通常時（実際にはほぼ全ての実行）はロック取得が即座に成立するため、
  所要時間・挙動は従来と変わらない。もう一方の経路が同時に走っていたときだけ、
  先行する `seed()` の完了までブロックしてから直列に実行される（＝デッドロック・部分適用の代わりに、
  両方とも成功する）。
- `SET LOCAL lock_timeout = '30s'` を添えてある。先行の `seed()` が何らかの理由で
  長時間戻らない場合に無期限待ちでコネクションプールを圧迫しないための保険で、
  タイムアウト時は通常のクエリ失敗と同様にエラーを投げるだけなので、
  呼び出し側の既存の `catch` がそのまま処理する（新しい分岐は増やしていない）。

*残っている課題*: `seed()` はフィード単位ではなく全フィード一括のままで、直列化しても
1フィードだけ変わった回に他フィードぶんのUPSERTも走る点は変わらない（G-1 の残課題と同根）。

### G-3 GTFSファイル差し替え中にインデックス構築が失敗しうる（高）— 既知 H-5

*場所*: [backend/src/services/gtfsFeedManager.js:168-192](../backend/src/services/gtfsFeedManager.js#L168-L192)

「既存ファイルを退避 → 新ファイルを配置」の2段階で、その間フィードディレクトリに必須ファイルが
無い時間帯が生まれる。`gtfsTimetable` / `gtfsCalendar` / `gtfsFare` の再構築がこの窓に走ると
`readCsv()` が ENOENT で throw し、時刻表・経路・バス停検索が500。
併せて B-1（当日便生成のロックアウト）も引き起こす。
**別名ディレクトリに展開してディレクトリごと1回の rename で切り替える**のが定石。

### G-4 ✅ `stops` / `schedule_stop_times` の孤児行が reseed で溜まる（中・新規）— 対応済み

*場所*: [backend/src/db/seed.js](../backend/src/db/seed.js)（`seedStopsAndTimetable()`）

**指摘だった状態**:

- `stops` は `ON CONFLICT (route_id, direction_id, gtfs_stop_id, occurrence) DO UPDATE` のみで、
  GTFSから消えたバス停・`occurrence` が変わったバス停の**古い行を削除しない**。
  `seq_order`（表示順）も古い値が残りうる。
- `schedule_stop_times` も `ON CONFLICT (trip_id, stop_id) DO UPDATE` のみ。
  ある便の停車パターンが変わって通らなくなったバス停の行が残る。
  `dailyTripBuilder.loadScheduleTrips` はこの（古い行を含む）テーブルを読むため、
  当日便に幽霊バス停が混入しうる（`replaceStopTimes` は daily 側しか DELETE しない）。
- なお G-1 の対応で「便そのものがずれる」経路は塞がったが、**便の中の停車パターンの残骸**は
  この G-4 の範囲でそのまま残っていた（`schedule_stop_times` は `gtfs_trip_id` で整列させても
  古い `(trip_id, stop_id)` の行が消えないため）。

**現在**: 指摘どおり、`seed()` 内で「今回のGTFSに存在しない行を DELETE」する方向で対応した。
テーブル洗い替えではなく、既存のUPSERT処理に掃除を1クエリずつ追加する形にしてある
（洗い替えだと一時的に空になる窓ができ、G-3 と同種の「その瞬間に読むと消える」問題を
新たに持ち込むため）。

- **`schedule_stop_times`**: 便ごとのUPSERTループで、その便が今回実際に使った `stop_id` を
  集めておき、ループの直後に `DELETE FROM schedule_stop_times WHERE trip_id = $1 AND NOT (stop_id = ANY($2))`
  を実行する。停車パターンが変わって通らなくなったバス停の行はこの1クエリで消える。
  `trip_id` は `schedule_trips` に `ON DELETE CASCADE` で従属し、`schedule_stop_times` 自体を
  参照する他テーブルは無い（外部キーの向きは常に `schedule_stop_times → schedule_trips` /
  `schedule_stop_times → stops`）ため、削除しても実績・進行中データを一切巻き込まない。
- **`stops`**: 方向（route_id, direction_id）単位でのUPSERTが終わった時点で、今回どの便からも
  使われなかった `stops` 行を掃除する。ただし `stops.id` は `daily_trip_stop_times` /
  `trip_stop_progress` / `trip_gps_matches` / `completed_trip_stop_times` /
  `segment_travel_stats`（`from_stop_id`・`to_stop_id`）/ `daily_trips`（`start_stop_id`）から
  `ON DELETE CASCADE` 無しで参照されているため、**これらのいずれかに現に参照されている行は
  `NOT EXISTS` で除外**し、削除対象を「今回使われず、かつどこからも参照が残っていない」行だけに
  限定した。これにより、当日便・進行中の割り当て・保持期間内の実績・区間統計を誤って
  巻き込んでFK違反で `seed()` 全体を失敗させる（ROLLBACKで今回の更新自体が丸ごと消える）
  事故を構造的に防いでいる。実際にどこかから参照されている行は次回以降の `seed()` でも
  同じ理由でスキップされ続けるので、保持期間切れ等で参照が無くなった時点で自然に掃除される。
- 掃除件数は `[seed] ... 停車パターンの残骸 N 件・不要になったバス停 N 件を登録しました。
  （掃除も実施）` として、既存の登録件数ログに追記する形で出す（何も掃除しなかった回は
  従来どおりのログのまま）。
- **既存の呼び出し経路・関数シグネチャは一切変えていない。** `seedStopsAndTimetable()` の
  UPSERTループの中に削除クエリを追加しただけで、`alignTripIndexesByGtfsTripId()` や
  `stops`/`schedule_trips` のUPSERT本体・呼び出し順序は変更していない。
- 開発環境の実DB（GTFS 2フィード・34路線）に対し、(1) 変更が無い状態での再実行で
  掃除件数が0件のまま既存の登録件数（停留所・時刻表便数）が変わらないこと、
  (2) 意図的に挿入した「本来存在しない `(trip_id, stop_id)` 行」「どこからも参照されていない
  孤児 `stops` 行」が次回の `seed()` 実行で過不足なく削除されること、
  (3) `daily_trip_stop_times` から現に参照されている `stops` 行には同じ削除条件を適用しても
  1件も削除されないこと、をそれぞれ確認済み。`backend/test/` のテストはDB非依存の純粋関数
  だけを対象にしているため（[CLAUDE.md](../CLAUDE.md)参照）、この確認は自動テストではなく
  上記の手動検証によるもの。

*残っている課題*:

- 掃除は「route_id・direction_id がまだ現在のGTFSに存在する」場合の中身（停車パターン・
  個々のバス停）だけを対象にしている。**路線ごと・方向ごと丸ごとGTFSから消えた**場合
  （`directionServiceTrips.length === 0` でループ自体に入らないケース）は対象外で、
  G-1 の残課題（消えた `service_id` が現役のままだと幽霊便が残る）と同種の別問題として
  known-issues.md 側に残る。
- `stops` の削除は「今回どこからも参照されていない」行に限られるため、保持期間内の実績
  （`completed_trip_stop_times` 等）が残っている間はGTFSから消えたバス停でも `stops` 行自体は
  残り続ける（削除されないだけで、実害はない）。

### G-5 ✅ `data gtfs/` が永続ボリュームでなく再作成で巻き戻る（低）— 既知 L-10 — 対応済み

*場所*: [docker-compose.yml](../docker-compose.yml)（`backend` の `gtfs_data` ボリューム）

**指摘だった状態**: コンテナ再作成でイメージ内の古いGTFS（リポジトリにコミット済みの版）に巻き戻り、
`ensureGtfsFilesPresent()` はファイルの有無しか見ないので再取得も走らず、デプロイ直後は最大1時間
ダイヤ改正前のGTFSで当日便が生成されていた。

**現在**: `backend` サービスに名前付きボリューム `gtfs_data` を `/app/data gtfs` へマウントした（D-5）。
コンテナを作り直しても、最後に取得したGTFSがボリュームに残る。

- ボリュームは初回作成時にイメージの内容（`Dockerfile` の `COPY ["data gtfs", "data gtfs"]`）で
  初期化されるため、**初めての起動時の挙動は従来と同じ**。
- 以降はパイプラインが毎時 `updateAllGtfsFeeds()` で最新へ更新し、内容が変われば `seed()` が走る。
- ボリュームを削除しても、`seed()` 冒頭の `ensureGtfsFilesPresent()` が欠損フィードを再取得するため
  自己復旧する。

*残っている課題*: イメージ同梱GTFSを更新して再デプロイしても、既存ボリュームには反映されない
（ライブのフィード取得で1時間以内に最新化されるため実害はない）。GTFSファイル差し替え中に
インデックス構築が失敗しうる問題（G-3 / 既知 H-5）は別。

### G-6 ✅ 有効フィード0件時に更新間隔の記録が更新されない（低）— 既知 L-9 — 対応済み

*場所*: [backend/src/services/gtfsFeedManager.js](../backend/src/services/gtfsFeedManager.js)（`updateAllGtfsFeeds()`）

**指摘だった状態**: `updateAllGtfsFeeds()` の「有効フィード0件」の早期リターンが
`lastGtfsUpdateAt = now`（関数末尾）より前にあり、しかも `pool.connect()` の**後ろ**にあった。
全GTFSフィードを `enabled: false`（`config/feeds.js`）にすると、`lastGtfsUpdateAt` が 0 のまま
更新されないため冒頭の更新間隔チェック（`lastGtfsUpdateAt > 0` が条件）が毎回素通りし、
パイプラインのポーリング（既定60秒）のたびに **DB接続の取得・解放とログ出力だけ**が空回りしていた。

**現在**: 有効フィードの判定を `pool.connect()` の**前**へ移し、0件の経路でも
`lastGtfsUpdateAt = now` を記録してから抜けるようにした。

- 有効フィードが0件なら**DB接続を一切取らない**（`getEnabledGtfsFeeds()` は `config/feeds.js` の
  コード定数を読むだけでDBに触れないため、`try` の外へ出しても失敗経路は増えない）。
- `lastGtfsUpdateAt` を進めるので、2回目以降は冒頭の更新間隔チェックで弾かれ、
  `GTFS_UPDATE_INTERVAL_MIN`（既定60分）の間はログも接続取得も走らない。
- **フィードが1件でも有効な通常構成では挙動は一切変わらない。** `getEnabledGtfsFeeds()` の
  呼び出し位置が `pool.connect()` の直前へ動いただけで、フィードごとの
  `downloadAndExtractGtfsFeed()` 呼び出し・`seed()` 起動条件・戻り値（`updated` /
  `unchanged` / `failed`）はそのまま。
- あわせて戻り値の形を3つの `return` で揃えた（更新間隔スキップ時に欠けていた `unchanged: 0`、
  0件時に欠けていた `skipped: false` を補完）。`jobMonitor` の `lastMeta` として保持されるだけで
  読み出し側は無く、表示への影響はない。

known-issues.md L-9 は本項の解消により削除した。

*残っている課題*: `GTFS_UPDATE_INTERVAL_MIN` を 0 以下（＝毎周期更新）にしている場合は、
冒頭の間隔チェック自体が無効なので0件時のログは毎周期出る。ただしDB接続の取得は無くなっており、
「毎周期更新」を明示的に選んでいる設定なのでログ出力は想定内。

---

## 5. API層

### A-1 ✅ `require.main` ガードなしの `migrate.js`（中）— 既知 M-16 — 対応済み

*場所*: [backend/src/db/migrate.js](../backend/src/db/migrate.js)

**指摘だった状態**:

```js
migrate().then(() => { ... process.exit(0); }).catch(() => process.exit(1));
module.exports = { migrate };
```

`module.exports` しているのに、`require('./db/migrate')` しただけで DDL 実行 → `process.exit()`。
誰かがインポートした瞬間にサーバープロセスが黙って落ちる。`seed.js` は
`if (require.main === module)` で正しくガードしており、パターンが不統一。

**現在**: `seed.js` と同じ `if (require.main === module) { migrate().then(...).catch(...); }` に揃えた。
`migrate.js` は `npm run db:init`（`node src/db/migrate.js`）と `docker-entrypoint.sh` の
`until node src/db/migrate.js; do ...`からしか呼ばれておらず、いずれも直接スクリプト実行
（`require.main === module` が真）なので、この2経路の挙動は変わらない。`require('./db/migrate')`
でモジュールとして読み込んだ場合に `migrate()` が実行されず `process.exit()` もされなくなる点だけが変わる。

*残っている課題*: 無し。

### A-2 ✅ `routeId` 省略時のデフォルトが単一路線に固定（中・新規）— 対応済み

*場所*: [backend/src/services/gtfsData.js](../backend/src/services/gtfsData.js)（`resolveRouteId`）、[backend/src/routes/api.js](../backend/src/routes/api.js)（`GET /stops`・`GET /timetable`・`GET /buses`）

**指摘だった状態**:

```js
function resolveRouteId(routeId) {
  if (!routeId) return 'guruttomatsumotobus1:11';   // 横田信大循環線に固定
  return EXTERNAL_ROUTE_ID_ALIASES[routeId] || routeId;
}
```

`/api/settings`・`/api/timetable`・`/api/buses` は `routeId` 未指定だと**黙って路線11のデータ**を返す。
約40路線を扱うシステムで、旧単一路線時代のデフォルトが残っている。外部API利用者・
テスト・将来のクライアントがハマる。

**現在**: `resolveRouteId()` は `routeId` 省略時に特定路線へ決め打ちするのをやめ、**`null` を返す**
だけにした。呼び出し側で「routeId必須」か「routeId無し＝全路線共通」かを明示させる。

- **`GET /api/stops`・`GET /api/timetable`・`GET /api/buses`**: `routeId` 未指定（＝`resolveRouteId()`
  が `null` を返す）なら **400** を返すようにした。この3エンドポイントは特定路線のバス停・時刻表・
  運行状況を返すものなので、路線が決まらないと本来レスポンスの意味を成さない。現在のフロントエンド
  （`frontend/app.js`）はいずれも `routeId` を必ず付けて呼んでおり、この3エンドポイントを
  `routeId` 無しで叩いている内部コードは無いため、既存の呼び出しへの影響はない。
- **`GET /api/settings`・`GET /api/admin/settings`**: お知らせ・重要なお知らせは全路線共通のデータで、
  `routeId` はもともと表示用の路線名解決にしか使っていない。ホーム画面の `loadNotices()` や
  管理画面「お知らせ編集」はいずれも `routeId` を付けずに呼ぶ設計のため、こちらは**引き続き省略可能**
  のままにした（`routeId` 必須化は誤り）。省略時は `resolveRouteId()` が `null` を返し、
  `loadSystemSettings()` 内の `routes` 参照が単に該当なしになるだけで、路線名は
  `system_settings.route_name`（管理画面の保存値）へのフォールバックがそのまま効くため、
  レスポンスの見え方は変わらない。
- `EXTERNAL_ROUTE_ID_ALIASES` のULIDエイリアス（特定のULIDを路線11のroute_idへ変換する対応表）は
  「`routeId`省略時の決め打ち」とは別の機能（明示的にそのULIDを渡してきた場合の変換）なので、
  今回は変更していない。

*残っている課題*: 無し。回帰テスト（`npm test`）は全件通過を確認済み。

### A-3 ✅ `/api/buses` が1台ごとに複数クエリ（N+1、ホットパス）（中・新規）— 対応済み

*場所*: [backend/src/routes/api.js](../backend/src/routes/api.js)（`GET /buses`）、[backend/src/services/realtimeTripLookup.js](../backend/src/services/realtimeTripLookup.js)（`buildBusEntry` / `buildBusEntriesBatch`）

**指摘だった状態**: `buildBusEntry()` は1台につき `trip_stop_progress` / 最新GPS /
`trip_arrival_predictions` の3クエリを発行し、それを `/api/buses` のループで台数ぶん回していた。
全クライアントが20秒間隔でポーリングする画面なので、ピーク時のDB負荷が台数×クライアント数に比例する。

**現在**: `realtimeTripLookup.js` に `buildBusEntriesBatch(trips, routeId, routeName)` を追加し、
`/api/buses` はこちらを使うようにした。

- 3クエリはそれぞれ `assignment_id` / `vehicle_id` の配列に対して `= ANY($1::int[])` で
  まとめて1回ずつ発行し（`Promise.all` で並列化）、JS側で `assignment_id` ごとに
  グルーピングしてから `buildBusEntry()` と同じ形の配列を組み立てる。台数によらず
  1リクエストあたり常に3クエリになる。
- 各クエリの `SELECT` 列・`WHERE`・`ORDER BY` は `buildBusEntry()` の個別クエリと同一で、
  `ANY()` に展開しただけ。停車進捗の組み立てロジック（到着予測とのマージ等）も
  そのまま流用しているため、返す `stops[]` の内容は1件ずつ呼んでいた場合と一致する。
- **`buildBusEntry()` 自体は変更していない。** 1台だけを引く他の呼び出し元
  （`busStopApproaching.js`・`gtfsRouteSearch.js`・便詳細ページの単発リアルタイム切替）は
  N=1なのでN+1問題が起きず、バッチ化する意味もないため、そのまま残してある。

*残っている課題*: 候補車両ぶんの計算（P-1と同根）や、`/api/buses-for-map` 側の別クエリは
対象外。

### A-4 ✅ `/api/buses` がリクエストごとに `console.log`（低・新規）— 対応済み

*場所*: [backend/src/routes/api.js](../backend/src/routes/api.js)（`GET /buses`）

**指摘だった状態**:

```js
console.log(`[api /buses] routeId=${routeId}, allGps=${includeAllGps}, trips=${trips.rows.length}`);
```

20秒ポーリング×クライアント数ぶんログが出る。`[pass]` `[locationFetcher]` `[tripAssignment]` なども
`console.log` 直書きで、ログレベルの概念がない。

**現在**: この1行（`/api/buses` のリクエストごとに出る唯一のログ）を削除した。
パイプライン各工程の `console.log`（`[pass]` `[locationFetcher]` `[tripAssignment]` 等）は
周期ジョブの完了報告で、1周期（既定60秒）に1回しか出ないためログ量の問題にならず、
このドキュメントでは対象にしていない（そのまま）。

*残っている課題*: 「ログレベルの概念がない」こと自体（構造化ログ＋レベル制御、例えば `pino`
の導入）はプロジェクト全体の構成に関わる変更のため、今回はスコープ外。

### A-5 ✅ SPA フォールバックが未知パスに 200 を返す（低・新規）— 対応済み

*場所*: [backend/src/server.js](../backend/src/server.js)

**指摘だった状態**: `app.get('*')` が `/api` 以外の未知パスすべてに `index.html` を 200 で返す。
存在しないURLが 200 になるため、監視・SEO・404計測が機能しない。
未知の `/api/*` は Express デフォルトの 404 HTML（JSONではない）が返り、APIクライアントが混乱する。

**現在**: 2点とも直した。

- `app.get('*')` は、パスルーティングのSPA画面（`frontend/*.js` の `isXxxPath()` が受理する
  パスと同一に保ってある `/timetable`・`/busstop`・`/routesearch`（配下含む）と
  `/`・`/stopmap`・`/spotsearch`（完全一致）だけを `index.html` で返すようにし、
  それ以外は `next()` して本物の404（`Not Found`）に落ちるようにした。既存の `/admin`・
  `/admin.html`・`/servicestatus`・`/servicestatus.html`・`/howto`・`/howto.html`
  （個別の `app.get()`）や、`express.static` が処理する静的ファイル（`app.js`・`style.css`・
  `vendor/`・`manifest.json`・`sw.js`・アイコン等）は元々この関数より前で処理されるため無関係。
- `app.use('/api', apiRouter)` の直後に `app.use('/api', (req, res) => res.status(404).json(...))`
  を追加した。`apiRouter` 内のどのルートにも一致しなかった `/api/*` だけがここに落ちる
  （既存の `/api/*` ルートは変わらず先にマッチする）ので、未知の `/api/*` が
  Express既定のHTML 404ではなくJSONの404を返すようになった。

*残っている課題*: 無し。回帰テスト（`npm test`）は全件通過を確認済み。

### A-6 ✅ 運行実績エクスポートの `LIMIT 200000` サイレント打ち切り（低）— 対応済み

*場所*: [backend/src/routes/api.js](../backend/src/routes/api.js)（`GET /admin/operation-records/export`）、[frontend/admin-operation-records.js](../frontend/admin-operation-records.js)

**指摘だった状態**: 期間内の `completed_trip_stop_times` 行数が20万を超えると無言で切れる。

**現在**: クエリを `LIMIT 200001`（上限+1件）に変え、201件目が返ってきたかどうかで
打ち切りの有無を判定してから、出力は従来どおり先頭20万件に切り詰める（＝出力される
データ自体は変えていない）。打ち切りが起きた回だけ、

- レスポンスヘッダー `X-Export-Truncated: true`（打ち切りが無い回は `false`）と、
- CSV末尾に「※ 200,000行の上限に達したため、これ以降のデータは含まれていません。期間や
  路線を絞って再度ダウンロードしてください。」という注記行（既存の `csvEscape()` を
  そのまま通す）

を付け加える。管理画面「運行実績ダウンロード」（`admin-operation-records.js`）は
このヘッダーを見て、打ち切られた回だけダウンロード完了メッセージの文言と色を変える
（打ち切りが無い回の見た目・文言は従来どおり）。

*残っている課題*: ストリーミング出力への変更は行っていない（20万行程度はメモリ上に
持っても実害が小さいという既存実装の判断を踏襲）。

---

## 6. フロントエンド

### F-1 ✅ 初期 `selectedRouteId = '11'`（未修飾）で初回描画が空（低）— 既知 L-4 — 対応済み

*場所*: [frontend/app.js](../frontend/app.js)（`selectedRouteId` の初期値、`syncRouteSelector()` のフォールバック）、[frontend/index.html](../frontend/index.html)（路線セレクタの既定オプション）

**指摘だった状態**: DBの `route_id` は `guruttomatsumotobus1:11` 形式。路線一覧取得後に補正されるが、
それ以前の `loadAll()` は素の `'11'` で叩き、一瞬「バスがありません」。`index.html` の
`<option value="11">横田信大循環線</option>` も同じ遺物。

**現在**: 未修飾の `'11'` を使っていた3箇所（`selectedRouteId` の初期値、`/api/routes` 取得失敗時に
`syncRouteSelector()` が組み立てるフォールバックの `<option>`、`index.html` の既定 `<option>`）を、
実際にDBが使う修飾済み `route_id`（`guruttomatsumotobus1:11`）に揃えた。`/api/routes` 取得成功後は
従来どおり実際の路線一覧で上書きされるため、通常時の見え方は変わらない。効果があるのは
「補正が入る前」「`/api/routes` が失敗して補正できない」場合で、いずれも `/api/buses`・`/api/timetable`
への最初のリクエストが実在する `route_id` と一致するようになり、初回描画で一瞬「バスがありません」に
なる窓が無くなる。値の置き換えのみでロジックは変えていないため、既存の挙動への影響はない。

### F-2 負荷チェックのポーリング自体が閲覧数を押し上げる（低）— 既知 L-8

*場所*: [frontend/app.js:1298-1300](../frontend/app.js#L1298-L1300)、[backend/src/routes/api.js:109-115](../backend/src/routes/api.js#L109-L115)

`checkServerLoad` は画面・可視状態によらず20秒ごとに `/api/server-load` を叩き、
そのリクエストが `X-Client-Id` 付きで**閲覧数としてカウントされる**。負荷判定のための通信が
負荷指標を作る。`/api/server-load` をカウント除外し、`document.visibilityState !== 'visible'` で停止。

### F-3 Tailwind がブラウザ内コンパイルのままで初期描画が重い（中）— S-6 で一部対応済み・静的CSS化は見送り

→ S-6 参照。Tailwind・Leaflet を `frontend/vendor/` へ同梱したことで、
**CDN依存・SRIなし・オフライン耐性ゼロ**（バス停でモバイル回線が細いときに外部CDNが読めないと真っ白）は解消した。

残るのは**Play CDN版のブラウザ内コンパイル**そのもの。約400KBのJSを読み、毎回ブラウザ内でCSSを生成するため、
初期描画のちらつきと遅さは同梱後も変わらない。解消には Tailwind CLI でビルドした静的CSSへの置き換えが要る。

**2026-09 追記（調査のみ・コードは変更していない）**: 「動的に組み立てたクラス名の取りこぼし」の
実際のリスクを調査した。`frontend/*.js` を対象に `(bg|text|border|from|to|via|ring|divide|fill|
stroke|w|h|p|m|rounded|shadow)-${` のようなTailwindユーティリティ接頭辞に続けてテンプレート
リテラルの変数展開が来るパターンを全ファイル検索したが、該当は無かった。路線カラー
（`routeColorStyle()`／`busstop.js`・`routesearch.js`・`timetable.js`）も Tailwind クラスではなく
`style="background:...;color:..."` のインラインスタイルで表現しており、クラス名の動的合成には
依存していない。**つまり静的CSS化そのものの技術的リスクは低いと確認できた。**

それでも今回は静的CSS化を**見送った**。理由は技術リスクではなく、
[CLAUDE.md](../CLAUDE.md) が明言する「素のHTML/CSS/JS、ビルドステップなし」という
このプロジェクトの前提に関わる判断だからである。Tailwind CLI での静的CSS化は、
今後 Tailwind のクラスを1つ追加・変更するたびに「再ビルドしてvendor配下のCSSへコミットし直す」
手順が**恒久的に**必要になることを意味する。CIも無い（T-2）この構成では、手順を1回忘れるだけで
「そのクラスだけ黙ってスタイルが当たらない」という、今回調べた取りこぼしリスクよりもさらに
気づきにくい形の不具合を将来にわたって作り込み続けることになる。ビルド工程の要否は
プロジェクトの開発フロー全体に関わる判断のため、コードを変更せずここに記録するにとどめる。

### F-4 ✅ PWA / Service Worker がない（中・新規）— 対応済み

*場所*: [frontend/manifest.json](../frontend/manifest.json)（新規）、[frontend/sw.js](../frontend/sw.js)（新規）、[frontend/icons/icon.svg](../frontend/icons/icon.svg)（新規）、[frontend/index.html](../frontend/index.html)（`<link rel="manifest">` 等）、[frontend/app.js](../frontend/app.js)（登録処理）

**指摘だった状態**: `manifest.json` / `sw.js` が無く、ホーム画面追加もオフラインキャッシュも
できなかった。`theme-color` と viewport は設定済みだった。

**現在**: 「ホーム画面に追加できる」ことと「電波が無いときに真っ白にならない」ことの2点だけに
範囲を絞って追加した。**「圏外でも直前の時刻表を表示」のようなAPIレスポンスのオフラインキャッシュは
意図的にやっていない**（下記）。

- `manifest.json` を新設し、`index.html` に `<link rel="manifest">` を追加した。アイコンは
  既存のfavicon（インラインSVG）と同じ絵柄を `frontend/icons/icon.svg` として書き出して再利用
  （見た目は変えていない）。iOS Safari は Web Manifest のアイコンを見ないため、
  `<link rel="apple-touch-icon">` も別途追加した。
- `sw.js` を新設し、`app.js` 末尾で `navigator.serviceWorker.register('/sw.js')` を呼ぶ
  （非対応ブラウザ・登録失敗は `catch` で握りつぶすだけで、既存の動作には一切影響しない）。
  キャッシュ方針は2点に絞った。
  1. **`/api/` 配下は一切インターセプトしない。** バスの位置・遅延・時刻表APIをキャッシュすると
     「古い運行情報を今の情報として見せる」事故になるため、常にネットワークへ直接通す。
  2. **静的ファイル（HTML/CSS/JS/vendor）はネットワーク優先。** このプロジェクトはJS/CSSの
     ファイル名にハッシュを付けていないため、キャッシュ優先にすると**デプロイ後も利用者が
     古いapp.js等を見続ける**事故になる。オンライン時は必ずネットワークから取得して
     キャッシュを上書きし、SWが効くのは「ネットワーク取得に失敗したとき（＝オフライン）」だけ。
     クロスオリジンのリクエスト（Googleフォント・OSMタイル）もSWを通さない。
- キャッシュ対象は `index.html` が読み込む静的ファイル一式（`style.css`・vendor2本・
  画面別JS・`manifest.json`・アイコン）に限定し、`admin.html` 等の管理画面は対象にしていない
  （オフライン対応が要るのは利用者向け画面だけのため）。

**2026-09 追記（バグ修正）**: 上記の「対象にしていない」はSHELL_URLSの事前キャッシュに
限った話で、`fetch`ハンドラ自体は`/admin`宛のリクエストも素通りせずインターセプトしていた。
SWは`app.js`（利用者向けトップページ）が`navigator.serviceWorker.register('/sw.js')`を
呼んだ時点でオリジン全体（スコープ`/`）を制御下に置くため、一度でも公開画面を開いたブラウザは
その後`/admin`への遷移もこのSWを経由する。ネットワーク取得（`fetch(req)`）が失敗すると
`caches.match(req)`→`caches.match('/')`の順にフォールバックするが、`admin.html`は
SHELL_URLSに無く一度も自分自身としてキャッシュされないため、必ず後者（トップページの
キャッシュ）に落ちる。結果、バックエンド再起動や一時的な接続断のたびに、**URLバーは
`/admin`のままなのに中身と`<title>`だけ公開トップページに差し替わる**という事故が起きていた
（管理者から見ると「管理画面にアクセスしてもトップページしか表示されない」）。
`fetch`ハンドラの先頭で`/admin`・`/admin.html`・`/admin.css`・`/admin-*.js`を素通り
（`return`）させ、管理画面関連のリクエストはSWを経由しない従来どおりの素のネットワーク
フェッチに戻した。失敗時はブラウザ標準のオフラインエラーが出るだけになり、誤って別画面の
内容が表示されることはなくなる。

*残っている課題*: 「圏外でも直前の時刻表を表示」（レビュー原文の期待）は今回のスコープ外。
`trip_arrival_predictions`・時刻表APIのレスポンスをオフラインでも出すには、鮮度表示
（X-3）とセットで別途設計が要る（生半可にキャッシュすると誤情報を配信するリスクの方が大きい）。
Web Push（I-2/X-5）も別課題。

### F-5 Google Fonts への外部依存（低）

*場所*: [frontend/index.html:11](../frontend/index.html#L11)

`fonts.googleapis.com` にブロッキングで依存し、利用者IPがGoogleに渡る。
フォントをセルフホスト（`font-display: swap` 付き）に。

### F-6 ✅ モーダル制御が `style.display` 直操作（低）— 対応済み

*場所*: [frontend/app.js](../frontend/app.js)（`openModal` / `closeModal`）、[frontend/style.css](../frontend/style.css)（`.modal-hidden`）、[frontend/index.html](../frontend/index.html)（モーダル7件）

**指摘だった状態**: `openModal()` / `closeModal()` がインラインの `style.display` を直接書き換えていた。

**現在**: `hidden` 属性ではなく、専用CSSクラス `.modal-hidden { display: none !important; }` の
付け外し（`classList.add/remove`）に置き換えた。

- **`hidden` 属性ではなく専用クラスにした理由**: 対象の7モーダル（`important-modal` /
  `notice-modal` / `gtfs-expiry-modal` / `tt-map-popup-modal` / `bs-map-modal` /
  `bs-platform-picker-modal` / `rs-spot-modal`）は、いずれも `class` に Tailwind の `flex`
  ユーティリティを**常時**持たせた上で `style="display:none;"` により初期非表示にしている。
  `hidden` 属性は仕様上 `display:none` を付与するだけの通常のCSSルールで、同じ詳細度を持つ
  `.flex{display:flex}` のようなクラスが同じ要素に付いていると、そちらに上書きされて
  **モーダルが消えなくなる**（Tailwindのpreflightにある `[hidden]` ルールも同様に上書きされる）。
  この事故を避けるため、`!important` を持つ専用クラスにした。
- `openModal(id)` は `.modal-hidden` を外すだけ、`closeModal(id)` は付けるだけになった。
  表示時のレイアウト（`flex` 等）はHTML側の既存クラスがそのまま担うので、開いたときの見た目は
  変わらない。
- `index.html` の該当7要素は `style="display:none;"` を外し、`class` に `modal-hidden` を
  追加した。openModal/closeModal を呼んでいるのはこの7件だけであることを確認済み
  （`busstop.js` / `routesearch.js` / `timetable.js` はいずれも `window.openModal` /
  `window.closeModal` 経由で、直接 `style.display` を触る箇所は残っていない）。
- モーダル以外のセクション表示切替（`app.js` のページ内セクション等）は今回のスコープ外で、
  従来どおり `style.display` のままにしてある（ページ全体の表示状態を持つ別の仕組みで、
  混同すると別の不具合を作りかねないため）。

*残っている課題*: 無し。

### F-7 ✅ `admin.html` が28本の `<script>` を個別読み込み（低）— 対応済み

*場所*: [frontend/admin.html](../frontend/admin.html)（末尾の `<script>` 一覧）

**指摘だった状態**: `admin-core.js` 以下25本の `<script src="...">` に `defer`/`async` が無く、
HTTP/1.1環境では「1本ダウンロード→実行→次の1本をダウンロード」の直列読み込みになっていた。

**現在**: 全25本の `<script>` タグに `defer` を追加した。

- **読み込み順の暗黙依存は壊れない**: `defer` 付きの外部スクリプトは、通常のスクリプトと同様
  **記述順のまま**、DOM解析完了後にまとめて実行される（`async` と違い順序が保証される）。
  `admin-router.js` 冒頭のコメント「`admin-core.js` と全 `admin-<section>.js` の読み込み後、
  最後に読み込むこと」という前提は、タグの並び順を変えていないのでそのまま成立する。
- **実行タイミングも実質変わらない**: 元々これらのタグは `</body>` 直前にあり、実行時点で
  DOMは既に解析済みだった。`defer` により実行が「解析完了直後（`DOMContentLoaded` 直前）」へ
  移るだけで、位置が既に末尾だったこのケースでは体感できるタイミングの違いは無い。
  変わるのは**ダウンロードの並列化**だけで、25本を直列に取りに行っていたのが並列になる。
- Tailwind Play CDN・Leaflet（`<head>` 内、FOUC回避のため描画前に実行する必要がある）には
  `defer` を付けていない。今回のスコープは末尾の管理画面自前スクリプトだけ。
- 1本へのバンドルは、ビルドステップを持たない方針（CLAUDE.md「素のHTML/CSS/JS、
  ビルドステップなし」）と衝突するため見送った（F-3の判断と同じ理由）。

*残っている課題*: 無し（バンドル自体は方針上見送り）。

---

## 7. データ整合性・DBスキーマ

### DB-1 `CURRENT_DATE` がDBサーバのTZで評価される（中）— 既知 M-1

*場所*: [backend/src/services/finishService.js:411-416](../backend/src/services/finishService.js#L411-L416)、[backend/src/services/dailyTripBuilder.js:315-317](../backend/src/services/dailyTripBuilder.js#L315-L317)

`service_date` はJST基準で書くのに、比較対象の `CURRENT_DATE` はDBセッションのTZ（compose では
`db` コンテナに `TZ` 未設定＝UTC）で評価される。前日の未クローズ便がJST 09:00まで残り、
アーカイブと区間統計反映がずれる。`(now() AT TIME ZONE 'Asia/Tokyo')::date` にするか、
アプリ側で計算した日付をパラメータで渡す。`db` コンテナに `TZ: Asia/Tokyo` も。

### DB-2 当日便生成の運行日判定に有効期間チェックがない（中）— 既知 M-2

*場所*: [backend/src/services/gtfsCalendar.js:97-113](../backend/src/services/gtfsCalendar.js#L97-L113)

`gtfsTimetable.getActiveServices()` は `start_date` / `end_date` を見るが、当日便生成用の
`getActiveServiceIds()` は見ない。「現行ダイヤ」と「次期ダイヤ」が同じZIPに同梱されると
両方が同時に有効になり同じ時刻の便が二重生成。期間切れ後は「時刻表は運行なし／当日便は生成継続」のずれ。

### DB-3 `daily_trips` の一意キーに位置依存の `frequency_index` が含まれる（中・新規）

*場所*: [backend/src/db/schema.sql:405](../backend/src/db/schema.sql#L405) `UNIQUE (service_date, schedule_trip_id, frequency_index)`

`frequency_index` は `expandFrequencies` が振る連番。frequencies.txt の内容が変わると
インスタンスの対応がずれ、`ON CONFLICT` で走行中でない仮想便が別インスタンスの内容に更新されうる。
G-1（`schedule_trips` の trip_index 問題）の frequencies 版。

### DB-4 一意制約・FKの見直し余地（低）

- ~~`vehicle_gps_log (vehicle_id, gps_time_ts)` に一意制約なし~~ → **対応済み**（P-4。
  `ux_vehicle_gps_log_vehicle_time`）。
- `stops` を参照する多数の子テーブル（`segment_travel_stats` など）が `ON DELETE` 指定なしで
  `stops(id)` を参照。G-4 で孤児 `stops` を消せない一因。
- `completed_trips.trip_id` / `daily_trip_id` / `assignment_id` は FK なし（意図的だが、
  `daily_trip_id`/`assignment_id` は `UNIQUE` のみ）。

### DB-5 `vehicles` の一意キーが `(route_id, car_id)`（中）— 既知 M-9

*場所*: [backend/src/db/schema.sql:300-310](../backend/src/db/schema.sql#L300-L310)、[backend/src/services/tripAssignment.js:97-104](../backend/src/services/tripAssignment.js#L97-L104)

1台の物理バスが位置情報CSVの系統IDごとに別 `vehicles` 行になる。系統表示が切り替わる前後の
GPSが「前の系統の車両行」に入っていると、次の便の候補検索（`v.route_id = trip.route_id`）に
ヒットせず、始発バス停に実際にバスが居るのに `unassigned` になる。
一意キーを `(feed_id, car_id)` にして物理車両1台＝1行にする案。

---

## 8. デプロイ・インフラ・可観測性

### D-1 ✅ パイプラインのスキップが記録・通知されない（高）— 既知 L-11 を拡大 — 対応済み

*場所*: [backend/src/jobs/scheduler.js](../backend/src/jobs/scheduler.js)、[backend/src/services/jobMonitor.js](../backend/src/services/jobMonitor.js)（`recordSkip` / `SKIP_ALERT_THRESHOLD`）、[backend/src/routes/api.js](../backend/src/routes/api.js)（`GET /api/admin/alerts` の `pipelineSkipped`）

**指摘だった状態**: `pipelineRunning` による多重実行防止は正しいが、スキップした事実がどこにも
残らない。実質的なポーリング間隔が2分・3分へ伸びていても気づけない。同様に `finishRunning` /
`cleanupRunning` のスキップも不可視だった。

**現在**: スキップの記録と、連続スキップ時のアラート化の両方を入れた。

- `jobMonitor.js` に `recordSkip(name)` を追加した。ジョブごとに `skipCount`（累計）・
  `consecutiveSkips`（連続回数）・`lastSkippedAt` を持ち、`track(name, fn)` が実際に呼ばれた
  瞬間（＝スキップが途切れた瞬間）に `consecutiveSkips` を0へ戻す。
- `scheduler.js` の3つのタイマー（メインパイプライン・終了バッチ・掃除バッチ）は、多重実行ガードで
  `return` する直前に `jobMonitor.recordSkip(...)` を呼ぶ。メインパイプラインは
  `runPipeline()` を1回分まるごと `jobMonitor.track('scheduler.pipeline', runPipeline)` で
  包むようにした（従来は `pipeline.*` という個々のステップしか計測しておらず、周期1回分の
  所要時間・スキップを表すジョブが無かったため）。終了バッチ・掃除バッチは既存の
  `scheduler.finishTrips` / `scheduler.cleanup` にそのまま乗せているので、ジョブ監視の
  行は増えない。
- `consecutiveSkips` が `SKIP_ALERT_THRESHOLD`（3回）に達すると `console.warn` を出す。
  加えて `GET /api/admin/alerts` に新しい異常アラート種別 `pipelineSkipped`（緊急）を追加した。
  DBは見ずjobMonitorのプロセス内カウンタを読むだけで、管理画面「異常アラート」に
  「メインパイプライン が3回連続でスキップ（前回の実行が長引いています）」のように出る。
  キーはスキップが連続している間は同じ異常インスタンスとして扱い（`skipStreakStartedAt`）、
  一度解消してから再発したら別のキーとして改めて表示される（他のアラート種別と同じ規約）。
- 管理画面「ジョブ監視」テーブルにも「スキップ」列を追加し、`連続N回 / 累計M回` を表示する
  （3回以上は赤字）。既存の列・既存のAPIレスポンス項目は変えていないため、他の監視画面への
  影響はない。

*残っている課題*: push通知（Slack/メール等）はまだ無いので、管理画面を開いていないと
アラートには気づけない（D-2 と同根）。またこの仕組みは「スキップが起きたこと」を検知するだけで、
スキップの根本原因（P-1〜P-4等の所要時間そのもの）は解消しない。

### D-2 能動的なアラート通知手段がない（高・新規）

*場所*: 監視系全般（[backend/src/services/jobMonitor.js](../backend/src/services/jobMonitor.js)、[backend/src/services/apiMetrics.js](../backend/src/services/apiMetrics.js)、`/api/admin/alerts`）

監視はすべて管理画面のプル型。フィード全滅・パイプライン停止・DB接続不能を
**人が管理画面を見ていないと気づけない**。メール / Slack / Webhook / PagerDuty 等への
push 通知がない。夜間・早朝の障害が翌朝まで放置される。

### D-3 監視データがすべてインメモリで再起動消滅（中・新規）

*場所*: [backend/src/services/jobMonitor.js:39](../backend/src/services/jobMonitor.js#L39)、[backend/src/services/apiMetrics.js:14](../backend/src/services/apiMetrics.js#L14)、[backend/src/services/visitorTracker.js:15](../backend/src/services/visitorTracker.js#L15)

`jobs` / `statsByEndpoint` / `lastSeenByClient` / `builtServiceDate` / `lastGtfsUpdateAt` は
すべてモジュール変数。デプロイのたびにジョブ履歴・API統計・閲覧数がリセットされ、
`lastGtfsUpdateAt` リセットで毎デプロイ フルGTFS再取得＋`seed()`（G-1/G-5と連動）。
最低限、ジョブ実行履歴とGTFS更新時刻はDB or 永続ストアへ。

### D-4 ✅ SIGTERM 未処理（低）— 既知 L-5 — 対応済み

*場所*: [backend/src/server.js](../backend/src/server.js)（`gracefulShutdown()` / `SHUTDOWN_TIMEOUT_MS`）

**指摘だった状態**: `SIGINT` だけを処理し、`scheduler.stop()` / `serviceStatusJob.stop()` のあと
即座に `process.exit(0)` していた。`docker stop` と各種PaaS（Render等）のデプロイは `SIGTERM` を送るため
そもそもハンドラが動かず、進行中のパイプライン処理・DBクエリが途中で切れて（DB側でロールバック
されるため実害は限定的だが）10秒後に SIGKILL されていた。HTTP接続・DB接続プールも閉じていなかった。

**現在**: `SIGTERM` / `SIGINT` の両方を同じ `gracefulShutdown(signal)` に通し、次の順で待ってから終了する。

1. `scheduler.stop()` / `serviceStatusJob.stop()` … 定期タイマーを止めて新しい仕事を積まない。
2. `httpServer.close()` … 新規接続を止め、処理中のリクエストの完了を待つ。20秒ポーリングの
   クライアントが張っているアイドルな keep-alive 接続は `closeIdleConnections()`（Node 18.2+）で
   即座に閉じ、`close()` が猶予いっぱいまで返らないのを避ける。
3. `pool.end()` … 進行中のクエリの完了を待ってから接続プールを閉じる。

- `SHUTDOWN_TIMEOUT_MS`（既定8000ms）で保険のタイマーを張り、`close()` / `end()` が返ってこなくても
  Docker の `stop` → SIGKILL 既定10秒より前に必ずプロセスを抜ける（`unref()` 済みなので
  正常終了は1msも遅らせない）。
- ハンドラは `shuttingDown` フラグで二重起動を防ぐ。
- 従来 `SIGINT`（Ctrl+C）で行っていた「タイマー停止 → 終了」もこの経路に含まれるため、
  ローカルでの手動停止の挙動は実質変わらない（終了が即時でなく、接続を閉じるぶん最大数百ms遅くなるだけ）。
- `SHUTDOWN_TIMEOUT_MS` を `.env.example` と README §8 に追記した。known-issues.md L-5 は解決済みのため削除した。

*残っている課題*: 進行中のパイプライン1周期そのものを中断・完了待ちする仕組みは入れていない
（`pool.end()` がその周期のトランザクション完了を待つのに任せ、間に合わなければ猶予切れで打ち切る）。

### D-5 ✅ `docker-compose.yml` の作り込み不足（中・新規）— 対応済み

*場所*: [docker-compose.yml](../docker-compose.yml)、README §9

**指摘だった項目と現在**:

- **`data gtfs/` 用の名前付きボリュームがない（G-5）** → `backend` サービスに `gtfs_data` ボリュームを
  `/app/data gtfs` へマウントした。コンテナ再作成でイメージ同梱の古いGTFSへ巻き戻らなくなった。
  初回作成時はイメージの内容で初期化されるため初めての起動時の挙動は従来と同じで、以降も
  パイプラインの毎時更新と `seed()` 時の `ensureGtfsFilesPresent()` で自己復旧する。→ G-5 参照。
- **`.env` 不在で `docker compose up` が失敗する** → `env_file` を `required: false`（Compose v2.24+）にし、
  `.env` が無くてもコード既定値で起動できるようにした（`backend/src/config/db.js` のローカル接続既定と
  `db` サービスの既定が一致しているため、DB接続もそのまま通る）。README §9 に
  「設定を変えたいときだけ `cp backend/.env.example .env`」の手順を明記した。
- **`backend` コンテナに `TZ` 未設定** → `TZ: Asia/Tokyo` を追加した。アプリのコードは時刻を
  ほぼすべて明示的に `Asia/Tokyo`（`Intl.DateTimeFormat` / `Date.UTC` ＋オフセット）で扱う
  （[backend/src/utils/time.js](../backend/src/utils/time.js)）ため判定ロジックには影響せず、
  効くのはログ・スタックトレースの時刻表記だけ。`node:20-alpine` は `tzdata` を持たないが
  Node は同梱ICUで `TZ` を解決するので効く（コンテナ内で `new Date().toString()` が JST 表記に
  なることを確認済み）。ローカルタイムに依存する箇所は `seed.js` の `new Date().getFullYear()`
  1か所だけで、これは祝日データを翌年ぶんまで先読み投入するためのもので年末の数時間だけ
  「翌々年ぶんの先読みが1時間遅れる」程度の差（実害なし。JST基準の方がむしろ正しい）。
- **`db` コンテナの `TZ`（DB-1 の一因）は据え置き** → こちらは `CURRENT_DATE` / `now()::date` の評価が
  変わり、便のクローズと保持期間掃除のタイミングが動く（＝挙動の変更）ため、DB-1 の範囲とした。
  compose のコメントにも理由を残してある。
- ~~`backend` に healthcheck がない（`db` にはある）~~ → **対応済み**（D-8。`GET /healthz` と
  `backend` サービスの healthcheck）。
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` を compose 本体に書いていない点は意図どおり（秘密情報を
  compose に直書きしない）。未設定時にランダム生成される挙動（S-1）と `.env` での設定手順は
  compose のコメントと README §8 / §9 に記載済み。

known-issues.md L-10 は G-5 の解消により削除した。

*残っている課題*: TLS終端はいまもリバースプロキシの仕事で、compose にプロキシは含めていない（S-5）。
`db` 側の `TZ` は DB-1 待ち。

### D-6 ✅ ビルドの再現性がない（`package-lock.json` を使っていない）（中・新規）— 対応済み

*場所*: [backend/package-lock.json](../backend/package-lock.json)、[Dockerfile](../Dockerfile)

**指摘だった状態**: `npm install`（`npm ci` ではない）で、`cheerio ^1.2.0` `express ^4.19.2` などの
推移的依存が浮動していた。ビルドのたびに解決されるバージョンが変わりうるため再現性がなく、
上流の不具合・脆弱性が予告なく入る。

**現在**: `package-lock.json`（`lockfileVersion: 3`、8直接依存＋推移的依存を固定）をコミット済みで、
コンテナビルドはこれを使う `npm ci` に切り替えた。

- `Dockerfile` は `package.json` と `package-lock.json` の両方を先にコピーしてから
  `npm ci --omit=dev` を実行する。`npm ci` は lockfile を**書き換えず**、lockfile と
  `package.json` の内容がずれていればビルドを失敗させる（`npm install` はその場で lockfile を
  更新して通してしまう）。`node_modules` を毎回まっさらから作るので、ローカルに残った
  古い依存がイメージに紛れ込むこともない。
- lockfile に固定されているバージョンは、現在ローカルにインストールされている
  `node_modules`（`cors 2.8.6` / `express 4.22.2` / `dotenv 16.6.1` / `pg 8.22.0` 等）と一致する。
  `npm ci --dry-run` が「up to date」で通ること、および `node:20-alpine` 上で
  `docker build`（`npm ci --omit=dev`）が成功し全 production 依存が解決することを確認済み。
- ローカル開発（README §9・CLAUDE.md）の `npm install` はそのまま。lockfile がある状態で
  `npm install` を実行しても、`package.json` を変更しない限り npm は lockfile どおりに入れる。
  完全に再現させたいときは `npm ci` を使う。

*残っている課題*: `npm audit` が報告する既存の警告（推移的依存）自体はこの変更では解消しない
（別途 `npm audit fix` の適用是非を判断する必要がある）。CIでの `npm ci` 実行・監査は T-2（CIなし）の範囲。

### D-7 OpenStreetMap 公式タイルサーバを直接利用（低・新規）

*場所*: [frontend/app.js:824-827](../frontend/app.js#L824-L827) `https://{s}.tile.openstreetmap.org/...`

OSMF のタイル利用ポリシーは重負荷・商用利用を禁止し、識別可能な User-Agent と適切な
attribution を要求する。公開交通アプリのアクセス量ではブロックされうる。
自前タイルキャッシュ or 商用タイルプロバイダ（MapTiler / Mapbox 等）へ。

### D-8 ✅ ヘルスチェック用エンドポイントがない（低・新規）— 対応済み

*場所*: [backend/src/services/healthCheck.js](../backend/src/services/healthCheck.js)、[backend/src/server.js](../backend/src/server.js)（`GET /healthz`）、[docker-compose.yml](../docker-compose.yml)

**指摘だった状態**: 「DB接続・直近パイプライン成功・GTFS鮮度」を返す軽量エンドポイントがなく、
オーケストレータやロードバランサが「起動したが不健全」を検知できなかった。

**現在**: `GET /healthz` を追加した。JSONで `{ status, healthy, uptimeSec, checks:{ db, pipeline, gtfs } }` を返す。

- **DB疎通**: `feeds` の最終取得時刻を1本読むついでに確認する（`SELECT max(last_fetched_at) …`）。
  プール枯渇で固まらないよう `HEALTHZ_DB_TIMEOUT_MS`（既定3000ms）で打ち切る。
- **直近パイプライン完了**: `jobMonitor` の `scheduler.pipeline`（1周期まるごと）の最終完了時刻を見る。
  `HEALTHZ_PIPELINE_STALE_SEC`（既定300秒＝5周期ぶん）を超えていれば「詰まっている」と判定。
  起動直後でまだ1周期も完了していない間は猶予として正常扱い（`status: 'starting'`）だが、
  起動から既定300秒を過ぎても1周期も回っていなければスケジューラ停止の兆候として異常に倒す。
- **GTFS鮮度**: フィードの最終取得からの経過秒と `stale` フラグ（既定3時間・`HEALTHZ_GTFS_STALE_SEC`）。
  **情報のみで全体の健全性判定には使わない**（`GTFS_UPDATE_INTERVAL_MIN` やフィード側都合で
  取得間隔が開くことはあり、それ自体は稼働不能ではないため）。
- HTTPコードは正常時200、**DB不通またはパイプラインが詰まっているとき503**。
- `httpsRedirect` / セキュリティヘッダー / CORS / レートリミット / 閲覧数カウントの**いずれの
  ミドルウェアよりも手前**に置いてある。`FORCE_HTTPS=true` でも平文の `localhost` から到達でき、
  API稼働統計（`apiMetrics`）や閲覧数（`visitorTracker`）を汚さない。
- `docker-compose.yml` の `backend` サービスに healthcheck を追加した
  （`wget -q -O /dev/null http://127.0.0.1:3000/healthz`。busyboxのwgetはHTTP 503で終了コード1）。
  `start_period: 60s` で起動直後の失敗はリトライに数えない。これは D-5 の「backend に
  healthcheck がない」も兼ねる。

*残っている課題*: healthcheck を見て**能動的に通知する**経路（Slack/メール等）は無い（D-2 と同根）。
compose の healthcheck 単体ではコンテナの自動再起動までは行わない（状態表示のみ。Swarm や
外部オーケストレータ側の設定が必要）。パイプラインの判定は「完了時刻の鮮度」で見るため、
1ステップだけが恒常的に失敗していても（`runPipeline()` が内部で握りつぶして戻る限り）
`healthy` には出ない——個々のステップの失敗は管理画面「ジョブ監視」「異常アラート」側で見る。

### D-9 ✅ `gtfsTimetable.js` のインメモリキー区切りが NUL 文字だった（低・新規）— 対応済み

*場所*: [backend/src/services/gtfsTimetable.js](../backend/src/services/gtfsTimetable.js)（`SEP` / `makeKey()`）

**指摘だった状態**: フィードIDとGTFS内IDを連結するキーの区切り `SEP` が NUL 文字（U+0000）で、
このためファイルが grep / ripgrep に**バイナリ扱い**され通常の検索がヒットしなかった
（コメントで自認済み）。保守時の地雷。

**現在**: `SEP` を `\x1f`（U+001F, Unit Separator）に変更した。制御文字なのでGTFSのID内には
現れず、NULではないので ripgrep 等のバイナリ判定にも引っかからない
（このファイルは通常の grep 検索でヒットするようになった）。

- このキーは**プロセス内のインメモリインデックス専用**で、DB・URL・APIレスポンスのいずれにも
  一切出ない。外部に出る `stopKey` / `groupKey` は `buildGroups()` が `_`（アンダースコア）で
  構成しており `SEP` とは無関係。キーはインデックス構築のたびに `makeKey()` で作り直され、
  分解（`split`）する箇所も無いため、区切り文字の値そのものに依存するコードは無い。
- 経路検索（`gtfsRouteSearch.js`）は共有インデックス上のキーを**不透明な文字列として**受け渡す
  だけで、`SEP` を使ったキーの生成・分解はしない。
- 現行2フィードの実データでインデックス構築・時刻表組み立て・経路検索が通ること、および
  既存の回帰テスト（`npm test`、177件）が全て通ることを確認済み。

*残っている課題*: 特になし。フロントエンド側（`frontend/timetable.js` の `routeFilterKey`）は
これとは別レイヤーで、以前から属性値として安全な `|` を使っている（[docs/timetable-search.md](timetable-search.md)）。

---

## 9. テスト・品質保証

### T-1 パイプライン・DBロジックの自動テストがない（高・新規）

*場所*: [backend/test/](../backend/test/)

`npm test` は純粋関数（`time` / `geo` / `kana` / `gtfsFrequencies` / `directionMapping` と、
`busStopApproaching` / `gtfsCalendar` / `gtfsTimetable` / `passDetection` / `realtimeTripLookup` /
`spotSearch` / `touristSpots` / `vehicleOperationHistory` の一部）のみ。

**テストがない重要領域**:
- 便クローズの二重実行対策（行ロック・`UNIQUE (daily_trip_id, assignment_id)`）
- `updateSegmentStats` の二重集計対策（`FOR UPDATE SKIP LOCKED`・原子的UPSERT）
- GTFS reseed パス（`seed()` の冪等性、trip_index ずれ）
- 実GPSトレースに対する `pass()` の通過判定（循環線対策①②③④、ベクトル判定）
- 割り当て → 再割り当て → クローズ の一連のライフサイクル

これらは「うっかり再発させやすい実際のバグへの回避策」（CLAUDE.md 冒頭）そのものなのに、
リグレッションを機械的に検知できない。testcontainers 等でPostgresを立てる統合テストを。

### T-2 CI がない（中・新規）

`.github/workflows` 等がなく、`npm test` すら自動実行されない。PR/push でテスト＋
（導入すれば）lint を回すCIを。

### T-3 lint / フォーマッタ設定がない（低）— 既知

CLAUDE.md も「lint設定は存在しません」と明記。ESLint + Prettier（既存挙動を変えない範囲で）。

### T-4 依存の脆弱性スキャンがない（低・新規）

`npm audit` / Dependabot / Renovate のいずれも見当たらない。D-6（lockfile）と併せて導入を。

---

## 10. プロダクト（サービス）としての欠陥

### X-1 「割り当て不確実」状態が利用者に伝わらない（中）

GPSはあるが割り当てに失敗した便（DB-5/M-9）、GPS途絶でクローズされた便（B-2/H-2）は
利用者画面で単に「バスがありません」。**物理的にバスが走っているのに情報が消える**のが
最悪の体験。「接近中（位置概算）」「一時的に追跡不能・最終確認 X時Y分 Z付近」のような
中間表現を持たせるべき。

### X-2 早発が誰にも見えない（中）

B-3 の帰結。利用者にとって「定刻より早く行ってしまった」は乗り遅れ＝最大の不満要因。
管理画面の運行監視にも出ない。

### X-3 リアルタイムの遅延が利用者に説明されていない（低）

`/api/buses` はポーリング間隔（最大60秒）＋ ETAが前周期の値（さらに最大60秒）で、
表示位置・予測が1〜2分古いことがある。UI上「X秒前の情報」の明示がない。

### X-4 運行実績の長期保管手段がない（中）

`completed_trips` は7日で掃除され、エクスポートもその範囲のみ。交通事業者にとって
運行実績は監査・改善・対外説明の一次資料。`segment_travel_stats` は平均だけ残るが、
個別便の記録を長期保存する経路（S3等へのアーカイブ、集計DWH）がない。

### X-5 能動通知（プッシュ）がない（中）

利用者向けに「お気に入りバス停の接近通知」「遅延通知」がない。
お気に入りは localStorage のみで、Web Push 未対応（F-4 のPWA不在と連動）。

### X-6 多言語対応が中途半端（低）

`tourist_spots` に `hours_en` / `description_en` 等の英語カラムがあるが
「利用者画面の英語表示には未使用」（[touristSpots.js:184-186](../backend/src/services/touristSpots.js#L184-L186)）。
`howto.html` 等の主要画面も日本語のみ。松本は観光都市なので、やるなら通しで。

### X-7 アクセシビリティの担保がない（低）

Tailwind クラス直書きの装飾中心で、`aria-*`・フォーカス管理・コントラストの体系的チェックがない。
モーダルはフォーカストラップなし。交通インフラの公共サービスとしては要考慮。

### X-8 単一プロセス・単一DBで水平スケール不可（中）

インメモリキャッシュ（`runtimeSettings` / `directionRules` / `holidayCalendar` /
`gtfsTimetable` インデックス / 監視系）と、パイプラインが「1プロセス前提」で書かれているため、
API を複数インスタンスにできない（パイプラインが多重に走る）。
負荷増時は「APIワーカー複数 + パイプライン専用ワーカー1」への分離設計が要る。

---

## 11. 機能面の改善提案

コード品質ではなく「あると良い機能」。

| # | 提案 | 背景 |
|---|---|---|
| I-1 | GTFS-Realtime (TripUpdates / VehiclePositions) の**出力**対応 | 現状は独自JSON API のみ。GTFS-RT を吐ければ Google/Yahoo/NAVITIME 等の経路検索に自社リアルタイムが載る |
| I-2 | お気に入りバス停の接近プッシュ通知（Web Push） | X-5。PWA化（F-4）とセット |
| I-3 | 遅延の傾向ダッシュボード（路線×時間帯×曜日のヒートマップ、長期） | 予測精度監視は7日上限。運行改善の意思決定材料として月次・年次の可視化 |
| I-4 | 「このバス停で降りる人向け」の降車通知・残り停留所カウントダウン | 便詳細ページにあるデータで実装可能 |
| I-5 | 管理画面の変更監査ログ（誰がいつ運用パラメータ・割り当て・お知らせを変更したか） | 現状 `updated_at` のみ。S-2 でセッション化したので操作単位の記録は載せやすくなった（残るは S-1 と、管理者アカウントの複数化） |
| I-6 | フィード障害時の利用者向け一括バナー（「◯◯の位置情報を一時停止中」） | リアルタイム休止は路線単位・手動。フィード全滅の自動検知＆表示 |
| I-7 | バリアフリー情報（ノンステップ車両か等）の車両ラベルへの追加 | `vehicle_labels` を拡張 |
| I-8 | 経路検索の「よく使う経路」保存＋出発リマインド | お気に入りに routesearch 種別はあるがリマインドなし |
| I-9 | 混雑度の推定・表示（候補/担当の乗車パターンや外部データから） | 交通アプリの定番ニーズ |
| I-10 | 時刻表・運賃の「最終更新日」「次回改正予定」の明示 | GTFS `feed_info.txt` / 有効期間データを利用者に見せる |

---

## 12. ドキュメントの不整合（新規）

| # | 場所 | 不整合 |
|---|---|---|
| ~~DOC-1~~ | [backend/.env.example](../backend/.env.example) / README §8 / CLAUDE.md の NIGHT_START/END 行 | ✅ **対応済み**（B-8）。「①当日便の生成だけが動き、②〜⑧（車両割り当てを含む）は止まる。ただし始発時刻を過ぎた未割り当ての便がある間は継続する」へ全箇所を統一 |
| DOC-2 | [docs/pass-detection.md](pass-detection.md) 末尾 vs [docs/known-issues.md](known-issues.md) M-5 | 通過バス停をGPSマッチ候補から除外しない挙動を、前者は「意図的な設計」、後者は「バグ」として記述（B-4） |
| DOC-3 | [backend/package.json:4](../backend/package.json#L4)、[backend/src/server.js:45](../backend/src/server.js#L45) | `description` と起動ログが「横田信大循環線 リアルタイム運行管理システム」。実体は松本市内 約40路線（A-2 と同根） |
| ~~DOC-4~~ | README / CLAUDE.md の「複数路線対応」記述 vs `resolveRouteId` の単一路線デフォルト・`app.js` の `'11'` 固定 | ✅ **解消**（A-2 / F-1 の対応により、単一路線への決め打ち・未修飾IDの既定値そのものが無くなった） |

---

## 13. 優先度付き対応リスト（提案）

### すぐ（今週）

1. **S-1**: `ADMIN_PASSWORD` 未設定なら起動拒否。compose / .env.example に必須明記
2. **D-6**: `package-lock.json` をコミットし `npm ci` に切替
3. ~~**B-1**: `ensureDailyTrips` の空 `activeServiceIds` 時に `builtServiceDate` を更新しない~~ → ✅ 対応済み
4. **DOC-2〜4**: ドキュメントの誤り修正（コードは変えずまず記述を合わせる。~~DOC-1~~ は B-8 で解消済み）
5. **A-1**: `migrate.js` に `require.main === module` ガード

### 近いうち（今月）

6. ~~**G-2**: `seed()` を `pg_advisory_lock` で直列化~~ → ✅ 対応済み（`pg_advisory_xact_lock`）
7. **G-3 / B-1**: GTFS差し替えを「別ディレクトリ展開 → rename 1回」に
8. ~~**D-1**: パイプラインスキップの計上＋連続スキップアラート~~ → ✅ 対応済み
9. **D-2**: フィード全滅・パイプライン停止の push 通知（Slack/メール）
10. ~~**P-1 / P-4**: 区間統計の一括読み込み、`vehicle_gps_log` の一意制約~~ → ✅ 対応済み
11. ~~**S-2**: 管理画面をサーバーセッション（httpOnly Cookie）へ~~ → ✅ 対応済み
12. ~~**S-3**: `/api/admin/*` と `/api/route-search` にレートリミット~~ → ✅ 対応済み
13. **DB-1**: `CURRENT_DATE` 比較のJST化、`db` コンテナに `TZ`

### 設計判断が要る（四半期）

14. **G-1**: GTFS 内容ハッシュ比較、`schedule_trips` 一意キーを `(route_id, gtfs_trip_id)` へ
15. **B-2 / X-1**: GPS途絶を中間状態にし復旧で復帰。利用者向け「追跡不能」表現
16. **X-2**: 早発アラート（**B-3** の符号付き遅延の保存は ✅ 対応済み。残るのは検知・通知）
17. **X-8**: APIワーカーとパイプラインワーカーの分離
18. **T-1 / T-2**: Postgres統合テスト＋CI
19. **F-3**: Tailwindの静的CSS化（技術リスクは低いと確認済みだが、ビルドステップなし方針との
    トレードオフのため見送り。詳細はF-3参照） — 依存のセルフホスト（**S-6**）は ✅ 対応済み
    ~~**F-4**: PWA化~~ → ✅ 対応済み（ホーム画面追加・オフラインシェルのみ。APIレスポンスの
    オフラインキャッシュは対象外）
20. **X-4**: 運行実績の長期アーカイブ

---

## 付記：良くできている点

指摘が中心のドキュメントだが、次の設計は堅実で、安易に「単純化」すべきでない：

- **便起点データモデル**（便を先に生成し始発時刻に車両を割り当て、候補にも同じ処理をする）は
  再割り当て時の実績コピー/マージを不要にしていて筋が良い。
- 便クローズの二重実行対策（行ロック + `UNIQUE` 制約の二層）、`updateSegmentStats` の
  `FOR UPDATE SKIP LOCKED` + 原子的UPSERT は、実際に起きる競合を正しく潰している。
- 曜日区分ロジックを用途別に3つ分離、`getRuntimeSetting` / `isDirectionIgnored` を
  「同期アクセサ + 非同期リフレッシュ」に割り切った判断も、呼び出し元の広範な非同期化を
  避けるトレードオフとして妥当。
- 予測精度監視の集計をSQL側に寄せた最適化、`predictionAccuracy.js` の `MATERIALIZED` CTE の
  使い方は丁寧。
- `docs/` の充実度と CLAUDE.md の「理解せずに修正しない」注意書きは、この規模の
  個人〜少人数開発としては例外的に整備されている。

このドキュメントの目的は、その土台の上に残っている穴を優先度付きで見えるようにすることにある。
