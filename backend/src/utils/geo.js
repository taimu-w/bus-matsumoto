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

module.exports = { haversineDistanceMeters, toLocalXYMeters };
