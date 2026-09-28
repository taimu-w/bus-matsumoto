// GTFS shapes.txt（路線の線形）の読み込みと、便（trips.txt の1行）への対応付け。
//
// 用途は**地図に線を描くこと専用**である。GPS照合・通過判定・距離計算には使わない
// （それらの座標の正は stops であり、shapes は見た目の線でしかない）。
//
// 利用箇所は2つ:
//   - db/seed.js の seedShapes()      … route_shapes テーブル（路線図マップ `/routemap`）
//   - services/gtfsTimetable.js       … 便詳細「地図で表示」に出すその便自身の線形
// どちらも自前のCSVリーダを持っているため、gtfsFrequencies.js と同じく readCsv を
// 引数で受け取る（このモジュールはファイルの有無だけを自分で判定する）。
const fs = require('fs');
const path = require('path');
const { getGtfsDir } = require('./gtfsFeedManager');

const SHAPES_FILE = 'shapes.txt';

// 座標の丸め桁数。6桁＝約0.11mで、地図に線を描く用途にはこれで十分すぎる。
// 原データの7桁以上をそのまま持つと、APIレスポンスとメモリを無駄に太らせるだけ。
const COORD_DECIMALS = 6;

/**
 * shapes.txt が存在するかどうか。
 * このファイルは任意扱い（OPTIONAL_GTFS_FILES）で、無いフィードでも一切のエラーにしない。
 */
function hasShapesFile(feedId) {
  return fs.existsSync(path.join(getGtfsDir(feedId), SHAPES_FILE));
}

/**
 * 指定フィードの shapes.txt を読み、shape_id ごとの座標列を返す。
 * ファイルが無い・読めない場合は空のMapを返す（エラーにしない）。
 *
 * @param {string|null} feedId
 * @param {(fileName: string, feedId: string|null) => object[]} readCsv
 * @returns {Map<string, Array<[number, number]>>} shape_pt_sequence 昇順の `[lat, lon]` 配列
 */
function readShapePointsByShapeId(feedId, readCsv) {
  if (!hasShapesFile(feedId)) return new Map();

  let rows;
  try {
    rows = readCsv(SHAPES_FILE, feedId);
  } catch (err) {
    console.warn(`[gtfsShapes] feed=${feedId} shapes.txt の読み込みに失敗（無視して継続）:`, err.message);
    return new Map();
  }

  const byShapeId = new Map();
  for (const row of rows) {
    const shapeId = (row.shape_id || '').trim();
    const lat = Number.parseFloat(row.shape_pt_lat);
    const lon = Number.parseFloat(row.shape_pt_lon);
    const seq = Number.parseInt(row.shape_pt_sequence, 10);
    if (!shapeId || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(seq)) continue;
    if (!byShapeId.has(shapeId)) byShapeId.set(shapeId, []);
    byShapeId.get(shapeId).push({ seq, lat, lon });
  }

  const result = new Map();
  for (const [shapeId, points] of byShapeId.entries()) {
    // shape_pt_sequence は「昇順であること」しか保証されない（連番とは限らない）ので、
    // ファイル上の行順ではなく必ずこの値で並べ替える。
    points.sort((a, b) => a.seq - b.seq);
    result.set(shapeId, points.map((p) => [
      Number(p.lat.toFixed(COORD_DECIMALS)),
      Number(p.lon.toFixed(COORD_DECIMALS))
    ]));
  }
  return result;
}

/**
 * trips.txt の1行から、その便の線形（shape_id）を決める。
 *
 * **`shape_id` 列が空でも諦めないこと。** ぐるっと松本バス1は全便の `shape_id` が
 * 空欄で、代わりに日本標準のGTFS拡張列 `jp_pattern_id` が shapes.txt の shape_id と
 * 1対1で対応している。`shape_id` だけを見ると、shapes.txt に47本の線形があるのに
 * 路線図が1本も描けない。
 *
 * 代替キーを使うのは「その値が shapes.txt に shape_id として実在するとき」だけなので、
 * 対応が無いフィードで誤った線形を拾うことはない。
 *
 * @param {object} tripRow trips.txt の1行（`shape_id` / `jp_pattern_id` を見る）
 * @param {Map<string, unknown>} pointsByShapeId readShapePointsByShapeId() の結果
 * @returns {string|null} 対応する shape_id。見つからなければ null
 */
function resolveTripShapeId(tripRow, pointsByShapeId) {
  if (!tripRow || !pointsByShapeId || pointsByShapeId.size === 0) return null;
  const shapeId = (tripRow.shape_id || '').trim();
  if (shapeId && pointsByShapeId.has(shapeId)) return shapeId;
  const patternId = (tripRow.jp_pattern_id || '').trim();
  if (patternId && pointsByShapeId.has(patternId)) return patternId;
  return null;
}

module.exports = {
  SHAPES_FILE,
  COORD_DECIMALS,
  hasShapesFile,
  readShapePointsByShapeId,
  resolveTripShapeId
};
