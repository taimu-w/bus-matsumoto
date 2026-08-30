// 乗り場お知らせ（のりばごとの画像/リンクお知らせ配信。docs/platform-notices.md）
//
// バス停詳細ページ（frontend/busstop.js）の「このバス停でできること」の下に、
// 乗り場別表示のときだけ出るお知らせを管理する。
(function () {
  // 追加/編集フォームの状態
  const form = {
    stopKey: '',
    stopName: '',
    editingId: null // null=新規、数値=その行を編集中
  };
  let searchTimer = null;
  let searchSeq = 0;

  const $ = (id) => document.getElementById(id);

  /** 標柱の表示名（busstop.js / timetable.js と同じロジック）。 */
  function platformLabel(platform) {
    const code = (platform.platformCode || '').trim();
    if (!code) return `のりば（${platform.stopId}）`;
    return /^\d+$/.test(code) ? `${code}番のりば` : code;
  }

  function selectedKind() {
    const checked = document.querySelector('input[name="pn-kind"]:checked');
    return checked ? checked.value : 'image';
  }

  function applyKindVisibility() {
    const kind = selectedKind();
    $('pn-image-field').classList.toggle('hidden', kind !== 'image');
    $('pn-link-field').classList.toggle('hidden', kind !== 'link');
  }

  function setSaveStatus(message, tone) {
    const el = $('pn-save-status');
    el.textContent = message || '';
    el.className = `text-sm font-bold ${tone === 'error' ? 'text-red-600' : tone === 'ok' ? 'text-green-700' : 'text-slate-500'}`;
  }

  // ---------- バス停検索 ----------
  function bindStopSearch() {
    const input = $('pn-stop-search');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const query = input.value.trim();
      if (!query) {
        $('pn-stop-results').classList.add('hidden');
        return;
      }
      searchTimer = setTimeout(() => runStopSearch(query), 200);
    });
    input.addEventListener('focus', () => {
      if ($('pn-stop-results').children.length > 0) $('pn-stop-results').classList.remove('hidden');
    });
    document.addEventListener('click', (event) => {
      if (!$('section-platform-notices').contains(event.target)) return;
      if (event.target === input || $('pn-stop-results').contains(event.target)) return;
      $('pn-stop-results').classList.add('hidden');
    });
  }

  async function runStopSearch(query) {
    const seq = ++searchSeq;
    const box = $('pn-stop-results');
    try {
      const data = await api(`/api/busstop/search?q=${encodeURIComponent(query)}&limit=20`);
      if (seq !== searchSeq) return;
      const stops = data.stops || [];
      if (stops.length === 0) {
        box.innerHTML = '<p class="px-3 py-2 text-sm text-slate-400">該当するバス停がありません。</p>';
        box.classList.remove('hidden');
        return;
      }
      box.innerHTML = stops.map((stop) => {
        const reading = [stop.nameHiragana, stop.nameRomaji].filter(Boolean).join(' / ');
        return `<button type="button" data-stop-key="${escapeHtml(stop.stopKey)}" data-stop-name="${escapeHtml(stop.stopName)}"
          class="pn-stop-pick w-full text-left px-3 py-2 hover:bg-slate-50">
          <span class="font-bold text-sm">${escapeHtml(stop.stopName)}</span>
          ${reading ? `<span class="block text-xs text-slate-400">${escapeHtml(reading)}</span>` : ''}
        </button>`;
      }).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('.pn-stop-pick').forEach((btn) => {
        btn.addEventListener('click', () => pickStop(btn.dataset.stopKey, btn.dataset.stopName));
      });
    } catch (err) {
      if (seq !== searchSeq) return;
      box.innerHTML = `<p class="px-3 py-2 text-sm text-red-600">${escapeHtml(err.message)}</p>`;
      box.classList.remove('hidden');
    }
  }

  async function pickStop(stopKey, stopName) {
    form.stopKey = stopKey;
    form.stopName = stopName;
    $('pn-stop-results').classList.add('hidden');
    $('pn-stop-search').value = '';
    const selectedEl = $('pn-stop-selected');
    selectedEl.textContent = `選択中のバス停：${stopName}`;
    selectedEl.classList.remove('hidden');
    await loadPlatforms(stopKey);
  }

  async function loadPlatforms(stopKey, preselectStopId) {
    const select = $('pn-platform');
    select.disabled = true;
    select.innerHTML = '<option value="">読み込み中...</option>';
    try {
      const data = await api(`/api/timetable/stops/${encodeURIComponent(stopKey)}`);
      const platforms = data.platforms || [];
      if (platforms.length === 0) {
        select.innerHTML = '<option value="">乗り場が登録されていません</option>';
        return;
      }
      select.innerHTML = platforms.map((p) => {
        const destinations = (p.headsigns || []).slice(0, 3).map((h) => h.headsign).filter(Boolean).join('・');
        const label = `${platformLabel(p)}${destinations ? `（${destinations} 方面）` : ''}`;
        return `<option value="${escapeHtml(p.stopId)}">${escapeHtml(label)}</option>`;
      }).join('');
      select.disabled = false;
      if (preselectStopId) select.value = preselectStopId;
      if (platforms.length === 1) {
        select.value = platforms[0].stopId;
      }
    } catch (err) {
      select.innerHTML = `<option value="">乗り場の取得に失敗しました</option>`;
      setSaveStatus(err.message, 'error');
    }
  }

  // ---------- 一覧 ----------
  async function loadPlatformNotices() {
    const data = await api('/api/admin/platform-notices');
    renderList(data.notices || []);
  }

  function kindBadge(kind) {
    return kind === 'image'
      ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">画像</span>'
      : '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">リンク</span>';
  }

  function renderList(notices) {
    const container = $('pn-list');
    if (notices.length === 0) {
      container.innerHTML = '<p class="text-sm text-slate-400">登録されている乗り場お知らせはありません。</p>';
      return;
    }
    container.innerHTML = notices.map((n) => {
      const preview = n.kind === 'image'
        ? `<img src="${escapeHtml(n.imageUrl)}" alt="" class="h-16 w-24 object-cover rounded border bg-slate-100 shrink-0">`
        : `<p class="text-sm text-slate-600 whitespace-pre-wrap break-all flex-1">${escapeHtml(n.linkBody)}</p>`;
      return `
        <div class="border rounded-xl p-3 bg-white ${n.enabled ? '' : 'opacity-50'}">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2 min-w-0">
              ${kindBadge(n.kind)}
              <span class="font-bold text-sm truncate">${escapeHtml(n.stopName)}</span>
              <span class="text-xs text-slate-500 shrink-0">${escapeHtml(platformLabel(n))}</span>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <label class="flex items-center gap-1 text-xs font-bold">
                <input type="checkbox" class="pn-enabled-toggle" data-id="${n.id}" ${n.enabled ? 'checked' : ''}> 表示
              </label>
              <button data-id="${n.id}" class="pn-edit-btn text-blue-600 hover:underline font-bold text-xs">編集</button>
              <button data-id="${n.id}" class="pn-delete-btn text-red-600 hover:underline font-bold text-xs">削除</button>
            </div>
          </div>
          ${n.title ? `<p class="text-sm font-bold text-slate-800 mt-2">${escapeHtml(n.title)}</p>` : ''}
          <div class="flex items-start gap-3 mt-2">${preview}</div>
        </div>`;
    }).join('');

    container.querySelectorAll('.pn-enabled-toggle').forEach((el) => {
      el.addEventListener('change', async () => {
        try {
          await api(`/api/admin/platform-notices/${el.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: el.checked })
          });
          await loadPlatformNotices();
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
    container.querySelectorAll('.pn-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => startEdit(notices.find((n) => String(n.id) === btn.dataset.id)));
    });
    container.querySelectorAll('.pn-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('この乗り場お知らせを削除しますか？')) return;
        try {
          await api(`/api/admin/platform-notices/${btn.dataset.id}`, { method: 'DELETE' });
          if (form.editingId && String(form.editingId) === btn.dataset.id) resetForm();
          await loadPlatformNotices();
          showStatus('削除しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  // ---------- 追加 / 編集 ----------
  function resetForm() {
    form.stopKey = '';
    form.stopName = '';
    form.editingId = null;
    $('pn-form-title').textContent = 'お知らせを追加';
    $('pn-save-btn').textContent = '追加';
    $('pn-cancel-edit-btn').classList.add('hidden');
    $('pn-stop-search').value = '';
    $('pn-stop-search').disabled = false;
    $('pn-stop-selected').classList.add('hidden');
    $('pn-stop-selected').textContent = '';
    const select = $('pn-platform');
    select.innerHTML = '<option value="">先にバス停を選択してください</option>';
    select.disabled = true;
    document.querySelector('input[name="pn-kind"][value="image"]').checked = true;
    $('pn-title').value = '';
    $('pn-image-url').value = '';
    $('pn-link-body').value = '';
    $('pn-enabled').checked = true;
    applyKindVisibility();
    setSaveStatus('');
  }

  async function startEdit(notice) {
    if (!notice) return;
    form.editingId = notice.id;
    form.stopKey = notice.stopKey;
    form.stopName = notice.stopName;
    $('pn-form-title').textContent = `お知らせを編集（#${notice.id}）`;
    $('pn-save-btn').textContent = '更新';
    $('pn-cancel-edit-btn').classList.remove('hidden');
    // 編集では対象の乗り場は変更しない（変えたい場合は削除して追加し直す）
    $('pn-stop-search').value = '';
    $('pn-stop-search').disabled = true;
    const selectedEl = $('pn-stop-selected');
    selectedEl.textContent = `対象のバス停：${notice.stopName}（乗り場は編集できません）`;
    selectedEl.classList.remove('hidden');
    await loadPlatforms(notice.stopKey, notice.stopId);
    $('pn-platform').disabled = true;
    document.querySelector(`input[name="pn-kind"][value="${notice.kind}"]`).checked = true;
    $('pn-title').value = notice.title || '';
    $('pn-image-url').value = notice.imageUrl || '';
    $('pn-link-body').value = notice.linkBody || '';
    $('pn-enabled').checked = notice.enabled;
    applyKindVisibility();
    setSaveStatus('');
    $('pn-form-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function collectPayload() {
    const kind = selectedKind();
    return {
      kind,
      title: $('pn-title').value.trim(),
      imageUrl: kind === 'image' ? $('pn-image-url').value.trim() : '',
      linkBody: kind === 'link' ? $('pn-link-body').value.trim() : '',
      enabled: $('pn-enabled').checked
    };
  }

  async function handleSave() {
    const payload = collectPayload();

    try {
      if (form.editingId) {
        await api(`/api/admin/platform-notices/${form.editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        setSaveStatus('更新しました。', 'ok');
      } else {
        if (!form.stopKey) {
          setSaveStatus('バス停を選択してください。', 'error');
          return;
        }
        const platform = $('pn-platform').value;
        if (!platform) {
          setSaveStatus('乗り場を選択してください。', 'error');
          return;
        }
        await api('/api/admin/platform-notices', {
          method: 'POST',
          body: JSON.stringify({ ...payload, stopKey: form.stopKey, platform })
        });
        setSaveStatus('追加しました。', 'ok');
      }
      resetForm();
      await loadPlatformNotices();
    } catch (err) {
      setSaveStatus(err.message, 'error');
    }
  }

  // ---------- 初期化 ----------
  document.querySelectorAll('input[name="pn-kind"]').forEach((el) => {
    el.addEventListener('change', applyKindVisibility);
  });
  $('pn-save-btn').addEventListener('click', handleSave);
  $('pn-cancel-edit-btn').addEventListener('click', resetForm);
  bindStopSearch();
  applyKindVisibility();

  window.AdminPlatformNotices = { load: loadPlatformNotices };
})();
