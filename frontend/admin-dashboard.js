// 運行ダッシュボード
(function () {
  async function loadDashboard() {
    const data = await api('/api/admin/dashboard-summary');
    const tiles = [
      { label: '稼働車両数', value: data.activeVehicles, tone: 'blue' },
      { label: '担当未確定便数', value: data.unassignedTripsCount, tone: data.unassignedTripsCount > 0 ? 'amber' : 'blue' },
      { label: '遅延便数', value: data.delayedTripsCount, tone: data.delayedTripsCount > 0 ? 'amber' : 'blue' },
      { label: 'GPS未受信車両数', value: data.staleGpsVehicleCount, tone: data.staleGpsVehicleCount > 0 ? 'red' : 'blue' },
      { label: 'GTFSフィード数', value: data.gtfsFeeds.length, tone: 'blue' }
    ];
    const toneClass = {
      blue: 'bg-blue-50 text-blue-800 border-blue-200',
      amber: 'bg-amber-50 text-amber-800 border-amber-200',
      red: 'bg-red-50 text-red-800 border-red-200'
    };
    document.getElementById('dashboard-tiles').innerHTML = tiles.map((t) => `
      <div class="rounded-xl border-2 p-4 ${toneClass[t.tone]}">
        <p class="text-xs font-bold opacity-70">${escapeHtml(t.label)}</p>
        <p class="text-3xl font-black mt-1">${t.value}</p>
      </div>
    `).join('');

    document.getElementById('dashboard-gtfs').innerHTML = data.gtfsFeeds.map((f) => `
      <div class="flex items-center justify-between py-2 border-b last:border-b-0">
        <span class="font-bold">${escapeHtml(f.name)}</span>
        <span class="flex items-center gap-3 text-xs">
          <span class="text-slate-400">最終取得: ${fmtDateTime(f.lastFetchedAt)}</span>
          <span class="px-2 py-0.5 rounded-full font-bold ${f.lastStatus === 'error' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">${f.lastStatus === 'error' ? 'エラー' : '正常'}</span>
        </span>
      </div>
    `).join('') || '<p class="text-slate-400">GTFSフィードが設定されていません。</p>';
  }

  window.AdminDashboard = { load: loadDashboard };
})();
