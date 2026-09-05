// ジョブ監視
(function () {
  function jobHistoryDots(history) {
    if (!history || history.length === 0) return '<span class="text-slate-300">—</span>';
    return history.slice(-10).map((h) => `<span class="inline-block w-2.5 h-2.5 rounded-full mr-0.5 ${h.ok ? 'bg-green-500' : 'bg-red-500'}" title="${escapeHtml(fmtDateTime(h.finishedAt))}"></span>`).join('');
  }

  function skipCell(j) {
    if (!j.skipCount) return '<span class="text-slate-300">—</span>';
    const warn = j.consecutiveSkips >= 3;
    return `<span class="${warn ? 'text-red-600 font-bold' : 'text-slate-500'}">連続${j.consecutiveSkips}回 / 累計${j.skipCount}回</span>`;
  }

  async function loadJobMonitor() {
    const data = await api('/api/admin/job-monitor');
    const tbody = document.getElementById('job-monitor-tbody');
    tbody.innerHTML = data.jobs.map((j) => `
      <tr class="border-t">
        <td class="px-3 py-2 font-mono text-xs">${escapeHtml(j.name)}</td>
        <td class="px-3 py-2 text-xs">${j.lastOk === false ? '<span class="text-red-600 font-bold">失敗</span> ' : ''}${fmtDateTime(j.lastFinishedAt)}</td>
        <td class="px-3 py-2">${fmtDuration(j.lastDurationMs)}</td>
        <td class="px-3 py-2">${jobHistoryDots(j.history)}</td>
        <td class="px-3 py-2 text-xs">${skipCell(j)}</td>
        <td class="px-3 py-2 text-xs text-red-600">${escapeHtml(j.lastError || '')}</td>
      </tr>
    `).join('');
  }

  window.AdminJobMonitor = { load: loadJobMonitor };
})();
