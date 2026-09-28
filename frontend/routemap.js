/* ==========================================================
 * 路線図マップ機能
 *
 * 画面とURL:
 *   /routemap                 GTFSのshapes.txt由来の線形を路線カラーで地図に描く。
 *   /routemap?route=<qualified route id>
 *                             1路線だけに絞り込んだ状態（「路線で絞り込み」セレクトの選択）。
 *                             共有・リロードで復元できるようURLに載せる。
 *
 * 描くのは `GET /api/route-shapes` が返す路線だけ＝**shapes.txtに線形がある路線だけ**である。
 * 線形を持たない路線は地図に描く線が存在しないので、絞り込みの選択肢にも出さない。
 *
 * 路線をタップすると、その地点にポップアップで路線名を出し、そこから
 * その路線のリアルタイム時刻表（#/realtime/{feedId}/{routeId}）へ遷移できる。
 * タップで即遷移させないのは、市街地では複数路線の線が重なっており、
 * 「どの路線を選んだのか」を確認してから遷移できる必要があるため。
 *
 * バスマップ（#/busmap）はハッシュルーティングだが、この画面は stopmap.js と同様に
 * History API（パス）でルーティングする。サーバー側は server.js の SPA_PATH_EXACT に
 * '/routemap' を登録済みなので、直リンク・リロードでもこの画面から復帰できる。
 * ========================================================== */
(function () {
  const API_BASE = '/api';
  // 線形の太さ。実線の下に透明な太い線を重ねて、細い線でもタップしやすくする。
  const LINE_WEIGHT = 4;
  const TAP_TARGET_WEIGHT = 16;
  const TAP_TARGET_PANE = 'routemapTapTargets';
  // 路線カラーが未設定（GTFSのroute_colorが空）の路線に使う色。
  const FALLBACK_ROUTE_COLOR = '#2563eb';

  let mapInstance = null;
  // 路線ごとの描画レイヤ。[{ route, layer }]。絞り込みは addLayer/removeLayer だけで行い、
  // 地図もレイヤも作り直さない（作り直すと表示位置が戻ってしまう）。
  let routeLayers = [];
  let userMarker = null;
  // 取得済みの路線図データ。GTFSの静的データで画面を開くたびに変わるものではないため、
  // 1度取得したらこのページ滞在中は使い回す（100KB前後あるため毎回は取り直さない）。
  let cachedRoutes = null;
  // 'all'＝すべての路線、それ以外は qualified route id（feedId:routeId）。
  let routeFilter = 'all';

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

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isRouteMapPath() {
    return window.location.pathname === '/routemap';
  }

  /** 路線カラー（GTFSのroutes.txt由来。"FF9900"のような#無し表記）を安全な#RRGGBBへ。 */
  function normalizeRouteColor(color) {
    const raw = String(color || '').replace(/^#/, '').trim();
    return /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw}` : FALLBACK_ROUTE_COLOR;
  }

  /** 表示名は必ずGTFSのroute名/略称から取る（内部IDは利用者に見せない）。 */
  function routeDisplayName(route) {
    return route.name || route.short_name || '路線';
  }

  /** 現在の絞り込みを載せた /routemap のURL。'all' は素の /routemap。 */
  function routeMapUrl(filter) {
    if (!filter || filter === 'all') return '/routemap';
    return `/routemap?route=${encodeURIComponent(filter)}`;
  }

  /**
   * その路線のリアルタイム時刻表（#/realtime/{feedId}/{routeId}）へSPA遷移する。
   * パスルーティングの画面からハッシュルーティングの画面へ移るため、pathname も '/' に戻す
   * （spotsearch.js の goToRealtimeTimetable と同じ理由・同じ組み立て）。
   */
  function goToRealtimeTimetable(qualifiedRouteId) {
    const [feedId, originalRouteId] = String(qualifiedRouteId).split(':');
    const url = originalRouteId
      ? `/#/realtime/${encodeURIComponent(feedId)}/${encodeURIComponent(originalRouteId)}`
      : `/#/realtime/default/${encodeURIComponent(qualifiedRouteId)}`;
    window.history.pushState({}, '', url);
    if (typeof window.renderCurrentRoute === 'function') window.renderCurrentRoute();
    else window.location.assign(url);
    window.scrollTo(0, 0);
  }

  function setStatus(text) {
    const el = document.getElementById('routemap-status');
    if (el) el.textContent = text;
  }

  function initializeMap() {
    const el = document.getElementById('routemap');
    if (!el) return false;

    // 地図を作り直すときはレイヤの参照も必ず捨てること（バスマップ・バス停マップと同じ注意点。
    // 残したままだと破棄済みの地図に紐づく古いレイヤを参照してしまい、
    // 2回目以降にこの画面を開いたとき路線が1本も描画されなくなる）。
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
    routeLayers = [];
    userMarker = null;

    mapInstance = window.L.map('routemap').setView([36.2381, 137.9701], 12);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(mapInstance);

    // タップ用の透明な太線だけを置く専用ペイン。既定のoverlayPane（z-index 400）より
    // 下に敷くことで、市街地で線が重なっていても「見えている線」のタップが必ず優先され、
    // 隣の路線の当たり判定に吸われない。
    mapInstance.createPane(TAP_TARGET_PANE);
    mapInstance.getPane(TAP_TARGET_PANE).style.zIndex = '390';

    // display:none から表示に切り替えた直後はコンテナのサイズが未確定なことがあり、
    // タイルも線も描画されないことがある。レイアウト確定後にサイズを再計算させる。
    setTimeout(() => {
      if (mapInstance) mapInstance.invalidateSize();
    }, 0);
    return true;
  }

  /** 路線名と「リアルタイム時刻表をひらく」ボタンを持つポップアップの中身を組み立てる。 */
  function buildPopupContent(route) {
    const wrap = document.createElement('div');
    wrap.className = 'min-w-[11rem]';
    wrap.innerHTML = `
      <p class="font-bold text-blue-900 text-sm leading-snug mb-2">${escapeHtml(routeDisplayName(route))}</p>
      <button type="button" data-role="routemap-goto"
        class="w-full bg-blue-700 text-white text-xs font-bold px-3 py-2 rounded-lg active:scale-[0.98] transition-transform">
        リアルタイム時刻表をひらく
      </button>
    `;
    wrap.querySelector('[data-role="routemap-goto"]').addEventListener('click', () => {
      goToRealtimeTimetable(route.id);
    });
    return wrap;
  }

  /**
   * 1路線ぶんの線形（複数本ありうる。往路・復路・枝分かれ）をレイヤグループにまとめる。
   * 実線の下に透明な太い線を敷いて、細い線でも指でタップできるようにする。
   */
  function buildRouteLayer(route) {
    const color = normalizeRouteColor(route.color);
    const group = window.L.layerGroup();

    (route.shapes || []).forEach((shape) => {
      const points = (shape.points || []).filter(
        (p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))
      );
      if (points.length < 2) return;

      const tapTarget = window.L.polyline(points, {
        color,
        weight: TAP_TARGET_WEIGHT,
        opacity: 0,
        pane: TAP_TARGET_PANE
      });
      const line = window.L.polyline(points, {
        color,
        weight: LINE_WEIGHT,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round'
      });

      [tapTarget, line].forEach((layer) => {
        layer.bindPopup(() => buildPopupContent(route));
        group.addLayer(layer);
      });
    });

    return group;
  }

  /** いま表示対象になっている路線すべてを囲む範囲（有効な範囲が無ければ isValid() が false）。 */
  function visibleBounds() {
    const bounds = window.L.latLngBounds([]);
    routeLayers.forEach(({ route, layer }) => {
      if (routeFilter !== 'all' && route.id !== routeFilter) return;
      layer.eachLayer((child) => {
        const childBounds = child.getBounds();
        if (childBounds.isValid()) bounds.extend(childBounds);
      });
    });
    return bounds;
  }

  /**
   * 現在の絞り込みに合わせて、地図に載せるレイヤを付け外しする。
   * @param {boolean} fit 表示範囲を対象に合わせ直すか
   */
  function applyRouteFilter({ fit = true } = {}) {
    if (!mapInstance) return;

    let visibleCount = 0;
    routeLayers.forEach(({ route, layer }) => {
      const visible = routeFilter === 'all' || route.id === routeFilter;
      if (visible) {
        visibleCount += 1;
        if (!mapInstance.hasLayer(layer)) layer.addTo(mapInstance);
      } else if (mapInstance.hasLayer(layer)) {
        mapInstance.removeLayer(layer);
      }
    });

    if (fit) {
      const bounds = visibleBounds();
      if (bounds.isValid()) mapInstance.fitBounds(bounds.pad(0.05), { maxZoom: 16 });
    }

    if (routeFilter === 'all') {
      setStatus(visibleCount > 0
        ? `路線図 ${visibleCount}路線を表示中（路線をタップすると時刻表へ移動できます）`
        : '路線図を表示できる路線がありません。');
    } else {
      const selected = routeLayers.find(({ route }) => route.id === routeFilter);
      setStatus(selected
        ? `${routeDisplayName(selected.route)}：路線をタップすると時刻表へ移動できます`
        : '選択した路線の路線図が見つかりませんでした。');
    }
  }

  /** 絞り込みセレクトに選択肢を流し込み、現在値へ同期する。 */
  function syncRouteSelector() {
    const selector = document.getElementById('routemap-route-select');
    if (!selector) return;

    selector.innerHTML = '<option value="all">すべての路線</option>';
    routeLayers.forEach(({ route }) => {
      const option = document.createElement('option');
      option.value = route.id;
      option.textContent = routeDisplayName(route);
      selector.appendChild(option);
    });
    selector.value = routeFilter;
  }

  /** URLのクエリ（?route=）から絞り込みを復元する。線形を持たない路線IDは無視する。 */
  function restoreFilterFromUrl(routes) {
    const requested = new URLSearchParams(window.location.search).get('route');
    routeFilter = (requested && routes.some((route) => route.id === requested)) ? requested : 'all';
    // 描けない路線IDがURLに載っていたら素の /routemap へ整える（履歴は積まない）。
    if (requested && routeFilter === 'all') {
      window.history.replaceState({}, '', routeMapUrl('all'));
    }
  }

  async function loadRouteShapes() {
    setStatus('路線図を読み込み中...');
    if (!cachedRoutes) {
      const data = await fetchJson(`${API_BASE}/route-shapes`);
      cachedRoutes = data.routes || [];
    }

    restoreFilterFromUrl(cachedRoutes);
    routeLayers = cachedRoutes.map((route) => ({ route, layer: buildRouteLayer(route) }));
    syncRouteSelector();
    applyRouteFilter({ fit: true });
  }

  /**
   * 現在地を重ねる。バスマップ（app.jsのaddUserLocation）と同じ理由で、
   * 位置情報の許可ダイアログをawaitで待ってから路線図を描くと、その間ずっと
   * 何も出ないため、路線図の描画とは独立して（awaitせず）動かす。
   *
   * バス停マップと違って表示位置は動かさない。この画面は路線網の全体を俯瞰するのが
   * 目的なので、現在地へズームすると肝心の路線図が画面外へ出てしまう。
   */
  async function overlayUserLocation() {
    if (typeof window.getUserLocation !== 'function') return;
    const location = await window.getUserLocation();
    if (!location || !mapInstance) return;
    if (userMarker) {
      userMarker.setLatLng([location.lat, location.lng]);
      return;
    }
    userMarker = window.L.circleMarker([location.lat, location.lng], {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: '#2563eb',
      fillOpacity: 1
    }).addTo(mapInstance);
    userMarker.bindPopup('現在地');
  }

  async function render() {
    const section = document.getElementById('section-routemap');
    if (!section) return;
    section.style.display = 'block';
    if (typeof window.setPageTitle === 'function') window.setPageTitle('路線図マップ', 'Route Map');
    if (!initializeMap()) return;

    try {
      await loadRouteShapes();
    } catch (err) {
      console.error('路線図の取得エラー:', err);
      setStatus('路線図の取得に失敗しました。');
    }
    overlayUserLocation();
  }

  // 絞り込みセレクト。地図インスタンス・レイヤは作り直さず、URLだけ replaceState で同期する
  // （pushState/遷移にすると renderCurrentRoute 経由で地図が再生成され、表示位置が戻るため）。
  document.addEventListener('change', (event) => {
    const selector = event.target.closest('#routemap-route-select');
    if (!selector) return;
    routeFilter = selector.value || 'all';
    window.history.replaceState({}, '', routeMapUrl(routeFilter));
    applyRouteFilter({ fit: true });
  });

  window.RouteMapView = { render, isRouteMapPath };
})();
