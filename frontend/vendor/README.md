# frontend/vendor/ — 同梱している外部ライブラリ

このディレクトリのファイルは**外部からダウンロードしてそのまま置いたサードパーティ製の配布物**です。
手で編集しないでください（更新は下記の手順でファイルごと差し替えます）。

## なぜ同梱しているか

以前は次の3本をCDNから直接読み込んでいました。

```html
<script src="https://cdn.tailwindcss.com"></script>                        <!-- Play CDN -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```

- どのタグにも `integrity=`（SRI）が無く、**CDNが汚染されたら任意のJSが利用者のブラウザで実行される**状態でした。
- `unpkg.com` は無保証の無料CDNで、障害が起きると地図（Leaflet）が丸ごと壊れます。
- `cdn.tailwindcss.com` はバージョンを固定しないURLで、上流の更新が予告なく本番の見た目に入ってきます。
- バス停でモバイル回線が細いときに、外部CDNが2つとも読めないと画面が真っ白になります。

同一オリジンから配信すればこの4つが同時に消えます（SRIは「別ホストから来たファイルが正しいか」を
確かめる仕組みなので、自分で配信するなら不要です）。詳細は
[docs/system-review-2026-09.md](../../docs/system-review-2026-09.md) の S-6 を参照してください。

## 中身とバージョン

| ファイル | サイズ(byte) | SHA-256 |
|---|---:|---|
| `leaflet/leaflet.css` | 14,806 | `sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=` |
| `leaflet/leaflet.js` | 147,552 | `sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=` |
| `leaflet/images/layers.png` | 696 | `sha256-Hbvp0CjikvNvy6j4s6KNXokydU/CIVuaxp5M3s9RB8Y=` |
| `leaflet/images/layers-2x.png` | 1,259 | `sha256-Bm2sqFDY/77wB68AsG6sABVyje4nnFHzy2xxbffELt8=` |
| `leaflet/images/marker-icon.png` | 1,466 | `sha256-V0w6XMqF9BFAhbaEFZbWLwDXyJLHsD8oy/owHesdxDc=` |
| `leaflet/images/marker-icon-2x.png` | 2,464 | `sha256-ABecTB7oMNOhCEEq4NKU9Vd2z+sIXGASmjmqb8SuJSg=` |
| `leaflet/images/marker-shadow.png` | 618 | `sha256-Jk9cZAM58ELdcpBiz8BMF/jqDymIK1OOOEjtjxDttNo=` |
| `tailwind/tailwind-3.4.17.js` | 407,279 | `sha256-F26JRmGqnNyaXLpscgBEy797i9gNHJoUKnwksbbFDRU=` |

- **Leaflet 1.9.4**（BSD-2-Clause）: `https://unpkg.com/leaflet@1.9.4/dist/` から取得。
  `leaflet.css` / `leaflet.js` のSHA-256は、Leaflet公式が配布ページに掲載しているSRI値と一致します。
- **Tailwind CSS 3.4.17 Play CDN**（MIT）: `https://cdn.tailwindcss.com/3.4.17` から取得。
  バージョン無しの `https://cdn.tailwindcss.com` は取得時点で 3.4.17 へリダイレクトされていたため、
  **同梱前と同じバージョン＝同じ見た目**になります。

### `leaflet/images/` を消さないこと

`leaflet.css` が `url(images/marker-icon.png)` のように**相対パスで**参照しており、
Leafletの既定マーカーもこのCSSからパスを検出します。`leaflet.css` と同じ階層に
`images/` が無いと、既定マーカーとレイヤー切替アイコンが表示されなくなります。

## 更新手順

1. 新しいバージョンを `frontend/vendor/` 配下へダウンロードする。

   ```bash
   # 例: Leaflet を x.y.z へ更新する場合（backend/ ではなくリポジトリのルートから）
   cd frontend/vendor/leaflet
   curl -fsSLO https://unpkg.com/leaflet@x.y.z/dist/leaflet.css
   curl -fsSLO https://unpkg.com/leaflet@x.y.z/dist/leaflet.js
   for f in layers.png layers-2x.png marker-icon.png marker-icon-2x.png marker-shadow.png; do
     curl -fsSL -o "images/$f" "https://unpkg.com/leaflet@x.y.z/dist/images/$f"
   done

   # 例: Tailwind Play CDN を x.y.z へ更新する場合
   curl -fsSL -o ../tailwind/tailwind-x.y.z.js https://cdn.tailwindcss.com/x.y.z
   ```

2. ダウンロードしたファイルのSHA-256を、配布元が公表しているSRI値と突き合わせる。

   ```bash
   openssl dgst -sha256 -binary leaflet.js | openssl base64 -A
   ```

3. **ファイル名にバージョンが入るTailwindは、参照している4つのHTMLを全部書き換える**
   （`frontend/index.html` / `admin.html` / `howto.html` / `servicestatus.html`）。
   1つでも古いままだと、そのページだけ別バージョンのTailwindで描画されます。
4. 上の表（ファイル名・サイズ・SHA-256）を更新する。
5. 画面を開いて、地図・ボタン・レイアウトが崩れていないか確認する
   （Tailwindはブラウザ内でCSSを生成するため、崩れはビルド時ではなく表示時にしか分かりません）。

## 残っている外部依存

- **Google Fonts**（`fonts.googleapis.com` / `fonts.gstatic.com`）は各HTMLからそのまま読み込んでいます。
  UAごとに内容が変わるためSRIを付けられず、セルフホストするには woff2 の同梱が必要です
  （[docs/system-review-2026-09.md](../../docs/system-review-2026-09.md) F-5）。
- **OpenStreetMapのタイルサーバ**は地図タイルの取得元としてそのまま使っています（同 D-7）。
- Tailwindはここに同梱した後も**ブラウザ内でCSSをコンパイルするPlay CDN版**のままです。
  初期描画のコストを下げるには、Tailwind CLIでビルドした静的CSSへ置き換える必要があります（同 F-3）。
