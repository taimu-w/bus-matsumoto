// 表示略称設定（系統名・行き先の一部文字列 -> 略称の対応表）
//
// バスマップ・バス停時刻表・接近中のバスパネルで、表示テキストがはみ出すときだけ
// ここで登録した略称に置き換えて表示する（frontend/text-abbrev.js）。
(function () {
  async function loadAbbreviations() {
    const data = await api('/api/admin/display-abbreviations');
    renderAbbreviations(data.abbreviations || []);
  }

  function renderAbbreviations(abbreviations) {
    const tbody = document.getElementById('display-abbreviations-list');
    tbody.innerHTML = '';
    if (abbreviations.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="px-3 py-3 text-slate-400">登録されている略称はありません。</td></tr>';
      return;
    }
    abbreviations.forEach((a) => {
      const tr = document.createElement('tr');
      tr.className = 'border-t';
      tr.innerHTML = `
        <td class="px-3 py-2 align-top">${escapeHtml(a.original)}</td>
        <td class="px-3 py-2 align-top font-bold">${escapeHtml(a.abbreviation)}</td>
        <td class="px-3 py-2 align-top text-slate-400 text-xs">${fmtDateTime(a.updatedAt)}</td>
        <td class="px-3 py-2 align-top text-right whitespace-nowrap">
          <button data-original="${escapeHtml(a.original)}" class="edit-abbrev-btn text-blue-600 hover:text-blue-800 hover:underline font-bold text-xs mr-3">編集</button>
          <button data-original="${escapeHtml(a.original)}" class="delete-abbrev-btn text-red-600 hover:text-red-800 hover:underline font-bold text-xs">削除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.edit-abbrev-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = abbreviations.find((row) => row.original === btn.dataset.original);
        if (!a) return;
        document.getElementById('abbrev-original').value = a.original;
        document.getElementById('abbrev-text').value = a.abbreviation;
        document.getElementById('abbrev-original').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    tbody.querySelectorAll('.delete-abbrev-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/admin/display-abbreviations/${encodeURIComponent(btn.dataset.original)}`, { method: 'DELETE' });
          await loadAbbreviations();
          showStatus('表示略称を削除しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  async function handleAddAbbreviation() {
    const original = document.getElementById('abbrev-original').value.trim();
    const abbreviation = document.getElementById('abbrev-text').value.trim();
    if (!original) {
      showStatus('元テキストを入力してください。', 'error');
      return;
    }
    if (!abbreviation) {
      showStatus('略称を入力してください。', 'error');
      return;
    }
    try {
      await api('/api/admin/display-abbreviations', { method: 'POST', body: JSON.stringify({ original, abbreviation }) });
      document.getElementById('abbrev-original').value = '';
      document.getElementById('abbrev-text').value = '';
      await loadAbbreviations();
      showStatus('表示略称を保存しました。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }
  document.getElementById('add-abbrev-btn').addEventListener('click', handleAddAbbreviation);
  document.getElementById('abbrev-text').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleAddAbbreviation(); }
  });

  window.AdminDisplayAbbreviations = { load: loadAbbreviations };
})();
