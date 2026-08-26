// 外部IDマッピング（外部ID ⇔ GTFS route_id 対応表）
//
// 路線は自由入力ではなく <select> の候補（/api/routes）から選ばせる。
// 表記ゆれによる対応漏れ（過去に「ケ/ヶ」1文字で発生）を、UI側でも構造的に防ぐため。
(function () {
  async function populateMappingRouteSelect(selectedValue) {
    const select = document.getElementById('mapping-route-id');
    const routes = await getRoutesList();
    const current = selectedValue !== undefined ? selectedValue : select.value;
    select.innerHTML = '<option value="">（対応する路線がまだ無い）</option>' +
      routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id)} — ${escapeHtml(r.name)}</option>`).join('');
    select.value = current;
  }

  async function loadRouteMappings() {
    await populateMappingRouteSelect();
    const data = await api('/api/admin/route-mappings');
    renderRouteMappings(data.mappings || []);
  }

  function renderRouteMappings(mappings) {
    const tbody = document.getElementById('route-mappings-list');
    tbody.innerHTML = '';
    if (mappings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="px-3 py-3 text-slate-400">登録されている対応はありません。</td></tr>';
      return;
    }
    mappings.forEach((m) => {
      const routeLabel = m.routeId
        ? `<span class="font-mono text-xs text-slate-500">${escapeHtml(m.routeId)}</span><br>${escapeHtml(m.routeName || '（GTFSに存在しない路線ID）')}`
        : '<span class="text-amber-600 font-bold text-xs">未対応</span>';
      const tr = document.createElement('tr');
      tr.className = 'border-t';
      tr.innerHTML = `
        <td class="px-3 py-2 font-mono text-xs align-top">${escapeHtml(m.externalId)}</td>
        <td class="px-3 py-2 align-top">${routeLabel}</td>
        <td class="px-3 py-2 align-top text-slate-500">${escapeHtml(m.note || '')}</td>
        <td class="px-3 py-2 align-top text-slate-400 text-xs">${fmtDateTime(m.updatedAt)}</td>
        <td class="px-3 py-2 align-top text-right whitespace-nowrap">
          <button data-external-id="${escapeHtml(m.externalId)}" class="edit-mapping-btn text-blue-600 hover:text-blue-800 hover:underline font-bold text-xs mr-3">編集</button>
          <button data-external-id="${escapeHtml(m.externalId)}" class="delete-mapping-btn text-red-600 hover:text-red-800 hover:underline font-bold text-xs">削除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.edit-mapping-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = mappings.find((row) => row.externalId === btn.dataset.externalId);
        if (!m) return;
        document.getElementById('mapping-external-id').value = m.externalId;
        document.getElementById('mapping-note').value = m.note || '';
        populateMappingRouteSelect(m.routeId || '');
        document.getElementById('mapping-external-id').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    tbody.querySelectorAll('.delete-mapping-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/admin/route-mappings/${encodeURIComponent(btn.dataset.externalId)}`, { method: 'DELETE' });
          await loadRouteMappings();
          showStatus('外部IDマッピングを削除しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  async function handleAddMapping() {
    const externalId = document.getElementById('mapping-external-id').value.trim();
    const routeId = document.getElementById('mapping-route-id').value;
    const note = document.getElementById('mapping-note').value.trim();
    if (!externalId) {
      showStatus('外部IDを入力してください。', 'error');
      return;
    }
    if (!routeId && !note) {
      showStatus('対応する路線がまだ無い場合は、備考に理由を入力してください。', 'error');
      return;
    }
    try {
      await api('/api/admin/route-mappings', { method: 'POST', body: JSON.stringify({ externalId, routeId, note }) });
      document.getElementById('mapping-external-id').value = '';
      document.getElementById('mapping-route-id').value = '';
      document.getElementById('mapping-note').value = '';
      await loadRouteMappings();
      showStatus('外部IDマッピングを保存しました。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }
  document.getElementById('add-mapping-btn').addEventListener('click', handleAddMapping);
  document.getElementById('mapping-note').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleAddMapping(); }
  });

  window.AdminRouteMappings = { load: loadRouteMappings };
})();
