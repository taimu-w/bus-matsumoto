/**
 * 2点間のハバーサイン距離をメートルで返す（GASのhaversineDistance関数と同一実装）。
 */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 基準点(refLat, refLon)を原点とする局所平面座標(メートル、東=x・北=y)に変換する。
 * 緯度によるcos補正のみを行う近似で、数百m程度の近距離限定（この範囲では地球の
 * 曲率誤差はcm未満で無視できる）。ベクトルの内積・線分最短距離など、2点間距離だけでは
 * 表現できない平面幾何演算が必要な用途向け（services/passDetection.jsのベクトル通過判定）。
 */
function toLocalXYMeters(lat, lon, refLat, refLon) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  return {
    x: toRad(lon - refLon) * Math.cos(toRad(refLat)) * R,
    y: toRad(lat - refLat) * R
  };
}

/**
 * 2点間の初期方位角を度(0〜360、真北=0・東=90)で返す。
 * ETAの周辺道路実績（services/etaPredictor.js）で、対象区間と候補区間の
 * 進行方向がどれだけ近いかを判定するために使う。
 */
function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const toDeg = (v) => (v * 180) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * 2つの方位角(度)の差を0〜180度で返す（周回方向を考慮した最短差）。
 */
function angleDiffDegrees(bearing1, bearing2) {
  const diff = Math.abs(bearing1 - bearing2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// ==========================================================
// 徒歩の所要時間の推定
// 「バス停・観光スポットまで歩いて何分か」を、2点間の直線距離（haversineDistanceMeters）から
// 見積もる。時刻表検索の「近くのバス停」・スポット検索・観光スポット情報・経路検索の徒歩乗換で
// 共通に使う（GPS照合・通過判定など「人が歩く」以外の用途では使わない）。
//
//   推定徒歩距離 = 直線距離 × 迂回係数 + 信号バッファ
//
// 街路網は直線ではないため、距離が伸びるほど曲がり角の迂回と横断歩道の信号待ちが積み重なる。
// そこで迂回係数・信号バッファのどちらも直線距離に応じて増やす（直線50mと500mでは500mの方が
// 迂回も信号待ちも大きい）。いずれも近距離で最小、遠距離で頭打ちになる区分線形。
// ==========================================================

// 徒歩の速度（分速メートル）。gtfsTimetable.js / gtfsRouteSearch.js / touristSpots.js で共通。
const WALK_SPEED_METERS_PER_MIN = 80;

// 迂回係数：直線距離が RAMP_START 以下で MIN 固定、RAMP_END 以上で MAX 固定、間は線形。
const WALK_DETOUR_FACTOR_MIN = 1.15;   // ほぼ一直線で行ける近距離
const WALK_DETOUR_FACTOR_MAX = 1.40;   // 市街地の街路網を通す遠距離の頭打ち
const WALK_DETOUR_RAMP_START_M = 100;
const WALK_DETOUR_RAMP_END_M = 1000;

// 信号バッファ：横断歩道の信号待ちの累積（メートル換算。徒歩速度で時間に直す）。
// 近距離では 0、遠距離で MAX（≒ 徒歩速度換算で約2分）で頭打ち。
const WALK_SIGNAL_BUFFER_MAX_M = 160;
const WALK_SIGNAL_RAMP_START_M = 100;
const WALK_SIGNAL_RAMP_END_M = 1200;

/** value を [inMin, inMax] の位置に応じて [outMin, outMax] へ線形補間する（範囲外はクランプ）。 */
function lerpClamped(value, inMin, inMax, outMin, outMax) {
  if (value <= inMin) return outMin;
  if (value >= inMax) return outMax;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

/**
 * 直線距離(m)から、実際に歩く道のりの推定(m)を返す。曲がり角の迂回と信号待ちを織り込む。
 * 0以下・非数は 0 を返す。
 */
function estimateWalkingMeters(straightLineMeters) {
  if (!(straightLineMeters > 0)) return 0;
  const factor = lerpClamped(
    straightLineMeters,
    WALK_DETOUR_RAMP_START_M, WALK_DETOUR_RAMP_END_M,
    WALK_DETOUR_FACTOR_MIN, WALK_DETOUR_FACTOR_MAX
  );
  const buffer = lerpClamped(
    straightLineMeters,
    WALK_SIGNAL_RAMP_START_M, WALK_SIGNAL_RAMP_END_M,
    0, WALK_SIGNAL_BUFFER_MAX_M
  );
  return straightLineMeters * factor + buffer;
}

/** 直線距離(m)から推定徒歩分数を返す（最低1分・四捨五入。各所の従来の丸め方に合わせる）。 */
function estimateWalkMinutes(straightLineMeters) {
  return Math.max(1, Math.round(estimateWalkingMeters(straightLineMeters) / WALK_SPEED_METERS_PER_MIN));
}

/** 直線距離(m)から推定徒歩秒数を返す（四捨五入のみ。最低秒数は呼び出し側で担保する）。 */
function estimateWalkSeconds(straightLineMeters) {
  return Math.round((estimateWalkingMeters(straightLineMeters) / WALK_SPEED_METERS_PER_MIN) * 60);
}

module.exports = {
  haversineDistanceMeters,
  toLocalXYMeters,
  bearingDegrees,
  angleDiffDegrees,
  WALK_SPEED_METERS_PER_MIN,
  estimateWalkingMeters,
  estimateWalkMinutes,
  estimateWalkSeconds
};
