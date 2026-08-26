// ETA予測精度の監視用集計サービス（読み取り専用）。
//
// trip_arrival_prediction_log（etaPredictor.jsが追記するETA予測の時系列履歴。
// source='actual'の行がその停留所への実績到着時刻）を元に、「予測がいつの時点・
// 何停留所手前で出されたものか（リードタイム／stopsBefore）」と「実績」との誤差を、
// 路線・停留所・時間帯・曜日区分別に集計する。誤差の許容分数(thresholdMinutes)や、
// リードタイム／停留所数での絞り込みは呼び出し側（管理画面）が指定できる。
//
// 既存のETA計算（predictArrivals/computeAndStoreAllArrivals）やパイプラインには
// 一切書き込みを行わない、完全に独立した参照系モジュール。
//
// 【性能方針】サンプル数が増えても管理画面が重くならないよう、集計はすべてSQL側で
// 行う（2026年8月）。以前は「実績×予測」の突合結果を最大20000行そのままNodeへ
// 取り出してJSでループ集計していたため、
//   ・サンプルが増えるほど転送量とGCが膨らんで画面が固まる
//   ・20000行で打ち切られるため、期間内の一部（最新分）だけを見た偏った数字が出る
//     （しかも画面には「全期間の集計」として表示される）
// という2つの問題があった。現在は GROUPING SETS で全軸を1パスで集計し、明細
// （直近100件）だけを別クエリで取り出す。行数に依存するのはDB内の集計だけになり、
// レスポンスは軸ごとの集計値＋100件の明細という固定サイズに収まる。
const pool = require('../config/db');
const { getDayType } = require('../utils/time');
const { loadHolidaySet } = require('./holidayCalendar');
const { describeSource } = require('./etaPredictor');

const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;
const DEFAULT_THRESHOLD_MIN = 3;
const MAX_THRESHOLD_MIN = 30;
const SAMPLE_LIMIT = 100;
// 明細（直近100件）を作るために遡る「実績」の件数上限。実績1件につき複数の予測が
// 紐づくため、絞り込みが厳しくても100件を埋められる十分な余裕を取ってある。
// 全期間を突合し直さずに済ませるための上限であり、集計値には一切影響しない。
const SAMPLE_SCAN_ACTUALS = 3000;
const WORST_STOPS_LIMIT = 30;

// 集計結果のメモリキャッシュのTTL。ログに新しい行が増えるのはパイプラインが
// 走ったときだけなので、ポーリング間隔より短いTTLで持っても無駄に古くならない。
// 絞り込み条件を切り替えて見比べる操作（管理画面の主な使い方）が即応になる。
const CACHE_TTL_MS = Math.min(Math.max(parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10) || 60, 15), 300) * 1000;
const CACHE_MAX_ENTRIES = 24;

const LEAD_ORDER = ['5分未満', '5〜15分前', '15〜30分前', '30分以上前'];
const STOPS_BEFORE_ORDER = ['1停留所前', '2停留所前', '3停留所前', '4〜6停留所前', '7停留所以上前'];
const HOUR_ORDER = Array.from({ length: 24 }, (_, i) => i);
const DAY_TYPE_ORDER = ['weekday', 'saturday', 'holiday'];

// ==========================================================
// SQL片
// ==========================================================

/**
 * "H:mm"（utils/time.js の minutesToTimeStr が生成する形式）を0時起点の分数に
 * 変換するSQL式。timeStrToMinutes() と同じ扱いになるよう、NULLなど時刻として
 * 読めない値はNULLになる（＝そのサンプルは集計から落ちる）。
 *
 * ⚠️ 抽出に substring(col from '正規表現') を使わないこと。キャプチャ付きの正規表現
 * 抽出はPostgreSQLでは1回あたり25マイクロ秒程度かかり、10万件規模では数秒〜十数秒に
 * 膨らむ（実測: 34657行の2列変換で1.7秒）。形の検査だけを正規表現（`~`。こちらは
 * 十分に速い）で行い、取り出しは split_part に任せると同じ処理が5ミリ秒台で終わる。
 * 検査を通った文字列は必ず数字のみになるため、::int のキャスト失敗も起こり得ない。
 */
function timeToMinutesSql(col) {
  return `(CASE WHEN ${col} ~ '^[0-9]{1,2}:[0-9]{1,2}$'
            THEN split_part(${col}, ':', 1)::int * 60 + split_part(${col}, ':', 2)::int
          END)`;
}

// 誤差（実績 － 予測）の日跨ぎ補正。utils/time.js の computeDelayMinutes と同じ流儀で
// 半日を超える差だけを補正する。誤差は正負の符号を残す（早着/遅着の傾向＝バイアスを
// 見るため0でクランプしない）。
const ERROR_MINUTES_SQL = `CASE
          WHEN raw_diff < -720 THEN raw_diff + 1440
          WHEN raw_diff >  720 THEN raw_diff - 1440
          ELSE raw_diff
        END`;

// リードタイム区分・停留所数区分。ラベルは LEAD_ORDER / STOPS_BEFORE_ORDER を
// 唯一の定義元として埋め込む（画面のセレクトの値とも一致させるため）。
const LEAD_BUCKET_SQL = `CASE
          WHEN lead_minutes < 5  THEN '${LEAD_ORDER[0]}'
          WHEN lead_minutes < 15 THEN '${LEAD_ORDER[1]}'
          WHEN lead_minutes < 30 THEN '${LEAD_ORDER[2]}'
          ELSE '${LEAD_ORDER[3]}'
        END`;

const STOPS_BUCKET_SQL = `CASE
          WHEN stops_before IS NULL OR stops_before <= 0 THEN NULL
          WHEN stops_before = 1 THEN '${STOPS_BEFORE_ORDER[0]}'
          WHEN stops_before = 2 THEN '${STOPS_BEFORE_ORDER[1]}'
          WHEN stops_before = 3 THEN '${STOPS_BEFORE_ORDER[2]}'
          WHEN stops_before <= 6 THEN '${STOPS_BEFORE_ORDER[3]}'
          ELSE '${STOPS_BEFORE_ORDER[4]}'
        END`;

/**
 * ドリルダウン絞り込み（リードタイム区分／停留所数区分）に合致するかの判定式。
 * 区分がNULLの行（stops_before未記録の古い予測）は、区分を指定したときは
 * 合致しない扱いにする（JS版の `r.stopsBeforeBucket !== stopsBeforeBucket` と同じ）。
 */
function matchedSql(leadParam, stopsParam) {
  return `(COALESCE(${leadParam}::text IS NULL OR lead_bucket = ${leadParam}::text, FALSE)`
    + ` AND COALESCE(${stopsParam}::text IS NULL OR stops_before_bucket = ${stopsParam}::text, FALSE))`;
}

// ==========================================================
// 集計の器（SQLが返した部分集計を足し合わせるだけ）
// ==========================================================

function round1(v) {
  return Math.round(v * 10) / 10;
}

function emptyAgg() {
  return { count: 0, sumAbsError: 0, sumError: 0, withinThreshold: 0 };
}

/**
 * SQLの部分集計行（件数・誤差の合計）を器に加える。
 * count/sum系はbigintなのでnode-pgからは文字列で返る点に注意。
 */
function addAggRow(agg, count, sumAbsError, sumError, withinThreshold) {
  agg.count += Number(count);
  agg.sumAbsError += Number(sumAbsError);
  agg.sumError += Number(sumError);
  agg.withinThreshold += Number(withinThreshold);
}

function finalizeAgg(agg) {
  if (!agg || agg.count === 0) {
    return { sampleCount: 0, meanAbsErrorMinutes: null, meanErrorMinutes: null, withinThresholdRate: null };
  }
  return {
    sampleCount: agg.count,
    meanAbsErrorMinutes: round1(agg.sumAbsError / agg.count),
    meanErrorMinutes: round1(agg.sumError / agg.count),
    withinThresholdRate: round1((agg.withinThreshold / agg.count) * 100)
  };
}

// 絞り込み後（matched）の集計値を器に加える
function addMatched(agg, row) {
  addAggRow(agg, row.m_count, row.m_sum_abs, row.m_sum_err, row.m_within);
}

// 絞り込み前（全件）の集計値を器に加える
function addAll(agg, row) {
  addAggRow(agg, row.a_count, row.a_sum_abs, row.a_sum_err, row.a_within);
}

// ==========================================================
// クエリ
// ==========================================================

/**
 * 全軸の集計をGROUPING SETSで1パスで取る。
 *
 * 返る行は「どの軸の行か」をGROUPING()のフラグで見分ける（列がNULLかどうかでは
 * 判別できない。hourやstops_before_bucketは実データとしてもNULLを取り得るため）。
 *
 * m_*（matched）はドリルダウン絞り込み後、a_*（all）は絞り込み前の集計。
 * byLeadTime / byStopsBefore は「選択肢の全体像」を見せるため絞り込み前の数字を使い、
 * それ以外の軸は絞り込み後の数字を使う（従来のJS集計と同じ切り分け）。
 *
 * 曜日区分は service_date 単位で集計しておき、weekday/saturday/holiday への
 * まとめはJS側で getDayType() を使って行う。曜日区分の判定ロジックをSQLへ
 * 複製しないため（CLAUDE.md「曜日区分ロジックは用途ごとに独立」方針）。
 * 件数・誤差の合計はどちらも単純加算できるので、まとめても値は厳密に一致する。
 */
function buildAggregateQuery({ routeFilter }) {
  return `
    -- ⚠️ 各CTEの MATERIALIZED を外さないこと。
    -- PostgreSQLは参照が1回だけのCTEをインライン展開するため、外すと式が
    -- 「それを参照する上位の式の数」だけ複製される（error_minutes のCASEは
    -- raw_diff を5回、集計は error_minutes を8回参照する）。特に時刻のパースと
    -- リードタイムの numeric 演算が1行あたり数十回走り、実測で十数秒かかっていた。
    --
    -- また acts / preds を先に materialize することで、時刻のパースが
    -- 「突合結果の件数（10万件規模）」ではなく「ログの行数（3万件規模）」で済む。
    WITH acts AS MATERIALIZED (
      -- 実績が確定した停留所（source='actual'）。
      -- 部分インデックス idx_prediction_log_actual_* が効く形にしておく。
      SELECT l.assignment_id, l.stop_id, l.route_id,
             l.computed_at AS actual_logged_at,
             ${timeToMinutesSql('l.predicted_time')} AS actual_min,
             d.service_date::text AS service_date
      FROM trip_arrival_prediction_log l
      JOIN daily_trips d ON d.id = l.daily_trip_id
      WHERE l.source = 'actual'
        AND l.computed_at >= now() - make_interval(days => $1::int)
        ${routeFilter}
    ),
    preds AS MATERIALIZED (
      -- 突き合わせる予測側。期間で絞らないのは、期間の境目をまたぐ予測
      -- （予測は期間外・実績は期間内）も1サンプルとして数えるため。
      -- ログ自体が daily_trips の保持期間で消えるので件数は自然に頭打ちになる。
      SELECT p.assignment_id, p.stop_id, p.computed_at AS predicted_at, p.stops_before,
             ${timeToMinutesSql('p.predicted_time')} AS pred_min
      FROM trip_arrival_prediction_log p
      WHERE p.source <> 'actual'
    ),
    raw_pairs AS MATERIALIZED (
      -- 実績1件 × その停留所に対して以前に出された予測すべて（1予測=1サンプル）
      SELECT a.route_id, a.stop_id, a.service_date,
             (a.actual_min / 60) % 24 AS hour,
             a.actual_min - p.pred_min AS raw_diff,
             round(EXTRACT(EPOCH FROM (a.actual_logged_at - p.predicted_at))::numeric / 60, 1) AS lead_minutes,
             p.stops_before
      FROM acts a
      JOIN preds p
        ON p.assignment_id = a.assignment_id
       AND p.stop_id = a.stop_id
       AND p.predicted_at < a.actual_logged_at
      WHERE a.actual_min IS NOT NULL
    ),
    pairs AS MATERIALIZED (
      SELECT route_id, stop_id, service_date, hour,
             ${ERROR_MINUTES_SQL} AS error_minutes,
             ${LEAD_BUCKET_SQL} AS lead_bucket,
             ${STOPS_BUCKET_SQL} AS stops_before_bucket
      FROM raw_pairs
      WHERE raw_diff IS NOT NULL
        AND lead_minutes >= 0   -- 異常値除外
    ),
    flagged AS (
      SELECT route_id, stop_id, service_date, hour, error_minutes,
             lead_bucket, stops_before_bucket,
             ${matchedSql('$3', '$4')} AS matched
      FROM pairs
    ),
    agg AS (
      SELECT
        GROUPING(route_id)            AS g_route,
        GROUPING(stop_id)             AS g_stop,
        GROUPING(hour)                AS g_hour,
        GROUPING(service_date)        AS g_date,
        GROUPING(lead_bucket)         AS g_lead,
        GROUPING(stops_before_bucket) AS g_stops,
        route_id, stop_id, hour, service_date, lead_bucket, stops_before_bucket,
        count(*) FILTER (WHERE matched)                                                AS m_count,
        COALESCE(sum(abs(error_minutes)) FILTER (WHERE matched), 0)                    AS m_sum_abs,
        COALESCE(sum(error_minutes) FILTER (WHERE matched), 0)                         AS m_sum_err,
        count(*) FILTER (WHERE matched AND abs(error_minutes) <= $2::numeric)          AS m_within,
        count(*)                                                                       AS a_count,
        COALESCE(sum(abs(error_minutes)), 0)                                           AS a_sum_abs,
        COALESCE(sum(error_minutes), 0)                                                AS a_sum_err,
        count(*) FILTER (WHERE abs(error_minutes) <= $2::numeric)                      AS a_within
      FROM flagged
      GROUP BY GROUPING SETS (
        (),                       -- 全体
        (route_id),               -- 路線別
        (route_id, stop_id),      -- 停留所別（誤差の大きい停留所）
        (hour),                   -- 時間帯別
        (service_date),           -- 運行日別（JS側で曜日区分へまとめる）
        (lead_bucket),            -- リードタイム区分別
        (stops_before_bucket)     -- 停留所数区分別
      )
    )
    SELECT a.*, r.name AS route_name, s.name AS stop_name
    FROM agg a
    LEFT JOIN routes r ON r.id = a.route_id
    LEFT JOIN stops  s ON s.id = a.stop_id
  `;
}

/**
 * 明細（直近100件）。集計とは独立に、新しい実績から SAMPLE_SCAN_ACTUALS 件だけを
 * 遡って突合する。路線名・停留所名・便の始発時刻の結合はLIMIT後の100行に対してのみ
 * 行い、突合結果の全件に名前を付けて回すことを避ける。
 */
function buildSamplesQuery({ routeFilter }) {
  return `
    WITH recent_actuals AS (
      SELECT l.assignment_id, l.stop_id, l.route_id, l.daily_trip_id,
             l.predicted_time AS actual_time,
             l.computed_at AS actual_logged_at,
             ${timeToMinutesSql('l.predicted_time')} AS actual_min
      FROM trip_arrival_prediction_log l
      WHERE l.source = 'actual'
        AND l.computed_at >= now() - make_interval(days => $1::int)
        ${routeFilter}
      ORDER BY l.computed_at DESC
      LIMIT ${SAMPLE_SCAN_ACTUALS}
    ),
    raw_pairs AS MATERIALIZED (
      SELECT a.route_id, a.stop_id, a.daily_trip_id, a.actual_time, a.actual_logged_at,
             p.predicted_time, p.source, p.computed_at AS predicted_at, p.stops_before,
             a.actual_min - ${timeToMinutesSql('p.predicted_time')} AS raw_diff,
             round(EXTRACT(EPOCH FROM (a.actual_logged_at - p.computed_at))::numeric / 60, 1) AS lead_minutes
      FROM recent_actuals a
      JOIN trip_arrival_prediction_log p
        ON p.assignment_id = a.assignment_id
       AND p.stop_id = a.stop_id
       AND p.source <> 'actual'
       AND p.computed_at < a.actual_logged_at
      WHERE a.actual_min IS NOT NULL
    ),
    -- MATERIALIZED の理由は集計クエリ側のコメントを参照（式の重複展開を防ぐため）
    scored AS MATERIALIZED (
      SELECT route_id, stop_id, daily_trip_id, actual_time, actual_logged_at,
             predicted_time, source, predicted_at, stops_before, lead_minutes,
             ${ERROR_MINUTES_SQL} AS error_minutes,
             ${LEAD_BUCKET_SQL} AS lead_bucket,
             ${STOPS_BUCKET_SQL} AS stops_before_bucket
      FROM raw_pairs
      WHERE raw_diff IS NOT NULL
        AND lead_minutes >= 0
    ),
    picked AS (
      SELECT * FROM scored
      WHERE ${matchedSql('$2', '$3')}
      ORDER BY actual_logged_at DESC, predicted_at DESC
      LIMIT ${SAMPLE_LIMIT}
    )
    SELECT k.route_id, r.name AS route_name, s.name AS stop_name, d.start_time,
           k.source, k.predicted_time, k.actual_time,
           k.error_minutes, k.lead_minutes, k.stops_before
    FROM picked k
    LEFT JOIN routes r      ON r.id = k.route_id
    LEFT JOIN stops  s      ON s.id = k.stop_id
    LEFT JOIN daily_trips d ON d.id = k.daily_trip_id
    ORDER BY k.actual_logged_at DESC, k.predicted_at DESC
  `;
}

// ==========================================================
// 本体
// ==========================================================

async function computeAccuracyReport({ clampedDays, clampedThreshold, routeId, leadBucket, stopsBeforeBucket }) {
  const startedAt = Date.now();

  // 集計クエリと明細クエリはパラメータ番号が異なる（明細はthresholdを使わない。
  // 未参照のプレースホルダを残すとPostgreSQLが型を決められずエラーになる）。
  const aggParams = [clampedDays, clampedThreshold, leadBucket, stopsBeforeBucket];
  let aggRouteFilter = '';
  if (routeId) {
    aggParams.push(routeId);
    aggRouteFilter = `AND l.route_id = $${aggParams.length}`;
  }

  const sampleParams = [clampedDays, leadBucket, stopsBeforeBucket];
  let sampleRouteFilter = '';
  if (routeId) {
    sampleParams.push(routeId);
    sampleRouteFilter = `AND l.route_id = $${sampleParams.length}`;
  }

  // 3つは互いに独立なので並行に投げる（loadHolidaySetは通常メモリキャッシュに当たる。
  // clientではなくpoolを渡しているのは、同じ接続を直列に使い回す必要がないため）。
  const [aggRes, sampleRes, holidaySet] = await Promise.all([
    pool.query(buildAggregateQuery({ routeFilter: aggRouteFilter }), aggParams),
    pool.query(buildSamplesQuery({ routeFilter: sampleRouteFilter }), sampleParams),
    loadHolidaySet(pool)
  ]);

  let overall = emptyAgg();
  let totalSampleCount = 0;
  const byRoute = new Map();
  const byStop = new Map();
  const byHour = new Map();
  const byServiceDate = new Map();
  const byLead = new Map();
  const byStopsBefore = new Map();

  for (const row of aggRes.rows) {
    // 判定順序が重要: (route_id, stop_id) の行は g_route も 0 になるため、
    // 粒度の細かい軸から先に振り分ける。
    if (row.g_lead === 0) {
      if (!byLead.has(row.lead_bucket)) byLead.set(row.lead_bucket, emptyAgg());
      addAll(byLead.get(row.lead_bucket), row);
    } else if (row.g_stops === 0) {
      if (row.stops_before_bucket === null) continue; // 停留所数が未記録の予測はこの軸に出さない
      if (!byStopsBefore.has(row.stops_before_bucket)) byStopsBefore.set(row.stops_before_bucket, emptyAgg());
      addAll(byStopsBefore.get(row.stops_before_bucket), row);
    } else if (row.g_hour === 0) {
      if (row.hour === null) continue;
      if (!byHour.has(row.hour)) byHour.set(row.hour, emptyAgg());
      addMatched(byHour.get(row.hour), row);
    } else if (row.g_date === 0) {
      if (!byServiceDate.has(row.service_date)) byServiceDate.set(row.service_date, emptyAgg());
      addMatched(byServiceDate.get(row.service_date), row);
    } else if (row.g_stop === 0) {
      // 停留所は「路線＋停留所名」で1件にまとめる（同名の停留所が別IDで
      // 複数フィードから入ることがあり、名前で見せる画面と粒度を合わせるため）。
      const stopName = row.stop_name || '';
      const key = `${row.route_id}:${stopName}`;
      if (!byStop.has(key)) {
        byStop.set(key, { routeId: row.route_id, routeName: row.route_name, stopName, agg: emptyAgg() });
      }
      addMatched(byStop.get(key).agg, row);
    } else if (row.g_route === 0) {
      if (!byRoute.has(row.route_id)) byRoute.set(row.route_id, { routeName: row.route_name, agg: emptyAgg() });
      addMatched(byRoute.get(row.route_id).agg, row);
    } else {
      overall = emptyAgg();
      addMatched(overall, row);
      totalSampleCount = Number(row.a_count);
    }
  }

  // 運行日別の集計を曜日区分（平日/土曜/休日）へまとめる
  const byDayType = new Map();
  for (const [serviceDate, agg] of byServiceDate) {
    const dayType = getDayType(new Date(`${serviceDate}T12:00:00+09:00`), holidaySet);
    if (!byDayType.has(dayType)) byDayType.set(dayType, emptyAgg());
    const target = byDayType.get(dayType);
    target.count += agg.count;
    target.sumAbsError += agg.sumAbsError;
    target.sumError += agg.sumError;
    target.withinThreshold += agg.withinThreshold;
  }

  const worstStops = Array.from(byStop.values())
    .map((v) => ({ routeId: v.routeId, routeName: v.routeName, stopName: v.stopName, ...finalizeAgg(v.agg) }))
    .filter((v) => v.sampleCount > 0)
    .sort((a, b) => (b.meanAbsErrorMinutes - a.meanAbsErrorMinutes) || (b.sampleCount - a.sampleCount))
    .slice(0, WORST_STOPS_LIMIT);

  const samples = sampleRes.rows.map((row) => ({
    routeId: row.route_id,
    routeName: row.route_name,
    stopName: row.stop_name,
    startTime: row.start_time,
    source: row.source,
    basisLabel: describeSource(row.source).label,
    predictedTime: row.predicted_time,
    actualTime: row.actual_time,
    errorMinutes: Number(row.error_minutes),
    leadMinutes: Number(row.lead_minutes),
    stopsBefore: row.stops_before
  }));

  return {
    days: clampedDays,
    routeId: routeId || null,
    thresholdMinutes: clampedThreshold,
    leadBucket: leadBucket || null,
    stopsBeforeBucket: stopsBeforeBucket || null,
    sampleCount: overall.count,
    // 絞り込み前の総サンプル数（画面で「全体のうち何件を見ているか」を示すため）
    totalSampleCount,
    overall: finalizeAgg(overall),
    byRoute: Array.from(byRoute.entries())
      .map(([id, v]) => ({ routeId: id, routeName: v.routeName, ...finalizeAgg(v.agg) }))
      .filter((v) => v.sampleCount > 0)
      .sort((a, b) => (b.sampleCount - a.sampleCount) || String(a.routeName || a.routeId).localeCompare(String(b.routeName || b.routeId), 'ja')),
    byHour: HOUR_ORDER.filter((h) => byHour.has(h) && byHour.get(h).count > 0)
      .map((h) => ({ hour: h, ...finalizeAgg(byHour.get(h)) })),
    byDayType: DAY_TYPE_ORDER.filter((t) => byDayType.has(t) && byDayType.get(t).count > 0)
      .map((t) => ({ dayType: t, ...finalizeAgg(byDayType.get(t)) })),
    byLeadTime: LEAD_ORDER.filter((l) => byLead.has(l))
      .map((l) => ({ leadBucket: l, ...finalizeAgg(byLead.get(l)) })),
    byStopsBefore: STOPS_BEFORE_ORDER.filter((l) => byStopsBefore.has(l))
      .map((l) => ({ stopsBeforeBucket: l, ...finalizeAgg(byStopsBefore.get(l)) })),
    worstStops,
    samples,
    generatedAt: new Date().toISOString(),
    computeMs: Date.now() - startedAt
  };
}

// ==========================================================
// キャッシュ（同一条件の連打・複数タブからの同時アクセスをまとめる）
// ==========================================================

// key -> { expiresAt, promise }。値ではなくPromiseを持つことで、集計中に来た
// 同一条件のリクエストを1回のクエリに合流させる。
const reportCache = new Map();

function pruneCache(now) {
  for (const [key, entry] of reportCache) {
    if (entry.expiresAt <= now) reportCache.delete(key);
  }
  // TTL内でも条件の組み合わせは多いため、上限を超えたら古い順に捨てる
  while (reportCache.size > CACHE_MAX_ENTRIES) {
    reportCache.delete(reportCache.keys().next().value);
  }
}

/**
 * 予測精度レポートを生成する。
 * 「実績（source='actual'）が確定した停留所」ごとに、それ以前に記録された
 * 予測（source<>'actual'）の全履歴と突き合わせ、1予測=1サンプルとして誤差を集計する。
 * 同じ停留所でも予測は時間とともに何度も更新されるため、履歴全体を使うことで
 * 「早い段階の予測ほど誤差が大きい」といった傾向も見える。
 *
 * @param {object} opts
 * @param {number} [opts.days=7] 何日前までのデータを対象にするか（1〜31）
 * @param {string} [opts.routeId] 路線で絞り込み
 * @param {number} [opts.thresholdMinutes=3] 「誤差◯分以内」の◯分（1〜30。UIから変更可能）
 * @param {string} [opts.leadBucket] リードタイム区分で絞り込み（byLeadTimeの値のいずれか）
 * @param {string} [opts.stopsBeforeBucket] 停留所数区分で絞り込み（byStopsBeforeの値のいずれか）
 */
async function getAccuracyReport({
  days = DEFAULT_DAYS,
  routeId = null,
  thresholdMinutes = DEFAULT_THRESHOLD_MIN,
  leadBucket = null,
  stopsBeforeBucket = null
} = {}) {
  const clampedDays = Math.min(Math.max(parseInt(days, 10) || DEFAULT_DAYS, 1), MAX_DAYS);
  const clampedThreshold = Math.min(Math.max(parseFloat(thresholdMinutes) || DEFAULT_THRESHOLD_MIN, 0.5), MAX_THRESHOLD_MIN);
  // 区分は選択肢に無い値を弾く（SQLへ渡す前に正規化する）
  const normalizedLead = LEAD_ORDER.includes(leadBucket) ? leadBucket : null;
  const normalizedStops = STOPS_BEFORE_ORDER.includes(stopsBeforeBucket) ? stopsBeforeBucket : null;
  const opts = {
    clampedDays,
    clampedThreshold,
    routeId: routeId || null,
    leadBucket: normalizedLead,
    stopsBeforeBucket: normalizedStops
  };

  const now = Date.now();
  pruneCache(now);

  const key = JSON.stringify([opts.clampedDays, opts.clampedThreshold, opts.routeId, opts.leadBucket, opts.stopsBeforeBucket]);
  const cached = reportCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { ...(await cached.promise), cached: true };
  }

  const promise = computeAccuracyReport(opts);
  reportCache.set(key, { expiresAt: now + CACHE_TTL_MS, promise });
  try {
    return { ...(await promise), cached: false };
  } catch (err) {
    reportCache.delete(key); // 失敗はキャッシュしない
    throw err;
  }
}

module.exports = { getAccuracyReport, LEAD_ORDER, STOPS_BEFORE_ORDER };
