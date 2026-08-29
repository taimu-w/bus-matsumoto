// 車両名・メモ管理（車両ID＝car_id ⇔ 名前・メモ）
//
// 名前を付けた車両は、運行ダッシュボードの便詳細セクションで車両IDの代わりに名前で表示され、
// 名前タップでメモが表示される（frontend/admin-dashboard.js の carLabelHtml/carMemoBlockHtml）。
(function () {
  const carIdInput = () => document.getElementById('vehicle-label-car-id');
  const nameInput = () => document.getElementById('vehicle-label-name');
  const memoInput = () => document.getElementById('vehicle-label-memo');

  async function loadVehicleLabels() {
    const data = await api('/api/admin/vehicle-labels');
    renderVehicleLabels(data.labels || []);
    renderKnownVehicles(data.knownVehicles || [], data.labels || []);
  }

  function renderVehicleLabels(labels) {
    const tbody = document.getElementById('vehicle-labels-list');
    tbody.innerHTML = '';
    if (labels.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="px-3 py-3 text-slate-400">登録されている車両名・メモはありません。</td></tr>';
      return;
    }
    labels.forEach((label) => {
      const tr = document.createElement('tr');
      tr.className = 'border-t align-top';
      tr.innerHTML = `
        <td class="px-3 py-2 font-mono text-xs">${escapeHtml(label.carId)}</td>
        <td class="px-3 py-2 font-bold">${escapeHtml(label.name || '')}</td>
        <td class="px-3 py-2 text-slate-500 whitespace-pre-wrap max-w-md">${escapeHtml(label.memo || '')}</td>
        <td class="px-3 py-2 text-slate-400 text-xs whitespace-nowrap">${fmtDateTime(label.updatedAt)}</td>
        <td class="px-3 py-2 text-right whitespace-nowrap">
          <button data-car-id="${escapeHtml(label.carId)}" class="edit-vehicle-label-btn text-blue-600 hover:text-blue-800 hover:underline font-bold text-xs mr-3">編集</button>
          <button data-car-id="${escapeHtml(label.carId)}" class="delete-vehicle-label-btn text-red-600 hover:text-red-800 hover:underline font-bold text-xs">削除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.edit-vehicle-label-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const label = labels.find((row) => row.carId === btn.dataset.carId);
        if (!label) return;
        carIdInput().value = label.carId;
        nameInput().value = label.name || '';
        memoInput().value = label.memo || '';
        carIdInput().scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    tbody.querySelectorAll('.delete-vehicle-label-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm(`車両ID「${btn.dataset.carId}」の名前・メモを削除しますか？`)) return;
        try {
          await api(`/api/admin/vehicle-labels/${encodeURIComponent(btn.dataset.carId)}`, { method: 'DELETE' });
          await loadVehicleLabels();
          showStatus('車両名・メモを削除しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  function renderKnownVehicles(knownVehicles, labels) {
    const labeled = new Set(labels.map((l) => l.carId));
    const datalist = document.getElementById('vehicle-label-known-ids');
    datalist.innerHTML = knownVehicles.map((v) => `<option value="${escapeHtml(v.carId)}"></option>`).join('');

    const container = document.getElementById('vehicle-labels-known');
    if (knownVehicles.length === 0) {
      container.innerHTML = '<span class="text-slate-400">最近観測された車両はありません。</span>';
      return;
    }
    container.innerHTML = knownVehicles.map((v) => {
      const done = labeled.has(v.carId);
      const routeText = v.routeNames && v.routeNames.length ? `（${v.routeNames.join('・')}）` : '';
      return `<button type="button" data-car-id="${escapeHtml(v.carId)}"
        class="known-vehicle-chip border rounded-full px-2.5 py-1 font-mono ${done ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white hover:border-slate-400'}"
        title="${done ? '登録済み' : '未登録'}${escapeHtml(routeText)}">
        ${done ? '✓ ' : ''}${escapeHtml(v.carId)}
      </button>`;
    }).join('');

    container.querySelectorAll('.known-vehicle-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const label = labels.find((row) => row.carId === btn.dataset.carId);
        carIdInput().value = btn.dataset.carId;
        nameInput().value = label ? (label.name || '') : '';
        memoInput().value = label ? (label.memo || '') : '';
        nameInput().focus();
      });
    });
  }

  async function handleSaveVehicleLabel() {
    const carId = carIdInput().value.trim();
    const name = nameInput().value.trim();
    const memo = memoInput().value.trim();
    if (!carId) {
      showStatus('車両IDを入力してください。', 'error');
      return;
    }
    try {
      const result = await api(`/api/admin/vehicle-labels/${encodeURIComponent(carId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name, memo })
      });
      carIdInput().value = '';
      nameInput().value = '';
      memoInput().value = '';
      await loadVehicleLabels();
      showStatus(result.deleted ? '名前・メモが空のため、この車両の登録を削除しました。' : '車両名・メモを保存しました。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }

  document.getElementById('save-vehicle-label-btn').addEventListener('click', handleSaveVehicleLabel);
  nameInput().addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleSaveVehicleLabel(); }
  });

  window.AdminVehicleLabels = { load: loadVehicleLabels };
})();
