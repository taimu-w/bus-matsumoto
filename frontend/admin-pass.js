// 通過判定
(function () {
  const PASS_STATUS_BADGE = {
    '到着済': '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">到着済</span>',
    '付近': '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700">付近</span>',
    '通過': '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-700">通過</span>',
    '': '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-500">未定</span>'
  };

  async function loadPassStatus() {
    const data = await api('/api/admin/pass-status');
    const container = document.getElementById('pass-container');
    if (data.rows.length === 0) {
      container.innerHTML = '<div class="bg-white rounded-xl border p-4 text-center text-slate-400">現在アクティブな割り当てがありません。</div>';
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
                <td class="px-4 py-1.5">${PASS_STATUS_BADGE[s.status] || escapeHtml(s.status)}</td>
                <td class="px-4 py-1.5 text-xs text-slate-500">${escapeHtml(s.actualTime || '')}</td>
                <td class="px-4 py-1.5 text-xs text-slate-500">${s.delayMinutes !== null && s.delayMinutes !== undefined ? `${s.delayMinutes}分` : ''}</td>
                <td class="px-4 py-1.5 text-xs text-slate-400">${s.nearbyMinDistanceMeters !== null && s.nearbyMinDistanceMeters !== undefined ? `${Math.round(s.nearbyMinDistanceMeters)}m` : ''}</td>
                <td class="px-4 py-1.5 text-xs text-slate-400">${escapeHtml(s.nearbyMinDistanceGpsTime || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('');
  }

  window.AdminPass = { load: loadPassStatus };
})();
