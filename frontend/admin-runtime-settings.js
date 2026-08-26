// 運用パラメータ設定（判定半径・タイムアウト・しきい値など）
//
// これまで環境変数・コードに直書きされていた値を管理画面から編集できるようにしたもの。
// 定義・現在値はGET /api/admin/runtime-settingsから取得し、カテゴリ(groupLabel)ごとに
// カード分けして表示する。保存・既定値へのリセットはキー単位のPUT/DELETE。
(function () {
  const RUNTIME_SETTING_SOURCE_LABEL = {
    override: { text: '管理画面で上書き中', cls: 'bg-blue-100 text-blue-700' },
    env: { text: '環境変数', cls: 'bg-slate-100 text-slate-600' },
    default: { text: '既定値', cls: 'bg-slate-100 text-slate-500' }
  };

  async function loadRuntimeSettings() {
    const data = await api('/api/admin/runtime-settings');
    renderRuntimeSettings(data.settings || []);
  }

  function runtimeSettingInputAttrs(def) {
    if (def.type === 'time') return 'type="text" placeholder="23:00"';
    const step = def.type === 'integer' ? '1' : 'any';
    const min = def.min !== null && def.min !== undefined ? ` min="${def.min}"` : '';
    const max = def.max !== null && def.max !== undefined ? ` max="${def.max}"` : '';
    return `type="number" step="${step}"${min}${max}`;
  }

  function renderRuntimeSettings(settings) {
    const container = document.getElementById('runtime-settings-container');
    container.innerHTML = '';
    if (settings.length === 0) {
      container.innerHTML = '<p class="text-slate-400 text-sm">設定項目がありません。</p>';
      return;
    }

    // group（カテゴリ）ごとにまとめる。順序はAPIが返す順（catalog定義順）をそのまま使う。
    const groups = [];
    const groupByKey = new Map();
    settings.forEach((s) => {
      if (!groupByKey.has(s.group)) {
        const g = { key: s.group, label: s.groupLabel, items: [] };
        groupByKey.set(s.group, g);
        groups.push(g);
      }
      groupByKey.get(s.group).items.push(s);
    });

    groups.forEach((group) => {
      const card = document.createElement('div');
      card.className = 'bg-white rounded-xl border overflow-hidden';
      const listId = `runtime-settings-group-${group.key}`;
      card.innerHTML = `
        <div class="px-4 py-2.5 bg-slate-50 font-bold text-sm text-slate-700">${escapeHtml(group.label)}</div>
        <div class="divide-y" id="${listId}"></div>
      `;
      container.appendChild(card);

      const list = card.querySelector(`#${listId}`);
      group.items.forEach((s) => {
        const source = RUNTIME_SETTING_SOURCE_LABEL[s.source] || RUNTIME_SETTING_SOURCE_LABEL.default;
        const row = document.createElement('div');
        row.className = 'p-4 flex flex-wrap items-start gap-4';
        row.innerHTML = `
          <div class="min-w-[16rem] flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-bold text-sm">${escapeHtml(s.label)}</span>
              <span class="px-2 py-0.5 rounded-full text-[11px] font-bold ${source.cls}">${source.text}</span>
              ${s.requiresRestart ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-700">再起動が必要</span>' : ''}
            </div>
            <p class="text-xs text-slate-500 mt-1">${escapeHtml(s.description || '')}</p>
            <p class="text-[11px] text-slate-400 mt-1">キー: <span class="font-mono">${escapeHtml(s.key)}</span>／既定値: ${escapeHtml(String(s.default))}${s.unit ? escapeHtml(s.unit) : ''}</p>
          </div>
          <div class="flex items-end gap-2 shrink-0">
            <label class="text-xs font-bold text-slate-500">現在値
              <div class="flex items-center gap-1 mt-1">
                <input data-key="${escapeHtml(s.key)}" class="runtime-setting-input border rounded-lg px-2 py-1.5 text-sm w-28" ${runtimeSettingInputAttrs(s)} value="${escapeHtml(String(s.value))}" />
                ${s.unit ? `<span class="text-xs text-slate-400">${escapeHtml(s.unit)}</span>` : ''}
              </div>
            </label>
            <button data-key="${escapeHtml(s.key)}" class="save-runtime-setting-btn bg-blue-700 hover:bg-blue-800 text-white font-bold rounded-lg px-3 py-2 text-xs">保存</button>
            ${s.source === 'override' ? `<button data-key="${escapeHtml(s.key)}" class="reset-runtime-setting-btn bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-lg px-3 py-2 text-xs">既定値に戻す</button>` : ''}
          </div>
        `;
        list.appendChild(row);
      });
    });

    container.querySelectorAll('.save-runtime-setting-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        const input = container.querySelector(`.runtime-setting-input[data-key="${key}"]`);
        const value = input.value.trim();
        try {
          await api(`/api/admin/runtime-settings/${encodeURIComponent(key)}`, {
            method: 'PUT',
            body: JSON.stringify({ value })
          });
          await loadRuntimeSettings();
          showStatus(`${key} を保存しました。`);
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
    container.querySelectorAll('.reset-runtime-setting-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        try {
          await api(`/api/admin/runtime-settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
          await loadRuntimeSettings();
          showStatus(`${key} を既定値に戻しました。`);
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  window.AdminRuntimeSettings = { load: loadRuntimeSettings };
})();
