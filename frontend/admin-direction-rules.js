// 方向マッピング（位置情報CSVの方向列の値 ⇔ GTFS direction_id）
//
// 行が無い路線は既定で ignore（方向で候補車両を絞り込まない）。方向で絞りたい路線にだけ
// map の行を追加し、CSV方向値→direction_id の変換表とフォールバックを設定する。
// 路線は自由入力ではなく <select>（/api/routes）から選ばせる（admin-route-mappings.js と同じ理由）。
(function () {
  function selectedMode() {
    const checked = document.querySelector('input[name="direction-mode"]:checked');
    return checked ? checked.value : 'ignore';
  }

  function syncMapEditorVisibility() {
    document.getElementById('direction-map-editor').classList.toggle('hidden', selectedMode() !== 'map');
  }

  // 変換表の1行（CSV方向値 + → direction_id + 削除ボタン）を生成する。
  function addMapRow(csvValue = '', directionId = '0') {
    const rows = document.getElementById('direction-map-rows');
    const row = document.createElement('div');
    row.className = 'direction-map-row flex items-center gap-2';
    row.innerHTML = `
      <input class="direction-map-key border rounded-lg px-2 py-1.5 text-sm w-40 font-mono" type="text" placeholder="CSVの方向値" value="${escapeHtml(csvValue)}" />
      <span class="text-slate-400">→ direction_id</span>
      <select class="direction-map-val border rounded-lg px-2 py-1.5 text-sm">
        <option value="0">0</option>
        <option value="1">1</option>
      </select>
      <button type="button" class="direction-map-remove text-red-600 hover:text-red-800 font-bold text-xs">削除</button>
    `;
    row.querySelector('.direction-map-val').value = String(directionId) === '1' ? '1' : '0';
    row.querySelector('.direction-map-remove').addEventListener('click', () => row.remove());
    rows.appendChild(row);
  }

  function resetForm() {
    document.getElementById('direction-route-id').value = '';
    document.getElementById('direction-note').value = '';
    document.querySelector('input[name="direction-mode"][value="ignore"]').checked = true;
    document.getElementById('direction-map-rows').innerHTML = '';
    document.getElementById('direction-fallback').value = '';
    syncMapEditorVisibility();
  }

  function fillForm(rule) {
    document.getElementById('direction-route-id').value = rule.routeId;
    document.getElementById('direction-note').value = rule.note || '';
    const mode = rule.mode === 'map' ? 'map' : 'ignore';
    document.querySelector(`input[name="direction-mode"][value="${mode}"]`).checked = true;
    document.getElementById('direction-map-rows').innerHTML = '';
    const entries = Object.entries(rule.valueMap || {});
    if (mode === 'map' && entries.length === 0) {
      addMapRow();
    } else {
      entries.forEach(([k, v]) => addMapRow(k, v));
    }
    document.getElementById('direction-fallback').value =
      rule.fallback === 0 || rule.fallback === 1 ? String(rule.fallback) : '';
    syncMapEditorVisibility();
    document.getElementById('direction-route-id').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function populateRouteSelect() {
    const select = document.getElementById('direction-route-id');
    const routes = await getRoutesList();
    const current = select.value;
    select.innerHTML = '<option value="">路線を選択…</option>' +
      routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id)} — ${escapeHtml(r.name)}</option>`).join('');
    select.value = current;
  }

  async function loadDirectionRules() {
    await populateRouteSelect();
    const data = await api('/api/admin/direction-rules');
    renderDirectionRules(data.rules || []);
  }

  function summarizeRule(rule) {
    if (rule.mode !== 'map') return '方向で絞り込まない';
    const parts = Object.entries(rule.valueMap || {}).map(([k, v]) => `"${k}"→${v}`);
    const fb = rule.fallback === 0 || rule.fallback === 1
      ? `その他→${rule.fallback}`
      : 'その他→方向不明';
    return [...parts, fb].join('、');
  }

  function renderDirectionRules(rules) {
    const tbody = document.getElementById('direction-rules-list');
    tbody.innerHTML = '';
    if (rules.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-3 py-3 text-slate-400">設定されている路線はありません（全路線が既定の「方向で絞り込まない」で動作しています）。</td></tr>';
      return;
    }
    rules.forEach((rule) => {
      const routeLabel = rule.routeName
        ? `<span class="font-mono text-xs text-slate-500">${escapeHtml(rule.routeId)}</span><br>${escapeHtml(rule.routeName)}`
        : `<span class="font-mono text-xs text-slate-500">${escapeHtml(rule.routeId)}</span><br><span class="text-amber-600 font-bold text-xs">GTFSに存在しない路線ID</span>`;
      const modeLabel = rule.mode === 'map'
        ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-100 text-blue-700">変換表で判定</span>'
        : '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600">方向で絞り込まない</span>';
      const tr = document.createElement('tr');
      tr.className = 'border-t';
      tr.innerHTML = `
        <td class="px-3 py-2 align-top">${routeLabel}</td>
        <td class="px-3 py-2 align-top">${modeLabel}</td>
        <td class="px-3 py-2 align-top text-slate-600 font-mono text-xs">${escapeHtml(summarizeRule(rule))}</td>
        <td class="px-3 py-2 align-top text-slate-500">${escapeHtml(rule.note || '')}</td>
        <td class="px-3 py-2 align-top text-slate-400 text-xs">${fmtDateTime(rule.updatedAt)}</td>
        <td class="px-3 py-2 align-top text-right whitespace-nowrap">
          <button data-route-id="${escapeHtml(rule.routeId)}" class="edit-direction-btn text-blue-600 hover:text-blue-800 hover:underline font-bold text-xs mr-3">編集</button>
          <button data-route-id="${escapeHtml(rule.routeId)}" class="delete-direction-btn text-red-600 hover:text-red-800 hover:underline font-bold text-xs">削除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.edit-direction-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rule = rules.find((r) => r.routeId === btn.dataset.routeId);
        if (rule) fillForm(rule);
      });
    });
    tbody.querySelectorAll('.delete-direction-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/admin/direction-rules/${encodeURIComponent(btn.dataset.routeId)}`, { method: 'DELETE' });
          await loadDirectionRules();
          showStatus('方向マッピングを削除しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  async function handleSave() {
    const routeId = document.getElementById('direction-route-id').value;
    const note = document.getElementById('direction-note').value.trim();
    const mode = selectedMode();
    if (!routeId) {
      showStatus('路線を選択してください。', 'error');
      return;
    }

    const body = { routeId, mode, note };
    if (mode === 'map') {
      const valueMap = {};
      for (const row of document.querySelectorAll('#direction-map-rows .direction-map-row')) {
        const key = row.querySelector('.direction-map-key').value.trim();
        const val = Number(row.querySelector('.direction-map-val').value);
        if (key === '') {
          showStatus('変換表のCSV方向値に空の行があります。', 'error');
          return;
        }
        valueMap[key] = val;
      }
      if (Object.keys(valueMap).length === 0) {
        showStatus('「変換表で判定」では変換表を1件以上入力してください（不要なら「方向で絞り込まない」を選んでください）。', 'error');
        return;
      }
      body.valueMap = valueMap;
      const fb = document.getElementById('direction-fallback').value;
      body.fallback = fb === '' ? null : Number(fb);
    }

    try {
      await api('/api/admin/direction-rules', { method: 'POST', body: JSON.stringify(body) });
      resetForm();
      await loadDirectionRules();
      showStatus('方向マッピングを保存しました。次回のパイプライン実行（最大60秒）で反映されます。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }

  document.querySelectorAll('input[name="direction-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      syncMapEditorVisibility();
      if (selectedMode() === 'map' && document.querySelectorAll('#direction-map-rows .direction-map-row').length === 0) {
        addMapRow();
      }
    });
  });
  document.getElementById('direction-map-add-row').addEventListener('click', () => addMapRow());
  document.getElementById('direction-save-btn').addEventListener('click', handleSave);

  window.AdminDirectionRules = { load: loadDirectionRules };
})();
