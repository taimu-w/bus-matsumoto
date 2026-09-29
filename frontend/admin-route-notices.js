// 路線お知らせ（題名＋画像・本文のお知らせを路線ごとに配信。docs/route-notices.md）
//
// 利用者画面のリアルタイム時刻表（#/realtime/...）の上部に出るお知らせを管理する。
// 画面には題名だけが並び、タップで画像・本文の詳細が開くため、題名は必須。
// 路線は自由入力ではなく <select> の候補（/api/routes）から選ばせる
// （admin-runtime-suspension.js / admin-direction-rules.js と同じ理由）。
(function () {
  let editingId = null; // null=新規、数値=その行を編集中

  const $ = (id) => document.getElementById(id);

  function setSaveStatus(message, tone) {
    const el = $('rn-save-status');
    el.textContent = message || '';
    el.className = `text-sm font-bold ${tone === 'error' ? 'text-red-600' : tone === 'ok' ? 'text-green-700' : 'text-slate-500'}`;
  }

  async function populateRouteSelect() {
    const select = $('rn-route-id');
    const routes = await getRoutesList();
    const current = select.value;
    select.innerHTML = '<option value="">路線を選択…</option>' +
      routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}（${escapeHtml(r.id)}）</option>`).join('');
    select.value = current;
  }

  // 運行日（JST）の今日 "YYYY-MM-DD"。サーバー側の配信判定（getServiceDateString）と同じ基準。
  function todayJst() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date());
  }

  // 一覧に出す配信状態のバッジ。
  function statusBadge(notice) {
    const today = todayJst();
    let label = '配信中';
    let cls = 'bg-green-100 text-green-700';
    if (!notice.enabled) {
      label = '非表示';
      cls = 'bg-slate-100 text-slate-500';
    } else if (notice.startDate && today < notice.startDate) {
      label = '配信前';
      cls = 'bg-blue-100 text-blue-700';
    } else if (notice.endDate && today > notice.endDate) {
      label = '配信終了';
      cls = 'bg-slate-100 text-slate-500';
    }
    return `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${cls}">${label}</span>`;
  }

  function periodText(notice) {
    if (!notice.startDate && !notice.endDate) return '期間指定なし';
    return `${notice.startDate || '（指定なし）'} 〜 ${notice.endDate || '（指定なし）'}`;
  }

  // ---------- 一覧 ----------
  async function loadRouteNotices() {
    await populateRouteSelect();
    const data = await api('/api/admin/route-notices');
    renderList(data.notices || []);
  }

  function renderList(notices) {
    const container = $('rn-list');
    if (notices.length === 0) {
      container.innerHTML = '<p class="text-sm text-slate-400">登録されている路線お知らせはありません。</p>';
      return;
    }
    container.innerHTML = notices.map((n) => {
      const image = n.imageUrl
        ? `<img src="${escapeHtml(n.imageUrl)}" alt="" class="h-16 w-24 object-cover rounded border bg-slate-100 shrink-0">`
        : '';
      const body = n.body
        ? `<p class="text-sm text-slate-600 whitespace-pre-wrap break-all flex-1">${escapeHtml(n.body)}</p>`
        : '';
      return `
        <div class="border rounded-xl p-3 bg-white ${n.enabled ? '' : 'opacity-50'}">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2 min-w-0">
              ${statusBadge(n)}
              <span class="font-bold text-sm truncate">${escapeHtml(n.routeName)}</span>
              <span class="font-mono text-xs text-slate-400 shrink-0">${escapeHtml(n.routeId)}</span>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <label class="flex items-center gap-1 text-xs font-bold">
                <input type="checkbox" class="rn-enabled-toggle" data-id="${n.id}" ${n.enabled ? 'checked' : ''}> 表示
              </label>
              <button data-id="${n.id}" class="rn-edit-btn text-blue-600 hover:underline font-bold text-xs">編集</button>
              <button data-id="${n.id}" class="rn-delete-btn text-red-600 hover:underline font-bold text-xs">削除</button>
            </div>
          </div>
          <p class="text-xs text-slate-500 mt-1">配信期間：${escapeHtml(periodText(n))}</p>
          <p class="text-sm font-bold text-slate-800 mt-2">📢 ${escapeHtml(n.title)}</p>
          ${image || body ? `<div class="flex items-start gap-3 mt-2">${image}${body}</div>` : ''}
        </div>`;
    }).join('');

    container.querySelectorAll('.rn-enabled-toggle').forEach((el) => {
      el.addEventListener('change', async () => {
        try {
          await api(`/api/admin/route-notices/${el.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: el.checked })
          });
          await loadRouteNotices();
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
    container.querySelectorAll('.rn-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => startEdit(notices.find((n) => String(n.id) === btn.dataset.id)));
    });
    container.querySelectorAll('.rn-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('この路線お知らせを削除しますか？')) return;
        try {
          await api(`/api/admin/route-notices/${btn.dataset.id}`, { method: 'DELETE' });
          if (editingId && String(editingId) === btn.dataset.id) resetForm();
          await loadRouteNotices();
          showStatus('削除しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  // ---------- 追加 / 編集 ----------
  function resetForm() {
    editingId = null;
    $('rn-form-title').textContent = 'お知らせを追加';
    $('rn-save-btn').textContent = '追加';
    $('rn-cancel-edit-btn').classList.add('hidden');
    $('rn-route-id').value = '';
    $('rn-title').value = '';
    $('rn-image-url').value = '';
    $('rn-body').value = '';
    $('rn-start-date').value = '';
    $('rn-end-date').value = '';
    $('rn-enabled').checked = true;
    setSaveStatus('');
  }

  function startEdit(notice) {
    if (!notice) return;
    editingId = notice.id;
    $('rn-form-title').textContent = `お知らせを編集（#${notice.id}）`;
    $('rn-save-btn').textContent = '更新';
    $('rn-cancel-edit-btn').classList.remove('hidden');
    $('rn-route-id').value = notice.routeId;
    if ($('rn-route-id').value !== notice.routeId) {
      // GTFS再取込で路線が消えている。保存するには現存する路線を選び直してもらう。
      setSaveStatus(`この路線（${notice.routeId}）は現在のGTFSに存在しません。路線を選び直してください。`, 'error');
    } else {
      setSaveStatus('');
    }
    $('rn-title').value = notice.title || '';
    $('rn-image-url').value = notice.imageUrl || '';
    $('rn-body').value = notice.body || '';
    $('rn-start-date').value = notice.startDate || '';
    $('rn-end-date').value = notice.endDate || '';
    $('rn-enabled').checked = notice.enabled;
    $('rn-form-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function collectPayload() {
    return {
      routeId: $('rn-route-id').value,
      title: $('rn-title').value.trim(),
      imageUrl: $('rn-image-url').value.trim(),
      body: $('rn-body').value.trim(),
      startDate: $('rn-start-date').value || '',
      endDate: $('rn-end-date').value || '',
      enabled: $('rn-enabled').checked
    };
  }

  async function handleSave() {
    const payload = collectPayload();
    if (!payload.routeId) {
      setSaveStatus('路線を選択してください。', 'error');
      return;
    }
    if (!payload.title) {
      setSaveStatus('題名を入力してください。', 'error');
      return;
    }
    if (payload.startDate && payload.endDate && payload.startDate > payload.endDate) {
      setSaveStatus('配信開始日が配信終了日より後になっています。', 'error');
      return;
    }

    try {
      if (editingId) {
        await api(`/api/admin/route-notices/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      } else {
        await api('/api/admin/route-notices', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }
      const message = editingId ? '更新しました。' : '追加しました。';
      resetForm();
      setSaveStatus(message, 'ok');
      await loadRouteNotices();
    } catch (err) {
      setSaveStatus(err.message, 'error');
    }
  }

  // ---------- 初期化 ----------
  $('rn-save-btn').addEventListener('click', handleSave);
  $('rn-cancel-edit-btn').addEventListener('click', resetForm);

  window.AdminRouteNotices = { load: loadRouteNotices };
})();
