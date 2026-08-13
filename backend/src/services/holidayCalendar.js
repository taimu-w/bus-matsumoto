// 祝日カレンダーのメモリキャッシュ層。
//
// holidays テーブルは高々年に十数件程度しか増えないが、ETAのプリコンピュート
// パイプラインは60秒ごとに全active割り当て分の predictArrivals() を呼ぶため、
// 毎回DBへ問い合わせるのは無駄が大きい。TTL付きでメモリにキャッシュし、
// 管理画面から祝日を追加・削除したときだけ invalidateHolidayCache() で破棄する。
//
// ※ utils/time.js の getDayType() 自体はDBアクセスを持たない純粋関数のままとし、
//   ここで読み込んだ Set<'YYYY-MM-DD'> を呼び出し側から渡す形にしている
//   （CLAUDE.mdの「曜日区分ロジックは用途ごとに独立」方針を壊さないため）。

const TTL_MS = 60 * 60 * 1000; // 1時間

let cache = null; // Set<'YYYY-MM-DD'>
let cachedAt = 0;

async function loadHolidaySet(client) {
  const now = Date.now();
  if (cache && (now - cachedAt) < TTL_MS) return cache;

  const res = await client.query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM holidays`);
  cache = new Set(res.rows.map((row) => row.d));
  cachedAt = now;
  return cache;
}

function invalidateHolidayCache() {
  cache = null;
}

module.exports = { loadHolidaySet, invalidateHolidayCache };
