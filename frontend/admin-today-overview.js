// 当日の状況：路線別ペースサマリ + 遅延メッシュ地図
// ETA予測（etaPredictor.jsのcombinePaceFactor）が「今日の状況」をどの程度反映しているかを
// 俯瞰するための画面。路線別サマリは/api/admin/eta-route-overview、メッシュ地図は
// /api/admin/delay-mesh から取得する（いずれも読み取り専用）。
(function () {
  const MAP_CENTER = [36.2381, 137.9701];
  const MAP_ZOOM = 12;

  let mapInstance = null;
  let meshRectangles = [];

  /* ---------- 地図初期化（一度だけ。以降はinvalidateSizeのみ） ---------- */
  function initializeMap() {
    const mapEl = document.getElementById('delay-mesh-map');
    if (!mapEl || mapInstance) return;

    mapInstance = L.map('delay-mesh-map').setView(MAP_CENTER, MAP_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(mapInstance);

    setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 0);
  }

  function paceLabel(factor) {
    if (factor < 0.85) return '定刻より早い';
    if (factor <= 1.15) return '定刻通り';
    if (factor <= 1.5) return 'やや遅れ';
    return '大幅な遅れ';
  }

  /* ---------- メッシュ地図（遅延メッシュ） ---------- */
  function renderMesh(mesh) {
    if (!mapInstance) return;
    meshRectangles.forEach((r) => mapInstance.removeLayer(r));
    meshRectangles = [];

    mesh.cells.forEach((cell) => {
      const color = paceFactorColor(cell.factor);
      // サンプル数が少ないセルほど確信度が低いことを示すため、塗りを控えめにする（4件で満額）。
      const confidence = Math.min(1, cell.sampleCount / 4);
      const rect = L.rectangle(
        [[cell.latMin, cell.lonMin], [cell.latMax, cell.lonMax]],
        { color: color.hex, weight: 1, fillColor: color.hex, fillOpacity: 0.12 + confidence * 0.38 }
      ).addTo(mapInstance);
      rect.bindTooltip(
        `<div class="mesh-cell-tooltip">ペース比 ×${cell.factor.toFixed(2)}（${escapeHtml(paceLabel(cell.factor))}）<br>サンプル${cell.sampleCount}件</div>`,
        { sticky: true }
      );
      meshRectangles.push(rect);
    });
  }

  function renderMeshLegend(mesh) {
    const legend = document.getElementById('delay-mesh-legend');
    const items = [
      { label: '定刻より早い', factor: 0.7 },
      { label: '定刻通り', factor: 1.0 },
      { label: 'やや遅れ', factor: 1.3 },
      { label: '大幅な遅れ', factor: 1.8 }
    ];
    const swatches = items.map((item) => {
      const c = paceFactorColor(item.factor);
      return `<span class="px-2 py-1 rounded-full font-bold ${c.bg} ${c.text}">${escapeHtml(item.label)}</span>`;
    }).join('');
    const cellCount = mesh ? mesh.cells.length : 0;
    legend.innerHTML = `${swatches}<span class="text-slate-400">セル${cellCount}件（濃さ=サンプル数の多さ）</span>`;
  }

  /* ---------- 路線別サマリ ---------- */
  function factorBadge(factor, extraHtml) {
    if (factor === null || factor === undefined) return '<span class="text-slate-300">—</span>';
    const c = paceFactorColor(factor);
    return `<span class="px-2 py-0.5 rounded-full text-xs font-bold ${c.bg} ${c.text}">×${factor.toFixed(2)}</span>${extraHtml || ''}`;
  }

  function normalizeRouteColor(color, fallback) {
    const raw = String(color || '').replace(/^#/, '');
    return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(raw) ? `#${raw}` : fallback;
  }

  function renderRouteTable(routes) {
    const tbody = document.getElementById('today-overview-route-tbody');
    if (routes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="px-3 py-6 text-center text-slate-400">現在稼働中の路線がありません。</td></tr>';
      return;
    }

    tbody.innerHTML = routes.map((r) => `
      <tr class="border-t">
        <td class="px-3 py-2">
          <span class="inline-flex items-center gap-1.5 font-bold">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${normalizeRouteColor(r.color, '#334155')}"></span>
            ${escapeHtml(r.routeName)}
          </span>
        </td>
        <td class="px-3 py-2">${r.activeAssignments}台</td>
        <td class="px-3 py-2">${factorBadge(r.avgLiveFactor)}</td>
        <td class="px-3 py-2">${r.todayPreviousTripUsageCount > 0
          ? factorBadge(r.avgTodayPreviousTripFactor, `<span class="text-slate-400 text-xs ml-1">(${r.todayPreviousTripUsageCount}件)</span>`)
          : '<span class="text-slate-300 text-xs">未使用</span>'}</td>
        <td class="px-3 py-2">${r.nearbyUsageCount > 0
          ? factorBadge(r.avgNearbyFactor, `<span class="text-slate-400 text-xs ml-1">(${r.nearbyUsageCount}件)</span>`)
          : '<span class="text-slate-300 text-xs">未使用</span>'}</td>
        <td class="px-3 py-2">${factorBadge(r.avgCombinedPaceFactor)}</td>
        <td class="px-3 py-2">${r.avgPredictedDelayMinutes != null ? `${r.avgPredictedDelayMinutes.toFixed(1)}分` : '—'}</td>
        <td class="px-3 py-2">${r.maxPredictedDelayMinutes != null ? `${r.maxPredictedDelayMinutes}分` : '—'}</td>
      </tr>
    `).join('');
  }

  /* ---------- ロード（セクション表示・30秒ポーリング・セルサイズ変更の全てから呼ばれる） ---------- */
  async function loadTodayOverview() {
    initializeMap();
    if (mapInstance) mapInstance.invalidateSize();

    const cellMeters = document.getElementById('mesh-cell-size').value;
    const [overview, mesh] = await Promise.all([
      api('/api/admin/eta-route-overview'),
      api(`/api/admin/delay-mesh?cellMeters=${encodeURIComponent(cellMeters)}`)
    ]);

    renderRouteTable(overview.routes);
    renderMesh(mesh);
    renderMeshLegend(mesh);
    document.getElementById('today-overview-updated').textContent = `更新: ${fmtDateTime(new Date().toISOString())}`;
  }

  document.getElementById('mesh-cell-size').addEventListener('change', () => {
    loadTodayOverview().catch((err) => showStatus(err.message, 'error'));
  });

  window.AdminTodayOverview = { load: loadTodayOverview };
})();
