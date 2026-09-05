/**
 * リアルタイム運行状況の新表示モード（基本表示）。
 *
 * 路線の全バス停を進行方向に沿って縦一列（トランク線）に並べ、運行中の各便を
 * 「最後に到着済み（または時刻表推定で通過済み）となったバス停」の直下にバスアイコンで
 * 表示する。既存の「カード表示」モード（app.js の createBusCard/createUnsupportedBusCard）
 * を置き換えるものではなく、app.js側のトグルで切り替える追加モードとして呼ばれる。
 *
 * timetable.js/busstop.js等の姉妹ファイルと同じく自己完結のIIFEとし、window.RealtimeDiagramView
 * だけを公開する。app.js からは buildTripDetailUrl/navigateToPath/navigateToBusStopByFeedStop/
 * openScheduleFallbackConfirm の4関数だけを window 経由で借りる（このファイルはapp.jsより先に
 * 読み込まれるため、これらは必ずイベントハンドラ内で都度 window.xxx として参照すること。
 * IIFE先頭でconstに捕まえるとundefinedを捕まえてしまう）。
 */
(function () {
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- URL組み立て（app.jsのrouteHref()と同じ組み立てをこのファイル内で複製） ---------- */
  function baseHref(routeId) {
    const [feedId, originalRouteId] = String(routeId).split(':');
    return originalRouteId
      ? `#/realtime/${encodeURIComponent(feedId)}/${encodeURIComponent(originalRouteId)}`
      : `#/realtime/default/${encodeURIComponent(routeId)}`;
  }
  function patternHref(routeId, patternKey) {
    return `${baseHref(routeId)}/${encodeURIComponent(patternKey)}`;
  }

  /* ---------- 経路（停車パターン）のグルーピング ---------- */
  /**
   * timetable（/api/timetableのレスポンス。各便が{tripId, directionId, stops:[{seqOrder, stopId, stopName, ...}]}）
   * から、便ごとの「停車パターン（経路）シグネチャ」でグルーピングする。
   * シグネチャは stopId（stops.id。route_id×direction_id×gtfs_stop_id×occurrenceで一意）の並びそのもの。
   * isThrough等の通過フラグはシグネチャに含めない＝通過フラグだけが違う便は自動的に同じグループになる
   * （経路差異ルール4：一部便のみ通過停留所がある場合はまとめて表示、が自然に成立する）。
   */
  function computeGroups(timetable) {
    const valid = (timetable || []).filter((t) => Array.isArray(t.stops) && t.stops.length > 0);
    const groupsByKey = new Map();
    for (const trip of valid) {
      const sorted = trip.stops.slice().sort((a, b) => a.seqOrder - b.seqOrder);
      const patternKey = sorted.map((s) => s.stopId).join('-');
      if (!groupsByKey.has(patternKey)) {
        groupsByKey.set(patternKey, { patternKey, directionId: trip.directionId, stops: sorted, tripIds: new Set() });
      }
      groupsByKey.get(patternKey).tripIds.add(trip.tripId);
    }
    return Array.from(groupsByKey.values());
  }

  // 経路（グループ）に属す便のうち、現在表示できるもの（リアルタイム便＋時刻表推定便）の数。
  // 選択画面で「運行中／現在運行なし」を出し分けるために使う。
  function countActiveForGroup(tripIds, buses, unsupportedTrips) {
    const busCount = (buses || []).filter((b) => tripIds.has(b.tripId)).length;
    const scheduleCount = (unsupportedTrips || []).filter((t) => tripIds.has(t.tripId)).length;
    return busCount + scheduleCount;
  }

  /**
   * 経路が複数ある場合の選択肢を組み立てる。
   * (起点stopId, 終点stopId) でクラスタ化し、クラスタ内が1経路だけなら
   * 「起点 → 終点」（ルール2）、複数経路あれば全経路共通の最長共通接頭辞の直後の
   * バス停を経由地として「起点 → 経由地経由 → 終点」（ルール3）とラベル付けする。
   * direction違いの便は stopId が route_id×direction_id スコープなので、起点・終点が
   * 一致することがなく自動的に別クラスタ（＝別の選択肢）になる。
   * 各選択肢には、現在その経路で表示できる便（リアルタイム＋時刻表推定）の数
   * （activeCount。0なら選択画面で「現在運行なし」と分かるように表示する）を持たせる。
   */
  function buildSelectionOptions(groups, buses, unsupportedTrips) {
    const clusters = new Map();
    for (const g of groups) {
      const origin = g.stops[0];
      const dest = g.stops[g.stops.length - 1];
      const key = `${origin.stopId}|${dest.stopId}`;
      if (!clusters.has(key)) clusters.set(key, { origin, dest, groups: [] });
      clusters.get(key).groups.push(g);
    }

    const options = [];
    for (const cluster of clusters.values()) {
      if (cluster.groups.length === 1) {
        const g = cluster.groups[0];
        options.push({
          patternKey: g.patternKey,
          directionId: g.directionId,
          label: `${cluster.origin.stopName} → ${cluster.dest.stopName}`,
          activeCount: countActiveForGroup(g.tripIds, buses, unsupportedTrips)
        });
        continue;
      }

      // ルール3: 全シグネチャに共通する最長共通接頭辞（起点から）を求め、
      // 各シグネチャの「接頭辞の直後のバス停」を経由地ラベルにする。
      const sigs = cluster.groups.map((g) => g.stops.map((s) => s.stopId));
      let commonLen = sigs[0].length;
      for (const sig of sigs.slice(1)) {
        let i = 0;
        while (i < commonLen && i < sig.length && sig[i] === sigs[0][i]) i++;
        commonLen = i;
      }

      const used = new Set();
      for (const g of cluster.groups) {
        const viaStop = g.stops[commonLen] || g.stops[g.stops.length - 1];
        let viaLabel = viaStop.stopName;
        // 3経路以上が同一クラスタに属す場合、共通接頭辞の直後がたまたま一致することがある
        // （構造的にあり得るため、実データで未発生でも防御的にサフィックスで区別する）。
        if (used.has(viaLabel)) {
          let n = 2;
          while (used.has(`${viaLabel}(${n})`)) n++;
          viaLabel = `${viaLabel}(${n})`;
        }
        used.add(viaLabel);
        options.push({
          patternKey: g.patternKey,
          directionId: g.directionId,
          label: `${cluster.origin.stopName} → ${viaLabel}経由 → ${cluster.dest.stopName}`,
          activeCount: countActiveForGroup(g.tripIds, buses, unsupportedTrips)
        });
      }
    }
    return options.sort((a, b) => a.directionId - b.directionId || a.label.localeCompare(b.label, 'ja'));
  }

  /* ---------- 便の「現在位置（最後に到着済み／通過済みのバス停）」判定 ---------- */
  // リアルタイム便：app.jsのfindLastArrivedIndexと同じロジックだが、インデックスではなくstopIdを返す。
  function findLastArrivedStopId(bus) {
    const stops = bus.stops || [];
    let stopId = null;
    stops.forEach((s) => { if (s.status === '到着済') stopId = s.stopId; });
    return stopId;
  }

  // 時刻表推定便：app.jsのparseScheduleMinutes/findScheduleCurrentStopと同じロジック。
  function parseScheduleMinutes(timeStr) {
    if (!timeStr) return NaN;
    const parts = String(timeStr).split(':');
    if (parts.length < 2) return NaN;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
    return h * 60 + m;
  }
  function findScheduleCurrentStopId(trip, nowMinutes) {
    const stops = (trip.stops || []).slice().sort((a, b) => a.seqOrder - b.seqOrder);
    let stopId = null;
    stops.forEach((stop) => {
      const t = parseScheduleMinutes(stop.scheduledTime);
      if (!Number.isNaN(t) && t <= nowMinutes) stopId = stop.stopId;
    });
    return stopId;
  }

  /* ---------- 描画：バスアイコン1件ぶん ---------- */
  // kindごとに tripId -> 元データ（bus/trip）を引けるようにしておき、タップ時のURL組み立てに使う。
  // （このモジュールが描画するコンテナは常に1つなので、モジュールレベルの状態で十分）
  let tripLookup = new Map();

  function iconRowHtml(kind, record, { beforeStart = false } = {}) {
    const tripId = record.tripId;
    tripLookup.set(`${kind}:${tripId}`, record);

    const rowClass = beforeStart
      ? 'flex items-center gap-2 py-1'
      : 'relative flex items-center gap-2 py-1 pl-9 pr-2';

    let badgeHtml;
    let headsignLabel;
    let iconBg;
    if (kind === 'realtime') {
      const delay = record.delayMinutes || 0;
      const delayLabel = delay <= 1 ? '定刻通り' : `+${delay}分`;
      const delayClass = delay >= 5 ? 'bg-red-600 text-white' : 'bg-blue-100 text-blue-800';
      badgeHtml = `<span class="text-xs font-bold ${delayClass} px-2 py-0.5 rounded-full" data-role="rt-bus-icon">${escapeHtml(delayLabel)}</span>`;
      headsignLabel = record.currentHeadsign || record.headsign || '';
      iconBg = 'bg-blue-800';
    } else {
      // 時刻表推定便は実遅延データが無いため、遅れ・定刻の文言は出さず「推定」バッジのみにする
      // （createUnsupportedBusCardと同じ方針。ユーザー確認済み）。
      badgeHtml = `<span class="text-[10px] font-bold text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full border border-gray-200" data-role="rt-bus-icon">推定</span>`;
      headsignLabel = record.headsign || '';
      iconBg = 'bg-gray-400';
    }

    const beforeStartBadge = beforeStart
      ? `<span class="text-[10px] font-bold text-gray-400">発車前</span>`
      : '';

    return `
      <div class="${rowClass}" data-role="rt-bus-row" data-kind="${kind}" data-trip-id="${escapeHtml(String(tripId))}">
        <span class="w-8 h-8 rounded-full ${iconBg} flex items-center justify-center text-white text-sm shrink-0 shadow cursor-pointer active:opacity-60" data-role="rt-bus-icon">🚌</span>
        ${badgeHtml}
        ${beforeStartBadge}
        ${headsignLabel ? `<span class="text-[11px] text-gray-500 font-bold truncate">${escapeHtml(headsignLabel)}行き</span>` : ''}
      </div>
    `;
  }

  // タグの意味はapp.jsのcreateScheduleCard（時刻表参考セクション）と揃える
  // （始発/終点/通過/降車のみ/乗車のみ）。
  function stopTagsHtml(stop, index, total) {
    const passed = stop.isThrough;
    const tagClass = 'text-[10px] font-bold px-1.5 py-0.5 rounded border';
    const tags = [
      index === 0 ? `<span class="${tagClass} text-emerald-700 bg-emerald-50 border-emerald-200">始発</span>` : '',
      index === total - 1 ? `<span class="${tagClass} text-rose-700 bg-rose-50 border-rose-200">終点</span>` : '',
      passed ? `<span class="${tagClass} text-gray-500 bg-gray-100 border-gray-200">通過</span>` : '',
      !passed && stop.noPickup && index !== total - 1 ? `<span class="${tagClass} text-gray-500 bg-gray-100 border-gray-200">降車のみ</span>` : '',
      !passed && stop.noDropOff && index !== 0 ? `<span class="${tagClass} text-gray-500 bg-gray-100 border-gray-200">乗車のみ</span>` : ''
    ].filter(Boolean).join(' ');
    return tags ? `<div class="flex flex-wrap gap-1 mt-0.5">${tags}</div>` : '';
  }

  function stopRowHtml(stop, feedId, index, total) {
    return `
      <div class="relative flex items-center gap-3 py-2.5 pl-9 pr-2">
        <span class="absolute left-[9px] top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-blue-500 border-2 border-white shadow"></span>
        <div class="min-w-0">
          <span data-role="rt-stop-name" data-stop-name="${escapeHtml(stop.stopName)}"
                data-feed-id="${escapeHtml(feedId)}" data-gtfs-stop-id="${escapeHtml(String(stop.gtfsStopId || ''))}"
                class="font-bold text-gray-800 underline decoration-dotted cursor-pointer active:text-blue-700">${escapeHtml(stop.stopName)}</span>
          ${stopTagsHtml(stop, index, total)}
        </div>
      </div>
    `;
  }

  const sectionHeadingHtml = `
    <h2 class="text-xl font-bold text-blue-900 flex items-center mb-4">
      <span class="w-2 h-6 bg-green-500 rounded-full mr-2 shadow-sm"></span>
      リアルタイム運行状況
    </h2>
  `;

  function renderSuspendedNotice(container, reason) {
    container.innerHTML = `
      ${sectionHeadingHtml}
      <div class="rounded-xl border-2 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p class="font-bold">この路線のリアルタイム運行情報は一時休止しています。</p>
        ${reason ? `<p class="mt-1">理由：${escapeHtml(reason)}</p>` : ''}
        <p class="mt-1 text-amber-800">下の時刻表は通常どおりご利用いただけます。</p>
      </div>
    `;
  }

  function renderEmptyNotice(container) {
    container.innerHTML = `
      ${sectionHeadingHtml}
      <p class="text-sm text-gray-500 px-1">現在表示できる運行データがありません。</p>
    `;
  }

  function selectionActivityBadgeHtml(activeCount) {
    return activeCount > 0
      ? `<span class="shrink-0 text-[10px] font-bold text-green-700 bg-green-50 px-2 py-1 rounded-full border border-green-200 flex items-center gap-1"><span class="w-1.5 h-1.5 bg-green-500 rounded-full"></span>運行中 ${activeCount}台</span>`
      : `<span class="shrink-0 text-[10px] font-bold text-gray-500 bg-gray-100 px-2 py-1 rounded-full border border-gray-200">現在運行なし</span>`;
  }

  function renderSelectionScreen(container, options, routeId) {
    container.innerHTML = `
      ${sectionHeadingHtml}
      <p class="text-sm text-gray-500 mb-3 px-1">この路線には複数の経路があります。表示する経路を選んでください。</p>
      <div class="space-y-3">
        ${options.map((opt) => `
          <a href="${escapeHtml(patternHref(routeId, opt.patternKey))}"
             class="flex items-center justify-between gap-3 bg-white rounded-xl border-2 border-gray-100 shadow-sm hover:border-blue-400 active:scale-[0.99] transition-all p-4">
            <span class="font-bold text-gray-900">${escapeHtml(opt.label)}</span>
            ${selectionActivityBadgeHtml(opt.activeCount || 0)}
          </a>
        `).join('')}
      </div>
    `;
  }

  function renderDiagram(container, group, buses, unsupportedTrips, { routeId, showChangeLink }) {
    tripLookup = new Map();
    const feedId = String(routeId).split(':')[0];
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

    const filteredBuses = (buses || []).filter((b) => group.tripIds.has(b.tripId));
    const filteredUnsupported = (unsupportedTrips || []).filter((t) => group.tripIds.has(t.tripId));

    const iconsByStopId = new Map();
    const notDeparted = [];

    filteredBuses.forEach((bus) => {
      const stopId = findLastArrivedStopId(bus);
      if (stopId === null) {
        notDeparted.push({ kind: 'realtime', record: bus });
      } else {
        if (!iconsByStopId.has(stopId)) iconsByStopId.set(stopId, []);
        iconsByStopId.get(stopId).push({ kind: 'realtime', record: bus });
      }
    });
    filteredUnsupported.forEach((trip) => {
      const stopId = findScheduleCurrentStopId(trip, nowMinutes);
      if (stopId === null) {
        notDeparted.push({ kind: 'schedule', record: trip });
      } else {
        if (!iconsByStopId.has(stopId)) iconsByStopId.set(stopId, []);
        iconsByStopId.get(stopId).push({ kind: 'schedule', record: trip });
      }
    });

    const rows = [];
    group.stops.forEach((stop, index) => {
      rows.push(stopRowHtml(stop, feedId, index, group.stops.length));
      const icons = iconsByStopId.get(stop.stopId) || [];
      icons.forEach((i) => rows.push(iconRowHtml(i.kind, i.record)));
    });

    const notDepartedHtml = notDeparted.length > 0
      ? `<div class="mb-3 space-y-1">${notDeparted.map((i) => iconRowHtml(i.kind, i.record, { beforeStart: true })).join('')}</div>`
      : '';

    const changeLinkHtml = showChangeLink
      ? `<a href="${escapeHtml(baseHref(routeId))}" class="inline-block text-xs font-bold text-blue-700 mb-3">← 経路を変更</a>`
      : '';

    const emptyHtml = (filteredBuses.length === 0 && filteredUnsupported.length === 0)
      ? `<p class="text-sm text-gray-500 px-1 mt-3">現在この経路で運行中のバスはありません。</p>`
      : '';

    container.innerHTML = `
      ${sectionHeadingHtml}
      ${changeLinkHtml}
      ${notDepartedHtml}
      <div class="relative">
        <div class="rt-diagram-trunk"></div>
        ${rows.join('')}
      </div>
      ${emptyHtml}
    `;
  }

  /* ---------- イベント委任（コンテナごとに1回だけ登録する） ---------- */
  function ensureDelegatedEvents(container) {
    if (container.dataset.rtEventsBound === '1') return;
    container.dataset.rtEventsBound = '1';

    container.addEventListener('click', (e) => {
      const stopNameEl = e.target.closest('[data-role="rt-stop-name"]');
      if (stopNameEl) {
        // 標柱単位で識別されたバス停詳細ページへ（解決できなければ名前ベースにフォールバック）。
        window.navigateToBusStopByFeedStop(
          stopNameEl.dataset.feedId,
          stopNameEl.dataset.gtfsStopId,
          stopNameEl.dataset.stopName
        );
        return;
      }

      const busIconEl = e.target.closest('[data-role="rt-bus-icon"]');
      if (!busIconEl) return;
      const row = busIconEl.closest('[data-role="rt-bus-row"]');
      if (!row) return;
      const kind = row.dataset.kind;
      const tripId = row.dataset.tripId;
      const record = tripLookup.get(`${kind}:${tripId}`);
      if (!record) return;

      if (kind === 'realtime') {
        const url = window.buildTripDetailUrl(record, { view: 'realtime' });
        if (url) window.navigateToPath(url);
      } else {
        const url = window.buildTripDetailUrl(record);
        if (url) window.openScheduleFallbackConfirm(url);
      }
    });
  }

  /* ---------- ポーリング安定化キャッシュ ---------- */
  // 選択済みの経路（patternKey）の便が、ある回のポーリングで一時的に0件になっても
  // （GPS瞬断・ポーリングタイミングのズレ等）経路選択画面に戻されないよう、
  // 一度観測したパターンは路線を変えるまで保持する（内容アドレス方式のキーなので
  // ダイヤ改正やdaily_tripsの世代交代を跨いでも同じパターンは同じキーを再利用する）。
  let cachedRouteId = null;
  let groupCache = new Map();

  function render(container, { routeId, patternKey, timetable, buses, unsupportedTrips, suspended, suspensionReason }) {
    ensureDelegatedEvents(container);

    if (routeId !== cachedRouteId) {
      cachedRouteId = routeId;
      groupCache = new Map();
    }

    if (suspended) {
      renderSuspendedNotice(container, suspensionReason);
      return;
    }

    const freshGroups = computeGroups(timetable);
    freshGroups.forEach((g) => groupCache.set(g.patternKey, g));

    if (freshGroups.length === 0) {
      renderEmptyNotice(container);
      return;
    }
    if (freshGroups.length === 1) {
      // 経路が1つしか無いのでURLの古いpatternKeyは無視して直接表示する。
      renderDiagram(container, freshGroups[0], buses, unsupportedTrips, { routeId, showChangeLink: false });
      return;
    }
    if (!patternKey) {
      renderSelectionScreen(container, buildSelectionOptions(freshGroups, buses, unsupportedTrips), routeId);
      return;
    }

    const resolved = groupCache.get(patternKey);
    if (!resolved) {
      renderSelectionScreen(container, buildSelectionOptions(freshGroups, buses, unsupportedTrips), routeId);
      return;
    }
    renderDiagram(container, resolved, buses, unsupportedTrips, { routeId, showChangeLink: true });
  }

  window.RealtimeDiagramView = { render };
})();
