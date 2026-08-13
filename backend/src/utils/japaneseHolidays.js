// 日本の国民の祝日を計算する（内閣府「国民の祝日に関する法律」に基づく）。
//
// ETA統計の曜日区分(getDayType/holidayCalendar)のデフォルト値を埋めるためのもので、
// 実際の祝日運用は holidays テーブル（管理画面から編集可能）が正となる。
// ここで生成した値は seed.js が初期投入するだけで、以後はDBの内容が優先される。
//
// 春分の日・秋分の日は本来「国立天文台の観測に基づき前年2月の官報で確定」するため
// 未来の正確な日付は厳密には未定だが、以下は広く使われている近似式（1980〜2099年で成立）。
function vernalEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
function autumnalEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

// 指定月の「第n ○曜日」の日付を返す（weekday: 0=日,1=月,...6=土）。
function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = first.getUTCDay();
  return 1 + ((weekday - firstWeekday + 7) % 7) + (n - 1) * 7;
}

function toKey(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateOfKey(key) {
  const [y, m, d] = key.split('-').map((v) => parseInt(v, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysKey(key, days) {
  const d = dateOfKey(key);
  d.setUTCDate(d.getUTCDate() + days);
  return toKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * 指定年の国民の祝日一覧を算出する（振替休日・国民の休日を含む）。
 * @returns {Map<string,string>} 'YYYY-MM-DD' -> 祝日名
 */
function getNationalHolidays(year) {
  const holidays = new Map();
  const add = (month, day, name) => holidays.set(toKey(year, month, day), name);

  add(1, 1, '元日');
  add(1, nthWeekdayOfMonth(year, 1, 1, 2), '成人の日'); // 1月第2月曜
  add(2, 11, '建国記念の日');
  add(2, 23, '天皇誕生日');
  add(3, vernalEquinoxDay(year), '春分の日');
  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  add(7, nthWeekdayOfMonth(year, 7, 1, 3), '海の日'); // 7月第3月曜
  add(8, 11, '山の日');
  add(9, nthWeekdayOfMonth(year, 9, 1, 3), '敬老の日'); // 9月第3月曜
  add(9, autumnalEquinoxDay(year), '秋分の日');
  add(10, nthWeekdayOfMonth(year, 10, 1, 2), 'スポーツの日'); // 10月第2月曜
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');

  // 振替休日: 祝日が日曜の場合、その直後の「祝日でない日」を振替休日とする
  for (const key of [...holidays.keys()].sort()) {
    if (dateOfKey(key).getUTCDay() !== 0) continue;
    let next = addDaysKey(key, 1);
    while (holidays.has(next)) next = addDaysKey(next, 1);
    holidays.set(next, '振替休日');
  }

  // 国民の休日: 前日・翌日がともに祝日で、その日自体が祝日でない平日
  const original = [...holidays.keys()].sort();
  for (const key of original) {
    const nextNext = addDaysKey(key, 2);
    if (!holidays.has(nextNext)) continue;
    const between = addDaysKey(key, 1);
    if (holidays.has(between)) continue;
    if (dateOfKey(between).getUTCDay() === 0) continue; // 日曜は対象外
    holidays.set(between, '国民の休日');
  }

  return holidays;
}

module.exports = { getNationalHolidays };
