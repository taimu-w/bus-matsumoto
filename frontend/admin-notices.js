// お知らせ編集
(function () {
  async function loadSettings() {
    const settings = await api('/api/admin/settings');
    document.getElementById('notice1').value = settings.notice1 || '';
    document.getElementById('notice2').value = settings.notice2 || '';
    document.getElementById('importantNotice').value = settings.importantNotice || '';
  }

  document.getElementById('save-btn').addEventListener('click', async () => {
    try {
      const payload = {
        notice1: document.getElementById('notice1').value,
        notice2: document.getElementById('notice2').value,
        importantNotice: document.getElementById('importantNotice').value,
        routeName: '横田信大循環線',
        operatorName: 'ぐるっと松本バス（アルピコ交通）'
      };
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
      showStatus('保存しました。公開画面に反映されます。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  });

  window.AdminNotices = { load: loadSettings };
})();
