// 祝日カレンダー
(function () {
  async function loadHolidays() {
    const data = await api('/api/admin/holidays');
    renderHolidays(data.holidays || []);
  }

  function renderHolidays(holidays) {
    const container = document.getElementById('holidays-list');
    container.innerHTML = '';
    if (holidays.length === 0) {
      container.innerHTML = '<div class="px-3 py-2 text-slate-400">登録されている祝日はありません。</div>';
      return;
    }
    holidays.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between px-3 py-2';
      row.innerHTML = `
        <span>${escapeHtml(h.date)}<span class="text-slate-500 ml-2">${escapeHtml(h.name || '')}</span></span>
        <button data-date="${escapeHtml(h.date)}" class="delete-holiday-btn text-red-600 hover:text-red-800 hover:underline font-bold text-xs">削除</button>
      `;
      container.appendChild(row);
    });
    container.querySelectorAll('.delete-holiday-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/admin/holidays/${encodeURIComponent(btn.dataset.date)}`, { method: 'DELETE' });
          await loadHolidays();
          showStatus('祝日を削除しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  async function handleAddHoliday() {
    const date = document.getElementById('holiday-date').value;
    const name = document.getElementById('holiday-name').value.trim();
    if (!date) {
      showStatus('日付を選択してください。', 'error');
      return;
    }
    try {
      await api('/api/admin/holidays', { method: 'POST', body: JSON.stringify({ date, name }) });
      document.getElementById('holiday-date').value = '';
      document.getElementById('holiday-name').value = '';
      await loadHolidays();
      showStatus('祝日を追加しました。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }
  document.getElementById('add-holiday-btn').addEventListener('click', handleAddHoliday);
  // 日付・名称欄でEnterキーを押しても追加できるようにする
  document.getElementById('holiday-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleAddHoliday(); }
  });

  window.AdminHolidays = { load: loadHolidays };
})();
