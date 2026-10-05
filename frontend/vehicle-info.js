// 車両詳細情報（公開用）の表示ヘルパー（window.VehicleInfo）。docs/vehicle-profiles.md
//
// /api/buses・/api/buses-for-map・便詳細の /realtime が返すバス情報の vehicleProfile
// （管理画面「車両詳細情報」で登録。未登録の車両は null）を描く。
// app.js（カード表示・バスマップ）・realtime-diagram.js（基本表示）・timetable.js（便詳細）で共用するため、
// これらより先に読み込むこと。管理画面（admin.html）でも運行ダッシュボードの地図マーカー用に読み込む
// （openDetail は利用者向け index.html のモーダル専用で、管理画面では使わない）。
//
// アイコン未登録の車両では iconImgHtml() が null を返すので、呼び出し側は従来のアイコン（🚌等）を描く。
(function () {
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function iconUrl(profile) {
    return profile && typeof profile.iconUrl === 'string' && profile.iconUrl ? profile.iconUrl : null;
  }

  /** バスアイコンの<img>。アイコン未登録ならnull。style は地図マーカーの向き（transform）用。 */
  function iconImgHtml(profile, className = '', alt = '', style = '') {
    const url = iconUrl(profile);
    if (!url) return null;
    const styleAttr = style ? ` style="${esc(style)}"` : '';
    return `<img src="${esc(url)}" alt="${esc(alt)}" class="${esc(className)}"${styleAttr} draggable="false" decoding="async">`;
  }

  // 登録されているバスアイコンはすべて左向きの横顔。地図（北が上）で進行方向へ向けるため、
  // APIの heading（方位角。真北=0・東=90・時計回り、backend/src/services/vehicleHeading.js）に
  // 合わせて画像を変形する。回転角は常に±90度以内に収め、車体が逆さまにならないようにする。
  //   西寄り（180〜360度、0度＝真北を含む）… 反転せず、時計回りに (heading − 270) 度回転
  //       例：北西315度 → 時計回りに45度、真北0度 → 時計回りに90度、真南180度 → 反時計回りに90度
  //   東寄り（0〜180度、両端を除く）… 左右反転してから、時計回りに (heading − 90) 度回転
  //       例：北東45度 → 反転して反時計回りに45度、真東90度 → 反転のみ、南東135度 → 反転して時計回りに45度
  // CSSの rotate(θ) は画面座標（y下向き）で時計回り。transform は右の関数から先に効くので
  // 「rotate(θ) scaleX(-1)」＝反転してから回転。heading が無い（算出できない）ときは画像のまま左向き。
  const MARKER_W = 44;
  const MARKER_H = 32;

  /** heading → { flip: 左右反転するか, rotate: 時計回りの回転角（度、−90〜90） } */
  function markerTransform(heading) {
    if (heading === null || heading === undefined || heading === '') return { flip: false, rotate: 0 };
    const h = Number(heading);
    if (!Number.isFinite(h)) return { flip: false, rotate: 0 };
    const a = ((h % 360) + 360) % 360;
    if (a > 0 && a < 180) return { flip: true, rotate: a - 90 };
    return { flip: false, rotate: ((a - 270 + 540) % 360) - 180 };
  }

  /**
   * 地図マーカー用のバスアイコン（背景・枠なしで画像だけ）。アイコン未登録ならnull。
   * 画像要素は常に MARKER_W×MARKER_H で、それを回転させた外接矩形を枠の大きさにする
   * （戻り値の size は L.divIcon の iconSize にそのまま渡す。下に出す行先ラベルが画像に重ならないように）。
   * className は枠に足すクラス（管理画面の運行ダッシュボードで選択中を示す is-selected など）。
   * 利用者向け画面（style.css）と管理画面（admin.css）の両方に .bus-marker-photo の定義がある。
   */
  function mapMarkerPhoto(profile, heading, { className = '' } = {}) {
    const { flip, rotate } = markerTransform(heading);
    const transforms = [];
    if (rotate) transforms.push(`rotate(${rotate}deg)`);
    if (flip) transforms.push('scaleX(-1)');
    const style = transforms.length ? `transform:${transforms.join(' ')};` : '';
    const img = iconImgHtml(profile, '', 'バス', style);
    if (!img) return null;
    const rad = (rotate * Math.PI) / 180;
    const w = Math.ceil(Math.abs(MARKER_W * Math.cos(rad)) + Math.abs(MARKER_H * Math.sin(rad)));
    const h = Math.ceil(Math.abs(MARKER_W * Math.sin(rad)) + Math.abs(MARKER_H * Math.cos(rad)));
    return {
      html: `<div class="bus-marker-photo${className ? ` ${esc(className)}` : ''}" style="width:${w}px;height:${h}px;">${img}</div>`,
      size: [w, h]
    };
  }

  function featureRowHtml(label, value) {
    if (value !== true && value !== false) return '';
    const badge = value
      ? '<span class="text-xs font-bold text-green-800 bg-green-100 border border-green-200 rounded-full px-2.5 py-0.5">対応</span>'
      : '<span class="text-xs font-bold text-gray-600 bg-gray-100 border border-gray-200 rounded-full px-2.5 py-0.5">非対応</span>';
    return `
      <div class="flex items-center justify-between gap-3 py-2 border-b border-gray-100 last:border-b-0">
        <span class="text-sm font-bold text-gray-800">${esc(label)}</span>
        ${badge}
      </div>`;
  }

  function detailBodyHtml(profile) {
    const p = profile || {};
    const image = iconImgHtml(p, 'max-h-full max-w-full object-contain', '車両の外観');
    const imageHtml = image
      ? `<div class="bg-gray-50 rounded-2xl h-44 flex items-center justify-center p-3 mb-4">${image}</div>`
      : '';

    const featureRows = featureRowHtml('ノンステップバス', p.nonStep) + featureRowHtml('車いす対応', p.wheelchair);
    const featureHtml = featureRows
      ? `<div class="mb-4">
           <p class="text-xs font-bold text-gray-500 mb-1">車両の設備</p>
           <div class="bg-white border border-gray-200 rounded-xl px-3">${featureRows}</div>
         </div>`
      : '';

    const methods = Array.isArray(p.paymentMethods) ? p.paymentMethods : [];
    const note = typeof p.paymentNote === 'string' ? p.paymentNote.trim() : '';
    const paymentHtml = (methods.length > 0 || note)
      ? `<div class="mb-4">
           <p class="text-xs font-bold text-gray-500 mb-1">お支払い方法</p>
           ${methods.length > 0
             ? `<div class="flex flex-wrap gap-1.5">${methods.map((m) => `<span class="text-sm font-bold text-blue-900 bg-blue-50 border border-blue-200 rounded-lg px-2.5 py-1">${esc(m.label)}</span>`).join('')}</div>`
             : ''}
           ${note ? `<p class="text-xs text-gray-700 mt-2 whitespace-pre-wrap">${esc(note)}</p>` : ''}
         </div>`
      : '';

    const emptyHtml = (!featureHtml && !paymentHtml)
      ? '<p class="text-sm text-gray-500 mb-4">この車両の設備・お支払い方法の情報は登録されていません。</p>'
      : '';

    return `
      ${imageHtml}
      ${featureHtml}
      ${paymentHtml}
      ${emptyHtml}
      <p class="text-[11px] text-gray-400">車両の入れ替え等により、実際の車両と異なる場合があります。</p>`;
  }

  /** 車両詳細ポップアップ（index.html の #vehicle-detail-modal）を開く。title は便の行先など。 */
  function openDetail(profile, { title = '' } = {}) {
    const titleEl = document.getElementById('vehicle-detail-title');
    const bodyEl = document.getElementById('vehicle-detail-body');
    if (!bodyEl || typeof window.openModal !== 'function') return;
    if (titleEl) titleEl.textContent = title;
    bodyEl.innerHTML = detailBodyHtml(profile);
    window.openModal('vehicle-detail-modal');
  }

  window.VehicleInfo = { iconUrl, iconImgHtml, markerTransform, mapMarkerPhoto, openDetail };
})();
