/* ==========================================================
 * バス停マップ機能
 *
 * 画面とURL:
 *   /stopmap  バス停を地図上に表示する。同名で標柱番号が異なるバス停は
 *             代表点（グループの中心座標）1件のみ表示する。統合ロジックは
 *             backend/src/services/gtfsTimetable.js の buildGroups が担っており、
 *             このファイルは /api/timetable/stops/map が返す結果をそのまま描画するだけ。
 *             バス停をタップすると /timetable/stops/{stop_id} へ遷移する。
 *
 * 既存の「バスマップ」（#/busmap）はハッシュルーティングだが、この画面は
 * timetable.js と同様に History API（パス）でルーティングする。
 * サーバー側は /api 以外をすべて index.html へフォールバックさせているので、
 * 直リンク・リロードでもこの画面から復帰できる。
 * ========================================================== */
(function () {
  const API_BASE = '/api';

  let mapInstance = null;
  let stopMarkers = [];

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
    return `/timetable/stops/${encodeURIComponent(stopKey)}`;
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

    mapInstance = window.L.map('stopmap').setView([36.2381, 137.9701], 13);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(mapInstance);

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
      marker.bindTooltip(stop.stopName || '', { direction: 'top', offset: [0, -4] });
      marker.on('click', () => navigate(stopUrl(stop.stopKey)));
      stopMarkers.push(marker);
    });

    if (latLngs.length > 0) {
      mapInstance.fitBounds(window.L.latLngBounds(latLngs).pad(0.1), { maxZoom: 16 });
    }
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

  async function render() {
    const section = document.getElementById('section-stopmap');
    if (!section) return;
    section.style.display = 'block';
    if (typeof window.setPageTitle === 'function') window.setPageTitle('バス停マップ', 'Stop Map');
    if (!initializeMap()) return;
    await loadStops();
  }

  window.StopMapView = { render, isStopMapPath };
})();
