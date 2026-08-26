// サイト閲覧数
(function () {
  const viewersStatus = document.getElementById('viewers-status');

  async function loadViewerStats() {
    try {
      const data = await api('/api/server-load');
      const toneClass = data.highLoad ? 'text-red-700' : 'text-green-700';
      const statusLabel = data.highLoad ? '⚠ 高負荷（自動更新は自動OFFになります）' : '通常';
      viewersStatus.innerHTML = `
        <span class="${toneClass}">現在の閲覧数: ${data.activeViewers} 人</span>
        <span class="text-slate-400 mx-2">/</span>
        <span class="text-slate-500">しきい値 ${data.threshold} 人</span>
        <span class="text-slate-400 mx-2">/</span>
        <span class="${toneClass}">${statusLabel}</span>
      `;
    } catch (err) {
      viewersStatus.textContent = '閲覧数の取得に失敗しました。';
      viewersStatus.className = 'text-sm font-bold text-red-600';
    }
  }

  document.getElementById('refresh-viewers-btn').addEventListener('click', () => loadViewerStats().catch((err) => showStatus(err.message, 'error')));

  window.AdminViewers = { load: loadViewerStats };
})();
