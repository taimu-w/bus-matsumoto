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

module.exports = { haversineDistanceMeters, toLocalXYMeters, bearingDegrees, angleDiffDegrees };
