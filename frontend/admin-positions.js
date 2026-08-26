// バス位置情報モニター（手動更新のみ。SECTION_LOADERSには登録しない）
(function () {
  const positionsContainer = document.getElementById('positions-container');
  const positionsStatus = document.getElementById('positions-status');

  function renderBusPositions(data) {
    positionsContainer.innerHTML = '';
    if (!data || !data.positions || data.positions.length === 0) {
      positionsContainer.innerHTML = `
        <div class="bg-yellow-50 border-2 border-yellow-200 rounded-xl p-4 text-center">
          <p class="font-bold text-yellow-800">直近3分以内のバス位置情報はありません。</p>
          <p class="text-sm text-yellow-600 mt-1">位置情報の取得間隔やフィルタ設定を確認してください。</p>
        </div>
      `;
      return;
    }

    const now = new Date(data.fetchedAt);

    data.positions.forEach((pos) => {
      const gpsDate = new Date(pos.gpsTimeTs);
      const diffSec = Math.floor((now.getTime() - gpsDate.getTime()) / 1000);
      const freshnessLabel = diffSec < 60 ? `${diffSec}秒前` : Math.floor(diffSec / 60) + '分前';
      const freshnessColor = diffSec < 60 ? 'text-green-600 bg-green-50 border-green-200' : 'text-yellow-700 bg-yellow-50 border-yellow-200';

      const card = document.createElement('div');
      card.className = 'border-2 border-slate-200 rounded-xl p-4 bg-white hover:shadow-md transition-shadow';
      card.innerHTML = `
        <div class="flex justify-between items-start mb-3">
          <div class="flex items-center gap-2">
            <span class="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-700 font-bold">${escapeHtml(pos.carId.slice(-2))}</span>
            <div>
              <span class="font-bold text-lg text-slate-900">車両 ${escapeHtml(pos.carId)}</span>
              <span class="text-xs px-2 py-0.5 rounded-full border ${freshnessColor} font-bold ml-2">${freshnessLabel}</span>
            </div>
          </div>
          <a href="https://www.google.com/maps?q=${pos.lat},${pos.lon}" target="_blank"
             class="text-blue-600 hover:text-blue-800 text-sm font-bold flex items-center gap-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path>
            </svg>
            地図
          </a>
        </div>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p class="text-slate-400 text-xs font-bold">路線</p>
            <p class="font-bold">${escapeHtml(pos.routeName)}${pos.directionId === 0 ? '（下り）' : '（上り）'}</p>
          </div>
          <div>
            <p class="text-slate-400 text-xs font-bold">GPS時刻</p>
            <p class="font-bold">${escapeHtml(pos.gpsTime)}</p>
          </div>
          <div class="col-span-2">
            <p class="text-slate-400 text-xs font-bold">位置</p>
            <p class="font-bold">${pos.address ? escapeHtml(pos.address) : '住所取得中...'}</p>
            <p class="text-xs text-slate-400 mt-0.5">${pos.lat}, ${pos.lon}</p>
          </div>
        </div>
      `;
      positionsContainer.appendChild(card);
    });
  }

  async function loadBusPositions() {
    const icon = document.getElementById('pos-refresh-icon');
    icon.classList.add('animate-spin');
    positionsStatus.textContent = '位置情報を取得中...';
    positionsStatus.className = 'text-sm font-bold text-blue-600';

    try {
      const data = await api('/api/admin/bus-positions');
      renderBusPositions(data);
      const fetchedAtStr = new Date(data.fetchedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      positionsStatus.textContent = `✓ ${data.count} 台のバスを検出（取得時刻: ${fetchedAtStr}）`;
      positionsStatus.className = 'text-sm font-bold text-green-700';
    } catch (err) {
      positionsContainer.innerHTML = `
        <div class="bg-red-50 border-2 border-red-200 rounded-xl p-4">
          <p class="font-bold text-red-800">位置情報の取得に失敗しました。</p>
          <p class="text-sm text-red-600 mt-1">${escapeHtml(err.message)}</p>
        </div>
      `;
      positionsStatus.textContent = 'エラーが発生しました。もう一度お試しください。';
      positionsStatus.className = 'text-sm font-bold text-red-600';
    } finally {
      setTimeout(() => icon.classList.remove('animate-spin'), 500);
    }
  }

  document.getElementById('refresh-positions-btn').addEventListener('click', loadBusPositions);

  window.AdminPositions = {};
})();
