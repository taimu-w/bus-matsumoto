// ETA予測根拠
(function () {
  const BASIS_CATEGORY_STYLE = {
    schedule: 'bg-slate-100 text-slate-600',
    historical: 'bg-indigo-100 text-indigo-700',
    pace: 'bg-purple-100 text-purple-700',
    fallback: 'bg-amber-100 text-amber-700',
    actual: 'bg-green-100 text-green-700',
    unknown: 'bg-slate-100 text-slate-500'
  };

  async function loadEtaBasis() {
    const data = await api('/api/admin/eta-basis');

    const legend = document.getElementById('eta-basis-legend');
    legend.innerHTML = Object.values(data.sourceLegend || {}).map((info) => `
      <span class="px-2 py-1 rounded-full font-bold ${BASIS_CATEGORY_STYLE[info.category] || BASIS_CATEGORY_STYLE.unknown}">${escapeHtml(info.label)}</span>
    `).join('');

    const container = document.getElementById('eta-basis-container');
    if (data.rows.length === 0) {
      container.innerHTML = '<div class="bg-white rounded-xl border p-4 text-center text-slate-400">現在アクティブな割り当てがありません。</div>';
      document.getElementById('eta-basis-updated').textContent = `更新: ${fmtDateTime(new Date().toISOString())}`;
      return;
    }

    const byTrip = new Map();
    for (const row of data.rows) {
      const key = `${row.tripId}:${row.assignmentId}`;
      if (!byTrip.has(key)) byTrip.set(key, { ...row, stops: [] });
      byTrip.get(key).stops.push(row);
    }

    container.innerHTML = Array.from(byTrip.values()).map((trip) => `
      <div class="bg-white rounded-xl border overflow-hidden">
        <div class="px-4 py-2 bg-slate-50 flex items-center justify-between">
          <span class="font-bold">${escapeHtml(trip.startTime || '')}発 ${escapeHtml(trip.headsign || '')}</span>
          <span class="text-xs px-2 py-0.5 rounded-full font-bold ${trip.role === 'assigned' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}">
            車両${escapeHtml(trip.carId)}（${trip.role === 'assigned' ? '担当' : '候補'}）
          </span>
        </div>
        <table class="w-full text-sm">
          <tbody>
            ${trip.stops.map((s) => `
              <tr class="border-t">
                <td class="px-4 py-1.5">${escapeHtml(s.stopName)}</td>
                <td class="px-4 py-1.5 text-xs text-slate-500">定刻 ${escapeHtml(s.scheduledTime || '—')}</td>
                <td class="px-4 py-1.5 text-xs text-slate-500">予測 ${escapeHtml(s.predictedTime || '—')}${s.predictedDelayMinutes ? `（${s.predictedDelayMinutes}分遅れ）` : ''}</td>
                <td class="px-4 py-1.5">
                  <span class="px-2 py-0.5 rounded-full text-xs font-bold ${BASIS_CATEGORY_STYLE[s.basisCategory] || BASIS_CATEGORY_STYLE.unknown}">${escapeHtml(s.basisLabel)}</span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('');
    document.getElementById('eta-basis-updated').textContent = `更新: ${fmtDateTime(new Date().toISOString())}`;
  }

  window.AdminEtaBasis = { load: loadEtaBasis };
})();
