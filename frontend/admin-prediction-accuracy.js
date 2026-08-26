// 予測精度の監視
(function () {
  const DAY_TYPE_LABEL = { weekday: '平日', saturday: '土曜', holiday: '休日' };

  // 行をクリックすると「予測タイミング（何分前／何停留所前）」の絞り込みセレクトに反映する
  function accuracyRow(label, row, drilldown) {
    const drilldownAttr = drilldown ? `data-drill-field="${escapeHtml(drilldown.field)}" data-drill-value="${escapeHtml(drilldown.value)}"` : '';
    const labelCell = drilldown
      ? `<button class="font-bold text-blue-700 hover:underline accuracy-drill-btn" ${drilldownAttr}>${escapeHtml(label)}</button>`
      : `<span class="font-bold">${escapeHtml(label)}</span>`;
    if (!row || row.sampleCount === 0) {
      return `<tr class="border-t"><td class="px-3 py-2">${labelCell}</td><td class="px-3 py-2 text-slate-300" colspan="3">データなし</td></tr>`;
    }
    return `
      <tr class="border-t">
        <td class="px-3 py-2">${labelCell}</td>
        <td class="px-3 py-2">${row.sampleCount}</td>
        <td class="px-3 py-2">${row.meanAbsErrorMinutes}分（${row.meanErrorMinutes >= 0 ? '+' : ''}${row.meanErrorMinutes}分）</td>
        <td class="px-3 py-2">${row.withinThresholdRate}%</td>
      </tr>
    `;
  }

  let accuracyRoutesLoaded = false;
  async function ensureAccuracyRoutesLoaded() {
    if (accuracyRoutesLoaded) return;
    accuracyRoutesLoaded = true;
    try {
      const routes = await getRoutesList();
      const select = document.getElementById('accuracy-route');
      routes.forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.name || r.id;
        select.appendChild(opt);
      });
    } catch (err) {
      accuracyRoutesLoaded = false; // 失敗時は次回の表示で再試行できるようにする
      // 路線一覧の取得に失敗しても「すべて」での集計は行えるため握りつぶす
    }
  }

  function currentAccuracyFilters() {
    return {
      days: document.getElementById('accuracy-days').value,
      routeId: document.getElementById('accuracy-route').value,
      thresholdMinutes: document.getElementById('accuracy-threshold').value,
      leadBucket: document.getElementById('accuracy-lead').value,
      stopsBeforeBucket: document.getElementById('accuracy-stops-before').value
    };
  }

  // 絞り込みを立て続けに切り替えたときに、走り終えた古いリクエストの結果で画面が
  // 上書きされたり、不要な集計クエリがDBに積み上がったりしないよう、
  // 新しいリクエストを出す前に前のリクエストを中断する。
  let accuracyAbort = null;

  function setAccuracyLoading(loading) {
    const btn = document.getElementById('refresh-accuracy-btn');
    btn.disabled = loading;
    btn.classList.toggle('opacity-60', loading);
    btn.classList.toggle('cursor-not-allowed', loading);
    if (loading) document.getElementById('accuracy-meta').textContent = '集計中…';
  }

  async function loadPredictionAccuracy() {
    await ensureAccuracyRoutesLoaded();
    const f = currentAccuracyFilters();
    const params = new URLSearchParams({ days: f.days, thresholdMinutes: f.thresholdMinutes });
    if (f.routeId) params.set('routeId', f.routeId);
    if (f.leadBucket) params.set('leadBucket', f.leadBucket);
    if (f.stopsBeforeBucket) params.set('stopsBeforeBucket', f.stopsBeforeBucket);

    if (accuracyAbort) accuracyAbort.abort();
    const controller = new AbortController();
    accuracyAbort = controller;
    setAccuracyLoading(true);

    let data;
    try {
      data = await api(`/api/admin/prediction-accuracy?${params.toString()}`, { signal: controller.signal });
    } catch (err) {
      // 中断は「後から来た絞り込みが引き継いだ」だけなのでエラー表示しない
      if (err.name === 'AbortError') return;
      setAccuracyLoading(false);
      document.getElementById('accuracy-meta').textContent = '';
      throw err;
    } finally {
      if (accuracyAbort === controller) accuracyAbort = null;
    }
    setAccuracyLoading(false);

    const metaParts = [`集計時刻 ${fmtDateTime(data.generatedAt)}`];
    if (typeof data.totalSampleCount === 'number') {
      metaParts.push(`サンプル ${data.sampleCount.toLocaleString()} / ${data.totalSampleCount.toLocaleString()}件`);
    }
    if (typeof data.computeMs === 'number') {
      metaParts.push(data.cached ? 'キャッシュ' : `集計 ${fmtDuration(data.computeMs)}`);
    }
    document.getElementById('accuracy-meta').textContent = metaParts.join(' ・ ');

    document.querySelectorAll('.accuracy-threshold-header').forEach((el) => {
      el.textContent = `的中率(±${data.thresholdMinutes}分)`;
    });

    const overall = data.overall;
    const tiles = [
      { label: 'サンプル数（現在の絞り込み）', value: (overall.sampleCount ?? 0).toLocaleString() },
      { label: '平均誤差(絶対値)', value: overall.meanAbsErrorMinutes !== null ? `${overall.meanAbsErrorMinutes}分` : '—' },
      { label: '平均誤差(符号あり・+は遅め予測)', value: overall.meanErrorMinutes !== null ? `${overall.meanErrorMinutes >= 0 ? '+' : ''}${overall.meanErrorMinutes}分` : '—' },
      { label: `的中率（±${data.thresholdMinutes}分以内）`, value: overall.withinThresholdRate !== null ? `${overall.withinThresholdRate}%` : '—' }
    ];
    document.getElementById('accuracy-summary').innerHTML = tiles.map((t) => `
      <div class="rounded-xl border-2 p-4 bg-blue-50 text-blue-800 border-blue-200">
        <p class="text-xs font-bold opacity-70">${escapeHtml(t.label)}</p>
        <p class="text-2xl font-black mt-1">${t.value}</p>
      </div>
    `).join('');

    document.getElementById('accuracy-lead-tbody').innerHTML = data.byLeadTime.length
      ? data.byLeadTime.map((r) => accuracyRow(r.leadBucket, r, { field: 'lead', value: r.leadBucket })).join('')
      : '<tr><td colspan="4" class="px-3 py-6 text-center text-slate-400">データがありません。</td></tr>';

    document.getElementById('accuracy-stops-before-tbody').innerHTML = data.byStopsBefore.length
      ? data.byStopsBefore.map((r) => accuracyRow(r.stopsBeforeBucket, r, { field: 'stopsBefore', value: r.stopsBeforeBucket })).join('')
      : '<tr><td colspan="4" class="px-3 py-6 text-center text-slate-400">データがありません（対応版で記録された予測がまだありません）。</td></tr>';

    document.getElementById('accuracy-daytype-tbody').innerHTML = data.byDayType.length
      ? data.byDayType.map((r) => accuracyRow(DAY_TYPE_LABEL[r.dayType] || r.dayType, r)).join('')
      : '<tr><td colspan="4" class="px-3 py-6 text-center text-slate-400">データがありません。</td></tr>';

    document.getElementById('accuracy-route-tbody').innerHTML = data.byRoute.length
      ? data.byRoute.map((r) => accuracyRow(r.routeName || r.routeId, r)).join('')
      : '<tr><td colspan="4" class="px-3 py-6 text-center text-slate-400">データがありません。</td></tr>';

    document.getElementById('accuracy-hour-tbody').innerHTML = data.byHour.length
      ? data.byHour.map((r) => accuracyRow(`${r.hour}時台`, r)).join('')
      : '<tr><td colspan="4" class="px-3 py-6 text-center text-slate-400">データがありません。</td></tr>';

    const worstTbody = document.getElementById('accuracy-worst-tbody');
    worstTbody.innerHTML = data.worstStops.length
      ? data.worstStops.map((r) => `
          <tr class="border-t">
            <td class="px-3 py-2">${escapeHtml(r.routeName || r.routeId)}</td>
            <td class="px-3 py-2 font-bold">${escapeHtml(r.stopName)}</td>
            <td class="px-3 py-2">${r.sampleCount}</td>
            <td class="px-3 py-2">${r.meanAbsErrorMinutes}分</td>
            <td class="px-3 py-2">${r.meanErrorMinutes >= 0 ? '+' : ''}${r.meanErrorMinutes}分</td>
            <td class="px-3 py-2">${r.withinThresholdRate}%</td>
          </tr>
        `).join('')
      : '<tr><td colspan="6" class="px-3 py-6 text-center text-slate-400">データがありません（実績が確定した便がまだありません）。</td></tr>';

    const samplesTbody = document.getElementById('accuracy-samples-tbody');
    samplesTbody.innerHTML = data.samples.length
      ? data.samples.map((s) => `
          <tr class="border-t">
            <td class="px-3 py-2">${escapeHtml(s.routeName || s.routeId)}</td>
            <td class="px-3 py-2 font-bold">${escapeHtml(s.stopName)}</td>
            <td class="px-3 py-2 text-xs text-slate-500">${escapeHtml(s.startTime || '')}発</td>
            <td class="px-3 py-2 text-xs">${escapeHtml(s.basisLabel)}</td>
            <td class="px-3 py-2 text-xs">${escapeHtml(s.predictedTime || '')}</td>
            <td class="px-3 py-2 text-xs">${escapeHtml(s.actualTime || '')}</td>
            <td class="px-3 py-2 ${Math.abs(s.errorMinutes) > data.thresholdMinutes ? 'text-red-600 font-bold' : ''}">${s.errorMinutes >= 0 ? '+' : ''}${s.errorMinutes}分</td>
            <td class="px-3 py-2 text-xs text-slate-500">${s.leadMinutes}分前</td>
            <td class="px-3 py-2 text-xs text-slate-500">${s.stopsBefore !== null && s.stopsBefore !== undefined ? `${s.stopsBefore}停留所前` : '—'}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="9" class="px-3 py-6 text-center text-slate-400">データがありません。</td></tr>';
  }

  // ドリルダウン用のボタンは表を描き直すたびに作り直されるため、リスナは
  // tbody側へ一度だけ委譲して張る（再描画のたびに張り直さない）。
  ['accuracy-lead-tbody', 'accuracy-stops-before-tbody'].forEach((id) => {
    document.getElementById(id).addEventListener('click', (event) => {
      const btn = event.target.closest('.accuracy-drill-btn');
      if (!btn) return;
      const field = btn.dataset.drillField;
      const value = btn.dataset.drillValue;
      const selectId = field === 'lead' ? 'accuracy-lead' : 'accuracy-stops-before';
      const select = document.getElementById(selectId);
      select.value = select.value === value ? '' : value; // 同じ行を再クリックしたら解除
      loadPredictionAccuracy().catch((err) => showStatus(err.message, 'error'));
    });
  });

  ['accuracy-days', 'accuracy-route', 'accuracy-threshold', 'accuracy-lead', 'accuracy-stops-before'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => loadPredictionAccuracy().catch((err) => showStatus(err.message, 'error')));
  });
  document.getElementById('refresh-accuracy-btn').addEventListener('click', () => loadPredictionAccuracy().catch((err) => showStatus(err.message, 'error')));
  document.getElementById('clear-accuracy-filter-btn').addEventListener('click', () => {
    document.getElementById('accuracy-lead').value = '';
    document.getElementById('accuracy-stops-before').value = '';
    document.getElementById('accuracy-route').value = '';
    loadPredictionAccuracy().catch((err) => showStatus(err.message, 'error'));
  });

  window.AdminPredictionAccuracy = { load: loadPredictionAccuracy };
})();
