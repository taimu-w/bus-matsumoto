// 位置情報フィード監視
(function () {
  function locationSkipSummary(counts) {
    if (!counts) return '<span class="text-slate-300">実行履歴なし</span>';
    return `取得${counts.inserted ?? 0} / 走査${counts.scanned ?? 0} / 路線不一致${counts.skippedNoRouteMatch ?? 0} / 時刻異常${counts.skippedStaleOrInvalidTime ?? 0} / 座標異常${counts.skippedInvalidLatLon ?? 0}`;
  }

  async function loadLocationFeeds() {
    const data = await api('/api/admin/location-feeds');
    const tbody = document.getElementById('location-feeds-tbody');
    tbody.innerHTML = data.feeds.map((f) => `
      <tr class="border-t">
        <td class="px-3 py-2 font-bold">${escapeHtml(f.name)}</td>
        <td class="px-3 py-2 text-xs">${fmtDateTime(f.lastFetchedAt)}</td>
        <td class="px-3 py-2">
          <span class="px-2 py-0.5 rounded-full text-xs font-bold ${f.lastStatus === 'error' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">${f.lastStatus === 'error' ? 'エラー' : '正常'}</span>
        </td>
        <td class="px-3 py-2">${f.lastRunCounts ? f.lastRunCounts.inserted : '—'}</td>
        <td class="px-3 py-2 text-xs text-slate-500">${locationSkipSummary(f.lastRunCounts)}</td>
      </tr>
    `).join('');
  }

  document.getElementById('refresh-location-feeds-btn').addEventListener('click', () => loadLocationFeeds().catch((err) => showStatus(err.message, 'error')));

  window.AdminLocationFeeds = { load: loadLocationFeeds };
})();
