// バス停お知らせ（見出し・画像・本文を任意に組み合わせたお知らせ配信。docs/busstop-notices.md）
//
// バス停詳細ページ（frontend/busstop.js）の「このバス停でできること」の下に出るお知らせを管理する。
// 配信範囲は scope で切り替える：
//   - stop     … バス停単位。どの乗り場を見ていても表示される。
//   - platform … 乗り場単位。乗り場別表示のときだけ表示される。
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

  function selectedScope() {
    const checked = document.querySelector('input[name="bn-scope"]:checked');
    return checked ? checked.value : 'stop';
  }

  function applyScopeVisibility() {
    // 乗り場単位のときだけ「乗り場」セレクトを出す。
    $('bn-platform-field').classList.toggle('hidden', selectedScope() !== 'platform');
  }

  function setSaveStatus(message, tone) {
    const el = $('bn-save-status');
    el.textContent = message || '';
    el.className = `text-sm font-bold ${tone === 'error' ? 'text-red-600' : tone === 'ok' ? 'text-green-700' : 'text-slate-500'}`;
  }

  // ---------- バス停検索 ----------
  function bindStopSearch() {
    const input = $('bn-stop-search');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const query = input.value.trim();
      if (!query) {
        $('bn-stop-results').classList.add('hidden');
        return;
      }
      searchTimer = setTimeout(() => runStopSearch(query), 200);
    });
    input.addEventListener('focus', () => {
      if ($('bn-stop-results').children.length > 0) $('bn-stop-results').classList.remove('hidden');
    });
    document.addEventListener('click', (event) => {
      if (!$('section-busstop-notices').contains(event.target)) return;
      if (event.target === input || $('bn-stop-results').contains(event.target)) return;
      $('bn-stop-results').classList.add('hidden');
    });
  }

  async function runStopSearch(query) {
    const seq = ++searchSeq;
    const box = $('bn-stop-results');
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
          class="bn-stop-pick w-full text-left px-3 py-2 hover:bg-slate-50">
          <span class="font-bold text-sm">${escapeHtml(stop.stopName)}</span>
          ${reading ? `<span class="block text-xs text-slate-400">${escapeHtml(reading)}</span>` : ''}
        </button>`;
      }).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('.bn-stop-pick').forEach((btn) => {
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
    $('bn-stop-results').classList.add('hidden');
    $('bn-stop-search').value = '';
    const selectedEl = $('bn-stop-selected');
    selectedEl.textContent = `選択中のバス停：${stopName}`;
    selectedEl.classList.remove('hidden');
    await loadPlatforms(stopKey);
  }

  async function loadPlatforms(stopKey, preselectStopId) {
    const select = $('bn-platform');
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
  async function loadBusstopNotices() {
    const data = await api('/api/admin/busstop-notices');
    renderList(data.notices || []);
  }

  function scopeBadge(notice) {
    return notice.scope === 'platform'
      ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">乗り場単位</span>'
      : '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">バス停単位</span>';
  }

  function contentBadges(notice) {
    const badges = [];
    if (notice.imageUrl) badges.push('<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">画像</span>');
    if (notice.body) badges.push('<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">本文</span>');
    return badges.join(' ');
  }

  function renderList(notices) {
    const container = $('bn-list');
    if (notices.length === 0) {
      container.innerHTML = '<p class="text-sm text-slate-400">登録されているバス停お知らせはありません。</p>';
      return;
    }
    container.innerHTML = notices.map((n) => {
      const image = n.imageUrl
        ? `<img src="${escapeHtml(n.imageUrl)}" alt="" class="h-16 w-24 object-cover rounded border bg-slate-100 shrink-0">`
        : '';
      const body = n.body
        ? `<p class="text-sm text-slate-600 whitespace-pre-wrap break-all flex-1">${escapeHtml(n.body)}</p>`
        : '';
      const target = n.scope === 'platform'
        ? `<span class="text-xs text-slate-500 shrink-0">${escapeHtml(platformLabel(n))}</span>`
        : '';
      return `
        <div class="border rounded-xl p-3 bg-white ${n.enabled ? '' : 'opacity-50'}">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2 min-w-0">
              ${scopeBadge(n)}
              <span class="font-bold text-sm truncate">${escapeHtml(n.stopName)}</span>
              ${target}
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <label class="flex items-center gap-1 text-xs font-bold">
                <input type="checkbox" class="bn-enabled-toggle" data-id="${n.id}" ${n.enabled ? 'checked' : ''}> 表示
              </label>
              <button data-id="${n.id}" class="bn-edit-btn text-blue-600 hover:underline font-bold text-xs">編集</button>
              <button data-id="${n.id}" class="bn-delete-btn text-red-600 hover:underline font-bold text-xs">削除</button>
            </div>
          </div>
          <div class="flex items-center gap-1 mt-1.5">${contentBadges(n)}</div>
          ${n.title ? `<p class="text-sm font-bold text-slate-800 mt-2">${escapeHtml(n.title)}</p>` : ''}
          ${image || body ? `<div class="flex items-start gap-3 mt-2">${image}${body}</div>` : ''}
        </div>`;
    }).join('');

    container.querySelectorAll('.bn-enabled-toggle').forEach((el) => {
      el.addEventListener('change', async () => {
        try {
          await api(`/api/admin/busstop-notices/${el.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: el.checked })
          });
          await loadBusstopNotices();
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
    container.querySelectorAll('.bn-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => startEdit(notices.find((n) => String(n.id) === btn.dataset.id)));
    });
    container.querySelectorAll('.bn-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('このバス停お知らせを削除しますか？')) return;
        try {
          await api(`/api/admin/busstop-notices/${btn.dataset.id}`, { method: 'DELETE' });
          if (form.editingId && String(form.editingId) === btn.dataset.id) resetForm();
          await loadBusstopNotices();
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
    $('bn-form-title').textContent = 'お知らせを追加';
    $('bn-save-btn').textContent = '追加';
    $('bn-cancel-edit-btn').classList.add('hidden');
    document.querySelector('input[name="bn-scope"][value="stop"]').checked = true;
    document.querySelectorAll('input[name="bn-scope"]').forEach((el) => { el.disabled = false; });
    $('bn-stop-search').value = '';
    $('bn-stop-search').disabled = false;
    $('bn-stop-selected').classList.add('hidden');
    $('bn-stop-selected').textContent = '';
    const select = $('bn-platform');
    select.innerHTML = '<option value="">先にバス停を選択してください</option>';
    select.disabled = true;
    $('bn-title').value = '';
    $('bn-image-url').value = '';
    $('bn-body').value = '';
    $('bn-enabled').checked = true;
    applyScopeVisibility();
    setSaveStatus('');
  }

  async function startEdit(notice) {
    if (!notice) return;
    form.editingId = notice.id;
    form.stopKey = notice.stopKey;
    form.stopName = notice.stopName;
    $('bn-form-title').textContent = `お知らせを編集（#${notice.id}）`;
    $('bn-save-btn').textContent = '更新';
    $('bn-cancel-edit-btn').classList.remove('hidden');
    // 編集では配信範囲・対象のバス停/乗り場は変更しない（変えたい場合は削除して追加し直す）
    document.querySelector(`input[name="bn-scope"][value="${notice.scope}"]`).checked = true;
    document.querySelectorAll('input[name="bn-scope"]').forEach((el) => { el.disabled = true; });
    $('bn-stop-search').value = '';
    $('bn-stop-search').disabled = true;
    const selectedEl = $('bn-stop-selected');
    const scopeText = notice.scope === 'platform' ? '（配信範囲・乗り場は編集できません）' : '（配信範囲は編集できません）';
    selectedEl.textContent = `対象のバス停：${notice.stopName}${scopeText}`;
    selectedEl.classList.remove('hidden');
    applyScopeVisibility();
    if (notice.scope === 'platform') {
      await loadPlatforms(notice.stopKey, notice.stopId);
      $('bn-platform').disabled = true;
    }
    $('bn-title').value = notice.title || '';
    $('bn-image-url').value = notice.imageUrl || '';
    $('bn-body').value = notice.body || '';
    $('bn-enabled').checked = notice.enabled;
    setSaveStatus('');
    $('bn-form-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function collectPayload() {
    return {
      title: $('bn-title').value.trim(),
      imageUrl: $('bn-image-url').value.trim(),
      body: $('bn-body').value.trim(),
      enabled: $('bn-enabled').checked
    };
  }

  async function handleSave() {
    const payload = collectPayload();

    try {
      if (form.editingId) {
        await api(`/api/admin/busstop-notices/${form.editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        setSaveStatus('更新しました。', 'ok');
      } else {
        if (!form.stopKey) {
          setSaveStatus('バス停を選択してください。', 'error');
          return;
        }
        const scope = selectedScope();
        const platform = scope === 'platform' ? $('bn-platform').value : '';
        if (scope === 'platform' && !platform) {
          setSaveStatus('乗り場を選択してください。', 'error');
          return;
        }
        await api('/api/admin/busstop-notices', {
          method: 'POST',
          body: JSON.stringify({ ...payload, scope, stopKey: form.stopKey, platform })
        });
        setSaveStatus('追加しました。', 'ok');
      }
      resetForm();
      await loadBusstopNotices();
    } catch (err) {
      setSaveStatus(err.message, 'error');
    }
  }

  // ---------- 初期化 ----------
  document.querySelectorAll('input[name="bn-scope"]').forEach((el) => {
    el.addEventListener('change', applyScopeVisibility);
  });
  $('bn-save-btn').addEventListener('click', handleSave);
  $('bn-cancel-edit-btn').addEventListener('click', resetForm);
  bindStopSearch();
  applyScopeVisibility();

  window.AdminBusstopNotices = { load: loadBusstopNotices };
})();
