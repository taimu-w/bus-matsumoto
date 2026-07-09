// GASのユーティリティ関数（getNowTimeInt, isNightTime, timeStrToMinutes等）をNode.jsに移植したもの。
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

function parseHHMM(str) {
  // "23:00" -> {h:23, m:0}
  const [h, m] = String(str).split(':').map((v) => parseInt(v, 10));
  return { h, m };
}

/**
 * 深夜帯判定。.envのNIGHT_START〜NIGHT_ENDの範囲(日をまたぐ)で判定する。
 * 既定値は23:00〜5:45（元GASと同一）。
 */
function isNightTime() {
  const nightStart = parseHHMM(process.env.NIGHT_START || '23:00');
  const nightEnd = parseHHMM(process.env.NIGHT_END || '05:45');
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

/**
 * "H:mm" 文字列を分単位の数値に変換（例: "8:30" -> 510）。不正値はNaN。
 */
function timeStrToMinutes(timeStr) {
  if (timeStr === null || timeStr === undefined) return NaN;
  const s = String(timeStr).trim();
  if (!s || s === '↓' || s === '通過') return NaN;
  const parts = s.split(':');
  if (parts.length < 2) return NaN;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

/**
 * 分を "H:mm" 形式へ変換。
 */
function minutesToTimeStr(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = ((minutes % 60) + 60) % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * "H:mm" 形式の時刻文字列を、今日の日付のJST Dateオブジェクトへ変換する。
 * GPS時刻など「今日の時刻」を表す文字列の比較に用いる。
 */
function timeStrToDateToday(timeStr) {
  const { h, m } = parseHHMM(String(timeStr).includes(':') ? timeStr : `${timeStr}:00`);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const t = nowInTokyo();
  // JSTのHH:mm:ssをUTCに変換したDateを作る（JST = UTC+9固定、夏時間なし）
  const utcMs = Date.UTC(t.year, t.month - 1, t.day, h - 9, m, 0);
  return new Date(utcMs);
}

/**
 * 曜日区分（平日/土曜/休日）を判定する。ETA統計のバケット分けに使用。
 * 日本の祝日カレンダーは持たないため、日曜日のみ「holiday」扱いとし、
 * 祝日運用が必要な場合は system_settings に祝日リストを追加して拡張すること。
 */
function getDayType(date = new Date()) {
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
 * 定刻(scheduledStr)と実績/予測時刻(actualStr)から遅延分数を算出する。
 *
 * 修正前は「actual - scheduled が負ならそのまま +24h(1440分)する」という
 * 単純な日跨ぎ対策になっていたため、たとえば定刻より5分早く出発しただけの
 * ケースでも diff=-5 → 1435分遅れ、という意味不明な表示になってしまっていた。
 *
 * この路線は 6:05〜22:26 の間で運行が完結しており、実運用で日付を跨ぐことは
 * 基本的に無い。したがって「半日(720分)を超える」ような極端な差分のときだけ
 * 日跨ぎとみなして補正し、数分程度の早着・早発は単純に「遅れなし(0分)」として
 * 扱う。結果が負の場合（＝定刻より早い）は遅延ではないため 0 に丸める。
 *
 * @returns {number|null} 遅延分数（0以上）。時刻が不正な場合はnull。
 */
function computeDelayMinutes(scheduledStr, actualStr) {
  const s = timeStrToMinutes(scheduledStr);
  const a = timeStrToMinutes(actualStr);
  if (Number.isNaN(s) || Number.isNaN(a)) return null;

  let diff = a - s;
  if (diff < -720) diff += 24 * 60; // 深夜便が日付を跨いだ場合のみ補正
  else if (diff > 720) diff -= 24 * 60;

  return Math.max(0, diff);
}

module.exports = {
  nowInTokyo,
  getNowTimeInt,
  isNightTime,
  formatNowNoFormat,
  formatTimeNoFormat,
  timeStrToMinutes,
  minutesToTimeStr,
  timeStrToDateToday,
  getDayType,
  getDayOfWeek,
  computeDelayMinutes
};