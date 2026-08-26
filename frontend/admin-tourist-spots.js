// 観光スポット管理
(function () {
  // textarea内でTabキーを押すとブラウザ標準では次のフォーム要素（登録ボタン）へ
  // フォーカスが移動してしまい、タブ区切りテキストを直接手入力できない。
  // Tabキー押下時はカーソル位置にタブ文字を挿入し、フォーカス移動を止める。
  (function setupSpotsTextareaTabKey() {
    const textarea = document.getElementById('spots-textarea');
    if (!textarea) return;
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      const { selectionStart: start, selectionEnd: end, value } = textarea;
      textarea.value = `${value.slice(0, start)}\t${value.slice(end)}`;
      textarea.selectionStart = textarea.selectionEnd = start + 1;
    });
  })();

  async function loadTouristSpots() {
    const data = await api('/api/admin/tourist-spots');
    renderTouristSpots(data.spots || []);
  }

  function renderTouristSpots(spots) {
    const container = document.getElementById('spots-list');
    if (spots.length === 0) {
      container.innerHTML = '<p class="text-sm text-slate-400 col-span-full">登録されている観光スポットはありません。</p>';
      return;
    }
    container.innerHTML = spots.map((s) => `
      <div class="border rounded-xl overflow-hidden bg-white ${s.enabled ? '' : 'opacity-50'}">
        <div class="h-28 bg-slate-100 flex items-center justify-center overflow-hidden">
          ${s.photoUrl
            ? `<img src="${escapeHtml(s.photoUrl)}" alt="" class="w-full h-full object-cover">`
            : '<span class="text-xs text-slate-400">写真なし</span>'}
        </div>
        <div class="p-3 space-y-2">
          <p class="font-bold text-sm truncate">${escapeHtml(s.name)}</p>
          <div class="flex items-center justify-between gap-2">
            <label class="flex items-center gap-1 text-xs font-bold">
              <input type="checkbox" data-id="${s.spotId}" class="spot-enabled-toggle" ${s.enabled ? 'checked' : ''}>
              表示する
            </label>
            <button data-id="${s.spotId}" class="spot-delete-btn text-red-600 hover:text-red-800 hover:underline font-bold text-xs">削除</button>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.spot-enabled-toggle').forEach((el) => {
      el.addEventListener('change', async () => {
        try {
          await api(`/api/admin/tourist-spots/${el.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: el.checked })
          });
          await loadTouristSpots();
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
    container.querySelectorAll('.spot-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('この観光スポットを削除しますか？')) return;
        try {
          await api(`/api/admin/tourist-spots/${btn.dataset.id}`, { method: 'DELETE' });
          await loadTouristSpots();
          showStatus('削除しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  document.getElementById('save-spots-btn').addEventListener('click', async () => {
    const text = document.getElementById('spots-textarea').value;
    const statusEl = document.getElementById('spots-save-status');
    const errorsBox = document.getElementById('spots-errors');
    errorsBox.classList.add('hidden');
    errorsBox.innerHTML = '';
    statusEl.textContent = '登録中...';
    statusEl.className = 'text-sm font-bold text-slate-500';

    try {
      // 汎用api()ヘルパーはerrors配列を持つ400レスポンスを汎用メッセージに潰してしまうため、
      // ここだけ生のfetchでレスポンス本体（行番号付きのバリデーションエラー）を見る。
      const res = await fetch('/api/admin/tourist-spots', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${state.token}` },
        body: JSON.stringify({ text })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        const errors = data.errors || [{ line: 0, reason: data.error || '登録に失敗しました。' }];
        errorsBox.classList.remove('hidden');
        errorsBox.innerHTML = '<p class="font-bold mb-1">登録できませんでした。以下を修正してください：</p>' +
          errors.map((e) => `<p>${e.line > 0 ? `${e.line}行目：` : ''}${escapeHtml(e.reason)}</p>`).join('');
        statusEl.textContent = '';
        return;
      }
      statusEl.textContent = `${data.count}件を登録しました。`;
      statusEl.className = 'text-sm font-bold text-green-700';
      await loadTouristSpots();
    } catch (err) {
      statusEl.textContent = '';
      errorsBox.classList.remove('hidden');
      errorsBox.textContent = err.message;
    }
  });

  window.AdminTouristSpots = { load: loadTouristSpots };
})();
