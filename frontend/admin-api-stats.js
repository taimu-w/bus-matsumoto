// API稼働監視
(function () {
  async function loadApiStats() {
    const data = await api('/api/admin/api-stats');
    const tbody = document.getElementById('api-stats-tbody');
    tbody.innerHTML = data.endpoints.map((e) => `
      <tr class="border-t">
        <td class="px-3 py-2 font-mono text-xs">${escapeHtml(e.method)} ${escapeHtml(e.pattern)}</td>
        <td class="px-3 py-2">${e.count}</td>
        <td class="px-3 py-2 ${e.errorRate > 0 ? 'text-red-600 font-bold' : ''}">${(e.errorRate * 100).toFixed(1)}%</td>
        <td class="px-3 py-2">${e.avgDurationMs}ms</td>
        <td class="px-3 py-2 text-xs text-slate-400">${fmtDateTime(e.lastAccessAt)}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="px-3 py-6 text-center text-slate-400">記録がありません。</td></tr>';

    const errorsBox = document.getElementById('api-stats-errors');
    errorsBox.innerHTML = data.recentErrors.length === 0
      ? '<p class="text-slate-400">直近の失敗はありません。</p>'
      : data.recentErrors.map((e) => `
          <div class="flex items-center justify-between py-1 border-b last:border-b-0">
            <span class="font-mono text-xs">${escapeHtml(e.method)} ${escapeHtml(e.pattern)}</span>
            <span class="text-xs text-red-600 font-bold">${e.statusCode}</span>
            <span class="text-xs text-slate-400">${fmtDateTime(e.ts)}</span>
          </div>
        `).join('');
  }

  document.getElementById('refresh-api-stats-btn').addEventListener('click', () => loadApiStats().catch((err) => showStatus(err.message, 'error')));

  window.AdminApiStats = { load: loadApiStats };
})();
