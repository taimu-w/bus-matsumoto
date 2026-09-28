// 外部IDマッピング（外部ID ⇔ GTFS route_id 対応表）
//
// 路線は自由入力ではなく <select> の候補（/api/routes）から選ばせる。
// 表記ゆれによる対応漏れ（過去に「ケ/ヶ」1文字で発生）を、UI側でも構造的に防ぐため。
//
// 1行＝1つの (外部ID, 路線) の対応で、多対多。1つの路線に複数の外部IDを、
// 1つの外部IDに複数の路線を紐づけられるため、編集・削除は外部IDだけでなく
// 「どの行か」（外部ID＋路線）を指定して行う。
(function () {
  // 編集中の行。null なら新規追加モード。routeId は '' のとき「未対応」行。
  let editingRow = null;

  async function populateMappingRouteSelect(selectedValue) {
    const select = document.getElementById('mapping-route-id');
    const routes = await getRoutesList();
    const current = selectedValue !== undefined ? selectedValue : select.value;
    select.innerHTML = '<option value="">（対応する路線がまだ無い）</option>' +
      routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id)} — ${escapeHtml(r.name)}</option>`).join('');
    select.value = current;
  }

  // 編集モードの表示を切り替える。編集中は外部IDを読み取り専用にして、
  // 「どの行を書き換えているのか」が入力途中でずれないようにする。
  function renderEditMode() {
    const externalIdInput = document.getElementById('mapping-external-id');
    const hint = document.getElementById('mapping-edit-hint');
    const cancelBtn = document.getElementById('cancel-mapping-edit-btn');
    const saveBtn = document.getElementById('add-mapping-btn');
    externalIdInput.readOnly = editingRow !== null;
    externalIdInput.classList.toggle('bg-slate-100', editingRow !== null);
    saveBtn.textContent = editingRow ? '更新' : '保存';
    cancelBtn.classList.toggle('hidden', editingRow === null);
    if (editingRow) {
      hint.textContent = `編集中: 外部ID ${editingRow.externalId} ／ 対応路線 ${editingRow.routeId || '（未対応）'}`;
      hint.classList.remove('hidden');
    } else {
      hint.textContent = '';
      hint.classList.add('hidden');
    }
  }

  function clearForm() {
    editingRow = null;
    document.getElementById('mapping-external-id').value = '';
    document.getElementById('mapping-route-id').value = '';
    document.getElementById('mapping-note').value = '';
    renderEditMode();
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
    // 同じ外部IDに複数の路線が紐づくことがあるので、何路線あるかを行に出す。
    const routeCountByExternalId = new Map();
    mappings.forEach((m) => {
      if (!m.routeId) return;
      routeCountByExternalId.set(m.externalId, (routeCountByExternalId.get(m.externalId) || 0) + 1);
    });

    mappings.forEach((m, index) => {
      const routeLabel = m.routeId
        ? `<span class="font-mono text-xs text-slate-500">${escapeHtml(m.routeId)}</span><br>${escapeHtml(m.routeName || '（GTFSに存在しない路線ID）')}`
        : '<span class="text-amber-600 font-bold text-xs">未対応</span>';
      const shared = routeCountByExternalId.get(m.externalId) || 0;
      const sharedLabel = shared > 1
        ? `<br><span class="text-xs text-slate-400">この外部IDに ${shared} 路線</span>`
        : '';
      const tr = document.createElement('tr');
      tr.className = 'border-t';
      tr.innerHTML = `
        <td class="px-3 py-2 font-mono text-xs align-top">${escapeHtml(m.externalId)}${sharedLabel}</td>
        <td class="px-3 py-2 align-top">${routeLabel}</td>
        <td class="px-3 py-2 align-top text-slate-500">${escapeHtml(m.note || '')}</td>
        <td class="px-3 py-2 align-top text-slate-400 text-xs">${fmtDateTime(m.updatedAt)}</td>
        <td class="px-3 py-2 align-top text-right whitespace-nowrap">
          <button data-index="${index}" class="edit-mapping-btn text-blue-600 hover:text-blue-800 hover:underline font-bold text-xs mr-3">編集</button>
          <button data-index="${index}" class="add-route-to-mapping-btn text-slate-600 hover:text-slate-800 hover:underline font-bold text-xs mr-3">路線を追加</button>
          <button data-index="${index}" class="delete-mapping-btn text-red-600 hover:text-red-800 hover:underline font-bold text-xs">削除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.edit-mapping-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = mappings[Number(btn.dataset.index)];
        if (!m) return;
        editingRow = { externalId: m.externalId, routeId: m.routeId || '' };
        document.getElementById('mapping-external-id').value = m.externalId;
        document.getElementById('mapping-note').value = m.note || '';
        populateMappingRouteSelect(m.routeId || '');
        renderEditMode();
        document.getElementById('mapping-external-id').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    // 同じ外部IDに別の路線を足す導線。外部IDだけ引き継いで新規追加モードにする。
    tbody.querySelectorAll('.add-route-to-mapping-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = mappings[Number(btn.dataset.index)];
        if (!m) return;
        editingRow = null;
        document.getElementById('mapping-external-id').value = m.externalId;
        document.getElementById('mapping-note').value = '';
        populateMappingRouteSelect('');
        renderEditMode();
        document.getElementById('mapping-route-id').focus();
        document.getElementById('mapping-external-id').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    tbody.querySelectorAll('.delete-mapping-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const m = mappings[Number(btn.dataset.index)];
        if (!m) return;
        try {
          // routeId は必ず送る（省略するとその外部IDの対応が全件消えるため）。
          await api(
            `/api/admin/route-mappings/${encodeURIComponent(m.externalId)}?routeId=${encodeURIComponent(m.routeId || '')}`,
            { method: 'DELETE' }
          );
          if (editingRow && editingRow.externalId === m.externalId && editingRow.routeId === (m.routeId || '')) {
            clearForm();
          }
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
    const payload = { externalId, routeId, note };
    // 編集中は「どの行を書き換えるか」を渡す。付けないと同じ外部IDに行が増えてしまう。
    if (editingRow) payload.originalRouteId = editingRow.routeId;
    try {
      await api('/api/admin/route-mappings', { method: 'POST', body: JSON.stringify(payload) });
      clearForm();
      await loadRouteMappings();
      showStatus('外部IDマッピングを保存しました。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }
  document.getElementById('add-mapping-btn').addEventListener('click', handleAddMapping);
  document.getElementById('cancel-mapping-edit-btn').addEventListener('click', clearForm);
  document.getElementById('mapping-note').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleAddMapping(); }
  });

  window.AdminRouteMappings = { load: loadRouteMappings };
})();
