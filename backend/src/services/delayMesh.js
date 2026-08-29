// 管理画面「当日の状況」のメッシュ可視化。
//
// etaPredictor.js の getRecentSegmentPerformance()（ETA予測の「周辺道路実績」が使っている
// のと同じ、直近の区間実績データ）を、特定の対象区間に絞らずシステム全体で格子(メッシュ)に
// 集約する。「今この道路周辺がどの程度混雑しているか」を地図上で俯瞰できるようにするための、
// 読み取り専用の集計モジュール。ETA予測本体(predictArrivals)・パイプラインには一切書き込まない。
const { getRecentSegmentPerformance, nearbyRecencyWeight } = require('./etaPredictor');
const { nowInTokyo } = require('../utils/time');

const DEFAULT_CELL_METERS = 300;
const MIN_CELL_METERS = 100;
const MAX_CELL_METERS = 2000;

// 緯度1度あたりの概算距離(m)。地球を球とみなす近似（utils/geo.jsのtoLocalXYMetersと同じ
// 考え方）で、市内程度の範囲のメッシュ分割には十分な精度。
const METERS_PER_LAT_DEGREE = 111320;
// 経度方向のセル幅をcos補正するための基準緯度（松本市中心付近。frontend各所のMAP_CENTERと
// 同じ地点を採用し、セルの見た目のサイズを地図表示と揃える）。
const REFERENCE_LAT_DEGREES = 36.2381;

function resolveCellMeters(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CELL_METERS;
  return Math.min(MAX_CELL_METERS, Math.max(MIN_CELL_METERS, n));
}

/**
 * システム全体の直近区間実績を、指定サイズの格子(メッシュ)へ集約する。
 * セルのキーは緯度経度をセル幅(度)で切り捨てたインデックスのペア。
 * 各セルの値(factor)は、セル内にマッチした区間実績の比率（実績÷定刻。
 * etaPredictor.jsのclampPaceRatioで既に0.5〜2.5にクランプ済み）を、新しさだけで
 * 重み付けした加重平均。距離・方位による重み付けは「対象区間」がある場合
 * （ETA予測の周辺道路補正）にのみ意味を持つため、ここでは使わない。
 *
 * @returns {Promise<{cellMeters: number, generatedAt: string, cells: Array<{latMin,lonMin,latMax,lonMax,factor,sampleCount}>}>}
 */
async function getDelayMesh(client, options = {}) {
  const cellMeters = resolveCellMeters(options.cellMeters);
  const cellLatDeg = cellMeters / METERS_PER_LAT_DEGREE;
  const cellLonDeg = cellMeters / (METERS_PER_LAT_DEGREE * Math.cos((REFERENCE_LAT_DEGREES * Math.PI) / 180));

  const segments = await getRecentSegmentPerformance(client);
  const now = nowInTokyo();
  const nowMinutes = now.hour * 60 + now.minute;

  const cellMap = new Map();
  for (const seg of segments) {
    let minutesAgo = nowMinutes - seg.toMinutes;
    if (minutesAgo < -700) minutesAgo += 24 * 60; // 日跨ぎ補正（getNearbyCandidateSegmentsと同じ方針）
    if (minutesAgo < 0) minutesAgo = 0;

    const weight = nearbyRecencyWeight(minutesAgo);
    if (weight === 0) continue; // NEARBY_RECENCY_MINUTESより古い実績はメッシュにも使わない

    const latIdx = Math.floor(seg.midLat / cellLatDeg);
    const lonIdx = Math.floor(seg.midLon / cellLonDeg);
    const key = `${latIdx}:${lonIdx}`;

    let cell = cellMap.get(key);
    if (!cell) {
      cell = {
        latMin: latIdx * cellLatDeg,
        latMax: (latIdx + 1) * cellLatDeg,
        lonMin: lonIdx * cellLonDeg,
        lonMax: (lonIdx + 1) * cellLonDeg,
        weightedRatioSum: 0,
        weightTotal: 0,
        sampleCount: 0
      };
      cellMap.set(key, cell);
    }

    cell.weightedRatioSum += weight * seg.ratio;
    cell.weightTotal += weight;
    cell.sampleCount++;
  }

  const cells = Array.from(cellMap.values()).map((cell) => ({
    latMin: cell.latMin,
    lonMin: cell.lonMin,
    latMax: cell.latMax,
    lonMax: cell.lonMax,
    factor: cell.weightedRatioSum / cell.weightTotal,
    sampleCount: cell.sampleCount
  }));

  return {
    cellMeters,
    generatedAt: new Date().toISOString(),
    cells
  };
}

module.exports = { getDelayMesh, DEFAULT_CELL_METERS, MIN_CELL_METERS, MAX_CELL_METERS };
