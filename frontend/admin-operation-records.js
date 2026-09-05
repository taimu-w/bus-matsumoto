// 運行実績ダウンロード
(function () {
  let recordsRoutesLoaded = false;

  async function initOperationRecords() {
    const fromInput = document.getElementById('records-from');
    const toInput = document.getElementById('records-to');
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // "YYYY-MM-DD"
    if (!fromInput.value) fromInput.value = todayStr;
    if (!toInput.value) toInput.value = todayStr;

    if (!recordsRoutesLoaded) {
      recordsRoutesLoaded = true;
      try {
        const routes = await getRoutesList();
        const select = document.getElementById('records-route');
        routes.forEach((r) => {
          const opt = document.createElement('option');
          opt.value = r.id;
          opt.textContent = r.name || r.id;
          select.appendChild(opt);
        });
      } catch (err) {
        recordsRoutesLoaded = false; // 失敗時は次回の表示で再試行できるようにする
        // 路線一覧の取得に失敗してもダウンロード自体（全路線対象）は行えるため握りつぶす
      }
    }
  }

  document.getElementById('download-records-btn').addEventListener('click', async () => {
    const from = document.getElementById('records-from').value;
    const to = document.getElementById('records-to').value;
    const routeId = document.getElementById('records-route').value;
    const statusEl = document.getElementById('records-status');
    if (!from || !to) {
      statusEl.textContent = '開始日と終了日を指定してください。';
      statusEl.className = 'text-sm text-red-600 font-bold';
      return;
    }

    statusEl.textContent = 'ダウンロード準備中...';
    statusEl.className = 'text-sm text-slate-500';
    try {
      const params = new URLSearchParams({ from, to });
      if (routeId) params.set('routeId', routeId);
      // 認証はhttpOnly Cookie（同一オリジンなので既定で送られる）。
      // CSVをそのまま受け取りたいので、JSON前提のapi()ではなく生のfetchを使う。
      const response = await fetch(`/api/admin/operation-records/export?${params.toString()}`, {
        credentials: 'same-origin'
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'ダウンロードに失敗しました');
      }
      const truncated = response.headers.get('X-Export-Truncated') === 'true';
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `operation-records_${from}_${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (truncated) {
        statusEl.textContent = 'ダウンロードしました（件数が上限を超えたため一部のみ。詳細はCSV末尾を参照）。';
        statusEl.className = 'text-sm text-amber-600 font-bold';
      } else {
        statusEl.textContent = 'ダウンロードしました。';
        statusEl.className = 'text-sm text-green-700 font-bold';
      }
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'text-sm text-red-600 font-bold';
    }
  });

  window.AdminOperationRecords = { load: initOperationRecords };
})();
