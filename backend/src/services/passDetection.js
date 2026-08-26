// GPS走行ログとバス停マスタを突き合わせ、バス停通過を検知する。
//
// 便起点方式では処理単位が「車両」ではなく「便への割り当て(assignment)」になる。
// 担当車両・候補車両を区別せず、有効な割り当てすべてに対して同じ処理を行う（仕様書 9）。
// 判定アルゴリズム本体（循環線対策・巻き戻り防止・重複解消・欠落補完）は
// 従来のまま変更していない（仕様書 14）。
//   ① 直近の到着済バス停インデックスから4つ先までしか探索しない
//   ② 始発時刻から一定時間以内は、便全体の後半80%のバス停を候補から除外する。
//      除外時間は固定値ではなく、その便の時刻表上の所要時間（終着予定時刻－始発予定時刻）の
//      50%を便ごとに動的に算出する（例: 所要20分の便なら10分、40分の便なら20分）。
//      所要時間が算出できない場合のみ、従来の固定値20分にフォールバックする。
//   ③ ETAによる時間制約（ETA-7分 〜 ETA+20分）を満たすバス停だけを候補とする
//      （循環線対策の追加強化。①②の既存仕様はそのまま維持し、削除・弱体化しない）
//
// ③で使うETAは、trip_arrival_predictionsに保存されている値をpass()の開始時点で
// 読み取ったものを使う。パイプラインは 6:pass() → 7:delayCalc() → 8:computeAndStoreAllArrivals()
// の順で直列実行される（jobs/pipeline.js）ため、pass()実行時点でDBにあるETAは
// 必ず「前回のパイプライン実行」で計算されたものであり、今回のpass()の結果を
// 使って今回のETAが計算されるのはこの後（⑧）になる。したがって、ここでETAを
// 読むだけで到着判定とETA計算の循環依存は発生しない。
//
// 【2段階到着判定】（バス停到着判定およびフロントエンド表示改善案）
// 従来はSTOP_RADIUS_METERS以内に入った時点で即座に'到着済'としていたが、信号待ち・
// 渋滞・到着前の一時停止などで実際には未到着なのに到着済と誤判定されることがあった。
// これを解消するため、状態を '' → '付近' → '到着済' の2段階にした。
//   ・付近入り(passStepEntry): 上記①②③の判定ロジック本体は変更せず、判定結果の
//     行き先を「到着済に確定」ではなく「付近状態に入る」に変えただけ。
//     このときGPS点をtrip_gps_matchesに消費（従来と同じ）。
//   ・到着確定(passStepConfirm): 付近状態の間、観測した最小距離を
//     trip_stop_progress.nearby_min_distance_*に記録し続け（GPS点はtrip_gps_matches
//     に消費しないため、未消費のまま次バッチでも再評価され続ける）、現在距離が
//     「最小距離＋DEPARTURE_MARGIN_METERS」を上回った時点＝バス停から遠ざかり
//     始めたと判定し、'到着済'に確定する。actual_timeには離れたのを確認した時刻
//     ではなく、最小距離を記録した時点のGPS時刻を採用する。
//
// 【ベクトル通過判定】（到着判定高速化）
// 上記の離脱判定（passStepConfirm）は、最小距離＋マージン分だけ遠ざかるのを待つため、
// バス停通過から到着確定までにタイムラグがある。これを短縮するため、離脱判定とは別に
// 「GPSの移動がバス停を挟んで反対側へ抜けた」ことを直接検知する補助判定を追加する。
// 対象は「まだ到着済になっていない次の1停留所」1件のみ（findNextUnarrivedStop）。
// 循環線対策①（passStepEntryのlastArrivedIdx+4先までの探索）とは無関係で、そちらの
// 探索範囲・ロジックは変更しない。
//   ・過去位置P1・現在位置P2（同一assignmentのGPSログを時系列で隣接する2点）が、
//     ①P1-P2間の距離が10〜250m、②P1・P2ともに対象バス停から500m以内、
//     ③P1またはP2のどちらかが300m以内、④線分P1-P2と対象バス停の最短距離が50m以内、
//     ⑤対象バス停を挟んでP1とP2が反対側にいる、をすべて満たした場合のみ到着確定する
//     （evaluateVectorCrossing）。⑤の判定は、対象バス停を原点とする局所平面座標での
//     P1・P2それぞれの位置ベクトル（＝S→P1、S→P2）の内積が負であること＝符号反転＝
//     反対側、で判定する。
//   ・履歴不足（GPSが1点以下）・距離条件外など、上記のいずれかを満たさない場合は
//     この判定を行わず、従来の付近入り→離脱検知（passStepEntry→passStepConfirm）
//     だけで判定する（フォールバック）。
//   ・到着確定した場合のactual_timeは、線分P1-P2上でバス停に最も近い点の位置(t)を
//     使ってP1・P2のGPS時刻を線形補間した時刻を採用する。
//   ・従来の到着判定（付近入り・離脱検知・付近スタックの遡及昇格・欠落補完）は
//     一切変更せず並行して動作させる。同一バッチ内で従来判定が先に到着確定していた
//     場合はベクトル判定をスキップする（二重確定・二重ログの防止）。
const pool = require('../config/db');
const { haversineDistanceMeters, toLocalXYMeters } = require('../utils/geo');
const { timeStrToMinutes, minutesToTimeStr, formatTimeNoFormat } = require('../utils/time');
const { getRuntimeSetting } = require('./runtimeSettings');

// ETA時間制約のマージン（分）。早着側は7分、遅着側は20分と非対称にしている。
// 循環線で先のバス停を誤って拾うことを厳しく防ぎつつ、渋滞等による実際の遅延は
// ある程度許容するため。
const ETA_EARLY_MARGIN_MIN = 7;
const ETA_LATE_MARGIN_MIN = 20;

// 【循環線対策②】始発直後の除外時間は、便の時刻表上の所要時間の何%を使うか。
const EARLY_EXCLUSION_RATIO = 0.5;
// 所要時間（始発予定時刻・終着予定時刻）が算出できない便向けのフォールバック（旧・固定値）。
const EARLY_EXCLUSION_FALLBACK_MIN = 20;

// 【ベクトル通過判定】到着判定高速化のための補助判定のしきい値。
// P1-P2間の距離がこの範囲外の場合は判定しない（近すぎる＝停車中等のノイズ、
// 遠すぎる＝GPS途絶やフィード欠測による飛びの可能性があるため）。
const VECTOR_STEP_MIN_METERS = 10;
const VECTOR_STEP_MAX_METERS = 250;
// P1・P2ともにこの距離以内であること（大きく外れた無関係な移動を除外する）。
const VECTOR_STOP_RANGE_METERS = 500;
// P1またはP2のどちらかがこの距離以内であること（バス停に十分近づいた移動に限定する）。
const VECTOR_STOP_CLOSE_METERS = 300;
// 線分P1-P2と対象バス停の最短距離がこの距離以内であること。
const VECTOR_SEGMENT_DISTANCE_METERS = 50;

/**
 * 2つの"H:mm"由来の分数の差（a - b）を、日跨ぎを考慮して正規化する。
 * computeDelayMinutes（utils/time.js）と同じ「半日(720分)を超える差分だけ
 * 日跨ぎとみなす」考え方を踏襲する。この路線は日付を跨がない運行のため、
 * 720分を超える差は「前日/翌日を跨いだ見かけ上の差」とみなして補正する。
 */
function diffMinutesSigned(aMin, bMin) {
  let diff = aMin - bMin;
  if (diff < -720) diff += 24 * 60;
  else if (diff > 720) diff -= 24 * 60;
  return diff;
}

/**
 * 処理対象の割り当て一覧。担当・候補の両方が対象。
 */
async function getActiveAssignments(client) {
  const res = await client.query(
    `SELECT a.id AS assignment_id, a.vehicle_id, a.role,
            d.id AS daily_trip_id, d.route_id, d.start_time, d.start_at,
            v.car_id
     FROM trip_vehicle_assignments a
     JOIN daily_trips d ON d.id = a.daily_trip_id
     JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.state = 'active'
     ORDER BY a.id ASC`
  );
  return res.rows;
}

/**
 * その便の停留所と現在の進捗。便の停車パターンだけが対象になるため、
 * 路線に属していてもその便が通らないバス停は最初から含まれない。
 */
async function getStopMaster(client, assignmentId) {
  const res = await client.query(
    `SELECT p.stop_id, p.seq_order, p.status, p.scheduled_time, s.name, s.lat, s.lon, s.notice,
            p.nearby_min_distance_meters, p.nearby_min_distance_gps_time, p.nearby_min_distance_gps_time_ts
     FROM trip_stop_progress p
     JOIN stops s ON s.id = p.stop_id
     WHERE p.assignment_id = $1
     ORDER BY p.seq_order ASC`,
    [assignmentId]
  );
  return res.rows;
}

/**
 * その割り当てについて、直前のパイプライン実行で計算され、
 * trip_arrival_predictionsに保存されているETA（predicted_time）を
 * stop_idごとに取得する。今回のpass()実行より後（⑧）に計算される
 * 新しいETAは使わない。
 */
async function getEtaMap(client, assignmentId) {
  const res = await client.query(
    `SELECT stop_id, predicted_time FROM trip_arrival_predictions WHERE assignment_id = $1`,
    [assignmentId]
  );
  const map = new Map();
  for (const row of res.rows) {
    if (row.predicted_time) map.set(row.stop_id, row.predicted_time);
  }
  return map;
}

/**
 * 【循環線対策②】始発直後に後半80%のバス停を除外する時間（分）を、
 * その便の時刻表上の所要時間（終着予定時刻－始発予定時刻）の50%として算出する。
 * 終着予定時刻は、末尾から探して最初に見つかった有効な scheduled_time
 * （通常は末尾＝終点バス停のscheduled_timeがそのまま採用される。GTFSデータが
 * 一部欠損している場合のみ、末尾から遡って有効な時刻を探す）を使う。
 * 所要時間を算出できない場合は従来の固定値にフォールバックする。
 */
function computeEarlyExclusionMin(assignment, stopMaster) {
  const startSchedMin = timeStrToMinutes(assignment.start_time);
  let endSchedMin = NaN;
  for (let i = stopMaster.length - 1; i >= 0; i--) {
    const m = timeStrToMinutes(stopMaster[i].scheduled_time);
    if (!Number.isNaN(m)) {
      endSchedMin = m;
      break;
    }
  }
  if (Number.isNaN(startSchedMin) || Number.isNaN(endSchedMin)) return EARLY_EXCLUSION_FALLBACK_MIN;

  let durationMin = endSchedMin - startSchedMin;
  if (durationMin < 0) durationMin += 24 * 60; // 日跨ぎ対策（念のため）
  if (durationMin <= 0) return EARLY_EXCLUSION_FALLBACK_MIN;

  return durationMin * EARLY_EXCLUSION_RATIO;
}

/**
 * 【付近入り(entry)】判定アルゴリズム本体（①②③）は従来のpassStep1And3から変更していない。
 * 変わったのは判定結果の意味づけだけ：「到着済に確定」ではなく「付近状態に入る（最初の
 * 近接観測）」を表す候補を返す。到着済・付近いずれかの状態のバス停は、既に確定済みか
 * 既に追跡中のため、新規の付近入り候補から除外する（excludedSet）。
 */
function passStepEntry(assignment, stopMaster, gpsRows, radiusMeters, etaByStopId) {
  const totalStops = stopMaster.length;
  // 旧実装の「出発時刻からの経過分」に相当する基準。便起点方式では便の始発時刻を使う。
  const startMin = timeStrToMinutes(assignment.start_time);
  // 【循環線対策②】この便の所要時間から動的に算出した除外時間（分）
  const earlyExclusionMin = computeEarlyExclusionMin(assignment, stopMaster);

  // DB上で確定している「最後に到着したバス停」のインデックスを取得
  // 【循環線対策】このバッチ処理中は、この基準値を書き換えない（固定する）
  let lastArrivedIdx = -1;
  for (let i = stopMaster.length - 1; i >= 0; i--) {
    if (stopMaster[i].status === '到着済') {
      lastArrivedIdx = stopMaster[i].seq_order;
      break;
    }
  }

  // 【巻き戻り防止用】バッチ内での進行状況を記録する変数（初期値はDBの直近バス停）
  let currentMaxIdx = lastArrivedIdx;

  // 【2段階到着判定】到着済はもちろん、既に付近状態で追跡中のバス停も
  // 新規の付近入り候補から除外する（二重に付近入りさせないため）。
  const excludedSet = new Set(
    stopMaster.filter((s) => s.status === '到着済' || s.status === '付近').map((s) => s.seq_order)
  );
  const tentativeMatches = [];

  for (const gps of gpsRows) {
    const gpsMin = timeStrToMinutes(gps.gps_time);
    const minSinceStart = !Number.isNaN(startMin) && !Number.isNaN(gpsMin) ? gpsMin - startMin : NaN;

    let best = null;
    for (const stop of stopMaster) {
      if (excludedSet.has(stop.seq_order)) continue;

      // 【巻き戻り防止】すでに通過した（またはこのバッチ内で通過判定が出た）バス停は除外
      if (stop.seq_order <= currentMaxIdx) continue;

      // 【循環線対策①】探索範囲の制限（確定している直近バス停の4つ先まで）
      if (lastArrivedIdx !== -1 && stop.seq_order > lastArrivedIdx + 4) continue;

      // 【循環線対策②】初期の誤判定防止（始発からearlyExclusionMin分以内は後半80%を除外）
      if (!Number.isNaN(minSinceStart) && minSinceStart < earlyExclusionMin && stop.seq_order / totalStops > 0.8) continue;

      // 【距離制約】STOP_RADIUS_METERS以内のバス停だけを候補とする
      const dist = haversineDistanceMeters(gps.lat, gps.lon, stop.lat, stop.lon);
      if (dist > radiusMeters) continue;

      // 【時間制約(ETA)】ETA-7分 <= 現在時刻 <= ETA+20分を満たさない候補は除外する。
      // 対象バス停にETAが存在しない場合は、この制約を適用せず既存の挙動のまま
      // （距離・順番制約のみ）で候補として扱う。ETA未計算を理由に到着判定を
      // 止めないため。
      const etaStr = etaByStopId && etaByStopId.get(stop.stop_id);
      if (etaStr) {
        const etaMin = timeStrToMinutes(etaStr);
        if (!Number.isNaN(etaMin) && !Number.isNaN(gpsMin)) {
          const diff = diffMinutesSigned(gpsMin, etaMin);
          if (diff < -ETA_EARLY_MARGIN_MIN || diff > ETA_LATE_MARGIN_MIN) continue;
        }
      }

      if (!best || dist < best.dist) {
        best = { stopId: stop.stop_id, seqOrder: stop.seq_order, stopName: stop.name, dist };
      }
    }

    if (best) {
      tentativeMatches.push({
        gpsRowId: gps.id,
        gpsTime: gps.gps_time,
        gpsTimeTs: gps.gps_time_ts,
        lat: gps.lat,
        lon: gps.lon,
        ...best
      });

      // 【巻き戻り防止】マッチしたバス停を記録し、次のGPSログからはこれより前を探索させない
      currentMaxIdx = Math.max(currentMaxIdx, best.seqOrder);
    }
  }

  return tentativeMatches;
}

function passStep2Dedup(matches, stopMaster) {
  const coordByStop = new Map(stopMaster.map((s) => [s.stop_id, { lat: s.lat, lon: s.lon }]));
  const byStop = new Map();
  for (const m of matches) {
    if (!byStop.has(m.stopId)) byStop.set(m.stopId, []);
    byStop.get(m.stopId).push(m);
  }
  const kept = [];
  for (const [stopId, arr] of byStop.entries()) {
    if (arr.length === 1) {
      kept.push(arr[0]);
      continue;
    }
    const coord = coordByStop.get(stopId);
    arr.sort((a, b) => {
      const da = haversineDistanceMeters(a.lat, a.lon, coord.lat, coord.lon);
      const db = haversineDistanceMeters(b.lat, b.lon, coord.lat, coord.lon);
      return da - db;
    });
    kept.push(arr[0]);
  }
  return kept;
}

/**
 * 【到着確定の判定（純粋関数）】「付近」状態のバス停から、観測した最小距離より
 * marginMeters以上離れたことを検知したら、バス停から遠ざかり始めた＝到着確定とみなす。
 * 信号待ち・渋滞・到着前の一時停止など、120m圏内での小刻みな距離の増減を
 * 到着確定と誤判定しないためのマージンである。
 */
function shouldConfirmDeparture(currentDist, minDist, marginMeters) {
  return currentDist > minDist + marginMeters;
}

/**
 * DB上で既に「付近」状態のバス停（stopMaster由来）と、このバッチでpassStepEntry+
 * passStep2Dedupにより新たに「付近」入りしたバス停（freshEntries）をマージし、
 * passStepConfirmが扱う追跡対象一覧を作る。座標は常にバス停自身のもの（GPS点ではない）。
 */
function buildNearbyTrackingState(stopMaster, freshEntries) {
  const coordByStop = new Map(stopMaster.map((s) => [s.stop_id, { lat: s.lat, lon: s.lon }]));
  const list = [];
  const seen = new Set();

  for (const s of stopMaster) {
    if (s.status !== '付近') continue;
    const coord = coordByStop.get(s.stop_id);
    list.push({
      stopId: s.stop_id,
      seqOrder: s.seq_order,
      lat: coord.lat,
      lon: coord.lon,
      minDist: s.nearby_min_distance_meters,
      minGpsTime: s.nearby_min_distance_gps_time,
      minGpsTimeTs: s.nearby_min_distance_gps_time_ts
    });
    seen.add(s.stop_id);
  }

  for (const m of freshEntries) {
    if (seen.has(m.stopId)) continue;
    const coord = coordByStop.get(m.stopId);
    if (!coord) continue;
    list.push({
      stopId: m.stopId,
      seqOrder: m.seqOrder,
      lat: coord.lat,
      lon: coord.lon,
      minDist: m.dist,
      minGpsTime: m.gpsTime,
      minGpsTimeTs: m.gpsTimeTs
    });
  }

  return list;
}

/**
 * 【付近→到着済確認(confirm)】「付近」状態の各バス停について、GPSログ（gpsRowsは
 * gps_time_ts昇順）を走査し、最小距離の更新・到着確定（離脱検知）を判定する。
 *
 * 記録済みの最小距離の観測時刻(minGpsTimeTs)より前のGPS点は評価しない。これを
 * 怠ると、未消費のまま時間窓に残っていた古いGPS点（②の除外時間帯にいたため
 * 付近入りできなかった点など）が、実際の付近入りより前の見かけ上「近い」距離として
 * 紛れ込み、actual_timeを不正な過去時刻へ巻き戻してしまう。最小距離は常に時間的に
 * 前進する方向にしか更新しない。
 *
 * 到着確定時のactual_timeは、遠ざかったのを確認した時刻ではなく、最小距離を
 * 記録した時点のGPS時刻を採用する。
 *
 * ①②③（探索範囲・始発直後の除外・ETA制約）は付近入りの時点で既に適用済みのため
 * ここでは再適用しない。到着確定は純粋に「最小距離からの離脱」だけで判定する。
 */
function passStepConfirm(nearbyStops, gpsRows, marginMeters) {
  const results = [];

  for (const stop of nearbyStops) {
    let currentMinDist = stop.minDist;
    let currentMinGpsTime = stop.minGpsTime;
    let currentMinGpsTimeTs = stop.minGpsTimeTs;
    let confirmedActualTime = null;

    for (const gps of gpsRows) {
      if (currentMinGpsTimeTs && new Date(gps.gps_time_ts).getTime() < new Date(currentMinGpsTimeTs).getTime()) {
        continue;
      }

      const dist = haversineDistanceMeters(gps.lat, gps.lon, stop.lat, stop.lon);

      if (currentMinDist === null || currentMinDist === undefined || dist < currentMinDist) {
        currentMinDist = dist;
        currentMinGpsTime = gps.gps_time;
        currentMinGpsTimeTs = gps.gps_time_ts;
        continue;
      }

      if (shouldConfirmDeparture(dist, currentMinDist, marginMeters)) {
        confirmedActualTime = currentMinGpsTime;
        break;
      }
    }

    if (confirmedActualTime) {
      results.push({ type: 'confirm', stopId: stop.stopId, seqOrder: stop.seqOrder, actualTime: confirmedActualTime });
    } else if (currentMinDist !== stop.minDist) {
      results.push({
        type: 'refine',
        stopId: stop.stopId,
        minDist: currentMinDist,
        minGpsTime: currentMinGpsTime,
        minGpsTimeTs: currentMinGpsTimeTs
      });
    }
  }

  return results;
}

/**
 * 【ベクトル判定の対象選定】まだ「到着済」になっていない次の1停留所だけを返す（純粋関数）。
 * stopMasterはseq_order昇順であることが前提（getStopMasterのORDER BY seq_order ASCで保証）。
 *
 * passStepEntryの「lastArrivedIdx+4先まで」の探索とは別の独立したロジックであり、
 * 複数候補ではなく単一の対象（DB確定済みの最後の到着済バス停の直後の1停留所）だけを返す。
 * 該当する停留所がない場合（全停留所が到着済＝実質終点到達済み）はnullを返す。
 *
 * extraArrivedSeqOrders（省略可）は、stopMaster取得後・同一バッチ内で新たに到着確定した
 * seq_orderの一覧。stopMasterはバッチ処理開始時点のスナップショットのため、その後
 * passStepConfirmで到着確定したバス停の状態を反映していない。これを渡さないと、
 * 直前に確定したばかりのバス停を「まだ未到着」として誤って対象にしてしまう
 * （呼び出し側のconfirmedThisBatchチェックでDB更新自体は防げるが、次に進めず
 * 1周期分ベクトル判定の機会を逃してしまう）。
 */
function findNextUnarrivedStop(stopMaster, extraArrivedSeqOrders) {
  let lastArrivedSeq = -1;
  for (let i = stopMaster.length - 1; i >= 0; i--) {
    if (stopMaster[i].status === '到着済') {
      lastArrivedSeq = stopMaster[i].seq_order;
      break;
    }
  }
  if (extraArrivedSeqOrders) {
    for (const seq of extraArrivedSeqOrders) {
      if (seq > lastArrivedSeq) lastArrivedSeq = seq;
    }
  }
  for (const stop of stopMaster) {
    if (stop.seq_order > lastArrivedSeq) return stop;
  }
  return null;
}

/**
 * 【ベクトル通過判定（純粋関数）】過去位置P1・現在位置P2を結ぶ移動が、対象バス停Sを
 * 挟んで反対側へ抜けたかどうかを判定する。従来の付近入り→離脱検知（passStepConfirm）
 * とは独立して動作する、到着判定を早めるための補助判定。
 *
 * 前提条件（距離レンジ）→線分条件（Sと線分P1-P2の最短距離）→ベクトル条件（反対側判定）
 * の順に評価し、いずれかを満たさない時点でconfirmed:falseを返す（reasonに理由を入れる。
 * デバッグ・テスト用）。すべて満たした場合のみconfirmed:trueを返す。
 *
 * ベクトル条件について：仕様上はA=P1→S、B=S→P2の内積で表現されるが、この2ベクトルの
 * 内積は「PとSを挟んで反対側にいるか」に対して符号が逆になる（P1→Sの終点とS→P2の
 * 始点をそろえると、A・Bが同じ向きに並ぶのは反対側へ抜けた場合であり、その内積は正になる）。
 * そのため実装では、対象バス停Sを原点とする局所平面座標でのP1・P2それぞれの位置ベクトル
 * （S→P1、S→P2。同一基準点からの相対位置ベクトル）の内積を使う。この内積が負＝符号反転＝
 * P1とP2がSを挟んで反対側にいる、と判定する（数直線上で2値の積が負なら符号が異なる、
 * という古典的な判定と同じ考え方）。
 */
function evaluateVectorCrossing(p1, p2, stop) {
  const stepDist = haversineDistanceMeters(p1.lat, p1.lon, p2.lat, p2.lon);
  if (stepDist < VECTOR_STEP_MIN_METERS || stepDist > VECTOR_STEP_MAX_METERS) {
    return { confirmed: false, reason: 'step_distance_out_of_range', debug: { stepDist } };
  }

  const distP1Stop = haversineDistanceMeters(p1.lat, p1.lon, stop.lat, stop.lon);
  const distP2Stop = haversineDistanceMeters(p2.lat, p2.lon, stop.lat, stop.lon);
  if (distP1Stop > VECTOR_STOP_RANGE_METERS || distP2Stop > VECTOR_STOP_RANGE_METERS) {
    return { confirmed: false, reason: 'too_far_from_stop', debug: { stepDist, distP1Stop, distP2Stop } };
  }
  if (distP1Stop > VECTOR_STOP_CLOSE_METERS && distP2Stop > VECTOR_STOP_CLOSE_METERS) {
    return { confirmed: false, reason: 'not_close_enough', debug: { stepDist, distP1Stop, distP2Stop } };
  }

  // 対象バス停Sを原点とする局所平面座標。p1xy・p2xyはそのままS→P1、S→P2の位置ベクトル。
  const p1xy = toLocalXYMeters(p1.lat, p1.lon, stop.lat, stop.lon);
  const p2xy = toLocalXYMeters(p2.lat, p2.lon, stop.lat, stop.lon);

  // 線分条件：線分P1-P2上でSに最も近い点との距離（tは線分上の位置、0=P1・1=P2にクランプ）
  const abx = p2xy.x - p1xy.x;
  const aby = p2xy.y - p1xy.y;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq > 0 ? -(p1xy.x * abx + p1xy.y * aby) / abLenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const closestX = p1xy.x + t * abx;
  const closestY = p1xy.y + t * aby;
  const segDist = Math.sqrt(closestX * closestX + closestY * closestY);

  if (segDist > VECTOR_SEGMENT_DISTANCE_METERS) {
    return { confirmed: false, reason: 'segment_too_far', debug: { stepDist, distP1Stop, distP2Stop, segDist } };
  }

  // ベクトル条件：S→P1とS→P2の内積が負なら、P1とP2はSを挟んで反対側（上のコメント参照）
  const dot = p1xy.x * p2xy.x + p1xy.y * p2xy.y;
  if (!(dot < 0)) {
    return { confirmed: false, reason: 'not_opposite_side', debug: { stepDist, distP1Stop, distP2Stop, segDist, dot } };
  }

  return { confirmed: true, t, debug: { stepDist, distP1Stop, distP2Stop, segDist, dot, t } };
}

/**
 * 【ベクトル判定オーケストレーション】gpsRows（gps_time_ts昇順）を先頭から走査し、
 * 時系列で隣接する2点（P1=過去,P2=現在）ごとにevaluateVectorCrossingを評価する。
 * 最初に条件を満たした時点（＝最も早く到着確定できる時点）で確定し、以降は走査しない。
 *
 * gpsRowsが2点未満（履歴不足）の場合は判定できないためnullを返す。全ペアが条件を
 * 満たさない場合もnullを返す。呼び出し側はnullの場合、従来の到着判定のみで進める
 * （フォールバック）。
 *
 * actual_timeは、線分P1-P2上でSに最も近い点の位置(t)を使ってP1・P2のgps_time_tsを
 * 線形補間し、"H:mm"形式（他の到着確定と同じ形式）に変換したものを採用する。
 */
function findVectorConfirmation(gpsRows, stop) {
  if (!stop || !gpsRows || gpsRows.length < 2) return null;

  for (let i = 1; i < gpsRows.length; i++) {
    const p1 = gpsRows[i - 1];
    const p2 = gpsRows[i];
    const result = evaluateVectorCrossing(p1, p2, stop);
    if (!result.confirmed) continue;

    const p1Ts = new Date(p1.gps_time_ts).getTime();
    const p2Ts = new Date(p2.gps_time_ts).getTime();
    const interpolatedTs = p1Ts + result.t * (p2Ts - p1Ts);
    const actualTime = formatTimeNoFormat(new Date(interpolatedTs));

    return {
      stopId: stop.stop_id,
      seqOrder: stop.seq_order,
      stopName: stop.name,
      actualTime,
      p1,
      p2,
      debug: result.debug
    };
  }

  return null;
}

/**
 * 【付近スタックの遡及昇格】まだ「付近」のまま止まっているバス停のうち、
 * それより先のバス停が既に「到着済」になっているもの（＝進行が先に進んだ以上、
 * このバス停はとっくに通過しているはず）を、記録済みの最小距離の観測値を使って
 * 強制的に「到着済」へ昇格させる。線形推測ではなく実際に観測されたGPSデータに
 * 基づく確定なので interpolated = FALSE とする（後続の線形補間とは区別する）。
 */
async function promoteStuckNearbyStops(client, assignmentId) {
  const rows = await client.query(
    `SELECT stop_id, seq_order, status, nearby_min_distance_gps_time FROM trip_stop_progress
     WHERE assignment_id = $1 ORDER BY seq_order ASC`,
    [assignmentId]
  );

  let maxArrivedSeq = -1;
  for (const r of rows.rows) {
    if (r.status === '到着済') maxArrivedSeq = Math.max(maxArrivedSeq, r.seq_order);
  }
  if (maxArrivedSeq === -1) return 0;

  let promoted = 0;
  for (const r of rows.rows) {
    if (r.status !== '付近') continue;
    if (r.seq_order >= maxArrivedSeq) continue;
    if (!r.nearby_min_distance_gps_time) continue;

    await client.query(
      `UPDATE trip_stop_progress
       SET status = '到着済', actual_time = $1, interpolated = FALSE
       WHERE assignment_id = $2 AND stop_id = $3 AND status = '付近'`,
      [r.nearby_min_distance_gps_time, assignmentId, r.stop_id]
    );
    await client.query(
      `UPDATE trip_vehicle_assignments SET last_arrived_seq = GREATEST(last_arrived_seq, $1) WHERE id = $2`,
      [r.seq_order, assignmentId]
    );
    promoted++;
  }
  return promoted;
}

async function passInterpolate(client, assignmentId) {
  // 【付近スタックの遡及昇格】線形補間より先に行う。これにより後続の欠落補間が
  // 実観測データで昇格した区間を新しいアンカーとして使える。
  const promoted = await promoteStuckNearbyStops(client, assignmentId);

  const rows = await client.query(
    `SELECT stop_id, seq_order, status, actual_time FROM trip_stop_progress
     WHERE assignment_id = $1 ORDER BY seq_order ASC`,
    [assignmentId]
  );

  const arrivedList = [];
  for (const r of rows.rows) {
    if (r.status !== '到着済' || !r.actual_time) continue;
    const mins = timeStrToMinutes(r.actual_time);
    if (Number.isNaN(mins)) continue;
    arrivedList.push({ seqOrder: r.seq_order, mins });
  }
  if (arrivedList.length < 2) return promoted;

  const firstArrivedSeq = arrivedList[0].seqOrder;
  const statusBySeq = new Map(rows.rows.map((r) => [r.seq_order, r]));
  let filled = 0;

  for (let a = 0; a < arrivedList.length - 1; a++) {
    const prev = arrivedList[a];
    const next = arrivedList[a + 1];
    const segments = next.seqOrder - prev.seqOrder;
    if (segments <= 1) continue;

    for (let j = 1; j < segments; j++) {
      const targetSeq = prev.seqOrder + j;
      if (targetSeq < firstArrivedSeq) continue;
      const target = statusBySeq.get(targetSeq);
      if (!target || target.status === '到着済') continue;

      const interpolatedMins = Math.round(prev.mins + ((next.mins - prev.mins) * j) / segments);
      if (Number.isNaN(interpolatedMins) || interpolatedMins < 0 || interpolatedMins > 1439) continue;

      const timeStr = minutesToTimeStr(interpolatedMins);
      await client.query(
        `UPDATE trip_stop_progress
         SET status = '到着済', actual_time = $1, interpolated = TRUE
         WHERE assignment_id = $2 AND stop_id = $3`,
        [timeStr, assignmentId, target.stop_id]
      );
      filled++;
    }
  }
  return promoted + filled;
}

async function pass() {
  const client = await pool.connect();
  const radiusMeters = getRuntimeSetting('STOP_RADIUS_METERS');
  const marginMeters = getRuntimeSetting('DEPARTURE_MARGIN_METERS');
  const freshnessMin = getRuntimeSetting('GPS_FRESHNESS_MIN');
  const gpsWindowMin = getRuntimeSetting('ASSIGN_GPS_WINDOW_MIN');
  let totalNearby = 0;
  let totalPassed = 0;
  let totalInterpolated = 0;
  let totalVectorConfirmed = 0;

  try {
    const assignments = await getActiveAssignments(client);

    for (const assignment of assignments) {
      const stopMaster = await getStopMaster(client, assignment.assignment_id);
      if (stopMaster.length === 0) continue;

      // この割り当てでまだ消費していないGPSログ。
      // 「どのGPSを処理済みか」は車両ではなく割り当てごとに管理する必要がある
      // （1台の車両が複数便の候補になり得るため）。
      const windowStart = new Date(new Date(assignment.start_at).getTime() - gpsWindowMin * 60 * 1000);
      const gpsRes = await client.query(
        `SELECT g.id, g.gps_time, g.gps_time_ts, g.lat, g.lon
         FROM vehicle_gps_log g
         WHERE g.vehicle_id = $1
           AND g.gps_time_ts >= $2
           AND g.gps_time_ts >= now() - ($3::int * INTERVAL '1 minute')
           AND NOT EXISTS (
             SELECT 1 FROM trip_gps_matches m
             WHERE m.assignment_id = $4 AND m.gps_log_id = g.id
           )
         ORDER BY g.gps_time_ts ASC`,
        [assignment.vehicle_id, windowStart, freshnessMin, assignment.assignment_id]
      );

      if (gpsRes.rows.length === 0) {
        await passInterpolate(client, assignment.assignment_id);
        continue;
      }

      // 【時間制約(ETA)】DBに保存済みのETA（前回のパイプライン実行分）を読み取る。
      // ここで読むのは必ず「今回のpass()より前」に確定した値であり、今回のpass()の
      // 結果を使って計算される今回のETA（パイプライン⑧）とは循環依存しない。
      const etaByStopId = await getEtaMap(client, assignment.assignment_id);

      // --- ① 付近入り(entry): 判定アルゴリズム本体(①②③)は従来のまま ---
      const tentative = passStepEntry(assignment, stopMaster, gpsRes.rows, radiusMeters, etaByStopId);
      const kept = passStep2Dedup(tentative, stopMaster);

      for (const m of kept) {
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO trip_gps_matches (assignment_id, gps_log_id, stop_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (assignment_id, gps_log_id) DO NOTHING`,
            [assignment.assignment_id, m.gpsRowId, m.stopId]
          );
          await client.query(
            `UPDATE trip_stop_progress
             SET status = '付近',
                 nearby_min_distance_meters = $1,
                 nearby_min_distance_gps_time = $2,
                 nearby_min_distance_gps_time_ts = $3
             WHERE assignment_id = $4 AND stop_id = $5 AND status NOT IN ('到着済', '付近')`,
            [m.dist, m.gpsTime, m.gpsTimeTs, assignment.assignment_id, m.stopId]
          );
          await client.query(
            `UPDATE trip_vehicle_assignments
             SET last_arrived_seq = GREATEST(last_arrived_seq, $1)
             WHERE id = $2`,
            [m.seqOrder, assignment.assignment_id]
          );
          await client.query('COMMIT');
          totalNearby++;
          console.log(
            `[pass] 付近入り: 便=${assignment.start_time}発 carId=${assignment.car_id} ` +
            `バス停=${m.stopName} 距離=${Math.round(m.dist)}m 時刻=${m.gpsTime}`
          );
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[pass] エラー carId=${assignment.car_id}:`, err.message);
        }
      }

      // 重複除去で外れたGPSログは trip_gps_matches に記録しないため、
      // 次回のバッチで自動的に再評価される（旧実装の matched_label 戻し処理に相当）。

      // --- ② 付近→到着済確認(confirm): 最小距離からの離脱を検知して到着確定する ---
      // GPS点はここではtrip_gps_matchesに消費しないため、未消費のまま次バッチでも
      // 再評価され続ける（最小距離の更新・離脱判定を継続するため意図的）。
      const nearbyStops = buildNearbyTrackingState(stopMaster, kept);
      const confirmations = passStepConfirm(nearbyStops, gpsRes.rows, marginMeters);

      for (const c of confirmations) {
        if (c.type === 'confirm') {
          await client.query('BEGIN');
          try {
            await client.query(
              `UPDATE trip_stop_progress
               SET status = '到着済', actual_time = $1
               WHERE assignment_id = $2 AND stop_id = $3 AND status = '付近'`,
              [c.actualTime, assignment.assignment_id, c.stopId]
            );
            await client.query(
              `UPDATE trip_vehicle_assignments
               SET last_arrived_seq = GREATEST(last_arrived_seq, $1)
               WHERE id = $2`,
              [c.seqOrder, assignment.assignment_id]
            );
            await client.query('COMMIT');
            totalPassed++;
            console.log(
              `[pass] 到着確定（付近経由）: 便=${assignment.start_time}発 carId=${assignment.car_id} ` +
              `stopId=${c.stopId} 時刻=${c.actualTime}`
            );
          } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[pass] エラー carId=${assignment.car_id}:`, err.message);
          }
        } else {
          // refine: 最小距離の更新のみ。まだ到着未確定なのでトランザクションは不要。
          await client.query(
            `UPDATE trip_stop_progress
             SET nearby_min_distance_meters = $1,
                 nearby_min_distance_gps_time = $2,
                 nearby_min_distance_gps_time_ts = $3
             WHERE assignment_id = $4 AND stop_id = $5 AND status = '付近'`,
            [c.minDist, c.minGpsTime, c.minGpsTimeTs, assignment.assignment_id, c.stopId]
          );
        }
      }

      // --- ③ ベクトル通過判定(到着判定高速化): 従来の到着判定はそのまま①②で動作させたうえで、
      // 「まだ到着済になっていない次の1停留所」だけを対象に、より早く到着確定できないかを追加で判定する。
      // ②で今回のバッチ内で既に到着確定済みならスキップする（二重確定・二重ログの防止）。
      const confirmedThisBatch = new Set(
        confirmations.filter((c) => c.type === 'confirm').map((c) => c.stopId)
      );
      const confirmedSeqThisBatch = confirmations
        .filter((c) => c.type === 'confirm')
        .map((c) => c.seqOrder);
      const vectorTargetStop = findNextUnarrivedStop(stopMaster, confirmedSeqThisBatch);
      if (vectorTargetStop && !confirmedThisBatch.has(vectorTargetStop.stop_id)) {
        const vectorMatch = findVectorConfirmation(gpsRes.rows, vectorTargetStop);
        if (vectorMatch) {
          await client.query('BEGIN');
          try {
            const upd = await client.query(
              `UPDATE trip_stop_progress
               SET status = '到着済', actual_time = $1
               WHERE assignment_id = $2 AND stop_id = $3 AND status != '到着済'`,
              [vectorMatch.actualTime, assignment.assignment_id, vectorMatch.stopId]
            );
            if (upd.rowCount > 0) {
              await client.query(
                `UPDATE trip_vehicle_assignments
                 SET last_arrived_seq = GREATEST(last_arrived_seq, $1)
                 WHERE id = $2`,
                [vectorMatch.seqOrder, assignment.assignment_id]
              );
            }
            await client.query('COMMIT');
            if (upd.rowCount > 0) {
              totalPassed++;
              totalVectorConfirmed++;
              const d = vectorMatch.debug;
              console.log(
                `[pass] 到着確定（ベクトル判定）: 便=${assignment.start_time}発 carId=${assignment.car_id} ` +
                `バス停=${vectorMatch.stopName} stopId=${vectorMatch.stopId} 時刻=${vectorMatch.actualTime} ` +
                `stepDist=${Math.round(d.stepDist)}m distP1=${Math.round(d.distP1Stop)}m distP2=${Math.round(d.distP2Stop)}m ` +
                `segDist=${Math.round(d.segDist)}m dot=${Math.round(d.dot)} t=${d.t.toFixed(2)} ` +
                `P1=(${vectorMatch.p1.lat},${vectorMatch.p1.lon},${vectorMatch.p1.gps_time}) ` +
                `P2=(${vectorMatch.p2.lat},${vectorMatch.p2.lon},${vectorMatch.p2.gps_time})`
              );
            }
          } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[pass] エラー carId=${assignment.car_id}:`, err.message);
          }
        }
      }

      const filled = await passInterpolate(client, assignment.assignment_id);
      totalInterpolated += filled;
      if (filled > 0) {
        console.log(`[pass] 欠落補完: 便=${assignment.start_time}発 carId=${assignment.car_id} 件数=${filled}`);
      }
    }
  } finally {
    client.release();
  }

  return { totalNearby, totalPassed, totalInterpolated, totalVectorConfirmed };
}

module.exports = {
  pass,
  shouldConfirmDeparture,
  passStepConfirm,
  buildNearbyTrackingState,
  findNextUnarrivedStop,
  evaluateVectorCrossing,
  findVectorConfirmation
};
