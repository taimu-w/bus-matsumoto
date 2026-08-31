// お知らせ編集
(function () {
  const MAX_NOTICES = 3;

  function escapeAttr(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 通常のお知らせの編集カードを最大3件ぶん描画する。値は notices 配列（無い枠は空）で受け取る。
  function renderNoticeEditors(notices) {
    const container = document.getElementById('notices-editor');
    container.innerHTML = '';
    for (let i = 0; i < MAX_NOTICES; i++) {
      const n = notices[i] || {};
      const card = document.createElement('div');
      card.className = 'border rounded-xl p-4 space-y-3 bg-slate-50';
      card.dataset.noticeIndex = String(i);
      card.innerHTML = `
        <p class="text-sm font-black text-slate-600">お知らせ ${i + 1}</p>
        <label class="block text-sm font-bold">題名
          <input type="text" data-field="title" value="${escapeAttr(n.title || '')}"
                 class="mt-1 w-full border rounded-lg px-3 py-2 font-normal" placeholder="例: 年末年始の運休について">
        </label>
        <label class="block text-sm font-bold">内容
          <textarea data-field="body" rows="4"
                    class="mt-1 w-full border rounded-lg px-3 py-2 font-normal" placeholder="お知らせの本文。リンクは https://… または [表示文字列](https://…)">${escapeAttr(n.body || '')}</textarea>
        </label>
        <label class="block text-sm font-bold">画像URL（https://・任意）
          <input type="url" data-field="imageUrl" value="${escapeAttr(n.imageUrl || '')}"
                 class="mt-1 w-full border rounded-lg px-3 py-2 font-normal font-mono text-xs" placeholder="https://res.cloudinary.com/.../notice.jpg">
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="block text-sm font-bold">配信開始日
            <input type="date" data-field="startDate" value="${escapeAttr(n.startDate || '')}"
                   class="mt-1 w-full border rounded-lg px-3 py-2 font-normal">
          </label>
          <label class="block text-sm font-bold">配信終了日
            <input type="date" data-field="endDate" value="${escapeAttr(n.endDate || '')}"
                   class="mt-1 w-full border rounded-lg px-3 py-2 font-normal">
          </label>
        </div>
        <button type="button" data-action="clear-notice"
                class="text-xs font-bold text-red-600 hover:underline">このお知らせを空にする</button>
      `;
      card.querySelector('[data-action="clear-notice"]').addEventListener('click', () => {
        card.querySelectorAll('[data-field]').forEach((el) => { el.value = ''; });
      });
      container.appendChild(card);
    }
  }

  function collectNotices() {
    const cards = document.querySelectorAll('#notices-editor [data-notice-index]');
    const notices = [];
    cards.forEach((card) => {
      const get = (f) => (card.querySelector(`[data-field="${f}"]`).value || '').trim();
      const title = get('title');
      const body = card.querySelector('[data-field="body"]').value || '';
      const imageUrl = get('imageUrl');
      const startDate = get('startDate');
      const endDate = get('endDate');
      if (!title && !body.trim() && !imageUrl) return; // 完全に空の枠は送らない
      notices.push({ title, body, imageUrl, startDate, endDate });
    });
    return notices;
  }

  function collectImportantNotice() {
    return {
      body: document.getElementById('importantNotice').value,
      imageUrl: (document.getElementById('important-image-url').value || '').trim(),
      startDate: document.getElementById('important-start-date').value || '',
      endDate: document.getElementById('important-end-date').value || ''
    };
  }

  async function loadSettings() {
    const settings = await api('/api/admin/settings');
    renderNoticeEditors(Array.isArray(settings.notices) ? settings.notices : []);
    const important = settings.importantNotice && typeof settings.importantNotice === 'object'
      ? settings.importantNotice
      : { body: settings.importantNotice || '', imageUrl: '', startDate: '', endDate: '' };
    document.getElementById('importantNotice').value = important.body || '';
    document.getElementById('important-image-url').value = important.imageUrl || '';
    document.getElementById('important-start-date').value = important.startDate || '';
    document.getElementById('important-end-date').value = important.endDate || '';
  }

  document.getElementById('save-btn').addEventListener('click', async () => {
    try {
      const notices = collectNotices();
      for (const n of notices) {
        if (n.startDate && n.endDate && n.startDate > n.endDate) {
          showStatus('配信期間の開始日が終了日より後になっているお知らせがあります。', 'error');
          return;
        }
      }
      const importantNotice = collectImportantNotice();
      if (importantNotice.startDate && importantNotice.endDate && importantNotice.startDate > importantNotice.endDate) {
        showStatus('重要なお知らせの配信期間の開始日が終了日より後になっています。', 'error');
        return;
      }
      const payload = {
        notices,
        importantNotice,
        routeName: '横田信大循環線',
        operatorName: 'ぐるっと松本バス（アルピコ交通）'
      };
      const updated = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
      renderNoticeEditors(Array.isArray(updated.notices) ? updated.notices : []);
      const savedImportant = updated.importantNotice && typeof updated.importantNotice === 'object'
        ? updated.importantNotice
        : { body: updated.importantNotice || '', imageUrl: '', startDate: '', endDate: '' };
      document.getElementById('importantNotice').value = savedImportant.body || '';
      document.getElementById('important-image-url').value = savedImportant.imageUrl || '';
      document.getElementById('important-start-date').value = savedImportant.startDate || '';
      document.getElementById('important-end-date').value = savedImportant.endDate || '';
      showStatus('保存しました。公開画面に反映されます。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  });

  window.AdminNotices = { load: loadSettings };
})();
