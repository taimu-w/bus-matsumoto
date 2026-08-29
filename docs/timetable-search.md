# 時刻表検索機能の詳細（`services/gtfsTimetable.js` / `frontend/timetable.js`）

GTFSデータから、利用者がバス停名で検索し、時刻表と各便の通過時刻を確認できる機能です。
**リアルタイム運行状況とはデータ経路が完全に独立しています。**

## なぜDBを使わずGTFSファイルを直接読むのか

既存の`stops`テーブルは「路線 × 方向 × 停車順」で正規化されており（`seed.js`）、
**GTFSの`stop_id`・標柱（のりば）・`stop_headsign`を保持していません**。
時刻表検索はこれらをそのまま扱う必要があるため、既存テーブルからは復元できません。

一方でGTFSファイル自体は`gtfsFeedManager.js`によって常にディスク上へ展開されています。
そこで**GTFSファイルをそのままの粒度でメモリにインデックス化する**方式を採りました。

- 既存スキーマ・既存パイプラインに一切影響を与えない
- データ量が小さい（全フィード合計で バス停677件 / 標柱999件（座標統合前1023件）/ 便948件、構築約0.2秒）
- インクリメンタル検索がDB往復なしで返せる

インデックスは初回アクセス時（およびサーバー起動時の事前構築）に作られ、30分でTTL失効します。
GTFS更新に成功すると`gtfsFeedManager.js`が`invalidateTimetableIndex()`を呼び、次回アクセスで作り直されます。

## translations.txt の取り込みとローマ字の自動生成

`translations.txt`は`OPTIONAL_GTFS_FILES`として扱われます（**`REQUIRED`に足してはいけません**。持たないフィードでGTFS更新全体が失敗します）。

読み込みは2つの書式に対応します。

| 書式 | 列 |
|---|---|
| 現行GTFS | `table_name, field_name, language, translation, record_id, field_value` |
| GTFS-JP旧書式 | `trans_id, lang, translation` |

`language`の値（`ja-Hrkt` / `en` など）は事業者によってゆれるため、**値の内容で判定**します
（かなだけ→よみがな、ラテン文字を含む→ローマ字）。

よみがなはあるがローマ字が無い場合は、`utils/kana.js`が**ヘボン式ローマ字を自動生成**します。
検索インデックスには表記ゆれを吸収するため複数の綴りを登録します。

- 長音：`とうきょう` → `toukyou` と `tokyo` の両方
- 撥音：`しんばし` → `shinbashi` と `shimbashi` の両方
- 促音・拗音：`まっちゃ` → `matcha`、`きょう` → `kyo`

検索時の正規化（`normalizeSearchText`）はNFKC正規化 → 小文字化 → カタカナ→ひらがな →
空白・記号・長音符の除去、の順で行います。これにより「マツモト」「まつもと」「ﾏﾂﾓﾄ」「Matsumoto」
「ばすたーみなる」「basutaminaru」がすべて同じキーに落ちます。

> **漢字→よみがなの変換は行いません**（形態素解析が必要でGTFSの範囲外）。
> `translations.txt`が無いフィードでは、そのバス停は漢字表記でのみ検索できます。

## バス停の統合ルール

GTFS-JPのバス停は`100_03`のように「ベースID_枝番」で標柱（のりば）単位に分かれています。
以下の順で「1つのバス停」にまとめます。

1. **標柱→バス停**：`parent_station`があればそれ、無ければ`stop_id`の枝番を落としたベースIDでまとめる
2. **ベースIDが同じで名前も一致** → 同一バス停として統合。URLキーは`{stop_id}`（例：`/timetable/stops/52`）
3. **ベースIDが同じで名前が違う** → 別バス停。URLキーは`{gtfs_id}_{stop_id}`（例：`guruttomatsumotobus1_100`）
4. **同名かつ400m以内** → さらに1件へ統合（`SAME_NAME_MERGE_RADIUS_METERS`）

4が必要な理由：本システムは2つのGTFSフィードを扱いますが、**両フィードのベースIDは
完全に別体系**です（feed1の`100`＝松本バスターミナル、feed2の`100`＝上立田公民館。
231件のベースIDが名前違いで衝突しています）。一方で「本町」「松本駅お城口」のように
**同じ物理バス停が両フィードに別IDで登録されている**ケースがあり（88件）、
統合しないと検索結果に同じ名前が2つ並び、時刻表も事業者ごとに分断されてしまいます。

統合されて使われなくなったキーは**別名（alias）として保持**し、古いURLでも開けます。
別名でアクセスされた場合、フロントエンドが`replaceState`で正規URLへ書き換えます。

## のりばの座標統合

上の「バス停の統合ルール」が**バス停（＝標柱の集合）**を束ねるのに対し、こちらは
**標柱そのもの**を束ねる別レイヤーの処理です（`mergeCoincidentPlatforms`）。

2つのGTFSフィードは**同じ物理のりばをそれぞれ別`stop_id`で登録している**ため、
バス停として統合しても「乗り場別」表示では同じのりばが2枚のカードに割れ、時刻表も
フィードごとに分断されてしまいます（例：`清水`の`guruttomatsumotobus1:130_01`と
`guruttomatsumotobus2:580_01`は座標が完全一致）。

- 同一バス停内の標柱のうち、**座標差が`PLATFORM_MERGE_RADIUS_METERS`（0.1m）以内**の
  ものどうしを1本に畳みます。しきい値が極小なので、道路の反対側など別ののりばを
  巻き込むことはありません。
- **代表標柱は`config/feeds.js`の`PLATFORM_DISPLAY_NAME_FEED_PRIORITY`の順**
  （既定でぐるっと松本バス1）で選び、表示名・よみがな・`platform_code`・URL上の
  のりばキー（`?platform=`）は代表標柱のものに揃えます。
- 畳まれた標柱の`stop_times`は代表標柱に合算されるため、そののりばの時刻表には
  両フィードの便が並びます。停車路線・所属フィードの集計も両方を含みます。
- 畳まれた標柱の旧`?platform=`（`{stop_id}`／`{feed_id}_{stop_id}`の両形式）は
  `resolvePlatform`が代表標柱へ解決するため、古いURLでも開けます。
- 畳まれた標柱の行自体は`index.stops`に残します（`mergedInto`で代表を指す）。
  経路検索（`gtfsRouteSearch.js`）は`stop_times`→`stop`→`groupKey`でバス停を
  解決するため、行を消すとその便の乗降が拾えなくなるからです。

## 時刻表の組み立て

- 対象は「選択中のバス停に属する標柱」の`stop_times`。`platform`指定時はその標柱のみ。
- **`pickup_type = 1`（乗車不可）の停車は載せません**。終点や通過扱いの停車が発車時刻表に出てしまうためです。
- 運行日の判定は`calendar.txt`＋`calendar_dates.txt`（`exception_type` 1=運行/2=運休）に加え、
  **`start_date`〜`end_date`の有効期間もチェック**します。
- `frequencies.txt`を持つ便は`gtfsFrequencies.js`で仮想便に展開してから並べます。
- 時（縦軸）ごとに分（横軸）をまとめて返します。24時以降はGTFS表記のまま（24, 25…）保持し、
  画面側で「翌日」バッジ付きで表示します。

> **`getActiveServices()`（gtfsTimetable.js）と`getActiveServiceIds()`（gtfsCalendar.js）は
> 統合しないこと。** 後者は当日便生成専用でDB保存形式の文字列を返し、有効期間チェックを持ちません。
> 前者は任意の日付を指定でき、表示用ラベル（平日/土曜/…）を曜日フラグから機械的に生成します。
> `utils/time.js`の`getDayType()`（ETA統計用）も含め、曜日区分ロジックは用途ごとに3つ独立しています。

## GTFSデータの有効期間外の注意喚起

GTFSには有効期間があり、その期間を過ぎた日付のダイヤはダイヤ改正で変わり得ます。時刻表・経路検索
で期間外の日付が選ばれたとき、画面にポップアップで「ダイヤが変更される可能性がある」旨を出します。

- 期間の求め方（`computeFeedValidity`、フィードごと・純粋関数）は次の優先順です。
  1. `feed_info.txt` の `feed_start_date` / `feed_end_date`（`OPTIONAL_GTFS_FILES`。持たないフィードが多い）
  2. `calendar.txt` の全サービスの `start_date`〜`end_date` の最小〜最大
  3. `calendar_dates.txt` の運行追加日（`exception_type = 1`）
  `feed_info.txt` に片方だけあれば、欠けている側だけを 2・3 から補います。
- インデックス全体の有効期間は**全有効フィードの union**（最も早い `start`〜最も遅い `end`）です。
  ある日付が「期間外」と判定されるのは、**どのフィードの有効期間にも入っていないとき**だけで、
  誤検知（片方のフィードだけ期間が短い、など）を避けます。
- `feed_info.txt` を `REQUIRED_GTFS_FILES` に足さないこと。持たないフィードでGTFS更新が全滅します
  （`translations.txt`・運賃ファイルと同じ理由）。
- `GET /api/timetable/stops/:stopKey`・`GET /api/route-search`（成否問わず）のレスポンスに
  `gtfsValidity: { available, outOfRange, position: 'before'|'within'|'after', periodStart, periodEnd, date }`
  を含めます。画面側（`app.js` の `showGtfsExpiryNotice()`、`gtfs-expiry-modal`）は
  `outOfRange` が真のときだけポップアップを開き、同じ日付・同じ期間では一度しか出しません
  （再描画・リアルタイムポーリングでの出し直しを防ぐ）。

## 画面とURL

| 画面 | URL |
|---|---|
| 検索 | `/timetable` |
| バス停詳細（すべての乗り場） | `/timetable/stops/{stop_id}` |
| バス停詳細（乗り場別） | `/timetable/stops/{stop_id}?platform={platform_stop_id}` |
| 便詳細（通過時刻） | `/timetable/trips/{gtfs_id}/{route_id}/{trip_id}/{departure_time}` |

`date=YYYY-MM-DD`を付けると任意の日付のダイヤを表示します（省略時は当日）。
`departure_time`は始発バス停の出発時刻（`0805`形式）で、`frequencies.txt`由来の仮想便を
特定するために使います。URLの時刻と実データがずれている場合（GTFS改訂後の古いURLなど）は
`departureTimeMismatch`を立てて画面に注意書きを出し、404にはしません。

- **表示モード切替は標柱が2つ以上あるときだけ表示**します。
- 「乗り場別」を選ぶと「地図から選ぶ」（Leafletのピン）／「方面から選ぶ」（`stop_headsign`を路線カラー付きで一覧）を出します。
  `stop_headsign`が空の便は`trip_headsign`で代替します。
- **路線カラーの視認性**：`route_color`と白背景のコントラスト比が3未満の場合は数字を濃色にし、
  路線カラーは下線＋小さい円形バッジで表現します。判定は`frontend/timetable.js`の
  `routeColorStyle()`（WCAG相対輝度）にあります。
- 日付選択は日付ピッカーに加えて「平日／土曜日／日祝日」タグを持ち、タグはその区分に当てはまる
  **直近の日付へジャンプ**します。実際に適用されるダイヤはその日付に対してGTFSカレンダーから
  判定するので、祝日の特別ダイヤ（`calendar_dates.txt`）も自然に反映されます。
- **凡例（路線カラー）は、そのバス停に路線が2つ以上あるときだけタップで絞り込みボタンになります。**
  項目をタップするとその路線の発車だけを時刻表に残し、もう一度タップ／「すべて表示」で解除します。
  路線が1つのバス停では従来どおり表示専用です。絞り込みは`frontend/timetable.js`の
  `timetableRouteFilter`（画面内の一時状態）で持ち、凡例タップは`#tt-timetable-section`だけを
  再描画して再フェッチしません。バス停切替・日付変更・表示モード変更（`renderStopView`を通る操作）
  では解除されます。凡例と発車の突き合わせキーは`routeFilterKey(feedId, routeId)`で、`data`属性に
  載せて読み戻すため区切りは属性値として安全な文字（`|`）にしてあります（NUL等はHTMLパーサに
  `U+FFFD`へ置換され読み戻し時に一致しなくなります）。
