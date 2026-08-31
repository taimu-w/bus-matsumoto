// リアルタイム休止（路線ごとの「リアルタイム運行情報の表示」一時停止スイッチ）
//
// 行があれば休止中、「再開」で削除。時刻表ベースの表示・経路検索は影響を受けない。
// 路線は自由入力ではなく <select> の候補（/api/routes）から選ばせる
// （admin-route-mappings.js / admin-direction-rules.js と同じ理由）。
(function () {
  async function populateRouteSelect() {
    const select = document.getElementById('suspension-route-id');
    const routes = await getRoutesList();
    const current = select.value;
    select.innerHTML = '<option value="">路線を選択…</option>' +
      routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id)} — ${escapeHtml(r.name)}</option>`).join('');
    select.value = current;
  }

  async function loadSuspensions() {
    await populateRouteSelect();
    const data = await api('/api/admin/realtime-suspensions');
    renderSuspensions(data.suspensions || []);
  }

  function renderSuspensions(suspensions) {
    const tbody = document.getElementById('suspension-list');
    tbody.innerHTML = '';
    if (suspensions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="px-3 py-3 text-slate-400">現在リアルタイムを休止している路線はありません（全路線が通常どおりリアルタイム表示されています）。</td></tr>';
      return;
    }
    suspensions.forEach((s) => {
      const routeLabel = s.routeName
        ? `<span class="font-mono text-xs text-slate-500">${escapeHtml(s.routeId)}</span><br>${escapeHtml(s.routeName)}`
        : `<span class="font-mono text-xs text-slate-500">${escapeHtml(s.routeId)}</span><br><span class="text-amber-600 font-bold text-xs">GTFSに存在しない路線ID</span>`;
      const tr = document.createElement('tr');
      tr.className = 'border-t';
      tr.innerHTML = `
        <td class="px-3 py-2 align-top">${routeLabel}</td>
        <td class="px-3 py-2 align-top text-slate-600">${escapeHtml(s.reason || '（未設定）')}</td>
        <td class="px-3 py-2 align-top text-slate-500">${escapeHtml(s.note || '')}</td>
        <td class="px-3 py-2 align-top text-slate-400 text-xs">${fmtDateTime(s.suspendedAt)}</td>
        <td class="px-3 py-2 align-top text-right whitespace-nowrap">
          <button data-route-id="${escapeHtml(s.routeId)}" class="edit-suspension-btn text-blue-600 hover:text-blue-800 hover:underline font-bold text-xs mr-3">編集</button>
          <button data-route-id="${escapeHtml(s.routeId)}" class="resume-suspension-btn text-red-600 hover:text-red-800 hover:underline font-bold text-xs">再開</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.edit-suspension-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = suspensions.find((row) => row.routeId === btn.dataset.routeId);
        if (!s) return;
        document.getElementById('suspension-route-id').value = s.routeId;
        document.getElementById('suspension-reason').value = s.reason || '';
        document.getElementById('suspension-note').value = s.note || '';
        document.getElementById('suspension-route-id').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    tbody.querySelectorAll('.resume-suspension-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/admin/realtime-suspensions/${encodeURIComponent(btn.dataset.routeId)}`, { method: 'DELETE' });
          await loadSuspensions();
          showStatus('リアルタイム表示を再開しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  async function handleSave() {
    const routeId = document.getElementById('suspension-route-id').value;
    const reason = document.getElementById('suspension-reason').value.trim();
    const note = document.getElementById('suspension-note').value.trim();
    if (!routeId) {
      showStatus('路線を選択してください。', 'error');
      return;
    }
    try {
      await api('/api/admin/realtime-suspensions', {
        method: 'POST',
        body: JSON.stringify({ routeId, reason, note })
      });
      document.getElementById('suspension-route-id').value = '';
      document.getElementById('suspension-reason').value = '';
      document.getElementById('suspension-note').value = '';
      await loadSuspensions();
      showStatus('この路線のリアルタイム表示を休止しました。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }

  document.getElementById('suspension-save-btn').addEventListener('click', handleSave);
  document.getElementById('suspension-reason').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleSave(); }
  });

  window.AdminRuntimeSuspension = { load: loadSuspensions };
})();
