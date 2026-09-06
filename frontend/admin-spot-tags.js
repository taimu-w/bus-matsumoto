// タグ管理（スポット検索「タグ検索」のタグ並び順。docs/spot-search.md）
//
// タグそのものの追加・削除は「観光スポット管理」のタグ列（全件洗い替え）で行う。
// この画面は spot_tags テーブルの sort_order（＝タグ検索でのタグの並び順）だけを編集する。
// 予約タグ「近い」はここには出てこない（タグ検索側で常に先頭に固定表示される）。
(function () {
  const $ = (id) => document.getElementById(id);

  let tags = []; // [{ name, sortOrder, spotCount }] を表示順で保持

  function setStatus(message, tone) {
    const el = $('spot-tags-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = `text-sm font-bold ${tone === 'error' ? 'text-red-600' : tone === 'ok' ? 'text-green-700' : 'text-slate-500'}`;
  }

  async function load() {
    const data = await api('/api/admin/spot-tags');
    tags = (data.tags || []).slice();
    setStatus('');
    render();
  }

  function move(index, delta) {
    const next = index + delta;
    if (next < 0 || next >= tags.length) return;
    const tmp = tags[index];
    tags[index] = tags[next];
    tags[next] = tmp;
    setStatus('未保存の変更があります。「並び順を保存」を押してください。', 'error');
    render();
  }

  function render() {
    const container = $('spot-tags-list');
    if (!container) return;
    if (tags.length === 0) {
      container.innerHTML = '<p class="p-4 text-sm text-slate-400">タグはまだありません。「観光スポット管理」でスポットにタグを付けると、ここに並び順を編集できるタグが出てきます。</p>';
      return;
    }
    container.innerHTML = tags.map((tag, i) => `
      <div class="flex items-center gap-3 px-3 py-2">
        <span class="w-6 text-right text-xs font-bold text-slate-400 tabular-nums">${i + 1}</span>
        <span class="flex-1 min-w-0">
          <span class="font-bold text-sm truncate">${escapeHtml(tag.name)}</span>
          <span class="text-xs text-slate-400 ml-2">${tag.spotCount}スポット</span>
        </span>
        <button data-move="up" data-index="${i}" class="spot-tag-move px-2 py-1 rounded border text-slate-600 disabled:opacity-30" ${i === 0 ? 'disabled' : ''} aria-label="上へ">▲</button>
        <button data-move="down" data-index="${i}" class="spot-tag-move px-2 py-1 rounded border text-slate-600 disabled:opacity-30" ${i === tags.length - 1 ? 'disabled' : ''} aria-label="下へ">▼</button>
      </div>`).join('');

    container.querySelectorAll('.spot-tag-move').forEach((btn) => {
      btn.addEventListener('click', () => move(Number(btn.dataset.index), btn.dataset.move === 'up' ? -1 : 1));
    });
  }

  async function save() {
    if (tags.length === 0) return;
    setStatus('保存中...');
    try {
      await api('/api/admin/spot-tags', {
        method: 'PUT',
        body: JSON.stringify({ order: tags.map((t) => t.name) })
      });
      await load();
      setStatus('並び順を保存しました。', 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  const saveBtn = $('save-spot-tags-btn');
  if (saveBtn) saveBtn.addEventListener('click', save);

  window.AdminSpotTags = { load };
})();
