// 異常アラート
(function () {
  const ALERT_LABEL = {
    staleGps: 'GPS途絶',
    unassignedTrip: '未割当便',
    severeDelay: '大幅遅延',
    etaComputeFailure: '予測計算失敗',
    gtfsFetchFailure: 'GTFS取得失敗'
  };

  function alertDetail(a) {
    switch (a.type) {
      case 'staleGps':
        return `車両${escapeHtml(a.carId)}（路線: ${escapeHtml(a.routeId || '')}） 最終GPS: ${fmtDateTime(a.lastGpsAt)}`;
      case 'unassignedTrip':
        return `${escapeHtml(a.startTime || '')}発 ${escapeHtml(a.headsign || '')}（${a.minutesOverdue}分経過）`;
      case 'severeDelay':
        return `${escapeHtml(a.startTime || '')}発 車両${escapeHtml(a.carId)} 遅延${a.delayMinutes}分`;
      case 'etaComputeFailure':
        return `${escapeHtml(a.startTime || '')}発 車両${escapeHtml(a.carId)} 最終計算: ${fmtDateTime(a.lastComputedAt)}`;
      case 'gtfsFetchFailure':
        return `${escapeHtml(a.feedName)}: ${escapeHtml(a.lastError || '')}`;
      default:
        return '';
    }
  }

  async function ackAlert(key, btn) {
    btn.disabled = true;
    try {
      await api('/api/admin/alerts/ack', { method: 'POST', body: JSON.stringify({ key }) });
      await loadAlerts();
    } catch (err) {
      btn.disabled = false;
      alert(err.message || '確認処理に失敗しました');
    }
  }

  async function loadAlerts() {
    const data = await api('/api/admin/alerts');
    const container = document.getElementById('alerts-container');
    if (data.alerts.length === 0) {
      container.innerHTML = '<div class="bg-green-50 border-2 border-green-200 rounded-xl p-4 text-center font-bold text-green-700">現在、異常は検知されていません。</div>';
    } else {
      container.innerHTML = data.alerts.map((a) => `
        <div class="rounded-xl border-2 p-3 flex items-start gap-3 ${a.severity === 'critical' ? 'bg-red-50 border-red-300' : 'bg-amber-50 border-amber-300'}">
          <span class="px-2 py-0.5 rounded-full text-xs font-black shrink-0 ${a.severity === 'critical' ? 'bg-red-600 text-white' : 'bg-amber-500 text-white'}">${a.severity === 'critical' ? '緊急' : '警告'}</span>
          <div class="flex-1">
            <p class="font-bold ${a.severity === 'critical' ? 'text-red-800' : 'text-amber-800'}">${ALERT_LABEL[a.type] || a.type}</p>
            <p class="text-sm text-slate-600">${alertDetail(a)}</p>
          </div>
          <button type="button" data-alert-key="${escapeHtml(a.key)}" class="ack-alert-btn shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-white border-2 border-slate-300 text-slate-600 hover:bg-slate-100">確認済みにする</button>
        </div>
      `).join('');
      container.querySelectorAll('.ack-alert-btn').forEach((btn) => {
        btn.addEventListener('click', () => ackAlert(btn.dataset.alertKey, btn));
      });
    }
    refreshAlertsBadge();
  }

  window.AdminAlerts = { load: loadAlerts };
})();
