const API_BASE = '/api';
const POLL_MS = 20000;
// 自動更新をまたいで保持する状態（開いているアコーディオン・スクロール位置）
const openTripKeys = new Set();

// 取得した最新データを保持しておく（お気に入り計算・再描画用）
let currentBuses = [];
let currentTimetable = [];
let selectedRouteId = '11';
let routeOptions = [];

function $(id) { return document.getElementById(id); }

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

/**
 * バス（/api/buses・/api/buses-for-map の1件）から便詳細ページのURLを組み立てる。
 * 便詳細ページ側と突き合わせ可能なGTFS識別子（feedId/gtfsRouteId/gtfsTripId/departureUrlTime）が
 * 揃っていない場合はnullを返す（＝時刻表側と紐付かない便なのでリンクを作らない）。
 */
function buildTripDetailUrl(bus, { view } = {}) {
  if (!bus.feedId || !bus.gtfsRouteId || !bus.gtfsTripId || !bus.departureUrlTime) return null;
  const query = view ? `?view=${encodeURIComponent(view)}` : '';
  return `/timetable/trips/${encodeURIComponent(bus.feedId)}/${encodeURIComponent(bus.gtfsRouteId)}/${encodeURIComponent(bus.gtfsTripId)}/${encodeURIComponent(bus.departureUrlTime)}${query}`;
}

/** timetable.js のSPAルーティングへパスで遷移する（history APIをpushしてrenderCurrentRouteを呼ぶ）。 */
function navigateToPath(url) {
  window.history.pushState({}, '', url);
  if (typeof window.renderCurrentRoute === 'function') window.renderCurrentRoute();
}

/**
 * 遅延分数の表示文字列を返す。0〜1分は誤差として「定刻通り」と表示する。
 * データが存在しない場合（null/undefined）は空文字を返す。
 */
function formatDelayLabel(minutes) {
  if (minutes === null || minutes === undefined) return '';
  return minutes <= 1 ? '定刻通り' : `${minutes}分遅れ`;
}

/* ---------- モーダル（style.displayのみで制御。hidden属性は使わない） ---------- */
function openModal(id) {
  $(id).style.display = 'flex';
}

function closeModal(id) {
  $(id).style.display = 'none';
}

document.addEventListener('click', (e) => {
  const closeTarget = e.target.closest('[data-close]');
  if (closeTarget) closeModal(closeTarget.dataset.close);
});

// バスマップのポップアップ内「便の詳細を見る」ボタン（Leafletが動的に挿入するDOM向けの委任リスナー）
document.addEventListener('click', (e) => {
  const detailBtn = e.target.closest('[data-role="tt-bus-detail-btn"]');
  if (detailBtn && detailBtn.dataset.url) navigateToPath(detailBtn.dataset.url);
});

function openStopModal(stop) {
  $('stop-name').textContent = stop.name;
  const noticeEl = $('stop-notice');
  if (stop.notice) {
    noticeEl.textContent = stop.notice;
    noticeEl.style.display = 'block';
  } else {
    noticeEl.style.display = 'none';
  }
  $('stop-map-btn').href = `https://www.google.com/maps?q=${stop.lat},${stop.lng}`;
  openModal('stop-modal');
}

/* ---------- 汎用アコーディオン開閉ヘルパー ---------- */
function setupAccordionToggle(card, openSet, key, getScrollTarget) {
  const acc = card.querySelector('[data-role="accordion"]');
  const arrow = card.querySelector('[data-role="arrow"]');
  const toggleEl = card.querySelector('[data-role="toggle"]');

  const applyOpenState = (open) => {
    acc.classList.toggle('open', open);
    if (arrow) arrow.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
  };

  if (openSet.has(key)) applyOpenState(true);

  toggleEl.addEventListener('click', () => {
    const willOpen = !acc.classList.contains('open');
    applyOpenState(willOpen);
    if (willOpen) {
      openSet.add(key);
      const target = getScrollTarget ? getScrollTarget() : null;
      if (target) {
        setTimeout(() => {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 420);
      }
    } else {
      openSet.delete(key);
    }
  });
}

/* ---------- お気に入り機能（localStorage連携） ---------- */
function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem('favStops')) || [];
  } catch(e) {
    return [];
  }
}

function toggleFavorite(stopName) {
  let favs = getFavorites();
  if (favs.includes(stopName)) {
    favs = favs.filter(s => s !== stopName);
  } else {
    favs.push(stopName);
  }
  localStorage.setItem('favStops', JSON.stringify(favs));
}

function setupFavoritesContainer() {
  if (!$('favorites-container')) {
    const container = document.createElement('div');
    container.id = 'favorites-container';
    container.className = 'mb-6';
    const target = $('realtime-buses');
    if (target && target.parentNode) {
      target.parentNode.insertBefore(container, target);
    }
  }
}

function renderFavorites() {
  setupFavoritesContainer();
  const container = $('favorites-container');
  container.innerHTML = '';
  const favs = getFavorites();

  if (favs.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';

  const title = document.createElement('h2');
  title.className = 'text-lg font-bold text-gray-800 mb-3 flex items-center gap-2 px-1';
  title.innerHTML = '<span>⭐</span> よく使うバス停';
  container.appendChild(title);

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  favs.forEach(stopName => {
    // 1. リアルタイム情報（接近中のバス）を探す
    const approachingBuses = [];
    currentBuses.forEach(bus => {
      const targetStop = (bus.stops || []).find(s => s.name === stopName);
      // これから来る（通過ではなく、到着済でもない）場合
      if (targetStop && targetStop.status !== '到着済' && targetStop.status !== '通過' && !targetStop.isPassStop) {
        approachingBuses.push({
          timeStr: targetStop.predictedTime || targetStop.scheduledTime,
          isRealtime: bus.isRealtime,
          delay: targetStop.predictedDelayMinutes || targetStop.delayMinutes || 0,
          rawStop: targetStop
        });
      }
    });

    // 2. 時刻表から今後の便を探す
    const scheduledTrips = [];
    currentTimetable.forEach(trip => {
      const targetStop = (trip.stops || []).find(s => s.stopName === stopName && s.scheduledTime && s.scheduledTime.includes(':'));
      if (targetStop) {
        const [h, m] = targetStop.scheduledTime.split(':').map(Number);
        const tripMinutes = h * 60 + m;
        // 現在時刻以降の便を抽出
        if (tripMinutes >= nowMinutes) {
          scheduledTrips.push({
            timeStr: targetStop.scheduledTime,
            delay: 0,
            rawStop: targetStop
          });
        }
      }
    });

    // 3. 両方をマージして直近の2件を抽出する
    const displayList = [];
    
    approachingBuses.forEach(rt => {
      displayList.push({
        type: 'realtime',
        timeStr: rt.timeStr,
        delay: rt.delay,
        label: rt.isRealtime ? '接近中' : '運行中',
        rawStop: rt.rawStop
      });
    });

    scheduledTrips.forEach(st => {
      // リアルタイム情報の中に同じ定刻の便がすでにあれば重複させない
      const isDuplicate = displayList.some(d => d.type === 'realtime' && d.rawStop.scheduledTime === st.timeStr);
      if (!isDuplicate) {
        displayList.push({
          type: 'scheduled',
          timeStr: st.timeStr,
          delay: 0,
          label: '予定'
        });
      }
    });

    // 時間順にソート（時刻文字列を分に変換）
    displayList.sort((a, b) => {
       const aTime = (a.timeStr || '').includes(':') ? a.timeStr : '99:99';
       const bTime = (b.timeStr || '').includes(':') ? b.timeStr : '99:99';
       const [ah, am] = aTime.split(':').map(Number);
       const [bh, bm] = bTime.split(':').map(Number);
       return (ah * 60 + am) - (bh * 60 + bm);
    });

    const next2 = displayList.slice(0, 2); // 先発と次発を取得

    // 4. カードのDOM構築
    const card = document.createElement('div');
    card.className = 'bg-white rounded-xl shadow-sm border-2 border-yellow-300 overflow-hidden mb-4';
    
    let infoHtml = '';
    if (next2.length === 0) {
      infoHtml = '<p class="text-sm text-gray-500 py-2 text-center">本日の運行は終了しました</p>';
    } else {
      next2.forEach((info, idx) => {
        const titleText = idx === 0 ? '先発' : '次発';
        const delayHtml = info.delay > 1 ? `<span class="text-red-500 text-xs font-bold ml-1">(${info.delay}分遅れ)</span>` : '';
        const badgeClass = info.type === 'realtime' 
          ? (info.label === '接近中' ? 'bg-green-100 text-green-800 border-green-200 animate-pulse' : 'bg-blue-100 text-blue-800 border-blue-200') 
          : 'bg-gray-100 text-gray-600 border-gray-200';
        
        infoHtml += `
          <div class="flex items-center justify-between py-2 ${idx === 0 && next2.length > 1 ? 'border-b border-dashed border-yellow-200' : ''}">
            <div class="flex items-baseline gap-2">
              <span class="text-xs font-bold text-gray-500 w-8">${titleText}</span>
              <span class="text-2xl font-bold tracking-tight ${info.delay > 1 ? 'text-red-600' : 'text-gray-800'}">${escapeHtml(info.timeStr)}</span>
              ${delayHtml}
            </div>
            <span class="text-[10px] font-bold px-2.5 py-1 rounded border ${badgeClass}">${info.label}</span>
          </div>
        `;
      });
    }

    card.innerHTML = `
      <div class="flex justify-between items-center p-3 bg-yellow-50 border-b border-yellow-200">
        <h3 class="font-bold text-md text-gray-900">${escapeHtml(stopName)}</h3>
        <button data-fav-remove="${escapeHtml(stopName)}" class="text-yellow-500 hover:text-gray-400 text-2xl focus:outline-none transition-colors leading-none" title="お気に入り解除">★</button>
      </div>
      <div class="px-4 py-2">
        ${infoHtml}
      </div>
    `;

    const removeBtn = card.querySelector('[data-fav-remove]');
    removeBtn.addEventListener('click', () => {
      toggleFavorite(stopName);
      renderFavorites();
      renderBuses(currentBuses); // リスト内の☆表示を同期させるため
    });

    container.appendChild(card);
  });
}

/* ---------- データ取得（画面の見た目・スクロール位置を維持したまま更新する） ---------- */
async function loadAll() {
  const icon = $('refresh-icon');
  icon.classList.add('animate-spin');

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  try {
    const routeData = await fetchJson(`${API_BASE}/routes`);
    routeOptions = routeData.routes || [];
    syncRouteSelector();

    const [settings, busData, timetable] = await Promise.all([
      fetchJson(`${API_BASE}/settings?routeId=${encodeURIComponent(selectedRouteId)}`),
      fetchJson(`${API_BASE}/buses?routeId=${encodeURIComponent(selectedRouteId)}`),
      fetchJson(`${API_BASE}/timetable?routeId=${encodeURIComponent(selectedRouteId)}`)
    ]);

    // お気に入り描画用にデータをグローバル保持
    currentBuses = busData.buses || [];
    currentTimetable = timetable || [];

    const isFirstLoad = $('loading').style.display !== 'none';
    $('loading').style.display = 'none';
    $('app-content').style.display = 'block';

    $('page-title').textContent = settings.routeName || $('page-title').textContent;
    renderNotices(settings);
    renderFavorites(); // お気に入りコンテナの表示
    renderBuses(currentBuses);
    renderSchedule(currentTimetable);

    if (!isFirstLoad) {
      window.scrollTo(scrollX, scrollY);
    }
  } catch (err) {
    console.error('データ取得エラー:', err);
    $('loading-text').textContent = '読み込みに失敗しました。しばらくして再度お試しください。';
  } finally {
    setTimeout(() => icon.classList.remove('animate-spin'), 500);
  }
}

function syncRouteSelector() {
  const selector = $('route-select');
  if (!selector) return;

  const currentValue = routeOptions.some((route) => route.id === selectedRouteId)
    ? selectedRouteId
    : (routeOptions[0]?.id || selectedRouteId);

  selector.innerHTML = '';
  routeOptions.forEach((route) => {
    const option = document.createElement('option');
    option.value = route.id;
    option.textContent = route.name || route.short_name || route.id;
    selector.appendChild(option);
  });

  if (!routeOptions.length) {
    selector.innerHTML = '<option value="11">横田信大循環線</option>';
  }

  selectedRouteId = currentValue;
  selector.value = selectedRouteId;
}

/* ---------- お知らせ ---------- */
function renderNotices(settings) {
  const container = $('notices');
  container.innerHTML = '';

  if (settings.notice1) {
    const el = document.createElement('div');
    el.className = 'bg-yellow-100 p-4 rounded-xl border-2 border-yellow-400 text-lg font-bold text-yellow-900';
    el.textContent = settings.notice1;
    container.appendChild(el);
  }

  if (settings.notice2) {
    const el = document.createElement('div');
    el.className = 'bg-white p-4 rounded-xl border border-gray-300 text-md font-medium';
    el.textContent = settings.notice2;
    container.appendChild(el);
  }

  if (settings.importantNotice) {
    $('important-body').textContent = settings.importantNotice;
    openModal('important-modal');
  }
}

/* ---------- バスカード（リアルタイム） ---------- */
function findLastArrivedIndex(stops) {
  let idx = -1;
  stops.forEach((s, i) => { if (s.status === '到着済') idx = i; });
  return idx;
}

function renderBuses(buses) {
  const container = $('realtime-buses');
  const emptyNote = $('realtime-empty');
  container.innerHTML = '';

  if (buses.length === 0) {
    emptyNote.style.display = 'block';
    return;
  }

  emptyNote.style.display = 'none';
  buses.forEach((bus) => container.appendChild(createBusCard(bus)));
}

function createBusCard(bus) {
  const stops = bus.stops || [];
  const firstStop = stops[0] || null;
  const lastStop = stops[stops.length - 1] || null;
  const startTime = firstStop?.scheduledTime || '--';
  const endTime = lastStop?.scheduledTime || '--';

  // --- 判定ロジック：1つだけ孤立して空になっているバス停を「通過バス停」と判定する ---
  stops.forEach((stop, i) => {
    const isSelfEmpty = !stop.scheduledTime || stop.scheduledTime === '--' || stop.scheduledTime === '↓';

    if (isSelfEmpty) {
      const prevStop = stops[i - 1];
      const nextStop = stops[i + 1];

      const isPrevEmpty = prevStop && (!prevStop.scheduledTime || prevStop.scheduledTime === '--' || prevStop.scheduledTime === '↓');
      const isNextEmpty = nextStop && (!nextStop.scheduledTime || nextStop.scheduledTime === '--' || nextStop.scheduledTime === '↓');

      if ((!isPrevEmpty && !isNextEmpty) || stop.status === '通過') {
        stop.isPassStop = true;
      } else {
        stop.isPassStop = false;
      }
    } else {
      stop.isPassStop = false;
    }
  });
  // ----------------------------------------------------------------------------------

  const lastIdx = findLastArrivedIndex(stops);
  const currentStop = lastIdx >= 0 ? stops[lastIdx] : null;
  const hasDeparted = currentStop !== null;
  const currentPos = currentStop ? `${currentStop.name}に到着済` : '始発前';

  const delay = bus.delayMinutes || 0;
  const delayStyle = delay >= 5
    ? 'bg-red-600 text-white delay-highlight'
    : 'bg-blue-100 text-blue-800';

  const badge = bus.isRealtime
    ? `<span class="text-[10px] font-bold text-green-700 bg-green-50 px-2 py-1 rounded border border-green-200 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-1 animate-pulse"></span>リアルタイム運行中</span>`
    : `<span class="text-[10px] font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded border border-gray-200">検知中…</span>`;

  // 臨時便判定は廃止した（GTFS便を先に生成し、車両を後から割り当てる方式に変更したため）。
  // 代わりに、その便の始発時刻を補助的に表示する。
  const extraBadge = bus.startTime
    ? `<span class="ml-1 text-[10px] font-bold text-blue-700 bg-blue-50 px-2 py-1 rounded border border-blue-200">${escapeHtml(bus.startTime)}発</span>`
    : '';

  const card = document.createElement('div');
  card.className = 'bg-white rounded-2xl shadow-sm border-2 border-blue-200 overflow-hidden mb-4 transition-all';

  // タップで便詳細ページ（リアルタイム表示）へSPA遷移する。時刻表側と紐付かない便
  // （GTFS識別子が引けない）は従来通りタップ不可のままにする。
  const detailUrl = hasDeparted ? buildTripDetailUrl(bus, { view: 'realtime' }) : null;
  const toggleCursorClass = detailUrl ? 'cursor-pointer active:opacity-50' : 'cursor-default';
  const arrowHtml = detailUrl
    ? `<svg class="w-6 h-6 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M9 5l7 7-7 7"></path></svg>`
    : '';

  card.innerHTML = `
    <div class="p-5 ${toggleCursorClass}" data-role="toggle">
      <div class="flex justify-between items-start mb-3">
        <div>${badge}${extraBadge}</div>
        <span class="text-2xl font-bold ${delayStyle} px-4 py-1.5 rounded-full shadow-sm">${formatDelayLabel(delay)}</span>
      </div>
      <div class="flex items-center justify-between">
        <div class="flex items-center">
          <div class="w-12 h-12 bg-blue-800 rounded-xl flex items-center justify-center text-white mr-3 shadow">
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M18,11H6V6h12M16.5,17A1.5,1.5 0 0,1 15,15.5A1.5,1.5 0 0,1 16.5,14A1.5,1.5 0 0,1 18,15.5A1.5,1.5 0 0,1 16.5,17M7.5,17A1.5,1.5 0 0,1 6,15.5A1.5,1.5 0 0,1 7.5,14A1.5,1.5 0 0,1 9,15.5A1.5,1.5 0 0,1 7.5,17M4,16c0,0.88 0.39,1.67 1,2.22V20a1,1 0 0,0 1,1h1a1,1 0 0,0 1-1v-1h8v1a1,1 0 0,0 1,1h1a1,1 0 0,0 1-1v-1.78c0.61-0.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8,0.5-8,4V16Z"></path></svg>
          </div>
          <div>
            <p class="text-[10px] text-gray-400 font-bold">現在の位置</p>
            <p class="text-xl font-bold text-gray-900">${escapeHtml(currentPos)}</p>
            <p class="text-[11px] text-gray-600 font-bold mt-1">始発 ${escapeHtml(startTime)} / 終点 ${escapeHtml(endTime)}</p>
          </div>
        </div>
        ${arrowHtml}
      </div>
    </div>
  `;

  if (detailUrl) {
    const toggleEl = card.querySelector('[data-role="toggle"]');
    toggleEl.addEventListener('click', () => navigateToPath(detailUrl));
  }

  return card;
}

/* ---------- 時刻表（参考） : アコーディオンで全バス停の時刻を閲覧できる ---------- */
function renderSchedule(timetable) {
  const container = $('schedule-list');
  container.innerHTML = '';

  if (!timetable || timetable.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-500 px-1">時刻表データがありません。</p>';
    return;
  }

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // 方向ごとにグループ化
  const tripsByDirection = new Map();
  timetable.forEach((trip) => {
    const dir = trip.directionId || 0;
    if (!tripsByDirection.has(dir)) tripsByDirection.set(dir, []);
    tripsByDirection.get(dir).push(trip);
  });

  // 各方向の便を処理
  // 行先ラベルは便ごとのGTFS headsign（trip.headsign）を優先して使う。
  // 以前は direction_id === 0/1 で「山城口方面」「松本バスターミナル方面」に決め打ちしていたが、
  // これは横田信大循環線専用の表示で、他路線では誤った行先が出てしまうバグだった。
  const allTrips = [];
  tripsByDirection.forEach((trips, directionId) => {
    const fallbackLabel = `${directionId === 0 ? '下り' : '上り'}方面`;

    const filteredTrips = trips
      .map((trip) => {
        const first = trip.stops.find((s) => s.scheduledTime);
        return { trip, firstTime: first ? first.scheduledTime : null };
      })
      .filter((t) => t.firstTime)
      .map((t) => {
        const [h, m] = t.firstTime.split(':').map(Number);
        return { ...t, minutes: h * 60 + m };
      })
      .sort((a, b) => a.minutes - b.minutes)
      .filter((t) => t.minutes >= nowMinutes - 15);
    
    filteredTrips.forEach((t) => {
      const directionLabel = t.trip.headsign ? `${t.trip.headsign}方面` : fallbackLabel;
      allTrips.push({ ...t, directionLabel });
    });
  });

  // 時間順にソート
  allTrips.sort((a, b) => a.minutes - b.minutes);

  if (allTrips.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-500 px-1">本日の残り便はありません。</p>';
    return;
  }

  allTrips.forEach((t) => container.appendChild(createScheduleCard(t.trip, t.firstTime, t.directionLabel)));
}

function createScheduleCard(trip, firstTime, directionLabel = '') {
  const card = document.createElement('div');
  card.className = 'bg-white rounded-xl border border-gray-200 overflow-hidden';
  const directionBadge = directionLabel ? `<span class="text-xs text-blue-700 bg-blue-50 px-2 py-1 rounded border border-blue-200 mr-2">${escapeHtml(directionLabel)}</span>` : '';
  card.innerHTML = `
    <div class="px-4 py-3 flex justify-between items-center cursor-pointer active:bg-gray-50" data-role="toggle">
      <span class="font-bold text-gray-800">${directionBadge}${escapeHtml(firstTime)} 発</span>
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-400 font-bold">全${trip.stops.length}停留所</span>
        <svg data-role="arrow" class="w-5 h-5 text-gray-300 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M19 9l-7 7-7-7"></path></svg>
      </div>
    </div>
    <div data-role="accordion" class="accordion-content bg-gray-50 border-t border-gray-100">
      <div class="p-3 space-y-1" data-role="stop-rows"></div>
    </div>
  `;

  const rowsContainer = card.querySelector('[data-role="stop-rows"]');
  trip.stops
    .slice()
    .sort((a, b) => a.seqOrder - b.seqOrder)
    .forEach((stop) => {
      const isThrough = !stop.scheduledTime;
      const row = document.createElement('div');
      row.className = `flex justify-between items-center px-3 py-2 rounded-lg ${isThrough ? 'opacity-50' : 'bg-white border border-gray-100'}`;
      row.innerHTML = `
        <span class="font-bold text-gray-800">${escapeHtml(stop.stopName)}</span>
        <span class="font-bold ${isThrough ? 'line-through-double text-gray-400' : 'text-blue-800'}">${isThrough ? '経由なし' : escapeHtml(stop.scheduledTime)}</span>
      `;
      rowsContainer.appendChild(row);
    });

  setupAccordionToggle(card, openTripKeys, `trip-${trip.tripIndex}`, () => null);
  return card;
}

/* ---------- ルート検索機能 ---------- */
let selectedFromStop = null;
let selectedToStop = null;

async function searchStops(query) {
  try {
    // ルート検索用は全路線から検索
    const result = await fetchJson(`${API_BASE}/stops/search?q=${encodeURIComponent(query)}`);
    return result.stops || [];
  } catch (err) {
    console.error('バス停検索エラー:', err);
    return [];
  }
}

function renderSuggestions(stops, containerId, inputId, onSelect) {
  const container = $(containerId);
  container.innerHTML = '';
  
  if (stops.length === 0) {
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'block';
  
  // バス停名で重複除去（路線表示は残す）
  const seen = new Set();
  const unique = [];
  stops.forEach(stop => {
    const key = `${stop.route_id}_${stop.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(stop);
    }
  });
  
  unique.slice(0, 8).forEach(stop => {
    const div = document.createElement('div');
    div.className = 'bg-white border-2 border-purple-200 rounded-lg p-3 cursor-pointer hover:bg-purple-50 active:scale-95 transition-all';
    div.innerHTML = `
      <div class="font-bold text-gray-900">${escapeHtml(stop.name)}</div>
    `;
    div.addEventListener('click', () => {
      $(inputId).value = stop.name;
      onSelect(stop);
      container.innerHTML = '';
      container.style.display = 'none';
    });
    container.appendChild(div);
  });
}

async function setupStopAutocomplete(inputId, suggestionsId, onSelect) {
  const input = $(inputId);
  const container = $(suggestionsId);
  let debounceTimer;
  
  input.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const query = e.target.value.trim();
    
    if (query.length < 1) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }
    
    debounceTimer = setTimeout(async () => {
      const stops = await searchStops(query);
      renderSuggestions(stops, suggestionsId, inputId, onSelect);
    }, 300);
  });
  
  input.addEventListener('blur', () => {
    setTimeout(() => {
      container.innerHTML = '';
      container.style.display = 'none';
    }, 200);
  });
}

async function performRouteSearch() {
  const fromInput = $('from-stop').value.trim();
  const toInput = $('to-stop').value.trim();
  const departureTime = $('departure-time').value;
  
  if (!fromInput || !toInput) {
    alert('出発地と目的地を入力してください。');
    return;
  }
  
  const resultContainer = $('route-result');
  const modalContent = $('route-result-content');
  
  // 検索中表示
  resultContainer.style.display = 'block';
  resultContainer.innerHTML = `
    <div class="bg-blue-50 border-2 border-blue-300 rounded-xl p-4">
      <p class="text-sm font-bold text-blue-900">検索中...</p>
    </div>
  `;
  
  try {
    // ルート検索は全路線から検索（routeIdを省略）
    const result = await fetchJson(
      `${API_BASE}/route-search?from=${encodeURIComponent(fromInput)}&to=${encodeURIComponent(toInput)}&departureTime=${encodeURIComponent(departureTime || '')}`
    );
    
    console.log('ルート検索結果:', result); // デバッグ用
    
    if (!result.found) {
      resultContainer.innerHTML = `
        <div class="bg-yellow-50 border-2 border-yellow-300 rounded-xl p-4">
          <p class="text-sm font-bold text-yellow-900">${escapeHtml(result.message || 'ルートが見つかりませんでした。バス停名を確認してください。')}</p>
        </div>
      `;
      return;
    }
    
    const route = result.route;
    console.log('ルートデータ:', route); // デバッグ用
    
    let html = '';
    
    // routeType フィールドを確認（後方互換性のため type も確認）
    const routeType = route.routeType || route.type;
    
    if (routeType === 'direct') {
      html = renderDirectRoute(route);
    } else if (routeType === 'transfer') {
      html = renderTransferRoute(route);
    } else {
      html = `<div class="bg-red-50 border-2 border-red-300 rounded-xl p-4">
        <p class="text-sm font-bold text-red-900">不明なルートタイプです: ${escapeHtml(routeType || 'undefined')}</p>
        <pre class="text-xs mt-2">${JSON.stringify(route, null, 2)}</pre>
      </div>`;
    }
    
    // インライン表示とモーダルの両方に表示
    resultContainer.innerHTML = html;
    modalContent.innerHTML = html;
    openModal('route-result-modal');
    
  } catch (err) {
    console.error('ルート検索エラー:', err);
    resultContainer.innerHTML = `
      <div class="bg-red-50 border-2 border-red-300 rounded-xl p-4">
        <p class="text-sm font-bold text-red-900">ルート検索に失敗しました: ${escapeHtml(err.message)}</p>
      </div>
    `;
    alert('ルート検索に失敗しました。詳細はコンソールを確認してください。');
  }
}

function getRouteName(routeId) {
  const route = routeOptions.find(r => r.id === routeId);
  return route ? route.name : (routeId || '');
}

function renderDirectRoute(route) {
  const candidate = route;
  const delayText = candidate.delayMinutes > 1 ? `<span class="text-red-600 font-bold ml-2">(${candidate.delayMinutes}分遅れ)</span>` : '';
  const realtimeBadge = candidate.isRealtime 
    ? '<span class="text-xs font-bold text-green-700 bg-green-50 px-2 py-1 rounded border border-green-200 ml-2 animate-pulse">● リアルタイム</span>'
    : '<span class="text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded border border-gray-200 ml-2">📋 時刻表</span>';
  
  const arrivalTime = candidate.arrivalTime || candidate.predictedArrival || candidate.scheduledArrival || '--';
  const routeName = getRouteName(route.routeId);
  
  return `
    <div class="space-y-4">
      <div class="bg-purple-50 border-2 border-purple-200 rounded-xl p-4">
        <h3 class="text-lg font-bold text-purple-900 mb-3 flex items-center gap-2">
          <span class="bg-purple-600 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">1</span>
          直接ルート（乗り換えなし）
        </h3>
        <div class="space-y-3">
          <div class="flex items-center gap-3 bg-white rounded-lg p-3 border border-purple-100">
            <div class="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center text-green-600 font-bold text-lg">A</div>
            <div>
              <p class="text-xs text-gray-500 font-bold">出発</p>
              <p class="font-bold text-gray-900 text-lg">${escapeHtml(route.fromStop)}</p>
            </div>
          </div>
          <div class="flex justify-center">
            <div class="w-1 h-8 bg-purple-300 rounded-full"></div>
          </div>
          <div class="flex items-center gap-3 bg-white rounded-lg p-3 border border-purple-100">
            <div class="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center text-red-600 font-bold text-lg">B</div>
            <div>
              <p class="text-xs text-gray-500 font-bold">到着</p>
              <p class="font-bold text-gray-900 text-lg">${escapeHtml(route.toStop)}</p>
            </div>
          </div>
        </div>
      </div>
      
      <div class="bg-white border-2 border-gray-200 rounded-xl p-4">
        <h4 class="text-md font-bold text-gray-800 mb-3">運行詳細</h4>
        <div class="space-y-3">
          <div class="flex justify-between items-center py-2 border-b border-gray-100">
            <span class="text-sm font-bold text-gray-600">路線</span>
            <span class="font-bold text-gray-900">${escapeHtml(routeName)}</span>
          </div>
          <div class="flex justify-between items-center py-2 border-b border-gray-100">
            <span class="text-sm font-bold text-gray-600">種別</span>
            <div>${realtimeBadge}</div>
          </div>
          ${candidate.type === 'realtime' ? `
            <div class="flex justify-between items-center py-2 border-b border-gray-100">
              <span class="text-sm font-bold text-gray-600">車両</span>
              <span class="font-bold text-gray-900">${escapeHtml(candidate.vehicleId)}</span>
            </div>
            <div class="flex justify-between items-center py-2 border-b border-gray-100">
              <span class="text-sm font-bold text-gray-600">出発</span>
              <span class="font-bold text-gray-900">${escapeHtml(candidate.departureTime)}</span>
            </div>
          ` : `
            <div class="flex justify-between items-center py-2 border-b border-gray-100">
              <span class="text-sm font-bold text-gray-600">便</span>
              <span class="font-bold text-gray-900">${candidate.tripIndex !== undefined ? (candidate.tripIndex + 1) + '番目' : '--'}</span>
            </div>
          `}
          <div class="flex justify-between items-center py-2">
            <span class="text-sm font-bold text-gray-600">到着予定</span>
            <span class="text-2xl font-bold text-purple-600">${escapeHtml(arrivalTime)}${delayText}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderTransferRoute(route) {
  const firstDelay = route.firstLeg.delayMinutes > 1 ? `<span class="text-red-600 font-bold ml-2">(${route.firstLeg.delayMinutes}分遅れ)</span>` : '';
  const secondDelay = route.secondLeg.delayMinutes > 1 ? `<span class="text-red-600 font-bold ml-2">(${route.secondLeg.delayMinutes}分遅れ)</span>` : '';
  
  const firstRealtimeBadge = route.firstLeg.isRealtime 
    ? '<span class="text-xs font-bold text-green-700 bg-green-50 px-2 py-1 rounded border border-green-200 animate-pulse">● リアルタイム</span>'
    : '<span class="text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded border border-gray-200">📋 時刻表</span>';
  
  const firstRouteName = getRouteName(route.firstLeg.routeId);
  const secondRouteName = getRouteName(route.secondLeg.routeId);
  
  return `
    <div class="space-y-4">
      <div class="bg-purple-50 border-2 border-purple-200 rounded-xl p-4">
        <h3 class="text-lg font-bold text-purple-900 mb-3 flex items-center gap-2">
          <span class="bg-purple-600 text-white w-7 h-7 rounded-full flex items-center justify-center text-sm">1⇄2</span>
          乗り換えルート
        </h3>
        <div class="space-y-3">
          <div class="flex items-center gap-3 bg-white rounded-lg p-3 border border-purple-100">
            <div class="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center text-green-600 font-bold text-lg">A</div>
            <div>
              <p class="text-xs text-gray-500 font-bold">出発</p>
              <p class="font-bold text-gray-900">${escapeHtml(route.fromStop)}</p>
            </div>
          </div>
          <div class="flex justify-center">
            <div class="w-1 h-8 bg-blue-300 rounded-full"></div>
          </div>
          <div class="flex items-center gap-3 bg-blue-50 rounded-lg p-3 border border-blue-200">
            <div class="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold text-lg">⇄</div>
            <div>
              <p class="text-xs text-blue-600 font-bold">乗り換え</p>
              <p class="font-bold text-gray-900">${escapeHtml(route.transferStop)}</p>
              <p class="text-xs text-gray-500">${escapeHtml(route.firstLeg.arrivalTime)} 着</p>
            </div>
          </div>
          <div class="flex justify-center">
            <div class="w-1 h-8 bg-green-300 rounded-full"></div>
          </div>
          <div class="flex items-center gap-3 bg-white rounded-lg p-3 border border-purple-100">
            <div class="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center text-red-600 font-bold text-lg">B</div>
            <div>
              <p class="text-xs text-gray-500 font-bold">到着</p>
              <p class="font-bold text-gray-900">${escapeHtml(route.toStop)}</p>
              <p class="text-xs text-gray-500">${escapeHtml(route.totalArrivalTime)} 着</p>
            </div>
          </div>
        </div>
      </div>
      
      <div class="bg-blue-50 border-2 border-blue-200 rounded-xl p-4">
        <h4 class="text-md font-bold text-blue-900 mb-3 flex items-center">
          <span class="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs mr-2">1</span>
          第一区間
        </h4>
        <div class="space-y-2 ml-8">
          <div class="flex justify-between items-center py-1">
            <span class="text-sm font-bold text-gray-600">路線</span>
            <span class="font-bold text-gray-900">${escapeHtml(firstRouteName)}</span>
          </div>
          <div class="flex justify-between items-center py-1">
            <span class="text-sm font-bold text-gray-600">種別</span>
            <div>${firstRealtimeBadge}</div>
          </div>
          ${route.firstLeg.type === 'realtime' ? `
            <div class="flex justify-between items-center py-1">
              <span class="text-sm font-bold text-gray-600">車両</span>
              <span class="font-bold text-gray-900">${escapeHtml(route.firstLeg.vehicleId)}</span>
            </div>
          ` : ''}
          <div class="flex justify-between items-center py-1">
            <span class="text-sm font-bold text-gray-600">乗り換え到着</span>
            <span class="text-lg font-bold text-blue-600">${escapeHtml(route.firstLeg.arrivalTime)}${firstDelay}</span>
          </div>
        </div>
      </div>
      
      <div class="bg-green-50 border-2 border-green-200 rounded-xl p-4">
        <h4 class="text-md font-bold text-green-900 mb-3 flex items-center">
          <span class="bg-green-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs mr-2">2</span>
          第二区間
        </h4>
        <div class="space-y-2 ml-8">
          <div class="flex justify-between items-center py-1">
            <span class="text-sm font-bold text-gray-600">路線</span>
            <span class="font-bold text-gray-900">${escapeHtml(secondRouteName)}</span>
          </div>
          <div class="flex justify-between items-center py-1">
            <span class="text-sm font-bold text-gray-600">種別</span>
            <span class="text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded border border-gray-200">📋 時刻表</span>
          </div>
          <div class="flex justify-between items-center py-1">
            <span class="text-sm font-bold text-gray-600">最終到着</span>
            <span class="text-lg font-bold text-green-600">${escapeHtml(route.totalArrivalTime)}${secondDelay}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ---------- タブ切り替え機能 ---------- */
function setPageTitle(title, subtitle) {
  $('page-title').textContent = title;
  $('page-subtitle').textContent = subtitle;
}

function hideAllPages() {
  ['section-home', 'section-route-list', 'section-realtime', 'section-routesearch', 'section-map', 'section-busmap', 'section-stopmap', 'section-timetable', 'notices'].forEach((id) => {
    const el = $(id);
    if (el) el.style.display = 'none';
  });
}

function routeHref(routeId) {
  const [feedId, originalRouteId] = String(routeId).split(':');
  return originalRouteId
    ? `#/realtime/${encodeURIComponent(feedId)}/${encodeURIComponent(originalRouteId)}`
    : `#/realtime/default/${encodeURIComponent(routeId)}`;
}

async function ensureRouteOptions() {
  if (routeOptions.length) return;
  const routeData = await fetchJson(`${API_BASE}/routes`);
  routeOptions = routeData.routes || [];
}

function renderRouteList() {
  const container = $('route-list');
  container.innerHTML = '';
  routeOptions.forEach((route) => {
    const link = document.createElement('a');
    link.href = routeHref(route.id);
    link.className = 'block bg-white rounded-xl border-2 border-blue-100 p-4 shadow-sm hover:border-blue-500 transition-colors';
    link.innerHTML = `<p class="font-bold text-lg text-blue-900">${escapeHtml(route.name || route.short_name || route.id)}</p><p class="text-xs text-gray-500 mt-1">${escapeHtml(route.short_name || route.id)}</p>`;
    container.appendChild(link);
  });
}

function parseHashRoute() {
  const parts = (window.location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
  if (parts[0] === 'search') return { page: 'search' };
  if (parts[0] === 'busmap') return { page: 'busmap' };
  if (parts[0] === 'map') return { page: 'map' };
  if (parts[0] !== 'realtime') return { page: 'home' };
  if (parts.length < 3) return { page: 'realtime-list' };
  const feedId = decodeURIComponent(parts[1]);
  const routeId = decodeURIComponent(parts.slice(2).join('/'));
  return { page: 'realtime-detail', routeId: feedId === 'default' ? routeId : `${feedId}:${routeId}` };
}

// 旧タブ操作からもハッシュURLへ遷移させる。
function switchTab(tab) {
  window.location.hash = tab === 'routesearch' ? '#/search' : '#/realtime';
}

/* ---------- マップ関連 ---------- */
let mapInstance = null;
let busMarkers = {};
let userMarker = null;
let busMapTimer = null;
let busMapFitted = false;

function initializeMap() {
  const mapEl = $('map');
  if (!mapEl) return false;

  // 地図を作り直すときはマーカーの参照も必ず捨てること。
  // 残したままだと、破棄済みの地図に紐づく古いマーカーを再利用してしまい、
  // 2回目以降にバスマップを開いたときバスが1台も描画されなくなる。
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  busMarkers = {};
  userMarker = null;
  busMapFitted = false;

  mapInstance = L.map('map').setView([36.2381, 137.9701], 12);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(mapInstance);

  // display:none から表示に切り替えた直後はコンテナのサイズが未確定なことがあり、
  // タイルもマーカーも描画されない。レイアウト確定後にサイズを再計算させる。
  setTimeout(() => {
    if (mapInstance) mapInstance.invalidateSize();
  }, 0);
  return true;
}

/** 路線色（GTFSのroutes.txt由来。"FF9900"のような#無し表記）を安全な#RRGGBBへ。 */
function normalizeRouteColor(color, fallback) {
  const raw = String(color || '').replace(/^#/, '');
  return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(raw) ? `#${raw}` : fallback;
}

function createBusIcon(bus) {
  const bg = normalizeRouteColor(bus.routeColor, '#ef4444');
  const labelBg = normalizeRouteColor(bus.routeColor, '#334155');
  const labelFg = normalizeRouteColor(bus.routeTextColor, '#ffffff');
  // 車両IDの代わりに、その地点（直近到着済み停留所）のstop_headsignを路線カラーのバッジで常時表示する
  // （stop_headsign未設定ならtrip_headsignにフォールバック。currentHeadsignはAPI側で解決済み）。
  const label = bus.currentHeadsign || bus.headsign || '';
  // マーカーはLeafletが動的に挿入するDOMなので、見た目はstyle.cssの.bus-marker側で定義する。
  return L.divIcon({
    html: `
      <div class="bus-marker-wrap">
        <div class="bus-marker-body" style="background:${bg};">🚌</div>
        ${label ? `<div class="bus-marker-label" style="background:${labelBg};color:${labelFg};">${escapeHtml(label)}</div>` : ''}
      </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
    className: 'bus-marker'
  });
}

/**
 * バスアイコンのポップアップ内容（路線名・現在の遅れ・headsign〔無ければtrip_headsign〕）。
 * 「詳細」ボタンを押すと便詳細ページ（リアルタイム表示）へ遷移する。
 */
function busPopupHtml(bus) {
  const label = bus.currentHeadsign || bus.headsign || '';
  const delay = bus.delayMinutes || 0;
  const delayLabel = formatDelayLabel(bus.delayMinutes) || '定刻通り';
  const delayClass = delay >= 5 ? 'text-red-600' : 'text-blue-700';
  const detailUrl = buildTripDetailUrl(bus, { view: 'realtime' });

  const lines = [];
  lines.push(`<div class="font-bold text-sm">${escapeHtml(bus.routeName || '不明な路線')}</div>`);
  if (label) lines.push(`<div class="text-xs text-gray-700 mt-0.5">${escapeHtml(label)}行き</div>`);
  lines.push(`<div class="text-xs font-bold ${delayClass} mt-1">${escapeHtml(delayLabel)}</div>`);
  if (detailUrl) {
    lines.push(`<button type="button" data-role="tt-bus-detail-btn" data-url="${escapeHtml(detailUrl)}" class="mt-2 w-full text-xs font-bold text-white bg-sky-600 rounded-lg px-3 py-1.5">便の詳細を見る</button>`);
  }
  return lines.join('');
}

function updateBusMarkers(buses) {
  if (!mapInstance) return;
  const seenMarkerIds = new Set();
  const latLngs = [];

  buses.forEach((bus) => {
    const lat = Number(bus.lat);
    const lng = Number(bus.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    // car_idは路線をまたぐと重複し得るので、車両ID（無ければ路線+車両）でキーを作る。
    const markerId = `bus-${bus.vehicleId ?? `${bus.routeId}-${bus.id}`}`;
    seenMarkerIds.add(markerId);
    latLngs.push([lat, lng]);

    let marker = busMarkers[markerId];
    if (marker) {
      marker.setLatLng([lat, lng]);
      marker.setIcon(createBusIcon(bus));
      marker.setPopupContent(busPopupHtml(bus));
    } else {
      marker = L.marker([lat, lng], { icon: createBusIcon(bus) }).addTo(mapInstance);
      marker.bindPopup(busPopupHtml(bus));
      busMarkers[markerId] = marker;
    }
  });

  Object.keys(busMarkers).forEach((markerId) => {
    if (!seenMarkerIds.has(markerId)) {
      mapInstance.removeLayer(busMarkers[markerId]);
      delete busMarkers[markerId];
    }
  });

  // 初回だけ、走行中のバスが全部入るように表示範囲を合わせる。
  // 以降は利用者の操作した表示位置を勝手に動かさない。
  if (!busMapFitted && latLngs.length > 0) {
    busMapFitted = true;
    mapInstance.fitBounds(L.latLngBounds(latLngs).pad(0.2), { maxZoom: 15 });
  }
}

function setBusMapStatus(text) {
  const el = $('busmap-status');
  if (el) el.textContent = text;
}

async function loadBusMapBuses() {
  if (!mapInstance) return;
  try {
    // routeIdを付けない＝全路線。1路線に決め打ちすると、その路線が運行していない
    // 時間帯にバスが1台も出ない（これが「バスが表示されない」原因だった）。
    const data = await fetchJson(`${API_BASE}/buses-for-map`);
    const buses = data.buses || [];
    updateBusMarkers(buses);
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    setBusMapStatus(buses.length > 0
      ? `運行中 ${buses.length}台（${time} 更新）`
      : `現在運行中のバスはありません（${time} 更新）`);
  } catch (err) {
    console.error('バス情報取得エラー:', err);
    setBusMapStatus('バス情報の取得に失敗しました。');
  }
}

function getUserLocation() {
  return new Promise((resolve) => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude
          });
        },
        () => {
          resolve(null);
        },
        { timeout: 10000, maximumAge: 60000 }
      );
    } else {
      resolve(null);
    }
  });
}

// 現在地マーカーを重ねる。バスの描画とは独立して動かすこと（awaitで待たない）。
// 位置情報の許可ダイアログは利用者が答えるまで解決しないため、
// これを待ってからバスを取得すると、その間ずっとバスが1台も出ない。
async function addUserLocation() {
  const location = await getUserLocation();
  if (!location || !mapInstance) return;

  if (userMarker) {
    userMarker.setLatLng([location.lat, location.lng]);
  } else {
    userMarker = L.circleMarker([location.lat, location.lng], {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: '#2563eb',
      fillOpacity: 1
    }).addTo(mapInstance);
    userMarker.bindPopup('現在地');
  }
}

async function renderMapMenu() {
  setPageTitle('マップ', 'Map Menu');
  $('section-map').style.display = 'block';
}

async function renderBusMap() {
  setPageTitle('バスマップ', 'Bus Map');
  $('section-busmap').style.display = 'block';
  setBusMapStatus('バス位置を読み込み中...');

  if (!initializeMap()) return;

  // バスの取得を最優先。現在地は取れ次第あとから重ねる。
  await loadBusMapBuses();
  addUserLocation();

  stopBusMapPolling();
  busMapTimer = setInterval(() => {
    if (parseHashRoute().page !== 'busmap') {
      stopBusMapPolling();
      return;
    }
    loadBusMapBuses();
  }, POLL_MS);
}

function stopBusMapPolling() {
  if (busMapTimer) {
    clearInterval(busMapTimer);
    busMapTimer = null;
  }
}

async function renderCurrentRoute() {
  hideAllPages();
  // バスマップから離れたら自動更新も止める（バスマップを開いたときに再開する）
  stopBusMapPolling();
  $('app-content').style.display = 'block';
  $('loading').style.display = 'none';

  // 時刻表検索機能はハッシュではなくパス（/timetable...）でルーティングする。
  // 既存画面のハッシュルーティングより先に判定すること。
  if (window.TimetableView && window.TimetableView.isTimetablePath()) {
    await window.TimetableView.render();
    return;
  }
  // バス停マップも同様にパス（/stopmap）でルーティングする。
  if (window.StopMapView && window.StopMapView.isStopMapPath()) {
    await window.StopMapView.render();
    return;
  }

  const state = parseHashRoute();
  try {
    if (state.page === 'home') {
      setPageTitle('松本市バス案内', 'Bus Information');
      $('section-home').style.display = 'block';
      return;
    }
    if (state.page === 'search') {
      setPageTitle('ルート検索', 'Route Search');
      $('section-routesearch').style.display = 'block';
      return;
    }
    if (state.page === 'map') {
      await renderMapMenu();
      return;
    }
    if (state.page === 'busmap') {
      await renderBusMap();
      return;
    }
    await ensureRouteOptions();
    if (state.page === 'realtime-list') {
      setPageTitle('リアルタイム運行情報', 'Select a Route');
      renderRouteList();
      $('section-route-list').style.display = 'block';
      return;
    }
    if (!routeOptions.some((route) => route.id === state.routeId)) {
      window.location.hash = '#/realtime';
      return;
    }
    selectedRouteId = state.routeId;
    const selectedRoute = routeOptions.find((route) => route.id === selectedRouteId);
    setPageTitle(selectedRoute?.name || 'リアルタイム運行情報', 'Realtime Timetable');
    $('selected-route-name').textContent = selectedRoute?.short_name || selectedRoute?.name || '';
    $('section-realtime').style.display = 'block';
    $('notices').style.display = 'block';
    await loadAll();
  } catch (err) {
    console.error('画面表示エラー:', err);
  }
}

/* ---------- 初期化 ---------- */
const refreshBtn = $('refresh-btn');
const routeSelect = $('route-select');
const searchRouteBtn = $('search-route-btn');
const tabRealtime = $('tab-realtime');
const tabRoutesearch = $('tab-routesearch');

if (refreshBtn) refreshBtn.addEventListener('click', () => {
  if (parseHashRoute().page === 'realtime-detail') loadAll();
});
if (routeSelect) {
  routeSelect.addEventListener('change', (e) => {
    selectedRouteId = e.target.value;
    loadAll();
  });
}

// タブ切り替え
if (tabRealtime) {
  tabRealtime.addEventListener('click', () => switchTab('realtime'));
}
if (tabRoutesearch) {
  tabRoutesearch.addEventListener('click', () => switchTab('routesearch'));
}

// バス停オートコンプリート設定
setupStopAutocomplete('from-stop', 'from-suggestions', (stop) => {
  selectedFromStop = stop;
});

setupStopAutocomplete('to-stop', 'to-suggestions', (stop) => {
  selectedToStop = stop;
});

// Enterキーでルート検索を実行
$('from-stop').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performRouteSearch();
});
$('to-stop').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performRouteSearch();
});
$('departure-time').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performRouteSearch();
});

// ルート検索ボタン
if (searchRouteBtn) {
  searchRouteBtn.addEventListener('click', performRouteSearch);
}

// 出発時間に現在時刻をセット
const departureTimeInput = $('departure-time');
if (departureTimeInput) {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  departureTimeInput.value = `${hours}:${minutes}`;
}

window.addEventListener('hashchange', renderCurrentRoute);
// 時刻表検索機能が使う History API による遷移（戻る/進む）にも追随させる
window.addEventListener('popstate', renderCurrentRoute);
// timetable.js から呼び出せるようにグローバルへ公開する
window.renderCurrentRoute = renderCurrentRoute;
renderCurrentRoute();
setInterval(() => {
  if (parseHashRoute().page === 'realtime-detail') loadAll();
}, POLL_MS);
