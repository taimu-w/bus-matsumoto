# システム全体レビュー（2026-09）— 問題点・バグ・欠陥・改善提案

このドキュメントは、バスロケーションシステム（`bussystem/`）のコード・アーキテクチャ・
運用面を一通り読み込んだうえでの**指摘事項の総まとめ**です。

- 対象: `backend/src/` 全体、`frontend/`（主要ファイル）、`docs/`、`Dockerfile` / `docker-compose.yml` / `schema.sql`
- 既存の [docs/known-issues.md](known-issues.md) と重複する項目には **「既知(H-2 等)」** と付記しています。
  重複項目もこのドキュメントで現状を再確認し、影響・背景を補っています。
- 重大度は known-issues.md の基準（利用者に見える誤情報を出すか／復旧に人手が要るか）に、
  **セキュリティ**と**プロダクトとしての完成度**の観点を加えています。

> **S-2〜S-6 は対応済みです。** 各項目の見出しに ✅ を付け、本文を「現在どうなっているか」と
> 「それでも残っている課題」に書き換えてあります。それ以外の項目は指摘のままで、コードは変えていません。

---

## 0. サマリ

### 最優先で対応すべきもの

| # | 重大度 | 分類 | 概要 |
|---|---|---|---|
| S-1 | **重大** | セキュリティ | 管理画面のデフォルト認証情報 `admin` / `admin123` のまま本番稼働しうる（compose・.env.example に設定なし） |
| ~~S-2~~ | ~~**重大**~~ | セキュリティ | ✅ **対応済み**（管理者の資格情報を`localStorage`に平文保存 → サーバー側セッション＝httpOnly Cookie へ） |
| ~~S-3~~ | ~~高~~ | セキュリティ | ✅ **対応済み**（レートリミットが一切ない → 認証失敗・RAPTOR探索・集計カウント系に上限を追加） |
| B-1 | 高 | バグ | `ensureDailyTrips` がカレンダー読み込みの一時失敗で「当日運行なし」を確定させ、GTFS再取得まで復旧しない |
| B-2 | 高 | バグ | GPS途絶（既定6分）で担当終了→候補なしでクローズ。GPS復旧後も便が利用者画面に戻らない（既知 H-2） |
| B-3 | 高 | バグ／整合性 | 中身が変わっていなくても毎時 `seed()` が全マスタを書き換える。`schedule_trips` の位置依存キーで便がずれる（既知 H-6） |
| B-4 | 高 | 整合性 | `seed()` に排他制御がなく、毎時パイプラインと管理画面の手動再取得が同時に走るとデッドロック／部分適用の恐れ |
| D-1 | 高 | 運用 | パイプラインが 60 秒以内に終わらないと**黙って**スキップされ、記録も通知もない（既知 L-11 を拡大） |
| P-1 | 高 | 性能 | ETA プリコンピュートが N+1（区間統計）＋ O(便数²)（周辺実績）。候補車両ぶんも計算するため、ピーク時に⑥⑦⑧がポーリング間隔を食い潰す（既知 M-10） |

### 分類別の件数

- セキュリティ: 8 件（うち **S-2〜S-6 の5件は対応済み**、残り3件は S-1 / S-7 / S-8）
- 運行判定ロジックのバグ・弱点: 12 件
- パイプライン／非同期／性能: 7 件
- GTFS取り込み・当日便生成: 6 件
- API層: 6 件
- フロントエンド: 7 件
- デプロイ・インフラ・可観測性: 9 件
- テスト・品質保証: 4 件
- プロダクトとしての欠陥: 8 件
- ドキュメントの不整合: 4 件

---

## 1. セキュリティ

### S-1 管理画面のデフォルト認証情報のまま稼働しうる（重大）

*場所*: [backend/src/services/adminAuth.js](../backend/src/services/adminAuth.js)、[docker-compose.yml](../docker-compose.yml)、[backend/.env.example](../backend/.env.example)

```js
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
```

- 運用者が明示的に設定しない限り `admin` / `admin123` で管理画面が開く。
- 管理画面からできること: 運用パラメータ（判定半径・タイムアウト）の変更、車両の手動割り当て・
  到着時刻の書き換え、公開画面へのお知らせ配信、リアルタイム休止、GTFS手動再取得。
  乗っ取られると**利用者に誤情報を配信**でき、運行判定を破壊できる。
- known-issues.md M-15 でも触れているが「起動を拒否する or ランダム値」対策が未実施。
- S-3 の総当たり対策（認証失敗10回で15分ブロック）は入ったが、**既定値を知っている相手には
  1回目で通る**ため、この項目の緩和にはならない。

*対策の方向性*: `ADMIN_PASSWORD` 未設定なら**起動を拒否**する（または起動時にランダム生成してログに1回だけ出す）。

なお `.env.example`（S-2/S-5対応時に追記）と `docker-compose.yml`（同コメント追記）には
必須項目として明記済みなので、残るのはコード側の強制だけ。

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

### S-7 運行実績CSVエクスポートに数式インジェクション対策がない（低）

*場所*: [backend/src/routes/api.js:2484-2488](../backend/src/routes/api.js#L2484-L2488)

`csvEscape()` は `"` `,` `\n` は処理するが、`=` `+` `-` `@` で始まるセルをExcelが数式として
実行する問題（CSV Formula Injection）に未対応。バス停名・終了理由などGTFS由来の文字列が入るため
可能性は低いが、エクスポートの定番ハードニング。単体の `\r` も未エスケープ。

### S-8 `express.json()` にボディサイズ上限の明示がない（低）

デフォルトの 100KB に依存。観光スポットの一括テキスト登録が大きくなると弾かれる可能性。
明示的に `express.json({ limit: '1mb' })` 等にしておくと意図が分かる。

---

## 2. 運行判定ロジックのバグ・弱点

### B-1 カレンダー読み込みの一時失敗で「当日運行なし」が確定する（高・新規）

*場所*: [backend/src/services/dailyTripBuilder.js:224-230](../backend/src/services/dailyTripBuilder.js#L224-L230)、[backend/src/services/gtfsCalendar.js:74-81](../backend/src/services/gtfsCalendar.js#L74-L81)

```js
// gtfsCalendar.getActiveServiceIds: フィードごとに catch して continue、全滅なら [] を返す
// dailyTripBuilder.ensureDailyTrips:
if (activeServiceIds.length === 0) {
  console.warn(`... 有効なservice_idがありません。当日便を生成しません。`);
  builtServiceDate = serviceDate;   // ← 「今日は生成済み」として確定してしまう
  return { serviceDate, skipped: false, created: 0 };
}
```

- `calendar.txt` / `calendar_dates.txt` の読み込みが一時的に失敗すると（H-5 のファイル差し替え窓、
  ディスクの瞬断など）、`activeServiceIds` が空になる。
- そのとき `builtServiceDate` に当日日付が入るため、以降のポーリングでは
  `builtServiceDate === serviceDate` で**即リターン**し、当日便が0件のまま再試行されない。
- 復旧するのは `invalidateDailyTripCache()` が呼ばれたときだけ = **GTFS再取得が成功したとき**。
  GTFS配信元が落ちていれば数時間〜半日、当日便ゼロ（＝リアルタイムも時刻表APIの当日分も空）。
- known-issues H-5 は「インデックス再構築が500を返す」までしか触れていない。当日便生成の
  ロックアウトはより深刻。

*対策の方向性*: `activeServiceIds` が空のときは `builtServiceDate` を更新せず、次回ポーリングで
再試行させる。または `getActiveServiceIds` が「1フィードでも読めなかった」ことを呼び出し側に
伝え、部分的な成功と全滅を区別する。

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

### B-3 早発・早着がすべて「遅延0分」に丸められる（中）— 既知 M-4

*場所*: [backend/src/utils/time.js:165-175](../backend/src/utils/time.js#L165-L175) `computeDelayMinutes()` の `Math.max(0, diff)`

- 日跨ぎ誤補正の再発防止という意図は理解できるが、副作用として
  「定刻より早い」という事象が**完全に不可視**。`delay_minutes` もDBに0で保存され復元不可。
- 早発は乗り遅れを生む運行事故だが管理画面アラートに出ない。
- `computeDelayMinutes()` は ETA予測の `predictedDelayMinutes` 計算にも使われるため、
  予測側も「早着」を表現できない（常に0以上）。

*対策の方向性*: 符号付きの差分を返す関数を別に用意し、DBには符号付きで保存。
表示側で `Math.max(0, …)` すれば利用者向けの見え方は現状維持できる。

### B-4 「通過」確定バス停が「到着済」に書き換わり区間統計を汚染（中）— 既知 M-5、ドキュメント矛盾あり

*場所*: [backend/src/services/passDetection.js:246-249](../backend/src/services/passDetection.js#L246-L249)（`excludedSet` に `通過` を含めない）、
[backend/src/services/passDetection.js:648-710](../backend/src/services/passDetection.js#L648-L710)（`passInterpolate`）

- `passStepEntry` の `excludedSet` は `到着済` / `付近` のみ除外し、`通過`（真の通過 `is_through`）は
  除外しない。GPSが120m以内を通れば `付近`→`到着済` に更新される。
- 降車できないバス停に実績時刻が付き、`completed_trip_stop_times.actual_minutes` に値が入るため
  `updateSegmentStats()` が「通過バス停を含む区間」を統計に取り込む。
  → ETA予測が通過区間を統計から除外している設計（[eta-prediction-algorithm.md](eta-prediction-algorithm.md)）と矛盾。
- **ドキュメント自体が矛盾している**: [pass-detection.md](pass-detection.md) 末尾は
  「通過ステータスのバス停を候補から除外しない」ことを**意図的な設計**として説明しているが、
  known-issues.md M-5 は同じ挙動を**バグ**として挙げている。どちらが正か決めて統一が必要。

### B-5 ETAの遅延キャップが実際に大きく遅れている便の到着を早く見せる（中）— 既知 L-12

*場所*: [backend/src/services/etaPredictor.js:94-116](../backend/src/services/etaPredictor.js#L94-L116) `resolveDelayCeiling()` / `capPredictedDelay()`

上限は現在の遅れだけで決まり、残り区間の長さも実際の統計も参照しない。
`DELAY_RECOVERY_BOOST`（1.15）は遅れ解消方向の予測を常に1.15倍強調する。
序盤定時・途中で大きく遅れる便で終盤に過小予測へ偏りうる（要実測検証）。

### B-6 プロセス停止中に始発時刻を過ぎた便が復旧後まとめて割り当てられる（中）— 既知 M-13

*場所*: [backend/src/services/tripAssignment.js:254-262](../backend/src/services/tripAssignment.js#L254-L262)

`start_at <= evaluateBefore` のみで下限がない。GPSログは48時間保持されるため、
数時間前の便でも当時のGPSが残っていれば割り当てが成立し `/api/buses` に並ぶ。

### B-7 候補ゼロで unassigned になった便は closed_at が立たず一日中アラートに残る（中）— 既知 M-14

*場所*: [backend/src/services/tripAssignment.js:366-379](../backend/src/services/tripAssignment.js#L366-L379)

`reassignOrphanTrips()` は「割り当て行が1件以上ある」便しか対象にしない。
候補ゼロの便は `closed_at` を立てる経路が翌日の運行日終了掃除しかなく、
`unassignedTrip` アラートがノイズ化する。

### B-8 深夜帯に車両割り当て（④）が動かないが、複数のドキュメントは「動く」と書いている（中・新規）

*場所*: [backend/src/jobs/pipeline.js:42-50](../backend/src/jobs/pipeline.js#L42-L50)

```js
if (night) {
  console.log('[pipeline] 深夜帯のため運行処理をスキップします（当日便の生成のみ実施）。');
  return;                                   // ← ここで抜ける
}
await jobMonitor.track('pipeline.assignPendingTrips', assignPendingTrips);  // ④ は night 時に実行されない
```

- コード上、深夜帯（既定23:00〜05:00）は `②fetchLocation` 以降がスキップされ、
  `④assignPendingTrips` も走らない。CLAUDE.md L83 の記述（「②以降だけが深夜帯にスキップ」）は正しい。
- しかし [backend/.env.example:48-49](../backend/.env.example#L48-L49) と README §8 の表は
  「**当日便の生成と車両割り当て**はこの時間帯でも動く」と書いており**誤り**。
- 現状は `NIGHT_END`(05:00) < 最早便(5:40) の余裕で表面化していないが、
  `NIGHT_START` / `NIGHT_END` は管理画面「運用パラメータ設定」から編集可能（`requiresRestart` でもない）。
  運用者が「GPS取得の停止時間帯」のつもりで `NIGHT_END` を 06:00 にすると、
  **早朝便の割り当てが黙って止まる**。
- 併せて `isNightTime` は `parseHHMM` が不正値で `NaN` を返すと全比較が false（＝常に非深夜）になる。
  管理画面のバリデーションが `time` 型を弾いているか要確認。

*対策の方向性*: `.env.example` / README の記述をコードに合わせる。
`assignPendingTrips` を深夜帯でも動かす（当日便が既にあるので安いはず）か、
最早便の始発時刻から逆算して「深夜帯でも割り当てを回す時間」を持たせる。

### B-9 早朝以降の「24時超え便」の扱いが不完全（低）— 既知（"24時以降の便"）

*場所*: [backend/src/utils/time.js:96-100](../backend/src/utils/time.js#L96-L100) `minutesToTimeStr()` の `% 24`

`minutesToTimeStr(1500)`（25:00）は `1:00` を返す。`daily_trips.start_at`（TIMESTAMPTZ）は正しく
扱えるが、`"H:mm"` 表示・`computeDelayMinutes()`・便詳細URLの `departureTime` 突合で破綻しうる。
さらに **frequencies由来の仮想便は `minutesToTimeStr` で "1:00" になり、素の便は "25:00" のまま**で
表記が不一致（[dailyTripBuilder.js:256-258](../backend/src/services/dailyTripBuilder.js#L256-L258)）。
深夜帯停止と合わせ実質対象外だが、ダイヤ次第で顕在化する。

### B-10 route_id / service_id にアンダースコアがあるとグループキー分解が壊れる（低）— 既知 L-3

*場所*: [backend/src/db/seed.js:314](../backend/src/db/seed.js#L314) 付近（`${route_id}_${directionId}_${serviceId}` を組み `split('_')` で復元）

現在の2フィードは数値IDのため該当しないが、`JSON.stringify([routeId, directionId, serviceId])` を
キーにすれば構造的に安全。

### B-11 外部IDの照合がCSV行全体の部分一致（低）— 既知 L-2

*場所*: [backend/src/services/locationFetcher.js:135-142](../backend/src/services/locationFetcher.js#L135-L142) `if (joined.includes(externalId))`

行を `join(',')` した文字列に外部IDが含まれるかで路線を決めている。現在の外部IDは26文字のULIDで
誤マッチはまず起きないが、短い系統コードや備考欄へのID混入で誤解決する。列位置を固定して完全一致に。

### B-12 GPS時刻の「未来」判定と日時書式が脆い（中）— 既知 M-6

*場所*: [backend/src/services/locationFetcher.js:150-154](../backend/src/services/locationFetcher.js#L150-L154)

`now` は `fetchLocation()` 冒頭で1度だけ取得しフィード取得中ずっと固定 → 処理が進むほど正常データが
「未来」判定で捨てられる。`new Date(str.replace(/-/g,'/') + ' +0900')` は書式依存で、フィードが
ISO 8601 に変わると全行 NaN → 全件破棄。破棄は `skippedStaleOrInvalidTime` カウンタにしか出ない。

---

## 3. パイプライン／非同期処理／性能

### P-1 ETA プリコンピュートの計算量（高）— 既知 M-10 を拡大

*場所*: [backend/src/services/etaPredictor.js:526-790](../backend/src/services/etaPredictor.js#L526-L790)（`predictArrivals`）、
[backend/src/services/etaPredictor.js:340-386](../backend/src/services/etaPredictor.js#L340-L386)（`getRecentSegmentPerformance`）

- `predictArrivals()` は未到着バス停ごとに `getSegmentStat()` を1クエリずつ発行（N+1）。
- `predictArrivals()` は全 active 割り当て（**候補車両ぶんも**）に対して直列実行。
- 各 `predictArrivals()` で `getRecentSegmentPerformance()` を呼び、これが
  「全 active 割り当て＋直近90分に終了した割り当ての `trip_stop_progress`」を毎回スキャンする
  → 実質 O(便数²)。
- 単一DB接続で直列。⑥⑦⑧の所要時間がポーリング間隔（60秒）に近づくと、
  次周期が `pipelineRunning` ガードでスキップされる（D-1）。

*対策の方向性*: その日必要な `segment_travel_stats` を `(day_type, hour_bucket)` 単位で1回まとめて
読みプロセス内 Map に載せる。`getRecentSegmentPerformance()` はパイプラインで1回だけ実行して
全 `predictArrivals()` に渡す。`predictArrivals()` の引数を「統計ルックアップ関数」にすると
アルゴリズム本体を変えずに済む。

### P-2 `pass()` が全割り当てを単一接続で直列処理（中）

*場所*: [backend/src/services/passDetection.js:927-958](../backend/src/services/passDetection.js#L927-L958)

割り当てごとに複数クエリ＋マッチごとに `BEGIN`/`COMMIT`。候補車両で割り当て数が2〜3倍に膨らむため、
台数が増えると1周期の所要時間が線形に伸びる。ステップごとの所要時間は `jobMonitor` に出るが、
「便あたり何ms」までは見えない。

### P-3 生ログ転記が1周期500件で頭打ち（中）— 既知 M-8

*場所*: [backend/src/services/vehicleAssigner.js:46-52](../backend/src/services/vehicleAssigner.js#L46-L52) `LIMIT 500`、1行ごとにトランザクション

取得件数が500を超えると未処理行が毎周期積み上がり、GPSが古い状態で割り当て・通過判定に使われる。
滞留の可視化がない。`INSERT … SELECT FROM unnest(...)` の一括化と、滞留時の同一周期ループを。

### P-4 同一測位が `vehicle_gps_log` に重複蓄積（中）— 既知 M-7

*場所*: [backend/src/db/schema.sql:369-378](../backend/src/db/schema.sql#L369-L378)（一意制約なし）、
[backend/src/services/vehicleAssigner.js:68-72](../backend/src/services/vehicleAssigner.js#L68-L72)（`ON CONFLICT` なし）

フィード更新間隔がポーリング間隔より長いと、同じ測位が `GPS_FRESHNESS_MIN`（15分）ぶん繰り返し挿入。
始発待機中・終点待機中は常時。`pass()` が重複ぶんの距離計算を毎回走らせる。
`CREATE UNIQUE INDEX ON vehicle_gps_log (vehicle_id, gps_time_ts)` ＋ `ON CONFLICT DO NOTHING` を。

### P-5 パイプライン多重起動ガードの初回同時開始（低）

*場所*: [backend/src/jobs/scheduler.js:77-79](../backend/src/jobs/scheduler.js#L77-L79)

`start()` の末尾で `runPipeline()` を即実行しつつ、直後に `setInterval` も開始する。
初回実行が `pollSeconds` を超えると、interval の1発目と重なる。`pipelineRunning` で二重実行自体は
防げるが、`finishTimer`（1分）・`cleanupTimer` と位相が揃いやすい点は
[trip-lifecycle.md](trip-lifecycle.md) が指摘するとおり（対策済みだが密度は高い）。

### P-6 予測ログの掃除が毎周期フルスキャン気味（低）

*場所*: [backend/src/services/etaPredictor.js:932-934](../backend/src/services/etaPredictor.js#L932-L934)

`DELETE FROM trip_arrival_predictions WHERE computed_at < now() - interval '48 hours'` を
60秒ごとに実行。`idx_trip_arrival_predictions_computed_at` はあるが、掃除頻度を1時間掃除タイマー側へ
寄せてもよい（CASCADE で大半は消えるため保険目的）。

### P-7 観光スポット系が毎回 `SELECT *` して JS でフィルタ（低）

*場所*: [backend/src/services/touristSpots.js:67-83](../backend/src/services/touristSpots.js#L67-L83)、[touristSpots.js:89-110](../backend/src/services/touristSpots.js#L89-L110)、[backend/src/services/spotSearch.js](../backend/src/services/spotSearch.js)

`findNearbySpots` / `searchTouristSpots` はテーブル全件取得＋JS側で距離・部分一致。
バス停ページ表示ごと・サジェストのキーストロークごとに走る。件数が小さいうちは実害軽微だが、
`earthdistance` / `pg_trgm` や単純な緯度経度BBox絞り込みで十分軽くできる。

---

## 4. GTFS取り込み・当日便生成

### G-1 内容不変でも毎時 `seed()` が全マスタ書き換え（高）— 既知 H-6

*場所*: [backend/src/services/gtfsFeedManager.js:291-306](../backend/src/services/gtfsFeedManager.js#L291-L306)、[backend/src/db/seed.js](../backend/src/db/seed.js)

- ダウンロード成功＝内容変更とみなしており、ETag / Last-Modified / 内容ハッシュの比較がない。
  同じZIPでも毎時 `seed()` が走り、全 `stops`・全 `schedule_stop_times` を UPDATE。
- `schedule_trips` の一意キー `(route_id, direction_id, service_id, trip_index)` の `trip_index` は
  **trips.txt 内の並び順依存**。ダイヤ改正で便が1本増減すると以降の便が全部ずれ、
  `ON CONFLICT` で既存行が別便の内容に更新される。
- GTFSから消えた `schedule_trips` は削除されない。
- 毎デプロイでも（`lastGtfsUpdateAt` がプロセス内変数のため）フル再ダウンロード＋`seed()`。

*対策の方向性*: ZIPのSHA-256を `feeds` に記録し変化時のみ展開・seed。
`schedule_trips` の一意キーを `(route_id, gtfs_trip_id)` へ。ダウンロードをトランザクション外に。

### G-2 `seed()` に排他制御がない（高・新規）

*場所*: [backend/src/services/gtfsFeedManager.js:293](../backend/src/services/gtfsFeedManager.js#L293)、[backend/src/routes/api.js:2180-2181](../backend/src/routes/api.js#L2180-L2181)

`seed()` は (1) パイプライン⓪の `updateAllGtfsFeeds()` 成功時、(2) 管理画面
`POST /api/admin/gtfs-feeds/:feedId/refetch` 成功時、の2経路から**別接続で**呼ばれる。
`pipelineRunning` ガードは (2) をカバーしない。両者が同時に `stops` / `schedule_trips` /
`schedule_stop_times` へ大量 UPSERT すると、route ごとのロック取得順の違いでデッドロックしうる
（→片方 ROLLBACK＝そのGTFS更新が黙って失敗、次周期リトライ）。少なくとも `seed()` 全体を
アドバイザリロック（`pg_advisory_lock`）で直列化すべき。

### G-3 GTFSファイル差し替え中にインデックス構築が失敗しうる（高）— 既知 H-5

*場所*: [backend/src/services/gtfsFeedManager.js:168-192](../backend/src/services/gtfsFeedManager.js#L168-L192)

「既存ファイルを退避 → 新ファイルを配置」の2段階で、その間フィードディレクトリに必須ファイルが
無い時間帯が生まれる。`gtfsTimetable` / `gtfsCalendar` / `gtfsFare` の再構築がこの窓に走ると
`readCsv()` が ENOENT で throw し、時刻表・経路・バス停検索が500。
併せて B-1（当日便生成のロックアウト）も引き起こす。
**別名ディレクトリに展開してディレクトリごと1回の rename で切り替える**のが定石。

### G-4 `stops` / `schedule_stop_times` の孤児行が reseed で溜まる（中・新規）

*場所*: [backend/src/db/seed.js:407-426](../backend/src/db/seed.js#L407-L426)（stops）、[backend/src/db/seed.js:497-509](../backend/src/db/seed.js#L497-L509)（schedule_stop_times）

- `stops` は `ON CONFLICT (route_id, direction_id, gtfs_stop_id, occurrence) DO UPDATE` のみで、
  GTFSから消えたバス停・`occurrence` が変わったバス停の**古い行を削除しない**。
  `seq_order`（表示順）も古い値が残りうる。
- `schedule_stop_times` も `ON CONFLICT (trip_id, stop_id) DO UPDATE` のみ。
  ある便の停車パターンが変わって通らなくなったバス停の行が残る。
  `dailyTripBuilder.loadScheduleTrips` はこの（古い行を含む）テーブルを読むため、
  当日便に幽霊バス停が混入しうる（`replaceStopTimes` は daily 側しか DELETE しない）。
- G-1（trip_index ずれ）と重なると停車パターンの破損が起きやすい。

*対策の方向性*: `seed()` 内で「今回のGTFSに存在しない `stops` / `schedule_stop_times` 行を
route/feed 単位で DELETE」する、または reseed をテーブル洗い替え方式にする。

### G-5 `data gtfs/` が永続ボリュームでなく再作成で巻き戻る（低）— 既知 L-10

*場所*: [Dockerfile:17](../Dockerfile#L17) `COPY ["data gtfs", "data gtfs"]`、[docker-compose.yml](../docker-compose.yml)（backend に volume 指定なし）

コンテナ再作成でイメージ内の古いGTFS（リポジトリにコミット済みの22ファイル）に巻き戻る。
`ensureGtfsFilesPresent()` はファイルの有無しか見ないので再取得も走らない。
デプロイ直後、最大1時間ダイヤ改正前のGTFSで当日便が生成される。名前付きボリューム、または
起動時に必ず1回 `updateAllGtfsFeeds()` を強制実行。

### G-6 有効フィード0件時に更新間隔の記録が更新されない（低）— 既知 L-9

*場所*: [backend/src/services/gtfsFeedManager.js:267-271](../backend/src/services/gtfsFeedManager.js#L267-L271)

`if (feeds.length === 0) return` が `lastGtfsUpdateAt = now` より前にある。全フィードを
`enabled: false` にすると60秒ごとに接続を取得してログを出すだけの無駄処理。`lastGtfsUpdateAt = now` を
入口 or finally に。

---

## 5. API層

### A-1 `require.main` ガードなしの `migrate.js`（中）— 既知 M-16

*場所*: [backend/src/db/migrate.js:823-833](../backend/src/db/migrate.js#L823-L833)

```js
migrate().then(() => { ... process.exit(0); }).catch(() => process.exit(1));
module.exports = { migrate };
```

`module.exports` しているのに、`require('./db/migrate')` しただけで DDL 実行 → `process.exit()`。
誰かがインポートした瞬間にサーバープロセスが黙って落ちる。`seed.js` は
`if (require.main === module)` で正しくガードしており、パターンが不統一。

### A-2 `routeId` 省略時のデフォルトが単一路線に固定（中・新規）

*場所*: [backend/src/services/gtfsData.js:15-20](../backend/src/services/gtfsData.js#L15-L20)

```js
function resolveRouteId(routeId) {
  if (!routeId) return 'guruttomatsumotobus1:11';   // 横田信大循環線に固定
  return EXTERNAL_ROUTE_ID_ALIASES[routeId] || routeId;
}
```

`/api/settings`・`/api/timetable`・`/api/buses` は `routeId` 未指定だと**黙って路線11のデータ**を返す。
約40路線を扱うシステムで、旧単一路線時代のデフォルトが残っている。外部API利用者・
テスト・将来のクライアントがハマる。`EXTERNAL_ROUTE_ID_ALIASES` のULIDエイリアスも路線11専用の遺物。

*対策の方向性*: `routeId` 必須にして 400 を返す、または「デフォルトなし」を明示。

### A-3 `/api/buses` が1台ごとに複数クエリ（N+1、ホットパス）（中・新規）

*場所*: [backend/src/routes/api.js:1353-1362](../backend/src/routes/api.js#L1353-L1362)、[backend/src/services/realtimeTripLookup.js:88-153](../backend/src/services/realtimeTripLookup.js#L88-L153)

`buildBusEntry()` は1台につき `trip_stop_progress` / 最新GPS / `trip_arrival_predictions` の
3クエリを発行し、それを `/api/buses` のループで台数ぶん回す。全クライアントが20秒間隔で
ポーリングする画面なので、ピーク時のDB負荷が台数×クライアント数に比例する。
（同一路線ぶんは1レスポンスにまとめられるので、路線内でJOIN一括取得に寄せられる。）

### A-4 `/api/buses` がリクエストごとに `console.log`（低・新規）

*場所*: [backend/src/routes/api.js:1349](../backend/src/routes/api.js#L1349)

```js
console.log(`[api /buses] routeId=${routeId}, allGps=${includeAllGps}, trips=${trips.rows.length}`);
```

20秒ポーリング×クライアント数ぶんログが出る。`[pass]` `[locationFetcher]` `[tripAssignment]` なども
`console.log` 直書きで、ログレベルの概念がない。構造化ログ＋レベル制御（`pino` など）を推奨。

### A-5 SPA フォールバックが未知パスに 200 を返す（低・新規）

*場所*: [backend/src/server.js:62-65](../backend/src/server.js#L62-L65)

`app.get('*')` が `/api` 以外の未知パスすべてに `index.html` を 200 で返す。
存在しないURLが 200 になるため、監視・SEO・404計測が機能しない。
未知の `/api/*` は Express デフォルトの 404 HTML（JSONではない）が返り、APIクライアントが混乱する。

### A-6 運行実績エクスポートの `LIMIT 200000` サイレント打ち切り（低）

*場所*: [backend/src/routes/api.js:2479](../backend/src/routes/api.js#L2479)

期間内の `completed_trip_stop_times` 行数が20万を超えると無言で切れる。
打ち切りが起きたことをレスポンスヘッダやファイル末尾に示すか、ストリーミング出力に。

---

## 6. フロントエンド

### F-1 初期 `selectedRouteId = '11'`（未修飾）で初回描画が空（低）— 既知 L-4

*場所*: [frontend/app.js:11](../frontend/app.js#L11)、[frontend/index.html:36](../frontend/index.html#L36)

DBの `route_id` は `guruttomatsumotobus1:11` 形式。路線一覧取得後に補正されるが、それ以前の
`loadAll()` は素の `'11'` で叩き、一瞬「バスがありません」。`index.html` の
`<option value="11">横田信大循環線</option>` も同じ遺物。

### F-2 負荷チェックのポーリング自体が閲覧数を押し上げる（低）— 既知 L-8

*場所*: [frontend/app.js:1298-1300](../frontend/app.js#L1298-L1300)、[backend/src/routes/api.js:109-115](../backend/src/routes/api.js#L109-L115)

`checkServerLoad` は画面・可視状態によらず20秒ごとに `/api/server-load` を叩き、
そのリクエストが `X-Client-Id` 付きで**閲覧数としてカウントされる**。負荷判定のための通信が
負荷指標を作る。`/api/server-load` をカウント除外し、`document.visibilityState !== 'visible'` で停止。

### F-3 Tailwind がブラウザ内コンパイルのままで初期描画が重い（中）— S-6 で一部対応済み

→ S-6 参照。Tailwind・Leaflet を `frontend/vendor/` へ同梱したことで、
**CDN依存・SRIなし・オフライン耐性ゼロ**（バス停でモバイル回線が細いときに外部CDNが読めないと真っ白）は解消した。

残るのは**Play CDN版のブラウザ内コンパイル**そのもの。約400KBのJSを読み、毎回ブラウザ内でCSSを生成するため、
初期描画のちらつきと遅さは同梱後も変わらない。解消には Tailwind CLI でビルドした静的CSSへの置き換えが要る
（動的に組み立てたクラス名の取りこぼしで見た目が変わりうるため、要検証）。

### F-4 PWA / Service Worker がない（中・新規）

*場所*: `frontend/` 全体（`manifest.json` / `sw.js` なし）

モバイルファーストの交通アプリなのに、オフラインキャッシュ・ホーム画面追加・
「圏外でも直前の時刻表を表示」ができない。`theme-color` と viewport は設定済みで惜しい。

### F-5 Google Fonts への外部依存（低）

*場所*: [frontend/index.html:11](../frontend/index.html#L11)

`fonts.googleapis.com` にブロッキングで依存し、利用者IPがGoogleに渡る。
フォントをセルフホスト（`font-display: swap` 付き）に。

### F-6 モーダル制御が `style.display` 直操作（低）

*場所*: [frontend/app.js:112-119](../frontend/app.js#L112-L119)

`hidden` 属性ではなく `style.display` を直接触る。CSS側の状態と競合しやすい。実害は小さいが統一を。

### F-7 `admin.html` が28本の `<script>` を個別読み込み（低）

*場所*: [frontend/admin.html:1060-1084](../frontend/admin.html#L1060-L1084)

ビルドなし方針は理解できるが、HTTP/1.1 環境では直列読み込みが重い。最低限 `defer` の付与、
できれば1本にバンドル。グローバル関数の暗黙依存（`admin-core.js` を先に、等）も
読み込み順に依存していて壊れやすい。

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

- `vehicle_gps_log (vehicle_id, gps_time_ts)` に一意制約なし（P-4）。
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

### D-1 パイプラインのスキップが記録・通知されない（高）— 既知 L-11 を拡大

*場所*: [backend/src/jobs/scheduler.js:24-32](../backend/src/jobs/scheduler.js#L24-L32) `if (pipelineRunning) return;`

多重実行防止は正しいが、スキップした事実がどこにも残らない。実質的なポーリング間隔が
2分・3分へ伸びていても気づけない。同様に `finishRunning` / `cleanupRunning` のスキップも不可視。
スキップ回数を `jobMonitor` のカウンタにし、連続スキップでアラート化。

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

### D-4 SIGTERM 未処理（低）— 既知 L-5

*場所*: [backend/src/server.js:95-100](../backend/src/server.js#L95-L100)（SIGINT のみ、`process.exit(0)` 即時）

`docker stop` / 各種PaaS のデプロイは SIGTERM を送る。進行中のトランザクションが途中で切れ
（DB側でロールバックされるため実害は限定的だが）、10秒後に SIGKILL される。
SIGTERM/SIGINT 両方で「タイマー停止 → `server.close()` → `pool.end()`」の順に待って終了。

### D-5 `docker-compose.yml` の作り込み不足（中・新規）

*場所*: [docker-compose.yml](../docker-compose.yml)

- `backend` サービスに `data gtfs/` 用の名前付きボリュームがない（G-5）。
- `env_file: - .env` が必須。リポジトリに `.env` はなく（正しい）、`.env.example` からのコピーが
  必要だが手順が README に薄い。`.env` 不在だと `docker compose up` が失敗する。
- どちらのコンテナにも `TZ` 未設定（DB-1 の一因）。
- `backend` に healthcheck がない（`db` にはある）。オーケストレータが「起動したが不健全」を検知できない。
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` を設定していない（S-1）。

### D-6 `package-lock.json` がない（中・新規）

*場所*: [backend/](../backend/)（lockfile 不在）、[Dockerfile:12](../Dockerfile#L12) `npm install --omit=dev`

`npm install`（`npm ci` ではない）＋ lockfile なしで、`cheerio ^1.2.0` `express ^4.19.2` などの
推移的依存が浮動。ビルドの再現性がなく、上流の不具合・脆弱性が予告なく入る。
`npm ci` ＋ `package-lock.json` のコミットへ。

### D-7 OpenStreetMap 公式タイルサーバを直接利用（低・新規）

*場所*: [frontend/app.js:824-827](../frontend/app.js#L824-L827) `https://{s}.tile.openstreetmap.org/...`

OSMF のタイル利用ポリシーは重負荷・商用利用を禁止し、識別可能な User-Agent と適切な
attribution を要求する。公開交通アプリのアクセス量ではブロックされうる。
自前タイルキャッシュ or 商用タイルプロバイダ（MapTiler / Mapbox 等）へ。

### D-8 ヘルスチェック用エンドポイントがない（低・新規）

`/healthz` のような「DB接続・直近パイプライン成功・GTFS鮮度」を返す軽量エンドポイントがない。
D-5 の compose healthcheck にも使える。

### D-9 `gtfsTimetable.js` の区切り文字が NUL 文字（低・新規）

*場所*: [backend/src/services/gtfsTimetable.js:34-38](../backend/src/services/gtfsTimetable.js#L34-L38)

```js
// ※次の行のクォート内は見た目は半角スペースだが実際はNUL文字(U+0000)。
const SEP = ' ';
```

このためファイルが grep / ripgrep に**バイナリ扱い**され、通常の検索・一部のツールがヒットしない
（コメントで自認済み）。保守時の地雷。`' '` と明示するか、`\x1f`（Unit Separator）等の
「検索を壊さないがIDに現れない」文字に。

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
| DOC-1 | [backend/.env.example:48-49](../backend/.env.example#L48-L49)、README §8 の NIGHT_START/END 行 | 「当日便の生成と**車両割り当て**はこの時間帯でも動く」と書いてあるが、コードでは `assignPendingTrips`(④) は深夜帯に動かない（B-8） |
| DOC-2 | [docs/pass-detection.md](pass-detection.md) 末尾 vs [docs/known-issues.md](known-issues.md) M-5 | 通過バス停をGPSマッチ候補から除外しない挙動を、前者は「意図的な設計」、後者は「バグ」として記述（B-4） |
| DOC-3 | [backend/package.json:4](../backend/package.json#L4)、[backend/src/server.js:45](../backend/src/server.js#L45) | `description` と起動ログが「横田信大循環線 リアルタイム運行管理システム」。実体は松本市内 約40路線（A-2 と同根） |
| DOC-4 | README / CLAUDE.md の「複数路線対応」記述 vs `resolveRouteId` の単一路線デフォルト・`app.js` の `'11'` 固定 | 設計思想（複数路線）と実装の既定値（路線11）がずれている |

---

## 13. 優先度付き対応リスト（提案）

### すぐ（今週）

1. **S-1**: `ADMIN_PASSWORD` 未設定なら起動拒否。compose / .env.example に必須明記
2. **D-6**: `package-lock.json` をコミットし `npm ci` に切替
3. **B-1**: `ensureDailyTrips` の空 `activeServiceIds` 時に `builtServiceDate` を更新しない
4. **DOC-1〜4**: ドキュメントの誤り修正（コードは変えずまず記述を合わせる）
5. **A-1**: `migrate.js` に `require.main === module` ガード

### 近いうち（今月）

6. **G-2**: `seed()` を `pg_advisory_lock` で直列化
7. **G-3 / B-1**: GTFS差し替えを「別ディレクトリ展開 → rename 1回」に
8. **D-1**: パイプラインスキップの計上＋連続スキップアラート
9. **D-2**: フィード全滅・パイプライン停止の push 通知（Slack/メール）
10. **P-1 / P-4**: 区間統計の一括読み込み、`vehicle_gps_log` の一意制約
11. ~~**S-2**: 管理画面をサーバーセッション（httpOnly Cookie）へ~~ → ✅ 対応済み
12. ~~**S-3**: `/api/admin/*` と `/api/route-search` にレートリミット~~ → ✅ 対応済み
13. **DB-1**: `CURRENT_DATE` 比較のJST化、`db` コンテナに `TZ`

### 設計判断が要る（四半期）

14. **G-1**: GTFS 内容ハッシュ比較、`schedule_trips` 一意キーを `(route_id, gtfs_trip_id)` へ
15. **B-2 / X-1**: GPS途絶を中間状態にし復旧で復帰。利用者向け「追跡不能」表現
16. **B-3 / X-2**: 符号付き遅延の保存、早発アラート
17. **X-8**: APIワーカーとパイプラインワーカーの分離
18. **T-1 / T-2**: Postgres統合テスト＋CI
19. **F-3 / F-4**: フロントのビルド導入（Tailwindの静的CSS化）、PWA化
    — 依存のセルフホスト（**S-6**）は ✅ 対応済み
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
