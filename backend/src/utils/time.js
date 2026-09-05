// タイムゾーンは常にAsia/Tokyo(JST)で統一する。

const TZ = 'Asia/Tokyo';

function nowInTokyo() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour') === '24' ? '0' : get('hour'), 10),
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10)
  };
}

function getNowTimeInt() {
  const t = nowInTokyo();
  return t.hour * 100 + t.minute;
}

/**
 * "HH:mm" を {h, m} に変換する。範囲外・書式違い・空値はすべて null を返す。
 *
 * 以前は parseInt に丸投げしていたため "23"（コロン無し）や "abc" でも
 * {h:23, m:NaN} / {h:NaN, m:NaN} を返し、呼び出し側（isNightTime）の比較が
 * すべて false ＝「常に非深夜」になっていた。不正値は null として明示し、
 * 呼び出し側が既定値へフォールバックできるようにする。
 */
function parseHHMM(str) {
  if (str === null || str === undefined) return null;
  const matched = /^\s*(\d{1,2}):(\d{1,2})\s*$/.exec(String(str));
  if (!matched) return null;
  const h = parseInt(matched[1], 10);
  const m = parseInt(matched[2], 10);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

/**
 * 深夜帯の境界時刻を「管理画面の上書き値 > 環境変数 > コード既定値」の順に解決する。
 * 途中の値が不正な書式だった場合はその段を飛ばし、次の候補（最終的にはコード既定値）を使う。
 */
function resolveNightBoundary(override, envValue, fallback) {
  return parseHHMM(override) || parseHHMM(envValue) || parseHHMM(fallback);
}

/**
 * 深夜帯判定。NIGHT_START〜NIGHT_ENDの範囲(日をまたぐ)で判定する。
 * 既定値は23:00〜5:00。
 *
 * 引数を省略した場合は従来どおり環境変数（未設定ならコード既定値）を見る。
 * 呼び出し側が管理画面での上書き値（services/runtimeSettings.js の
 * getRuntimeSetting('NIGHT_START'/'NIGHT_END')）を渡したい場合は、
 * その解決済みの値を引数で渡すこと。このファイル自体はDBアクセスを持たない
 * 純粋関数のままにしてある（CLAUDE.mdの「pure function」テスト方針、
 * および他の曜日区分ロジックと同じ「呼び出し側が外部データを渡す」設計に合わせるため）。
 *
 * 不正な書式の値（環境変数の打ち間違い等）は無視して既定値(23:00〜05:00)へ落ちる。
 * 「壊れた設定＝常に非深夜」にすると、深夜帯を止めたい運用者に無言で反対の挙動を
 * 返してしまうため。管理画面からの入力は config/runtimeSettingsCatalog.js の
 * validateSettingValue() が HH:mm を強制するので、ここへ不正値が届くのは環境変数経由だけ。
 */
function isNightTime(nightStartOverride, nightEndOverride) {
  const nightStart = resolveNightBoundary(nightStartOverride, process.env.NIGHT_START, '23:00');
  const nightEnd = resolveNightBoundary(nightEndOverride, process.env.NIGHT_END, '05:00');
  const startInt = nightStart.h * 100 + nightStart.m;
  const endInt = nightEnd.h * 100 + nightEnd.m;
  const t = getNowTimeInt();
  if (startInt > endInt) {
    // 日をまたぐ範囲（例: 23:00〜5:45）
    return t >= startInt || t <= endInt;
  }
  return t >= startInt && t <= endInt;
}

/**
 * 現在時刻を "H:mm" 形式（先頭ゼロなし、GASのformatTimeNoFormat相当）で返す。
 */
function formatNowNoFormat() {
  const t = nowInTokyo();
  return `${t.hour}:${String(t.minute).padStart(2, '0')}`;
}

/**
 * Dateを "H:mm" 形式に変換（JST基準）。
 */
function formatTimeNoFormat(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const h = get('hour') === '24' ? '0' : get('hour');
  return `${parseInt(h, 10)}:${get('minute')}`;
}

// 位置情報フィードのGPS時刻として受け付ける書式。
//   - "YYYY-MM-DD HH:MM(:SS)"（現行フィードの書式。区切りは "-" でも "/" でもよい）
//   - ISO 8601 の "YYYY-MM-DDTHH:MM:SS"（秒の小数部は無視する）
//   - 上記に "Z" / "+09:00" / "+0900" のタイムゾーン指定が付いたもの
// タイムゾーン指定が無い場合はJST(UTC+9・夏時間なし)として解釈する。
const GPS_TIME_PATTERN =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/;

/**
 * 位置情報フィードのGPS時刻文字列を Date に変換する。解釈できなければ null。
 *
 * 旧実装は `new Date(str.replace(/-/g, '/') + ' +0900')` の1行で、V8のパーサが
 * "YYYY/MM/DD HH:MM:SS" を受け付けることに完全に依存していた。フィードがISO 8601
 * （"2026-09-02T10:00:00+09:00" 等。Tやタイムゾーン指定が入る）へ変わると全行が
 * Invalid Date になり、位置情報が**1件も入らないまま**フィードは「正常」と記録される。
 *
 * ここでは書式を明示的にパターンで受けたうえで、日時としての妥当性（13月・25時など）の
 * 判定は従来どおりDateのパーサに委ねる。現行フィードの書式に対する結果は旧実装と同じ。
 */
function parseGpsTimeToDate(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const matched = GPS_TIME_PATTERN.exec(str);
  if (!matched) return null;

  const [, year, month, day, hour, minute, second, zone] = matched;
  let offset = '+0900';
  if (zone) offset = (zone === 'Z' || zone === 'z') ? '+0000' : zone.replace(':', '');

  const date = new Date(`${year}/${month}/${day} ${hour}:${minute}:${second || '00'} ${offset}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * "H:mm" 文字列を分単位の数値に変換（例: "8:30" -> 510）。不正値はNaN。
 */
function timeStrToMinutes(timeStr) {
  if (timeStr === null || timeStr === undefined) return NaN;
  const s = String(timeStr).trim();
  if (!s) return NaN;
  const parts = s.split(':');
  if (parts.length < 2) return NaN;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

/**
 * 分を "H:mm" 形式へ変換する。24時以降は0時へ折り返す（1500 → "1:00"）。
 *
 * 実時刻（GPS由来の実績・ETA予測の到着時刻）を文字列にするための関数。
 * GTFSの「運行日の0時起点」表記（24時超えをそのまま書く）が必要なところでは
 * minutesToServiceTimeStr() を使うこと。
 */
function minutesToTimeStr(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = ((minutes % 60) + 60) % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * 分を「運行日の0時起点」の "H:mm" 形式へ変換する。24時以降を折り返さない
 * （1500 → "25:00"）ため、GTFSの stop_times.txt と同じ表記になる。
 *
 * 定刻（schedule_stop_times / daily_trip_stop_times の scheduled_time、
 * daily_trips.start_time）はGTFSの表記をそのまま持つ列なので、frequencies由来の
 * 仮想便の定刻もこちらで作る。minutesToTimeStr() を使うと、同じ運行日の同じ時刻が
 * 素の便では "25:00"・仮想便では "1:00" と2通りに割れ、便詳細URLの departure_time
 * 突合（realtimeTripLookup.js の findLiveAssignment）が外れる。
 *
 * 1440分未満の値では minutesToTimeStr() と完全に同じ文字列を返す。
 * 負の値・非数は運行日表記として意味を持たないため minutesToTimeStr() に委ねる。
 */
function minutesToServiceTimeStr(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return minutesToTimeStr(minutes);
  const h = Math.floor(minutes / 60);
  const m = ((minutes % 60) + 60) % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * 運行日（サービス日）を "YYYY-MM-DD" 形式（JST基準）で返す。
 * daily_trips.service_date のキーとして使う。
 */
function getServiceDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * "YYYY-MM-DD" の運行日と「0時起点の分数」から、実時刻のDateを作る。
 * 分数が1440を超える場合（GTFSの24時超え表記）は翌日の時刻として正しく解釈する。
 * JSTは UTC+9 固定（夏時間なし）であることを利用する。
 */
function serviceDateTimeToDate(serviceDateStr, minutes) {
  const [y, m, d] = String(serviceDateStr).split('-').map((v) => parseInt(v, 10));
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d) || Number.isNaN(minutes)) return null;
  return new Date(Date.UTC(y, m - 1, d, -9, 0, 0) + minutes * 60 * 1000);
}

/**
 * 曜日区分（平日/土曜/休日）を判定する。ETA統計のバケット分けに使用。
 * 日曜日は常に「holiday」扱い。加えて holidaySet（'YYYY-MM-DD'のSet。
 * services/holidayCalendar.js の loadHolidaySet() が holidays テーブルから
 * 読み込む）に該当日が含まれる場合も「holiday」扱いとする。
 * holidaySet を渡さない場合は従来どおり日曜日のみholiday扱いになる
 * （このファイル自体はDBアクセスを持たない純粋関数のままにするため、
 * 祝日データの読み込みは呼び出し側の責務とする）。
 *
 * ※注意: GTFSのservice_id（平日/土休日）とは独立した、ETA統計専用の区分です。
 *   GTFSの曜日別ダイヤ適用は getActiveServiceIds()（gtfsCalendar.js）で行います。
 */
function getDayType(date = new Date(), holidaySet = null) {
  if (holidaySet && holidaySet.has(getServiceDateString(date))) return 'holiday';
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(date);
  if (wd === 'Sun') return 'holiday';
  if (wd === 'Sat') return 'saturday';
  return 'weekday';
}

function getDayOfWeek(date = new Date()) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd];
}

/**
 * 定刻(scheduledStr)と実績/予測時刻(actualStr)の差を、符号付きの分数で返す。
 * 正＝遅れ、負＝定刻より早い（早発・早着）、0＝定刻どおり。
 *
 * 「actual - scheduled が負ならそのまま +24h(1440分)する」という単純な日跨ぎ対策では、
 * 定刻より5分早く出発しただけで diff=-5 → 1435分遅れになってしまう。そのため
 * 「半日(720分)を超える」極端な差分のときだけ日跨ぎとみなして補正し、
 * 数分程度のズレは早発・早着としてそのまま符号付きで返す。
 *
 * この符号付きの値は「定刻より早く出た／着いた」という運行事故を残すための唯一の経路
 * （computeDelayMinutes() が0に丸めた値をDBへ入れると、あとから復元できない）。
 * 保存先は trip_stop_progress.signed_delay_minutes /
 * trip_vehicle_assignments.signed_delay_minutes / completed_trip_stop_times.signed_delay_minutes。
 *
 * @returns {number|null} 符号付きの差分（分）。時刻が不正な場合はnull。
 */
function computeSignedDelayMinutes(scheduledStr, actualStr) {
  const s = timeStrToMinutes(scheduledStr);
  const a = timeStrToMinutes(actualStr);
  if (Number.isNaN(s) || Number.isNaN(a)) return null;

  let diff = a - s;
  if (diff < -720) diff += 24 * 60; // 深夜便が日付を跨いだ場合のみ補正
  else if (diff > 720) diff -= 24 * 60;

  return diff;
}

/**
 * 利用者・運行監視に見せる「遅れ分数」。computeSignedDelayMinutes() の結果を0で下限を切る。
 *
 * 早発・早着を「遅れ0分」として扱うのは公開画面・遅延アラートの仕様
 * （「3分早い」を遅れとして出さない）。早いこと自体を知りたい場合は
 * computeSignedDelayMinutes() を使うこと。
 *
 * @returns {number|null} 遅延分数（0以上）。時刻が不正な場合はnull。
 */
function computeDelayMinutes(scheduledStr, actualStr) {
  const diff = computeSignedDelayMinutes(scheduledStr, actualStr);
  return diff === null ? null : Math.max(0, diff);
}

module.exports = {
  nowInTokyo,
  getNowTimeInt,
  isNightTime,
  formatNowNoFormat,
  formatTimeNoFormat,
  parseGpsTimeToDate,
  timeStrToMinutes,
  minutesToTimeStr,
  minutesToServiceTimeStr,
  getServiceDateString,
  serviceDateTimeToDate,
  getDayType,
  getDayOfWeek,
  computeDelayMinutes,
  computeSignedDelayMinutes
};