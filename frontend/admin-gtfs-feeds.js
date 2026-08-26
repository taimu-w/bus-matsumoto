// GTFSフィード監視
(function () {
  async function loadGtfsFeeds() {
    const data = await api('/api/admin/gtfs-feeds');
    const tbody = document.getElementById('gtfs-feeds-tbody');
    tbody.innerHTML = data.feeds.map((f) => `
      <tr class="border-t">
        <td class="px-3 py-2 font-bold">${escapeHtml(f.name)}</td>
        <td class="px-3 py-2 text-xs">${fmtDateTime(f.lastFetchedAt)}</td>
        <td class="px-3 py-2">${f.fileCount}</td>
        <td class="px-3 py-2">
          <span class="px-2 py-0.5 rounded-full text-xs font-bold ${f.lastStatus === 'error' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">${f.lastStatus === 'error' ? 'エラー' : '正常'}</span>
        </td>
        <td class="px-3 py-2 text-xs text-red-600">${escapeHtml(f.lastError || '')}</td>
        <td class="px-3 py-2">
          <button data-refetch-feed="${escapeHtml(f.id)}" class="refetch-btn bg-slate-800 hover:bg-slate-900 text-white font-bold rounded-lg px-3 py-1.5 text-xs">再取得</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.refetch-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const feedId = btn.dataset.refetchFeed;
        btn.disabled = true;
        btn.textContent = '取得中...';
        try {
          const result = await api(`/api/admin/gtfs-feeds/${encodeURIComponent(feedId)}/refetch`, { method: 'POST' });
          showStatus(result.success ? `${result.feed.name} を再取得しました。` : `${result.feed.name} の再取得に失敗しました。`, result.success ? 'info' : 'error');
          await loadGtfsFeeds();
        } catch (err) {
          showStatus(err.message, 'error');
          btn.disabled = false;
          btn.textContent = '再取得';
        }
      });
    });
  }

  document.getElementById('refresh-gtfs-feeds-btn').addEventListener('click', () => loadGtfsFeeds().catch((err) => showStatus(err.message, 'error')));

  window.AdminGtfsFeeds = { load: loadGtfsFeeds };
})();
