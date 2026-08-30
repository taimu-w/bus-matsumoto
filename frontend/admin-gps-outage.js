// GPS途絶の検証（全画面モーダル）
// 異常アラート「GPS途絶で便打ち切り」(type='gpsLostTrip') の行にある「地図で検証」から開く。
// 運行ダッシュボード（admin-dashboard.js）と同じ「左＝地図／右＝詳細」の構成で、
//   - その車両が担当開始（became_assigned_at）以降にどこを通ったか（青い軌跡）
//   - いつ・どこでGPSが途絶し、何分後にどこで復旧したか（赤＝途絶地点／緑＝復旧地点）
//   - 途絶した時点で時刻表のどこまで進んでいたか（直近到着済バス停・次のバス停）
// を表示する。データ元は GET /api/admin/gps-outage/:assignmentId。
// 走行経路は GPS_LOG_RETENTION_HOURS（既定48時間）を過ぎると空になる（その旨を表示する）。
(function () {
  const MAP_CENTER = [36.2381, 137.9701];
  const MAP_ZOOM = 12;

  let map = null;
  let layers = []; // 便ごとに貼り替えるオーバーレイ（バス停・軌跡・途絶マーカー）

  function ensureMap() {
    if (map) return;
    map = L.map('gps-outage-map').setView(MAP_CENTER, MAP_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
  }

  function clearLayers() {
    if (!map) return;
    layers.forEach((l) => map.removeLayer(l));
    layers = [];
  }

  function close() {
    document.getElementById('gps-outage-modal').classList.add('hidden');
    clearLayers();
  }

  /* ---------- 時刻整形 ---------- */
  function fmtClock(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
  }

  function minutesAgo(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  }

  function delayTag(minutes) {
    if (minutes === null || minutes === undefined) return '';
    const n = Number(minutes);
    if (n <= 1) return ' <span class="text-green-700 font-bold">±0</span>';
    const tone = n >= 5 ? 'text-red-600' : 'text-amber-600';
    return ` <span class="${tone} font-bold">+${n}</span>`;
  }

  function stopMarkerClass(status) {
    if (status === '到着済') return 'arrived';
    if (status === '付近') return 'nearby';
    return 'pending';
  }

  /* ---------- 地図オーバーレイ ---------- */
  function drawOverlay(data) {
    clearLayers();
    const bounds = [];

    // 停車バス停（状態で配色：到着済=緑／付近=amber／未到着=グレー）
    (data.stops || []).forEach((stop) => {
      const lat = Number(stop.lat);
      const lng = Number(stop.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const icon = L.divIcon({
        html: `<div class="stop-marker ${stopMarkerClass(stop.status)}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
        className: 'stop-marker-icon'
      });
      const marker = L.marker([lat, lng], { icon, zIndexOffset: 400 }).addTo(map);
      marker.bindTooltip(
        `<div class="text-xs"><span class="font-bold">${escapeHtml(stop.name)}</span><br>定刻 ${escapeHtml(stop.scheduledTime || '—')}</div>`,
        { direction: 'top', offset: [0, -6] }
      );
      layers.push(marker);
      bounds.push([lat, lng]);
    });

    // 走行軌跡（became_assigned_at 以降のGPSログ）
    const track = [];
    (data.positionHistory || []).forEach((p) => {
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      track.push([lat, lng]);
      const dot = L.marker([lat, lng], {
        icon: L.divIcon({ html: '<div class="history-dot"></div>', iconSize: [8, 8], iconAnchor: [4, 4], className: 'history-dot-icon' })
      }).addTo(map);
      dot.bindTooltip(`<div class="text-xs">位置情報 ${escapeHtml(p.gpsTime || '')}</div>`, { direction: 'top', offset: [0, -4] });
      layers.push(dot);
      bounds.push([lat, lng]);
    });
    if (track.length > 1) {
      const line = L.polyline(track, { color: '#2563eb', weight: 3, opacity: 0.5 }).addTo(map);
      layers.push(line);
    }

    // 途絶ごとの「途絶地点（赤）」「復旧地点（緑）」と、その間を結ぶ赤い破線
    (data.outages || []).forEach((o, i) => {
      const isPrimary = data.primaryOutage
        && o.lostAt === data.primaryOutage.lostAt
        && o.ongoing === data.primaryOutage.ongoing;
      const lostLat = Number(o.lostLat);
      const lostLng = Number(o.lostLng);
      if (Number.isFinite(lostLat) && Number.isFinite(lostLng)) {
        const m = L.marker([lostLat, lostLng], {
          icon: L.divIcon({
            html: `<div class="gps-outage-marker lost">🚨</div>`,
            iconSize: [26, 26], iconAnchor: [13, 13], className: 'gps-outage-marker-wrap'
          }),
          zIndexOffset: 900
        }).addTo(map);
        m.bindTooltip(
          `<div class="text-xs"><span class="font-bold">GPS途絶</span><br>${escapeHtml(o.lostGpsTime || fmtClock(o.lostAt))}${isPrimary ? '（便を打ち切り）' : ''}</div>`,
          { direction: 'top', offset: [0, -12], permanent: isPrimary }
        );
        layers.push(m);
        bounds.push([lostLat, lostLng]);
      }
      const recLat = Number(o.recoveredLat);
      const recLng = Number(o.recoveredLng);
      if (Number.isFinite(recLat) && Number.isFinite(recLng)) {
        const m = L.marker([recLat, recLng], {
          icon: L.divIcon({
            html: `<div class="gps-outage-marker recovered">📡</div>`,
            iconSize: [26, 26], iconAnchor: [13, 13], className: 'gps-outage-marker-wrap'
          }),
          zIndexOffset: 900
        }).addTo(map);
        m.bindTooltip(
          `<div class="text-xs"><span class="font-bold">GPS復旧</span><br>${escapeHtml(o.recoveredGpsTime || fmtClock(o.recoveredAt))}（途絶から${o.durationMinutes}分）</div>`,
          { direction: 'top', offset: [0, -12] }
        );
        layers.push(m);
        bounds.push([recLat, recLng]);
        if (Number.isFinite(lostLat) && Number.isFinite(lostLng)) {
          const gap = L.polyline([[lostLat, lostLng], [recLat, recLng]], {
            color: '#dc2626', weight: 3, opacity: 0.85, dashArray: '6 8'
          }).addTo(map);
          layers.push(gap);
        }
      }
    });

    map.invalidateSize();
    if (bounds.length > 0) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.2), { maxZoom: 16 });
    }
  }

  /* ---------- 右パネル ---------- */
  function outageSummaryHtml(data) {
    const o = data.primaryOutage;
    if (!o) {
      return `<div class="rounded-lg border bg-slate-50 p-3 text-sm text-slate-500">
        この割り当ての位置履歴からはGPS途絶を検出できませんでした（保持期間切れ、または既に復旧して走行を継続しています）。
      </div>`;
    }
    const lostAgo = minutesAgo(o.lostAt);
    const recovered = o.recoveredAt
      ? `<div><span class="text-slate-500">復旧</span> <span class="font-black text-green-700">${escapeHtml(o.recoveredGpsTime || fmtClock(o.recoveredAt))}</span>
           <span class="text-xs text-slate-500">（途絶から ${o.durationMinutes} 分）</span></div>`
      : `<div><span class="text-slate-500">復旧</span> <span class="font-black text-red-600">未復旧</span>
           <span class="text-xs text-slate-500">（${o.durationMinutes} 分経過・現在も途絶中）</span></div>`;
    const cardTitle = data.assignmentState === 'active'
      ? (o.ongoing ? '現在発生中の GPS途絶' : '直近の GPS途絶')
      : 'この便を打ち切った GPS途絶';
    return `
      <div class="rounded-lg border-2 border-red-200 bg-red-50 p-3 space-y-1.5">
        <div class="text-xs font-black text-red-700">${cardTitle}</div>
        <div><span class="text-slate-500">途絶</span> <span class="font-black text-red-700">${escapeHtml(o.lostGpsTime || fmtClock(o.lostAt))}</span>
          ${lostAgo !== null ? `<span class="text-xs text-slate-500">（${lostAgo} 分前）</span>` : ''}</div>
        ${recovered}
        <div class="text-xs text-slate-500 pt-1 border-t">
          途絶地点 ${Number(o.lostLat).toFixed(5)}, ${Number(o.lostLng).toFixed(5)}
          ${o.recoveredLat != null ? `<br>復旧地点 ${Number(o.recoveredLat).toFixed(5)}, ${Number(o.recoveredLng).toFixed(5)}` : ''}
        </div>
      </div>`;
  }

  function progressHtml(data) {
    const p = data.progressAtLoss || {};
    const la = p.lastArrivedStop;
    const ns = p.nextStop;
    return `
      <div class="rounded-lg border bg-white p-3 space-y-1.5">
        <div class="text-xs font-black text-slate-500">途絶時点の進捗（時刻表）</div>
        ${la
          ? `<div class="text-sm"><span class="font-bold text-green-700">「${escapeHtml(la.name)}」まで到着済</span>
               <span class="text-xs text-slate-500">定刻 ${escapeHtml(la.scheduledTime || '—')} ／ 実績 ${escapeHtml(la.actualTime || '—')}${delayTag(la.delayMinutes)}</span></div>`
          : `<div class="text-sm text-slate-500">到着済のバス停はまだありませんでした（始発〜最初のバス停の間で途絶）。</div>`}
        ${ns
          ? `<div class="text-sm"><span class="font-bold">次は「${escapeHtml(ns.name)}」</span>
               <span class="text-xs text-slate-500">定刻 ${escapeHtml(ns.scheduledTime || '—')}${ns.predictedTime ? ` ／ 予測 ${escapeHtml(ns.predictedTime)}` : ''}</span></div>`
          : ''}
        <div class="text-xs text-slate-400 pt-1 border-t">${p.arrivedCount ?? 0} / ${p.totalStops ?? 0} 停留所 到着済</div>
      </div>`;
  }

  function timetableHtml(data) {
    const la = (data.progressAtLoss || {}).lastArrivedStop;
    const afterSeq = la ? la.seqOrder : -1;
    const o = data.primaryOutage;
    const lostLabel = o ? escapeHtml(o.lostGpsTime || fmtClock(o.lostAt)) : '';
    let insertedDivider = false;

    const rows = (data.stops || []).map((s) => {
      let divider = '';
      if (!insertedDivider && o && s.seqOrder > afterSeq) {
        insertedDivider = true;
        divider = `<tr><td colspan="3" class="px-3 py-1 bg-red-600 text-white text-[11px] font-black">◆ ここで GPS途絶（${lostLabel}）</td></tr>`;
      }
      const right = s.status === '到着済'
        ? `<span class="text-green-700 font-bold">実績 ${escapeHtml(s.actualTime || '—')}</span>${delayTag(s.delayMinutes)}`
        : s.status === '通過'
          ? '<span class="text-slate-400">通過</span>'
          : s.predictedTime
            ? `<span class="text-blue-700">予測 ${escapeHtml(s.predictedTime)}</span>`
            : '<span class="text-slate-400">—</span>';
      const statusTone = s.status === '到着済' ? 'text-green-700' : s.status === '付近' ? 'text-amber-700' : 'text-slate-400';
      return `${divider}
        <tr class="border-b last:border-b-0">
          <td class="px-3 py-1.5 text-sm font-bold text-slate-800">${escapeHtml(s.name)}</td>
          <td class="px-3 py-1.5 text-xs whitespace-nowrap">
            <div class="text-slate-500">定刻 ${escapeHtml(s.scheduledTime || '—')}</div>
            <div>${right}</div>
          </td>
          <td class="px-3 py-1.5 text-[11px] font-bold ${statusTone} whitespace-nowrap">${escapeHtml(s.status || '未到着')}</td>
        </tr>`;
    }).join('');

    return `
      <div class="rounded-lg border overflow-hidden">
        <table class="w-full text-left">
          <thead><tr class="text-[11px] text-slate-400 border-b bg-slate-50">
            <th class="px-3 py-1.5 font-bold">バス停</th>
            <th class="px-3 py-1.5 font-bold">定刻／実績・予測</th>
            <th class="px-3 py-1.5 font-bold">状態</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function otherOutagesHtml(data) {
    const others = (data.outages || []).filter((o) => !(data.primaryOutage
      && o.lostAt === data.primaryOutage.lostAt && o.ongoing === data.primaryOutage.ongoing));
    if (others.length === 0) return '';
    const items = others.map((o) => `
      <li class="flex items-baseline gap-2 py-1 border-b last:border-b-0">
        <span class="text-xs font-bold text-slate-700 whitespace-nowrap">${escapeHtml(o.lostGpsTime || fmtClock(o.lostAt))} 〜 ${escapeHtml(o.recoveredGpsTime || fmtClock(o.recoveredAt))}</span>
        <span class="text-xs text-slate-500">${o.durationMinutes} 分</span>
      </li>`).join('');
    return `
      <div class="rounded-lg border bg-white p-3">
        <div class="text-xs font-black text-slate-500 mb-1">走行中の一時的な途絶（復旧済み）</div>
        <ul>${items}</ul>
      </div>`;
  }

  function render(data) {
    document.getElementById('gps-outage-title').textContent =
      `GPS途絶の検証 ・ ${data.routeName || ''} ${data.startTime || ''}発`;

    drawOverlay(data);

    const carLabel = data.carName ? `${data.carName}（${data.carId}）` : data.carId;
    const panel = document.getElementById('gps-outage-panel');
    panel.innerHTML = `
      <div class="p-4 space-y-3">
        <div>
          <p class="font-bold text-slate-800">${escapeHtml(data.routeName || '')}</p>
          <p class="text-xs text-slate-500 mt-0.5">
            ${escapeHtml(data.headsign || '')}行き ・ 車両 ${escapeHtml(carLabel || '—')} ・ ${escapeHtml(data.startTime || '')}発<br>
            ${data.assignmentState === 'active'
              ? '割り当ては継続中（まだ打ち切られていません）'
              : `打ち切り ${fmtClock(data.endedAt)}（理由: ${escapeHtml(data.endReason || '—')}）`}
          </p>
        </div>
        ${data.historyRetentionExpired
          ? `<div class="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
               走行経路（GPSログ）の保持期間（約${data.retentionHours}時間）を過ぎているため、地図上の軌跡・途絶地点は表示できません。
               時刻表上の進捗のみ表示しています。
             </div>`
          : ''}
        ${outageSummaryHtml(data)}
        ${progressHtml(data)}
        ${otherOutagesHtml(data)}
        ${timetableHtml(data)}
        <p class="text-[11px] text-slate-400">
          軌跡は担当開始以降のこの車両のGPSログ（約${data.retentionHours}時間保持）。途絶の判定間隔は ${data.thresholdMinutes} 分。
        </p>
      </div>`;
  }

  async function open(assignmentId) {
    const modal = document.getElementById('gps-outage-modal');
    modal.classList.remove('hidden');
    ensureMap();
    setTimeout(() => { if (map) map.invalidateSize(); }, 0);

    document.getElementById('gps-outage-title').textContent = 'GPS途絶の検証';
    const panel = document.getElementById('gps-outage-panel');
    panel.innerHTML = '<div class="p-4 text-sm text-slate-400">読み込み中…</div>';

    try {
      const data = await api(`/api/admin/gps-outage/${assignmentId}`);
      render(data);
    } catch (err) {
      clearLayers();
      panel.innerHTML = `<div class="p-4 text-sm font-bold text-red-600">${escapeHtml(err.message || '取得に失敗しました')}</div>`;
    }
  }

  document.getElementById('gps-outage-modal').addEventListener('click', (e) => {
    if (e.target.id === 'gps-outage-modal' || e.target.closest('[data-role="close-gps-outage"]')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('gps-outage-modal').classList.contains('hidden')) close();
  });

  window.AdminGpsOutage = { open };
})();
