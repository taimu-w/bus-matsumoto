/* ==========================================================
 * バス停マップ機能
 *
 * 画面とURL:
 *   /stopmap  バス停を地図上に表示する。同名で標柱番号が異なるバス停は
 *             代表点（グループの中心座標）1件のみ表示する。統合ロジックは
 *             backend/src/services/gtfsTimetable.js の buildGroups が担っており、
 *             このファイルは /api/timetable/stops/map が返す結果をそのまま描画するだけ。
 *             バス停をタップすると /busstop/{stop_id}（バス停情報の総合ポータル）へ遷移する
 *             （補完仕様書 3.6.3）。
 *
 * 既存の「バスマップ」（#/busmap）はハッシュルーティングだが、この画面は
 * timetable.js と同様に History API（パス）でルーティングする。
 * サーバー側は /api 以外をすべて index.html へフォールバックさせているので、
 * 直リンク・リロードでもこの画面から復帰できる。
 * ========================================================== */
(function () {
  const API_BASE = '/api';
  // このズームレベル以上に拡大したら、常時バス停名を表示する（要望対応）。
  const STOP_NAME_ZOOM_THRESHOLD = 14;

  let mapInstance = null;
  let stopMarkers = [];
  let userMarker = null;
  // 現在地が取得できてズームを合わせた後は、バス停側の fitBounds で
  // 表示範囲を市内全域に戻さないようにするためのフラグ。
  let userLocated = false;

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  function isStopMapPath() {
    return window.location.pathname === '/stopmap';
  }

  // timetable.js の navigate() と同じ流儀（History APIでのSPA遷移）。
  function navigate(url) {
    window.history.pushState({}, '', url);
    if (typeof window.renderCurrentRoute === 'function') window.renderCurrentRoute();
    window.scrollTo(0, 0);
  }

  function stopUrl(stopKey) {
    return `/busstop/${encodeURIComponent(stopKey)}`;
  }

  function setStatus(text) {
    const el = document.getElementById('stopmap-status');
    if (el) el.textContent = text;
  }

  function initializeMap() {
    const el = document.getElementById('stopmap');
    if (!el) return false;

    // 地図を作り直すときはマーカーの参照も必ず捨てること（バスマップと同じ注意点。
    // 残したままだと破棄済みの地図に紐づく古いマーカーを参照してしまう）。
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
    stopMarkers = [];
    userMarker = null;
    userLocated = false;

    mapInstance = window.L.map('stopmap').setView([36.2381, 137.9701], 13);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(mapInstance);
    mapInstance.on('zoomend', updateStopLabelVisibility);

    // display:none から表示に切り替えた直後はコンテナのサイズが未確定なことがあり、
    // タイルもマーカーも描画されないことがある。レイアウト確定後にサイズを再計算させる。
    setTimeout(() => {
      if (mapInstance) mapInstance.invalidateSize();
    }, 0);
    return true;
  }

  function addStopMarkers(stops) {
    if (!mapInstance) return;
    const latLngs = [];

    stops.forEach((stop) => {
      const lat = Number(stop.lat);
      const lon = Number(stop.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      latLngs.push([lat, lon]);

      const marker = window.L.circleMarker([lat, lon], {
        radius: 6,
        weight: 2,
        color: '#0f766e',
        fillColor: '#14b8a6',
        fillOpacity: 0.9
      }).addTo(mapInstance);
      marker.bindTooltip(stop.stopName || '', {
        direction: 'top',
        offset: [0, -4],
        permanent: mapInstance.getZoom() >= STOP_NAME_ZOOM_THRESHOLD
      });
      marker.on('click', () => navigate(stopUrl(stop.stopKey)));
      stopMarkers.push(marker);
    });

    // 現在地に合わせてズームを済ませている場合は、バス停全件のfitBoundsで
    // 市内全域まで表示範囲を引き戻さない（現在地周辺を拡大表示したまま保つ）。
    if (latLngs.length > 0 && !userLocated) {
      mapInstance.fitBounds(window.L.latLngBounds(latLngs).pad(0.1), { maxZoom: 16 });
    }
    updateStopLabelVisibility();
  }

  /**
   * ある程度拡大された（STOP_NAME_ZOOM_THRESHOLD以上）ときだけ、バス停名を常時表示する。
   * tooltipのpermanentオプションは動的に変更できないため、必要なときだけ付け替える
   * （permanent:falseのままopenTooltip()するだけだと、ホバー解除時にLeaflet内部の
   * mouseoutハンドラでcloseTooltip()されてしまい、常時表示を維持できない）。
   */
  function updateStopLabelVisibility() {
    if (!mapInstance) return;
    const showLabels = mapInstance.getZoom() >= STOP_NAME_ZOOM_THRESHOLD;
    stopMarkers.forEach((marker) => {
      const tooltip = marker.getTooltip();
      if (!tooltip || tooltip.options.permanent === showLabels) return;
      const content = tooltip.getContent();
      marker.unbindTooltip();
      marker.bindTooltip(content, { direction: 'top', offset: [0, -4], permanent: showLabels });
    });
  }

  async function loadStops() {
    setStatus('バス停を読み込み中...');
    try {
      const data = await fetchJson(`${API_BASE}/timetable/stops/map`);
      const stops = data.stops || [];
      addStopMarkers(stops);
      setStatus(stops.length > 0 ? `バス停 ${stops.length}件を表示中` : 'バス停が見つかりませんでした。');
    } catch (err) {
      console.error('バス停マップの取得エラー:', err);
      setStatus('バス停情報の取得に失敗しました。');
    }
  }

  /**
   * 現在地に地図を合わせる。バスマップ（app.jsのaddUserLocation）と同じ理由で、
   * 位置情報の許可ダイアログをawaitで待ってからバス停を取得すると、その間ずっと
   * バス停が1件も出ないため、バス停の取得とは独立して（awaitせず）動かす。
   */
  async function centerOnUserLocation() {
    if (typeof window.getUserLocation !== 'function') return;
    const location = await window.getUserLocation();
    if (!location || !mapInstance) return;
    userLocated = true;
    mapInstance.setView([location.lat, location.lng], 16);
    if (userMarker) {
      userMarker.setLatLng([location.lat, location.lng]);
    } else {
      userMarker = window.L.circleMarker([location.lat, location.lng], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#2563eb',
        fillOpacity: 1
      }).addTo(mapInstance);
      userMarker.bindPopup('現在地');
    }
  }

  async function render() {
    const section = document.getElementById('section-stopmap');
    if (!section) return;
    section.style.display = 'block';
    if (typeof window.setPageTitle === 'function') window.setPageTitle('バス停マップ', 'Stop Map');
    if (!initializeMap()) return;
    await loadStops();
    centerOnUserLocation();
  }

  window.StopMapView = { render, isStopMapPath };
})();
