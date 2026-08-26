// 便の割当監視
(function () {
  const OUTCOME_BADGE = {
    pending: '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-500">未評価</span>',
    assigned: '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">担当あり</span>',
    success: '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">正常終了</span>',
    unassigned: '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">未割当</span>'
  };

  async function loadAssignmentMonitor() {
    const data = await api('/api/admin/assignment-monitor');
    const tbody = document.getElementById('assignment-tbody');
    if (data.trips.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-6 text-center text-slate-400">本日の便がありません。</td></tr>';
    } else {
      tbody.innerHTML = data.trips.map((t) => `
        <tr class="border-t">
          <td class="px-3 py-2 whitespace-nowrap">
            <div class="font-bold">${escapeHtml(t.startTime || '')}発</div>
            <div class="text-xs text-slate-400">${escapeHtml(t.headsign || '')}</div>
          </td>
          <td class="px-3 py-2">${OUTCOME_BADGE[t.outcome] || ''}</td>
          <td class="px-3 py-2">${t.assigned ? `車両 ${escapeHtml(t.assigned.carId)}` : '<span class="text-slate-300">—</span>'}</td>
          <td class="px-3 py-2">${t.assigned ? `${Math.round(t.assigned.distanceMeters)}m` : '<span class="text-slate-300">—</span>'}</td>
          <td class="px-3 py-2 text-xs">${t.assigned ? fmtDateTime(t.assigned.becameAssignedAt) : '<span class="text-slate-300">—</span>'}</td>
          <td class="px-3 py-2">${
            t.candidates.length > 0
              ? t.candidates.map((c) => `<span class="inline-block mr-1 mb-1 px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600">車両${escapeHtml(c.carId)}(${Math.round(c.distanceMeters)}m)</span>`).join('')
              : '<span class="text-slate-300">—</span>'
          }</td>
          <td class="px-3 py-2 text-xs text-slate-500">${escapeHtml(t.reason || '')}</td>
        </tr>
      `).join('');
    }
    document.getElementById('assignment-updated').textContent = `更新: ${fmtDateTime(new Date().toISOString())}`;
  }

  window.AdminAssignment = { load: loadAssignmentMonitor };
})();
