# 横田信大循環線 リアルタイム運行管理システム（Webアプリ版）

Google Apps Script + Googleスプレッドシートで構築されていた「ぐるっと松本バス 横田信大循環線」の
リアルタイム運行管理システムを、Visual Studio Codeでそのまま開いて実行できる
Node.js（Express） + PostgreSQL構成のWebアプリケーションへ全面移植したものです。

**リアルタイム位置情報の取得方法・取得先・フィルタ条件は、提供されたGASコードの仕様を忠実に踏襲しています。**
判定ロジック（営業開始・出発・臨時便・GPS通過判定・循環線対策・欠落補間・遅延計算・運行終了）も
元のアルゴリズムを解析し、同等以上の精度でWebアプリ向けに再実装しています。
到着予測のみ、仕様書の指示どおり単純加算方式から「過去の同曜日区分・同時間帯・同区間の走行実績」を
用いた高度化アルゴリズムに置き換えています。

---

## 1. 構成

```
bus-realtime-system/
├─ docker-compose.yml        Docker Compose定義（db + backend）
├─ Dockerfile                backendコンテナのビルド定義（frontendも同梱）
├─ .env.example              docker compose用の環境変数サンプル
├─ backend/                  Node.js (Express) + PostgreSQL バックエンド
│  ├─ docker-entrypoint.sh   コンテナ起動時の初期化（マイグレーション→シード→起動）
│  ├─ src/
│  │  ├─ server.js           起動エントリポイント（APIサーバー + 静的配信）
│  │  ├─ config/db.js        PostgreSQL接続プール
│  │  ├─ db/
│  │  │  ├─ schema.sql       テーブル定義
│  │  │  ├─ migrate.js       スキーマ適用スクリプト
│  │  │  └─ seed.js          バス停・時刻表データの初期投入
│  │  ├─ jobs/
│  │  │  ├─ pipeline.js      GASの連鎖実行(ReNewLocation→…→delay)を再現
│  │  │  └─ scheduler.js     ポーリング/終了判定のタイマー管理（GASトリガー相当）
│  │  ├─ services/           GAS各関数を1対1で移植したロジック本体
│  │  ├─ routes/api.js       REST API（/api/buses, /api/stops, /api/settings, /api/timetable）
│  │  └─ utils/              時刻・距離計算ユーティリティ
│  ├─ data/
│  │  ├─ stops.tsv           バス停マスタ（名称・緯度・経度、路線順）
│  │  └─ timetable.tsv       時刻表（48便 × 31バス停）
│  ├─ package.json
│  └─ .env.example           ローカル実行（Docker不使用）用の環境変数サンプル
└─ frontend/                 静的フロントエンド（ビルド不要・そのままブラウザで動作）
   ├─ index.html
   ├─ style.css
   └─ app.js
```

## 2. GASロジックとの対応表

| # | GAS関数 | 移植先 | 内容 |
|---|---|---|---|
| 1 | `ReNewLocation` | `services/locationFetcher.js` | CSVフィード取得・車両IDフィルタ・重複排除 |
| 2 | `SortCarID` | `services/vehicleAssigner.js` | 車両別ログへの転記・車両新規作成 |
| 3 | `StartBusiness` | `services/businessStart.js` | 始発バス停エリア進入検知（営業開始） |
| 4 | `departure` | `services/departure.js` | 始発エリアからの離脱検知（出発） |
| 5 | `planmaking` / `planmarevise` | `services/planMaking.js` | 出発時刻と時刻表の照合 |
| 6 | `specialbus` | `services/specialBus.js` | 営業開始未検知＋到着済3件以上→臨時便判定 |
| 7 | `pass`（Step1&3/Step2/補完） | `services/passDetection.js` | GPS通過判定・重複除去・循環線対策・線形補間 |
| 8 | `delay` | `services/delayCalc.js` | 定刻と実績の差分から遅延分数を算出 |
| 9 | `finish` | `services/finishService.js` | 運行終了判定・統計アーカイブ・車両レコード削除 |
| - | （新規）| `services/etaPredictor.js` | 仕様書9項: 過去統計×直近ペースによる高精度到着予測 |

循環線対策（同一地点を最初と最後に通る路線での誤作動防止）は `passDetection.js` 内で
GASと同一の2条件（直近到着バス停から4つ先までしか探索しない／出発20分以内は後半80%のバス停を除外）
をそのまま実装しています。

## 3. セットアップ手順

### 3.0 Dockerを使う場合（推奨・最短）

Node.jsやPostgreSQLをローカルに用意する必要はありません。Docker / Docker Composeのみで動作します。

```bash
cp .env.example .env
# 必要であれば .env を編集（LOCATION_FEED_URL 等は初期設定済みのためそのままで動作します）

docker compose up --build
```

- `db` コンテナ: PostgreSQL 16（データは `db_data` ボリュームに永続化）
- `backend` コンテナ: 起動時に自動でスキーマ作成・バス停/時刻表データ投入（`docker-entrypoint.sh`）を行い、
  そのままAPIサーバー兼フロントエンド配信を開始します。

起動後、ブラウザで `http://localhost:3000` を開いてください。

停止する場合:
```bash
docker compose down          # コンテナ停止（データは保持）
docker compose down -v       # コンテナ停止 + DBデータも削除
```

ログ確認:
```bash
docker compose logs -f backend
```

コード（`backend/src`配下）を編集した場合は、イメージの再ビルドが必要です:
```bash
docker compose up --build
```

### 3.1 Dockerを使わない場合の前提

- Node.js 18以上
- PostgreSQL 14以上（ローカルでもクラウドでも可）

### 3.2 手順（ローカル実行）

```bash
cd backend
cp .env.example .env
# .env を編集し、PostgreSQL接続情報を設定してください
# LOCATION_FEED_URL / TARGET_EXTRA_ID は既存GASと同一の値が初期設定済みです

npm install
npm run setup      # スキーマ作成 + バス停・時刻表データの投入
npm start          # サーバー起動（http://localhost:3000）
```

ブラウザで `http://localhost:3000` を開くとフロントエンドが表示されます。
起動と同時にバックグラウンドで位置情報ポーリング（既定60秒間隔）と
運行終了判定（10分間隔）が自動的に開始されます。

開発中は `npm run dev`（ファイル変更を検知して自動再起動）が便利です。

### 3.3 動作確認用API

```
GET /api/settings   お知らせ・重要なお知らせ
GET /api/stops      バス停マスタ一覧
GET /api/timetable  全便の時刻表
GET /api/buses      稼働中バスのリアルタイム運行状況（フロントエンドが20秒毎にポーリング）
```

## 4. 設定項目（`.env`）

`.env.example` に全項目とコメントを記載しています。主なもの：

| 変数 | 内容 |
|---|---|
| `LOCATION_FEED_URL` / `TARGET_EXTRA_ID` | 既存GASと同一のリアルタイム位置情報取得元 |
| `STOP_RADIUS_METERS` | バス停通過判定の半径（元GASの矩形範囲設定を円形判定に置換） |
| `START_AREA_RADIUS_METERS` / `DEPARTURE_OFFSET_METERS` | 営業開始・出発判定の距離しきい値 |
| `SCHEDULE_MATCH_BEFORE_MIN` / `SCHEDULE_MATCH_AFTER_MIN` | 出発時刻と時刻表便の照合許容範囲 |
| `VEHICLE_MAX_AGE_MIN` | 運行終了とみなす経過時間 |
| `NIGHT_START` / `NIGHT_END` | 深夜運行停止帯（既定 23:00〜5:45） |
| `POLL_INTERVAL_SECONDS` | メイン処理のポーリング間隔 |
| `ETA_BLEND_WEIGHT` | 到着予測における「過去統計」と「直近実績ペース」の重み（0〜1） |

矩形判定を円形（半径）判定に置き換えている点、始発・終点エリアも同様に半径ベースにしている点は、
仕様書13項「システム構成・アルゴリズムはより優れた構成があれば改善してよい」に基づく改善です。
挙動（何を検知するか）は同一のまま、保守しやすい構成にしています。

## 5. 到着予測アルゴリズムの高度化（仕様書9項対応）

`services/etaPredictor.js` を参照してください。概要：

1. 運行終了した便は `completed_trips` / `completed_trip_stop_times` にアーカイブされる。
2. `updateSegmentStats` が、区間（隣接バス停間）×曜日区分（平日/土曜/休日）×時間帯（時単位）で
   走行時間の移動平均を `segment_travel_stats` に蓄積する。
3. 稼働中バスの到着予測 (`predictArrivals`) は、
   - 直近1〜3区間の「実績 ÷ 基準所要時間」から現在の走行ペース（`liveFactor`）を算出し、
   - 統計サンプルが十分（既定3件以上）にある区間は「過去平均 × ペース補正」を採用し、
   - サンプル不足の区間は「時刻表上の所要時間 × ペース補正」にフォールバックし、
   - それも算出できない場合のみ、従来の単純遅延加算方式にフォールバックする。

これにより、「特定区間だけ遅れやすい」「平日朝夕は混みやすい」といった傾向を統計的に取り込みながら、
データが少ない立ち上げ初期でも常に予測値を返せるようにしています。

## 6. 複数路線への拡張について

本実装は提供されたデータ（横田信大循環線、31バス停・48便）に基づいています。
「浅間線」等の別路線を追加する場合は、`routes`テーブルの導入と、
`stops` / `schedule_trips` / `vehicles` に `route_id` 列を追加するだけで
同一のロジック（`services/*`）を再利用できるように設計してあります。

## 7. 既存システムからの主な変更点（設計判断）

- Googleスプレッドシートの「車両IDシート」1枚 → `vehicles` + `vehicle_gps_log` + `vehicle_stop_status` の
  3テーブルに正規化。同時アクセス・大量データでもロック待ちが発生しない設計。
- `SpreadsheetApp` / `google.script.run` は使用せず、Express製REST APIとfetchポーリングに置換。
- GASの矩形範囲判定（P:S列）は、保守しやすいハバーサイン距離による円形半径判定に置換（`.env`で調整可能）。
- 深夜帯停止・LockService相当の多重実行防止は `utils/time.js` の`isNightTime()` と
  `jobs/scheduler.js` の実行中フラグでそのまま再現。
