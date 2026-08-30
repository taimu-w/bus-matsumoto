// 観光スポットの検索・アクセス数
// （スポット検索の検索回数 spot_search_counts ＋ 公式サイトリンクのタップ回数 tourist_spot_link_clicks、
//  docs/spot-search.md / docs/tourist-spots.md）
(function () {
  function jstTodayStr() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // "YYYY-MM-DD"
  }

  // セクションを開いたときに、未入力なら「直近30日」を初期値として入れる。
  function initDefaults() {
    const fromInput = document.getElementById('spot-clicks-from');
    const toInput = document.getElementById('spot-clicks-to');
    if (!fromInput || !toInput) return;
    if (!toInput.value) toInput.value = jstTodayStr();
    if (!fromInput.value) {
      const d = new Date(`${toInput.value}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 29);
      fromInput.value = d.toISOString().slice(0, 10);
    }
  }

  function statusLabel(row) {
    if (!row.listed) return '<span class="text-slate-400">掲載終了</span>';
    if (!row.enabled) return '<span class="text-amber-600">非表示</span>';
    return '<span class="text-green-700">表示中</span>';
  }

  async function loadStats() {
    const from = document.getElementById('spot-clicks-from').value;
    const to = document.getElementById('spot-clicks-to').value;
    const resultEl = document.getElementById('spot-clicks-result');
    if (!from || !to) {
      resultEl.innerHTML = '<p class="text-red-600 font-bold">開始日と終了日を指定してください。</p>';
      return;
    }
    if (from > to) {
      resultEl.innerHTML = '<p class="text-red-600 font-bold">開始日は終了日以前の日付を指定してください。</p>';
      return;
    }
    // サーバー側と同じく「366日以内（＝差が365日以内）」で弾く。
    const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
    if (spanDays > 365) {
      resultEl.innerHTML = '<p class="text-red-600 font-bold">期間は最大1年（366日）です。</p>';
      return;
    }

    resultEl.textContent = '集計中...';
    try {
      const params = new URLSearchParams({ from, to });
      const data = await api(`/api/admin/tourist-spots/link-clicks?${params.toString()}`);
      const rows = data.rows || [];
      const totalSearches = data.totalSearches || 0;
      const totalClicks = data.totalClicks || 0;

      if (totalSearches === 0 && totalClicks === 0) {
        resultEl.innerHTML = `<p class="text-slate-400">${escapeHtml(data.from)} 〜 ${escapeHtml(data.to)} の期間に、スポット検索・観光スポットリンクのアクセスはありません。</p>`;
        return;
      }

      const unresolved = data.unresolvedSearches || 0;
      const summary = `スポット検索 合計 ${totalSearches} 回`
        + (unresolved > 0 ? `（うち観光スポット以外＝バス停・地名 ${unresolved} 回）` : '')
        + ` ／ 公式サイトリンク 合計 ${totalClicks} タップ`;

      resultEl.innerHTML = `
        <p class="text-xs text-slate-500 mb-2">${escapeHtml(data.from)} 〜 ${escapeHtml(data.to)} ／ ${escapeHtml(summary)}</p>
        <div class="overflow-x-auto">
          <table class="min-w-full text-sm border bg-white">
            <thead class="bg-slate-100 text-slate-600">
              <tr>
                <th class="text-left px-3 py-2 font-bold">観光スポット</th>
                <th class="text-left px-3 py-2 font-bold">状態</th>
                <th class="text-right px-3 py-2 font-bold">検索回数</th>
                <th class="text-right px-3 py-2 font-bold">リンクタップ回数</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => `
                <tr class="border-t">
                  <td class="px-3 py-2">${escapeHtml(r.name)}</td>
                  <td class="px-3 py-2">${statusLabel(r)}</td>
                  <td class="px-3 py-2 text-right font-bold tabular-nums">${r.searches || 0}</td>
                  <td class="px-3 py-2 text-right font-bold tabular-nums">${r.clicks || 0}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <p class="text-xs text-slate-400 mt-2">「検索回数」はスポット検索でそのスポットの結果が表示された回数（Asia/Tokyo基準の日別集計）。掲載終了スポットはスナップショット名で残ります。</p>`;
    } catch (err) {
      resultEl.innerHTML = `<p class="text-red-600 font-bold">${escapeHtml(err.message)}</p>`;
    }
  }

  document.getElementById('spot-clicks-load-btn').addEventListener('click', () => loadStats());

  // セクションを開いたときは初期値を入れるだけ（集計は「集計」ボタン押下で実行）。
  window.AdminTouristSpotClicks = { load: async () => { initDefaults(); } };
})();
