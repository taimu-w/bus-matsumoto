// 運行ダッシュボード（地図）
// 利用者向けバスマップ（frontend/app.js の #/busmap）と同じ見た目で全路線のバスアイコン・
// 路線名を1枚の地図に掲載する。バスアイコンをタップすると、その便のリアルタイム時刻表を
// 右パネルに表示し、地図には「その便が停車予定の全バス停」と「その車両がこの便を担当して
// から記録された位置情報の履歴」を重ねて描画する。バス停・位置履歴それぞれへのマウスオーバーで
// 時刻・バス停名を確認できる。リアルタイム時刻表側では到着判定時刻（trip_stop_progress.actual_time）
// を手動編集できる（未到着のバス停への手動確定も可）。
//
// 表示モードは2つ：
//   - 'active'（既定）: 便に割り当てられている（担当）車両のみ。/api/buses-for-map と同じ。
//   - 'all': 路線・便への割り当て状況に関係なく、直近3分以内にGPSを受信した全車両
//     （便に割り当てられていない・候補にすらなっていない車両も含む）。/api/admin/vehicle-positions-map。
// いずれのモードでも、バスを選択している間はそのバス以外のアイコンを地図上から隠す
// （選択解除するまで、そのバスに関連する情報だけを表示する）。
(function () {
  const MAP_CENTER = [36.2381, 137.9701];
  const MAP_ZOOM = 12;

  let mode = 'active'; // 'active' | 'all'
  let mapInstance = null;
  let mapFitted = false;
  let busMarkers = {};   // key: markerKey(bus) -> L.Marker
  let busByKey = {};     // key: markerKey(bus) -> 直近取得したバスオブジェクト（クリック時の情報鮮度用）
  let stopMarkers = [];  // 選択中の便の停車バス停マーカー
  let historyMarkers = []; // 選択中の便の位置履歴マーカー
  let historyLine = null;
  let lastBuses = [];
  let selectedKey = null;  // 選択中のバスのmarkerKey（未選択ならnull）
  let selectedBus = null;  // 選択中のバスの直近のバスオブジェクト
  let delayFilterOnly = false;   // true の間は5分以上遅延の便のアイコンだけを地図に表示する
  let lastUnassignedTrips = [];  // サマリー欄「本日の未割当便数」タップ時のポップアップ用
  let openStopModal = null;      // 表示中のバス停詳細モーダル { assignmentId, stopId }（ポーリング再取得用）

  /* ---------- app.js と同じ路線カラー処理（別JSスコープのため移植） ---------- */
  function normalizeRouteColor(color, fallback) {
    const raw = String(color || '').replace(/^#/, '');
    return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(raw) ? `#${raw}` : fallback;
  }

  function formatDelayLabel(minutes) {
    if (minutes === null || minutes === undefined) return '';
    return minutes <= 1 ? '定刻通り' : `${minutes}分遅れ`;
  }

  /* ---------- 地図初期化（一度だけ。以降はinvalidateSizeのみ） ---------- */
  function initializeMap() {
    const mapEl = document.getElementById('dashboard-map');
    if (!mapEl || mapInstance) return;

    mapInstance = L.map('dashboard-map').setView(MAP_CENTER, MAP_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(mapInstance);

    // 表示直後はコンテナのサイズが未確定なことがあるため、レイアウト確定後に再計算させる
    // （frontend/app.js のバスマップと同じ対策）。
    setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 0);
  }

  /* ---------- バスアイコン（app.js の createBusIcon と同じ見た目） ---------- */
  function createBusIcon(bus, isSelected) {
    const bg = normalizeRouteColor(bus.routeColor, '#ef4444');
    const labelBg = normalizeRouteColor(bus.routeColor, '#334155');
    const labelFg = normalizeRouteColor(bus.routeTextColor, '#ffffff');
    const label = bus.currentHeadsign || bus.headsign || '';
    return L.divIcon({
      html: `
        <div class="bus-marker-wrap">
          <div class="bus-marker-body${isSelected ? ' is-selected' : ''}" style="background:${bg};">🚌</div>
          ${label ? `<div class="bus-marker-label" style="background:${labelBg};color:${labelFg};">${escapeHtml(label)}</div>` : ''}
        </div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      className: 'bus-marker'
    });
  }

  // assignmentIdが取れるバス（便に割り当て済み）はそれをキーにする。取れない場合はvehicleId。
  function markerKey(bus) {
    return bus.assignmentId != null ? `a-${bus.assignmentId}` : `v-${bus.vehicleId ?? bus.id}`;
  }

  // 選択中のバスがある間は、それ以外のバスアイコンを地図上から隠す
  // （「特定のバスを閲覧中は他のバスの情報は不要」という要件）。
  function updateBusMarkers(buses) {
    if (!mapInstance) return;
    buses.forEach((bus) => { busByKey[markerKey(bus)] = bus; });

    const visible = selectedKey
      ? buses.filter((bus) => markerKey(bus) === selectedKey)
      : delayFilterOnly
        ? buses.filter((bus) => (bus.delayMinutes || 0) >= 5)
        : buses;
    const seenKeys = new Set();
    const latLngs = [];

    visible.forEach((bus) => {
      const lat = Number(bus.lat);
      const lng = Number(bus.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const key = markerKey(bus);
      seenKeys.add(key);
      latLngs.push([lat, lng]);

      const isSelected = key === selectedKey;
      const icon = createBusIcon(bus, isSelected);

      let marker = busMarkers[key];
      if (marker) {
        marker.setLatLng([lat, lng]);
        marker.setIcon(icon);
      } else {
        marker = L.marker([lat, lng], { icon }).addTo(mapInstance);
        marker.on('click', () => {
          const current = busByKey[key];
          if (current) selectBus(current);
        });
        busMarkers[key] = marker;
      }
    });

    Object.keys(busMarkers).forEach((key) => {
      if (!seenKeys.has(key)) {
        mapInstance.removeLayer(busMarkers[key]);
        delete busMarkers[key];
      }
    });

    // 初回だけ、表示中のバスが全部入るように表示範囲を合わせる（以降は操作した表示位置を保持）。
    if (!mapFitted && latLngs.length > 0) {
      mapFitted = true;
      mapInstance.fitBounds(L.latLngBounds(latLngs).pad(0.2), { maxZoom: 15 });
    }
  }

  // 選択したバスの位置へ地図をパン・ズームする（「そのバスに関連する情報だけ」に焦点を当てる）。
  function focusOnBus(bus) {
    if (!mapInstance) return;
    const lat = Number(bus.lat);
    const lng = Number(bus.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const targetZoom = Math.max(mapInstance.getZoom(), 15);
    mapInstance.setView([lat, lng], targetZoom, { animate: true });
  }

  /* ---------- 選択中の便の停車バス停・位置履歴オーバーレイ ---------- */
  function clearOverlay() {
    if (!mapInstance) return;
    stopMarkers.forEach((m) => mapInstance.removeLayer(m));
    stopMarkers = [];
    historyMarkers.forEach((m) => mapInstance.removeLayer(m));
    historyMarkers = [];
    if (historyLine) {
      mapInstance.removeLayer(historyLine);
      historyLine = null;
    }
  }

  function stopMarkerClass(status) {
    if (status === '到着済') return 'arrived';
    if (status === '付近') return 'nearby';
    return 'pending';
  }

  function renderMapOverlay(detail) {
    clearOverlay();

    (detail.stops || []).forEach((stop) => {
      const lat = Number(stop.lat);
      const lng = Number(stop.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const icon = L.divIcon({
        html: `<div class="stop-marker ${stopMarkerClass(stop.status)}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
        className: 'stop-marker-icon'
      });
      const marker = L.marker([lat, lng], { icon, zIndexOffset: 500 }).addTo(mapInstance);
      marker.bindTooltip(
        `<div class="text-xs"><span class="font-bold">${escapeHtml(stop.name)}</span><br>定刻 ${escapeHtml(stop.scheduledTime || '—')}</div>`,
        { direction: 'top', offset: [0, -6] }
      );
      stopMarkers.push(marker);
    });

    const history = detail.positionHistory || [];
    const latLngs = [];
    history.forEach((point) => {
      const lat = Number(point.lat);
      const lng = Number(point.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      latLngs.push([lat, lng]);

      const icon = L.divIcon({
        html: '<div class="history-dot"></div>',
        iconSize: [8, 8],
        iconAnchor: [4, 4],
        className: 'history-dot-icon'
      });
      const marker = L.marker([lat, lng], { icon }).addTo(mapInstance);
      const stopLine = point.matchedStopName
        ? `<br>${escapeHtml(point.matchedStopName)}（定刻 ${escapeHtml(point.matchedScheduledTime || '—')}）`
        : '';
      marker.bindTooltip(
        `<div class="text-xs"><span class="font-bold">位置情報 ${escapeHtml(point.gpsTime)}</span>${stopLine}</div>`,
        { direction: 'top', offset: [0, -4] }
      );
      historyMarkers.push(marker);
    });

    if (latLngs.length > 1) {
      historyLine = L.polyline(latLngs, { color: '#2563eb', weight: 3, opacity: 0.5 }).addTo(mapInstance);
    }
  }

  /* ---------- 右パネル（リアルタイム時刻表・到着判定時刻の編集） ---------- */
  function statusLabelOf(status) {
    if (status === '到着済') return '到着済';
    if (status === '付近') return '付近';
    if (status === '通過') return '通過';
    return '未到着';
  }

  function statusToneOf(status) {
    if (status === '到着済') return 'text-green-700';
    if (status === '付近') return 'text-amber-700';
    return 'text-slate-400';
  }

  // 予測遅延（分）の短縮ラベル＋色。ETA予測の推移・時刻表セルの両方で使う。
  function delayChipHtml(minutes) {
    if (minutes === null || minutes === undefined) return '';
    const n = Number(minutes);
    if (n <= 0) return '<span class="text-green-700 font-bold">±0</span>';
    if (n === 1) return '<span class="text-slate-500 font-bold">+1</span>';
    const tone = n >= 5 ? 'text-red-600' : 'text-amber-600';
    return `<span class="${tone} font-bold">+${n}</span>`;
  }

  // 時刻表セル：定刻の下に「実績（到着済）」または「予測（未到着）」を積んで表示する。
  // これが「定刻表示だけでなくリアルタイム時刻表を表示」の実体。
  function stopTimeCellHtml(stop) {
    const sched = `<div class="text-xs text-slate-500 whitespace-nowrap">定刻 ${escapeHtml(stop.scheduledTime || '—')}</div>`;
    if (stop.status === '到着済') {
      const d = stop.delayMinutes;
      return sched + `<div class="text-xs font-bold text-green-700 whitespace-nowrap">実績 ${escapeHtml(stop.actualTime || '—')} ${d !== null && d !== undefined ? delayChipHtml(d) : ''}</div>`;
    }
    if (stop.status === '通過') {
      return sched + '<div class="text-xs text-slate-400">通過</div>';
    }
    const pt = stop.predictedTime;
    if (!pt) return sched + '<div class="text-xs text-slate-400">予測 —</div>';
    return sched + `<div class="text-xs font-bold text-blue-700 whitespace-nowrap">予測 ${escapeHtml(pt)} ${delayChipHtml(stop.predictedDelayMinutes)}</div>`;
  }

  function showDetailPanel() {
    document.getElementById('dashboard-detail-empty').classList.add('hidden');
    document.getElementById('dashboard-detail-body').classList.remove('hidden');
  }

  // 便に割り当てられている（assignmentIdが取れる）バス用の詳細パネル。
  function renderDetailPanel(detail) {
    showDetailPanel();
    const body = document.getElementById('dashboard-detail-body');

    const delay = detail.delayMinutes || 0;
    const delayClass = delay >= 5 ? 'bg-red-600 text-white' : 'bg-blue-100 text-blue-800';

    const rows = (detail.stops || []).map((stop) => `
      <tr class="dashboard-stop-row border-b last:border-b-0" data-role="stop-row" data-stop-id="${stop.stopId}"
          title="タップで到着根拠・ETA推移を表示">
        <td class="px-3 py-2 text-sm font-bold text-slate-800 align-top">${escapeHtml(stop.name)}</td>
        <td class="px-3 py-2 align-top">${stopTimeCellHtml(stop)}</td>
        <td class="px-3 py-2 text-xs font-bold align-top whitespace-nowrap ${statusToneOf(stop.status)}">${statusLabelOf(stop.status)}</td>
        <td class="px-3 py-2 align-top" data-role="actual-time-cell">
          <div class="flex items-center gap-1">
            <input type="text" data-role="actual-time-input" data-stop-id="${stop.stopId}"
                   value="${escapeHtml(stop.actualTime || '')}" placeholder="H:mm｜空=未到着に戻す"
                   class="w-16 border rounded px-1.5 py-1 text-xs" />
            <button type="button" data-role="actual-time-save" data-stop-id="${stop.stopId}"
                    class="text-xs font-bold text-blue-700 hover:text-blue-900 px-1.5 py-1">保存</button>
          </div>
        </td>
      </tr>`).join('');

    body.innerHTML = `
      <div class="p-4 border-b sticky top-0 bg-white z-10">
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-bold text-slate-800 truncate">${escapeHtml(detail.routeName)}</h3>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="text-xs font-bold px-2.5 py-1 rounded-full ${delayClass}">${formatDelayLabel(delay) || '定刻通り'}</span>
            <button type="button" data-role="clear-selection" title="選択解除"
                    class="text-slate-400 hover:text-slate-700 px-1 py-1 font-bold">✕</button>
          </div>
        </div>
        <p class="text-xs text-slate-500 mt-1">${escapeHtml(detail.headsign || '')}行き ・ 車両 ${escapeHtml(detail.carId)} ・ ${escapeHtml(detail.startTime || '')}発</p>
        <div class="mt-2">
          <button type="button" data-role="unlink-assignment" data-assignment-id="${detail.assignmentId}"
                  class="text-xs font-bold text-red-700 hover:text-red-900 border border-red-300 hover:border-red-500 rounded px-2 py-1">
            この便との紐づけを解除
          </button>
        </div>
      </div>
      <p class="px-4 py-1.5 text-[11px] text-slate-400 border-b">各バス停をタップすると、到着済は判定根拠（付近経由／ベクトル判定 等）と遅れ・ETA推移、未到着はETA予測根拠とETA推移を表示します。到着判定時刻を空にして保存すると未到着に戻せます。</p>
      <table class="w-full text-left">
        <thead>
          <tr class="text-[11px] text-slate-400 border-b">
            <th class="px-3 py-1.5 font-bold">バス停</th>
            <th class="px-3 py-1.5 font-bold">定刻／実績・予測</th>
            <th class="px-3 py-1.5 font-bold">状態</th>
            <th class="px-3 py-1.5 font-bold">到着判定時刻</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    body.querySelectorAll('[data-role="unlink-assignment"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この便との紐づけを解除しますか？')) return;
        btn.disabled = true;
        try {
          await api(`/api/admin/assignments/${btn.dataset.assignmentId}`, { method: 'DELETE' });
          showStatus('紐づけを解除しました。');
          clearSelection();
          loadDashboard();
        } catch (err) {
          showStatus(err.message, 'error');
          btn.disabled = false;
        }
      });
    });

    body.querySelectorAll('[data-role="actual-time-save"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // 行タップ（詳細モーダル）を発火させない
        const stopId = btn.dataset.stopId;
        const input = body.querySelector(`[data-role="actual-time-input"][data-stop-id="${stopId}"]`);
        const value = input.value.trim();
        if (value === '' && !confirm('このバス停を未到着に戻しますか？（到着判定・実績時刻・遅れ・判定根拠を消去します）')) return;
        btn.disabled = true;
        try {
          await api(`/api/admin/assignments/${detail.assignmentId}/stops/${stopId}`, {
            method: 'PUT',
            body: JSON.stringify({ actualTime: value })
          });
          showStatus(value === '' ? 'バス停を未到着に戻しました。' : '到着判定時刻を保存しました。');
          await loadAssignmentDetail(detail.assignmentId);
        } catch (err) {
          showStatus(err.message, 'error');
          btn.disabled = false;
        }
      });
    });

    // バス停の行タップ → 到着根拠／ETA予測根拠・ETA推移のモーダル。
    body.querySelectorAll('[data-role="stop-row"]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-role="actual-time-cell"]')) return; // 編集欄クリックは除外
        openStopDetailModal(detail.assignmentId, Number(tr.dataset.stopId));
      });
    });
  }

  // 便に割り当てられていない（＝候補にすらなっていない）バス用の簡易パネル。
  // 「全車両」モードでのみ現れうる。リアルタイム時刻表・停車バス停・位置履歴は表示できない。
  // vehicleIdが取れる車両については、この便一覧から選んで手動で紐づけられるようにする。
  function renderMinimalPanel(bus) {
    showDetailPanel();
    const body = document.getElementById('dashboard-detail-body');
    body.innerHTML = `
      <div class="p-4 border-b sticky top-0 bg-white z-10">
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-bold text-slate-800 truncate">${escapeHtml(bus.routeName || '路線未確定')}</h3>
          <button type="button" data-role="clear-selection" title="選択解除"
                  class="shrink-0 text-slate-400 hover:text-slate-700 px-1 py-1 font-bold">✕</button>
        </div>
        <p class="text-xs text-slate-500 mt-1">車両 ${escapeHtml(bus.id)} ・ GPS時刻 ${escapeHtml(bus.gpsTime || '—')}</p>
      </div>
      <div class="p-4 text-xs text-amber-700 bg-amber-50 border-t">
        この車両は現在どの便にも割り当てられていない（候補にもなっていない）ため、リアルタイム時刻表は表示できません。
      </div>
      <div class="p-4 border-t" data-role="link-panel">
        ${bus.vehicleId != null && bus.routeId
          ? `
            <p class="text-xs font-bold text-slate-600 mb-2">この車両を便に手動で紐づける</p>
            <select data-role="link-trip-select" class="w-full border rounded px-2 py-1.5 text-sm mb-2">
              <option value="">読み込み中…</option>
            </select>
            <button type="button" data-role="link-trip-submit" data-vehicle-id="${bus.vehicleId}"
                    class="w-full text-sm font-bold text-white bg-blue-700 hover:bg-blue-800 disabled:bg-slate-300 rounded px-2 py-1.5" disabled>
              この便に紐づける
            </button>
            <p data-role="link-trip-hint" class="text-[11px] text-slate-400 mt-1"></p>
          `
          : `<p class="text-xs text-slate-400">路線・車両が確定していないため、便への手動紐づけはできません。</p>`}
      </div>
    `;

    if (bus.vehicleId != null && bus.routeId) {
      loadLinkableTrips(bus.routeId);
    }
  }

  // 手動紐づけ用の便一覧をセレクトボックスへ読み込む。
  async function loadLinkableTrips(routeId) {
    const body = document.getElementById('dashboard-detail-body');
    const select = body.querySelector('[data-role="link-trip-select"]');
    const submitBtn = body.querySelector('[data-role="link-trip-submit"]');
    const hint = body.querySelector('[data-role="link-trip-hint"]');
    if (!select) return;
    try {
      const data = await api(`/api/admin/daily-trips?routeId=${encodeURIComponent(routeId)}`);
      const trips = data.trips || [];
      if (trips.length === 0) {
        select.innerHTML = '<option value="">本日の便がありません</option>';
        return;
      }
      select.innerHTML = trips.map((t) => {
        const busy = t.assignmentState === 'assigned' && t.assignedCarId;
        const label = `${t.startTime}発 ${t.headsign || ''}${busy ? `（担当あり: 車両${t.assignedCarId}）` : ''}`;
        return `<option value="${t.dailyTripId}" ${busy ? 'disabled' : ''}>${escapeHtml(label)}</option>`;
      }).join('');
      const firstAvailable = select.querySelector('option:not([disabled])');
      if (firstAvailable) select.value = firstAvailable.value;
      if (submitBtn) submitBtn.disabled = !select.value;
      if (hint) hint.textContent = '担当あり の便は先に解除してから紐づけてください。';
    } catch (err) {
      select.innerHTML = '<option value="">取得に失敗しました</option>';
      if (hint) hint.textContent = err.message;
    }
  }

  // 編集中の入力欄が消えてしまわないよう、自動更新（ポーリング）はフォーカス中はスキップする。
  function isEditingActualTime() {
    const active = document.activeElement;
    return !!(active && active.matches && active.matches('#dashboard-detail-body [data-role="actual-time-input"]'));
  }

  // 手動紐づけ用の便選択中に選択が消えてしまわないよう、自動更新はフォーカス中はスキップする。
  function isPickingLinkTrip() {
    const active = document.activeElement;
    return !!(active && active.matches && active.matches('#dashboard-detail-body [data-role="link-trip-select"], #dashboard-detail-body [data-role="link-trip-submit"]'));
  }

  async function loadAssignmentDetail(assignmentId) {
    try {
      const detail = await api(`/api/admin/assignments/${assignmentId}`);
      renderDetailPanel(detail);
      renderMapOverlay(detail);
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }

  // バスアイコンをタップしたときの選択処理。同じバスを再タップしたら選択解除する。
  async function selectBus(bus) {
    const key = markerKey(bus);
    if (selectedKey === key) {
      clearSelection();
      return;
    }

    closeStopDetailModal(); // 別のバスへ切り替えたら、前のバスのバス停詳細モーダルは閉じる
    selectedKey = key;
    selectedBus = bus;
    updateBusMarkers(lastBuses); // 選択中のバス以外を地図上から隠す
    focusOnBus(bus);

    if (bus.assignmentId != null) {
      await loadAssignmentDetail(bus.assignmentId);
    } else {
      clearOverlay();
      renderMinimalPanel(bus);
    }
  }

  function clearSelection() {
    selectedKey = null;
    selectedBus = null;
    closeStopDetailModal();
    clearOverlay();
    updateBusMarkers(lastBuses); // 全バスを再表示
    document.getElementById('dashboard-detail-empty').classList.remove('hidden');
    document.getElementById('dashboard-detail-body').classList.add('hidden');
  }

  /* ---------- 表示モード切替（運行中の便のみ / 全車両・直近3分） ---------- */
  function updateModeToggleUI() {
    document.querySelectorAll('#dashboard-mode-toggle [data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  function setMode(newMode) {
    if (mode === newMode) return;
    mode = newMode;
    mapFitted = false; // モードが変わるバス集合に合わせて再フィットさせる
    clearSelection();
    updateModeToggleUI();
    loadDashboard();
  }

  async function fetchBusesForMode() {
    if (mode === 'all') {
      const data = await api('/api/admin/vehicle-positions-map');
      return data.vehicles || [];
    }
    const data = await api('/api/buses-for-map');
    return data.buses || [];
  }

  function buildStatusText(count, time) {
    if (mode === 'all') {
      return count > 0
        ? `全車両 ${count}台（直近3分・${time} 更新）`
        : `直近3分以内にGPSを受信した車両はありません（${time} 更新）`;
    }
    return count > 0
      ? `運行中 ${count}台（${time} 更新）`
      : `現在運行中のバスはありません（${time} 更新）`;
  }

  /* ---------- サマリー欄（車両数・未割当便数・遅延便数） ---------- */
  function updateStatDelayedUI() {
    const btn = document.querySelector('#dashboard-stats-bar [data-role="stat-delayed"]');
    if (btn) btn.classList.toggle('is-active', delayFilterOnly);
  }

  // 「5分以上の遅延便数」タップ：運行中の便モードに切り替えた上で、地図には遅延便のアイコンだけ表示する。
  // 再タップで解除する。
  function toggleDelayFilter() {
    delayFilterOnly = !delayFilterOnly;
    updateStatDelayedUI();
    if (delayFilterOnly && mode !== 'active') {
      setMode('active'); // setMode側でclearSelection・地図再描画まで行う
    } else {
      clearSelection(); // updateBusMarkersが再実行され、delayFilterOnlyの新しい値が反映される
    }
  }

  function closeUnassignedPopup() {
    const existing = document.getElementById('dashboard-unassigned-modal');
    if (existing) existing.remove();
  }

  // 「本日の未割当便数」タップ：直近取得した未割当便の一覧をポップアップで表示する。
  async function showUnassignedPopup() {
    closeUnassignedPopup();

    let routesById = {};
    try {
      const routes = await getRoutesList();
      routesById = Object.fromEntries(routes.map((r) => [r.id, r.name]));
    } catch (err) {
      // 路線名が引けなくても route_id 表示で継続する
    }

    const trips = lastUnassignedTrips;
    const rows = trips.length
      ? trips.map((t) => `
          <tr class="border-b last:border-b-0">
            <td class="px-3 py-2 text-sm font-bold text-slate-800 whitespace-nowrap align-top">${escapeHtml(t.startTime || '—')}</td>
            <td class="px-3 py-2 text-sm text-slate-700 align-top">${escapeHtml(routesById[t.routeId] || t.routeId || '—')}</td>
            <td class="px-3 py-2 text-sm text-slate-600 align-top">${escapeHtml(t.headsign || '')}</td>
            <td class="px-3 py-2 text-xs text-red-700 align-top">${escapeHtml(t.reason || '')}</td>
          </tr>`).join('')
      : `<tr><td colspan="4" class="px-3 py-6 text-sm text-slate-400 text-center">本日、未割当の便はありません。</td></tr>`;

    const overlay = document.createElement('div');
    overlay.id = 'dashboard-unassigned-modal';
    overlay.className = 'fixed inset-0 bg-black/50 z-[2000] flex items-center justify-center px-4';
    overlay.innerHTML = `
      <div class="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto">
        <div class="p-4 border-b flex items-center justify-between sticky top-0 bg-white">
          <h3 class="font-bold text-slate-800">本日の未割当便（${trips.length}件）</h3>
          <button type="button" data-role="close-unassigned-modal" title="閉じる"
                  class="text-slate-400 hover:text-slate-700 px-1 font-bold">✕</button>
        </div>
        <table class="w-full text-left">
          <thead>
            <tr class="text-[11px] text-slate-400 border-b">
              <th class="px-3 py-1.5 font-bold">始発時刻</th>
              <th class="px-3 py-1.5 font-bold">路線</th>
              <th class="px-3 py-1.5 font-bold">行先</th>
              <th class="px-3 py-1.5 font-bold">未割当の理由</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-role="close-unassigned-modal"]')) closeUnassignedPopup();
    });
    document.body.appendChild(overlay);
  }

  /* ---------- バス停別詳細モーダル（到着判定根拠 / ETA予測根拠 / ETA推移） ---------- */
  function closeStopDetailModal() {
    openStopModal = null;
    const existing = document.getElementById('dashboard-stop-modal');
    if (existing) existing.remove();
  }

  function fmtClock(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
  }

  function signedDelayLabel(minutes) {
    if (minutes === null || minutes === undefined) return '';
    const n = Number(minutes);
    if (n <= 0) return '定刻通り';
    return `${n}分遅れ`;
  }

  // 到着済のときの「判定方法と根拠」ブロック。
  function renderArrivalEvidenceHtml(arrival) {
    if (!arrival) return '';
    const head = `
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-800 text-white">判定方法: ${escapeHtml(arrival.methodLabel)}</span>
        ${arrival.methodDescription ? `<span class="text-xs text-slate-500">${escapeHtml(arrival.methodDescription)}</span>` : ''}
      </div>`;

    let detail = '';
    if (arrival.vector) {
      const v = arrival.vector;
      const num = (x, unit) => (x === null || x === undefined ? '—' : `${Math.round(Number(x) * 100) / 100}${unit || ''}`);
      const pt = (p) => (p ? `${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)}<br><span class="text-slate-400">${escapeHtml(p.gpsTime || '—')}</span>` : '—');
      detail = `
        <table class="w-full text-xs mt-2 border rounded overflow-hidden">
          <tbody>
            <tr class="border-b bg-slate-50"><td class="px-2 py-1 font-bold text-slate-500 w-40">前の位置 P1（緯度,経度 / 時刻）</td><td class="px-2 py-1">${pt(v.p1)}</td></tr>
            <tr class="border-b"><td class="px-2 py-1 font-bold text-slate-500">現在の位置 P2（緯度,経度 / 時刻）</td><td class="px-2 py-1">${pt(v.p2)}</td></tr>
            <tr class="border-b bg-slate-50"><td class="px-2 py-1 font-bold text-slate-500">P1→P2 の移動距離</td><td class="px-2 py-1">${num(v.stepDist, ' m')}</td></tr>
            <tr class="border-b"><td class="px-2 py-1 font-bold text-slate-500">P1 とバス停の距離</td><td class="px-2 py-1">${num(v.distP1Stop, ' m')}</td></tr>
            <tr class="border-b bg-slate-50"><td class="px-2 py-1 font-bold text-slate-500">P2 とバス停の距離</td><td class="px-2 py-1">${num(v.distP2Stop, ' m')}</td></tr>
            <tr class="border-b"><td class="px-2 py-1 font-bold text-slate-500">線分 P1-P2 とバス停の最短距離</td><td class="px-2 py-1">${num(v.segDist, ' m')}</td></tr>
            <tr class="border-b bg-slate-50"><td class="px-2 py-1 font-bold text-slate-500">S→P1・S→P2 の内積（負＝反対側）</td><td class="px-2 py-1">${num(v.dot)}</td></tr>
            <tr><td class="px-2 py-1 font-bold text-slate-500">線分内の最近接位置 t（0=P1, 1=P2）</td><td class="px-2 py-1">${v.t === null || v.t === undefined ? '—' : Number(v.t).toFixed(3)}</td></tr>
          </tbody>
        </table>`;
    } else if (arrival.nearby) {
      const n = arrival.nearby;
      detail = `
        <div class="text-xs mt-2 bg-slate-50 border rounded p-2 space-y-0.5">
          <div>最接近を観測した距離: <span class="font-bold">${n.minDistanceMeters !== null && n.minDistanceMeters !== undefined ? `${Math.round(n.minDistanceMeters)} m` : '—'}</span></div>
          <div>そのときのGPS時刻: <span class="font-bold">${escapeHtml(n.gpsTime || '—')}</span>（この時刻を到着時刻に採用）</div>
          ${n.marginMeters !== null && n.marginMeters !== undefined ? `<div>離脱判定マージン: 最小距離 +${n.marginMeters} m を超えて遠ざかった時点で確定</div>` : ''}
        </div>`;
    } else if (arrival.note) {
      detail = `<div class="text-xs mt-2 text-slate-500">${escapeHtml(arrival.note)}</div>`;
    }
    return `<div class="mt-3">${head}${detail}</div>`;
  }

  // ETA予測の推移（trip_arrival_prediction_log）。末尾が実績（source='actual'）なら強調。
  function renderPredictionHistoryHtml(history) {
    if (!history || history.length === 0) {
      return '<p class="text-xs text-slate-400 mt-2">まだ予測の記録がありません（次回のパイプライン実行で記録されます）。</p>';
    }
    const rows = history.map((h) => {
      const isActual = h.source === 'actual';
      return `
        <li class="flex items-baseline gap-2 py-1 border-b last:border-b-0 ${isActual ? 'bg-green-50' : ''}">
          <span class="text-[11px] text-slate-400 whitespace-nowrap w-12 shrink-0">${fmtClock(h.computedAt)}</span>
          <span class="text-xs font-bold whitespace-nowrap ${isActual ? 'text-green-700' : 'text-slate-700'}">${isActual ? '実績' : '予測'} ${escapeHtml(h.predictedTime || '—')}</span>
          <span class="text-[11px] ${Number(h.predictedDelayMinutes) >= 5 ? 'text-red-600' : 'text-slate-500'} whitespace-nowrap">${signedDelayLabel(h.predictedDelayMinutes)}</span>
          <span class="text-[11px] text-slate-400 truncate">${escapeHtml(h.sourceLabel || h.source || '')}${h.stopsBefore > 0 ? ` ・ ${h.stopsBefore}停留所前` : ''}</span>
        </li>`;
    }).join('');
    return `<ul class="mt-2 border-t">${rows}</ul>`;
  }

  function renderStopDetailModalBody(data) {
    const statusBadge = `<span class="text-xs font-bold px-2 py-0.5 rounded-full ${
      data.status === '到着済' ? 'bg-green-100 text-green-700'
      : data.status === '付近' ? 'bg-amber-100 text-amber-700'
      : data.status === '通過' ? 'bg-blue-100 text-blue-700'
      : 'bg-slate-100 text-slate-500'}">${escapeHtml(statusLabelOf(data.status))}</span>`;

    let mainBlock;
    if (data.status === '到着済') {
      mainBlock = `
        <div class="rounded-lg bg-slate-50 border p-3">
          <div class="flex items-baseline gap-3 flex-wrap">
            <span class="text-sm text-slate-500">定刻 ${escapeHtml(data.scheduledTime || '—')}</span>
            <span class="text-lg font-black text-green-700">到着判定 ${escapeHtml(data.actualTime || '—')}</span>
            <span class="text-sm font-bold ${Number(data.delayMinutes) >= 5 ? 'text-red-600' : 'text-slate-600'}">${signedDelayLabel(data.delayMinutes) || '—'}</span>
            ${data.interpolated ? '<span class="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">補間値</span>' : ''}
          </div>
          ${renderArrivalEvidenceHtml(data.arrival)}
        </div>`;
    } else {
      const cp = data.currentPrediction;
      mainBlock = `
        <div class="rounded-lg bg-slate-50 border p-3">
          <div class="flex items-baseline gap-3 flex-wrap">
            <span class="text-sm text-slate-500">定刻 ${escapeHtml(data.scheduledTime || '—')}</span>
            ${cp
              ? `<span class="text-lg font-black text-blue-700">予測 ${escapeHtml(cp.predictedTime || '—')}</span>
                 <span class="text-sm font-bold ${Number(cp.predictedDelayMinutes) >= 5 ? 'text-red-600' : 'text-slate-600'}">${signedDelayLabel(cp.predictedDelayMinutes) || '—'}</span>`
              : '<span class="text-sm text-slate-400">予測値なし</span>'}
          </div>
          ${cp ? `
            <div class="mt-2 flex items-center gap-2 flex-wrap">
              <span class="text-xs font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">予測根拠: ${escapeHtml(cp.sourceLabel || cp.source)}</span>
              ${cp.computedAt ? `<span class="text-[11px] text-slate-400">${fmtClock(cp.computedAt)} 時点</span>` : ''}
            </div>
            ${paceBreakdownBadges(cp.paceBreakdown)}
          ` : ''}
        </div>`;
    }

    return `
      <div class="p-4 border-b sticky top-0 bg-white z-10 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <h3 class="font-bold text-slate-800 truncate">${escapeHtml(data.name)} ${statusBadge}</h3>
          <p class="text-xs text-slate-500 mt-0.5">${data.seqOrder != null ? `${data.seqOrder + 1} 番目のバス停` : ''}</p>
        </div>
        <button type="button" data-role="close-stop-modal" title="閉じる" class="shrink-0 text-slate-400 hover:text-slate-700 px-1 font-bold">✕</button>
      </div>
      <div class="p-4 space-y-4">
        ${mainBlock}
        <div>
          <p class="text-xs font-bold text-slate-500">予想到着時刻（ETA）の推移</p>
          ${renderPredictionHistoryHtml(data.predictionHistory)}
        </div>
      </div>`;
  }

  async function openStopDetailModal(assignmentId, stopId) {
    openStopModal = { assignmentId, stopId };
    let overlay = document.getElementById('dashboard-stop-modal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'dashboard-stop-modal';
      overlay.className = 'fixed inset-0 bg-black/50 z-[2100] flex items-start justify-center px-4 py-10 overflow-y-auto';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('[data-role="close-stop-modal"]')) closeStopDetailModal();
      });
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '<div class="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 text-sm text-slate-400 text-center">読み込み中…</div>';

    try {
      const data = await api(`/api/admin/assignments/${assignmentId}/stops/${stopId}`);
      // 読み込み中に別のバス停を開いた／閉じた場合は破棄する
      if (!openStopModal || openStopModal.assignmentId !== assignmentId || openStopModal.stopId !== stopId) return;
      overlay.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-full overflow-y-auto">${renderStopDetailModalBody(data)}</div>`;
    } catch (err) {
      overlay.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
        <p class="text-sm font-bold text-red-600">${escapeHtml(err.message)}</p>
        <button type="button" data-role="close-stop-modal" class="mt-3 text-xs font-bold text-slate-500">閉じる</button>
      </div>`;
    }
  }

  // ポーリング時にモーダルが開いていれば内容を更新する（バックグラウンドで静かに差し替え）。
  async function refreshOpenStopModal() {
    if (!openStopModal) return;
    const { assignmentId, stopId } = openStopModal;
    try {
      const data = await api(`/api/admin/assignments/${assignmentId}/stops/${stopId}`);
      if (!openStopModal || openStopModal.assignmentId !== assignmentId || openStopModal.stopId !== stopId) return;
      const overlay = document.getElementById('dashboard-stop-modal');
      if (overlay) {
        overlay.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-full overflow-y-auto">${renderStopDetailModalBody(data)}</div>`;
      }
    } catch (err) {
      // 静かに無視（次のポーリングで再試行）
    }
  }

  // 運行中の便（担当車両）一覧・本日の割当監視データからサマリー3項目を算出する。
  // 地図本体のバス取得（モード依存）とは独立に、常に「運行中の便＝担当車両」基準で数える。
  async function loadStats() {
    try {
      const [busesData, monitorData] = await Promise.all([
        api('/api/buses-for-map'),
        api('/api/admin/assignment-monitor')
      ]);
      const buses = busesData.buses || [];
      const trips = monitorData.trips || [];
      lastUnassignedTrips = trips.filter((t) => t.outcome === 'unassigned');
      const delayedCount = buses.filter((b) => (b.delayMinutes || 0) >= 5).length;

      const vehiclesEl = document.querySelector('[data-role="stat-vehicles-value"]');
      const unassignedEl = document.querySelector('[data-role="stat-unassigned-value"]');
      const delayedEl = document.querySelector('[data-role="stat-delayed-value"]');
      if (vehiclesEl) vehiclesEl.textContent = `${buses.length}台`;
      if (unassignedEl) unassignedEl.textContent = `${lastUnassignedTrips.length}件`;
      if (delayedEl) delayedEl.textContent = `${delayedCount}件`;
    } catch (err) {
      console.error('[admin-dashboard] サマリー取得エラー:', err);
    }
  }

  /* ---------- ロード（セクション表示・15秒ポーリングの両方から呼ばれる） ---------- */
  async function loadDashboard() {
    initializeMap();
    if (mapInstance) mapInstance.invalidateSize();

    const statusEl = document.getElementById('dashboard-map-status');
    try {
      lastBuses = await fetchBusesForMode();
      updateBusMarkers(lastBuses);

      const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      if (statusEl) statusEl.textContent = buildStatusText(lastBuses.length, time);

      if (selectedKey != null) {
        const updated = lastBuses.find((bus) => markerKey(bus) === selectedKey);
        if (!updated) {
          // 選択中の車両がこのモードの一覧から消えた（GPS途絶・便終了など）→選択解除する
          clearSelection();
        } else {
          selectedBus = updated;
          if (updated.assignmentId != null) {
            if (!isEditingActualTime()) await loadAssignmentDetail(updated.assignmentId);
            refreshOpenStopModal();
          } else if (!isPickingLinkTrip()) {
            renderMinimalPanel(updated);
          }
        }
      }
    } catch (err) {
      console.error('[admin-dashboard] バス情報取得エラー:', err);
      if (statusEl) statusEl.textContent = 'バス情報の取得に失敗しました。';
    }

    loadStats();
  }

  document.querySelectorAll('#dashboard-mode-toggle [data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
  document.getElementById('dashboard-detail-panel').addEventListener('click', (e) => {
    if (e.target.closest('[data-role="clear-selection"]')) clearSelection();
  });
  document.getElementById('dashboard-detail-panel').addEventListener('change', (e) => {
    if (e.target.matches('[data-role="link-trip-select"]')) {
      const submitBtn = document.querySelector('#dashboard-detail-body [data-role="link-trip-submit"]');
      if (submitBtn) submitBtn.disabled = !e.target.value;
    }
  });
  document.getElementById('dashboard-detail-panel').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role="link-trip-submit"]');
    if (!btn) return;
    const select = document.querySelector('#dashboard-detail-body [data-role="link-trip-select"]');
    const dailyTripId = select ? select.value : '';
    if (!dailyTripId) return;
    btn.disabled = true;
    try {
      await api('/api/admin/assignments', {
        method: 'POST',
        body: JSON.stringify({ vehicleId: Number(btn.dataset.vehicleId), dailyTripId: Number(dailyTripId) })
      });
      showStatus('便に紐づけました。');
      clearSelection();
      loadDashboard();
    } catch (err) {
      showStatus(err.message, 'error');
      btn.disabled = false;
    }
  });
  document.querySelector('#dashboard-stats-bar [data-role="stat-unassigned"]').addEventListener('click', () => {
    showUnassignedPopup();
  });
  document.querySelector('#dashboard-stats-bar [data-role="stat-delayed"]').addEventListener('click', () => {
    toggleDelayFilter();
  });
  updateModeToggleUI();

  window.AdminDashboard = { load: loadDashboard };
})();
