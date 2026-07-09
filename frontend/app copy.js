const API_BASE = '/api';
const POLL_MS = 20000;
// 自動更新をまたいで保持する状態（開いているアコーディオン・スクロール位置）
const openBusIds = new Set();
const openTripKeys = new Set();

// 取得した最新データを保持しておく（お気に入り計算・再描画用）
let currentBuses = [];
let currentTimetable = [];

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
        // 遅延情報が実際に取得できているかどうかをnull/undefinedのまま保持する（0で潰さない）。
        // 臨時便（比較対象の定刻が無い）や非リアルタイム（まだ検知できていない）の場合は
        // delayMinutesが0でも信用できないため、情報なし（null）扱いにする。
        const isExtraTrip = bus.tripType === '臨時便';
        const rawDelay = (!isExtraTrip && bus.isRealtime)
          ? (targetStop.predictedDelayMinutes ?? targetStop.delayMinutes ?? null)
          : null;
        approachingBuses.push({
          timeStr: targetStop.predictedTime || targetStop.scheduledTime,
          isRealtime: bus.isRealtime,
          delay: rawDelay,
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
            delay: null, // 時刻表由来は遅延情報を持たない
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
          delay: null,
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
        const hasDelayInfo = info.delay !== null && info.delay !== undefined;
        const delayHtml = hasDelayInfo && info.delay > 1 ? `<span class="text-red-500 text-xs font-bold ml-1">(${info.delay}分遅れ)</span>` : '';
        const badgeClass = info.type === 'realtime'
          ? (info.label === '接近中' ? 'bg-green-100 text-green-800 border-green-200 animate-pulse' : 'bg-blue-100 text-blue-800 border-blue-200')
          : 'bg-gray-100 text-gray-600 border-gray-200';

        infoHtml += `
          <div class="flex items-center justify-between py-2 ${idx === 0 && next2.length > 1 ? 'border-b border-dashed border-yellow-200' : ''}">
            <div class="flex items-baseline gap-2">
              <span class="text-xs font-bold text-gray-500 w-8">${titleText}</span>
              <span class="text-2xl font-bold tracking-tight ${hasDelayInfo && info.delay > 1 ? 'text-red-600' : 'text-gray-800'}">${escapeHtml(info.timeStr)}</span>
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
    const [settings, busData, timetable] = await Promise.all([
      fetchJson(`${API_BASE}/settings`),
      fetchJson(`${API_BASE}/buses`),
      fetchJson(`${API_BASE}/timetable`)
    ]);

    // お気に入り描画用にデータをグローバル保持
    currentBuses = busData.buses || [];
    currentTimetable = timetable || [];

    const isFirstLoad = $('loading').style.display !== 'none';
    $('loading').style.display = 'none';
    $('app-content').style.display = 'block';

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

  // 遅延情報が実際に取得できているかどうかをnull/undefinedのまま保持する（0で潰さない）。
  // さらに、以下のケースは「delayMinutesが0」であっても遅延判定として信用できないため、
  // 情報なし扱いにする。
  //   ・臨時便（tripType === '臨時便'）: 比較対象の定刻が無く、そもそも遅延を算出できない
  //   ・isRealtimeがfalse（「検知中…」の状態）: まだ実測に基づく遅延ではない
  const delay = bus.delayMinutes;
  const isExtraTrip = bus.tripType === '臨時便';
  const hasDelayInfo = delay !== null && delay !== undefined && !isExtraTrip && bus.isRealtime;
  const delayStyle = hasDelayInfo && delay >= 5
    ? 'bg-red-600 text-white delay-highlight'
    : 'bg-blue-100 text-blue-800';

  const delayBadgeHtml = hasDelayInfo
    ? `<span class="text-2xl font-bold ${delayStyle} px-4 py-1.5 rounded-full shadow-sm">${formatDelayLabel(delay)}</span>`
    : `<span class="text-sm font-bold text-gray-500 bg-gray-100 border border-gray-200 px-3 py-1.5 rounded-full">遅延情報なし</span>`;

  const badge = bus.isRealtime
    ? `<span class="text-[10px] font-bold text-green-700 bg-green-50 px-2 py-1 rounded border border-green-200 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-1 animate-pulse"></span>リアルタイム運行中</span>`
    : `<span class="text-[10px] font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded border border-gray-200">検知中…</span>`;

  const extraBadge = bus.tripType === '臨時便'
    ? `<span class="ml-1 text-[10px] font-bold text-amber-700 bg-amber-50 px-2 py-1 rounded border border-amber-200">臨時便</span>`
    : '';

  const card = document.createElement('div');
  card.className = 'bg-white rounded-2xl shadow-sm border-2 border-blue-200 overflow-hidden mb-4 transition-all';

  const toggleCursorClass = hasDeparted ? 'cursor-pointer active:opacity-50' : 'cursor-default';
  const arrowHtml = hasDeparted
    ? `<svg data-role="arrow" class="w-6 h-6 text-gray-300 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M19 9l-7 7-7-7"></path></svg>`
    : '';

  card.innerHTML = `
    <div class="p-5 ${toggleCursorClass}" data-role="toggle">
      <div class="flex justify-between items-start mb-3">
        <div>${badge}${extraBadge}</div>
        ${delayBadgeHtml}
      </div>
      <div class="flex items-center justify-between">
        <div class="flex items-center">
          <div class="w-12 h-12 bg-blue-800 rounded-xl flex items-center justify-center text-white mr-3 shadow">
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M18,11H6V6h12M16.5,17A1.5,1.5 0 0,1 15,15.5A1.5,1.5 0 0,1 16.5,14A1.5,1.5 0 0,1 18,15.5A1.5,1.5 0 0,1 16.5,17M7.5,17A1.5,1.5 0 0,1 6,15.5A1.5,1.5 0 0,1 7.5,14A1.5,1.5 0 0,1 9,15.5A1.5,1.5 0 0,1 7.5,17M4,16c0,0.88 0.39,1.67 1,2.22V20a1,1 0 0,0 1,1h1a1,1 0 0,0 1-1v-1h8v1a1,1 0 0,0 1,1h1a1,1 0 0,0 1-1v-1.78c0.61-0.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8,0.5-8,4V16Z"></path></svg>
          </div>
          <div>
            <p class="text-[10px] text-gray-400 font-bold">現在の位置</p>
            <p class="text-xl font-bold text-gray-900">${escapeHtml(currentPos)}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          ${currentStop ? `
          <button data-role="map" data-lat="${currentStop.lat}" data-lng="${currentStop.lng}" class="bg-blue-50 text-blue-700 p-2.5 rounded-full border border-blue-200 shadow-sm active:scale-90 transition-transform">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
            <span class="text-[10px] block font-bold leading-none mt-1">地図</span>
          </button>` : ''}
          ${arrowHtml}
        </div>
      </div>
    </div>
    ${hasDeparted ? `
    <div data-role="accordion" class="accordion-content bg-gray-50">
      <div class="p-3 space-y-1.5">
        <div class="grid grid-cols-12 gap-2 text-[10px] font-bold text-gray-400 px-3">
          <div class="col-span-5">バス停</div>
          <div class="col-span-3 text-center">定刻</div>
          <div class="col-span-4 text-center">予測/実績</div>
        </div>
        <div data-role="stop-rows"></div>
      </div>
    </div>` : ''}
  `;

  if (!hasDeparted) {
    return card;
  }

  let nextRowEl = null;
  const rowsContainer = card.querySelector('[data-role="stop-rows"]');

  stops.forEach((stop, i) => {
    const row = renderStopRow(bus, stop, i, lastIdx);
    if (i === lastIdx + 1) nextRowEl = row;
    rowsContainer.appendChild(row);
  });

  const scrollTargetEl = nextRowEl || rowsContainer.lastElementChild;
  setupAccordionToggle(card, openBusIds, bus.id, () => scrollTargetEl);

  const mapBtn = card.querySelector('[data-role="map"]');
  if (mapBtn) {
    mapBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`https://www.google.com/maps?q=${mapBtn.dataset.lat},${mapBtn.dataset.lng}`, '_blank');
    });
  }

  return card;
}

function renderStopRow(bus, stop, index, lastIdx) {
  const isArrived = stop.status === '到着済';
  const isThrough = stop.isPassStop || stop.status === '通過';
  const isNext = index === lastIdx + 1;
  const favs = getFavorites();
  const isFav = favs.includes(stop.name);

  const rowClass = isArrived || isThrough
    ? 'opacity-65 bg-gray-200/50'
    : isNext
      ? 'bg-blue-600 text-white shadow-lg rounded-xl'
      : 'bg-white rounded-lg border';

  // 臨時便は比較対象となる定刻が無いため、そもそも遅延という概念が成立しない。
  // delayMinutes/predictedDelayMinutesが0で返ってきても「定刻通り」とは表示しない。
  const isExtraTrip = bus.tripType === '臨時便';

  let predTime = '--';
  let delayLabel = '';

  if (isThrough) {
    predTime = '通過';
  } else if (isArrived) {
    predTime = stop.actualTime || '--';
    delayLabel = isExtraTrip ? '' : formatDelayLabel(stop.delayMinutes);
  } else if (bus.isRealtime) {
    predTime = stop.predictedTime || stop.scheduledTime || '--';
    delayLabel = isExtraTrip ? '' : formatDelayLabel(stop.predictedDelayMinutes);
  } else {
    predTime = stop.scheduledTime || '--';
  }

  const isDelayedPred = !isArrived && !isThrough && !isExtraTrip && (stop.predictedDelayMinutes || 0) > 1;
  const predTimeClass = isDelayedPred ? 'text-red-600 font-bold' : 'font-bold';
  const schedClass = isThrough ? 'line-through-double opacity-50' : '';

  const row = document.createElement('div');
  row.className = `grid grid-cols-12 gap-2 p-4 items-center ${rowClass} cursor-pointer transition-all active:scale-[0.98]`;

  // HTMLに☆ボタンを組み込む
  row.innerHTML = `
    <div class="col-span-5 text-xl font-bold leading-tight flex items-start">
      <button data-fav="true" class="text-2xl mr-1 -mt-0.5 leading-none focus:outline-none transition-colors ${isFav ? 'text-yellow-400' : 'text-gray-300'}" title="お気に入りに追加/解除">
        ${isFav ? '★' : '☆'}
      </button>
      <div class="leading-tight">
        ${isNext ? '<span class="text-[10px] block opacity-80 mb-0.5">次は</span>' : ''}
        ${escapeHtml(stop.name)}
      </div>
    </div>
    <div class="col-span-3 text-md text-center font-bold ${schedClass}">${escapeHtml(stop.scheduledTime || '--')}</div>
    <div class="col-span-4 text-center">
      <span class="text-2xl ${predTimeClass}">${escapeHtml(predTime)}</span>
      ${delayLabel ? `<span class="block text-xs font-bold">${escapeHtml(delayLabel)}</span>` : ''}
    </div>
  `;

  // ☆ボタンのクリック処理（モーダルを開かずにお気に入りをトグル）
  const favBtn = row.querySelector('[data-fav]');
  if (favBtn) {
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(stop.name);
      renderFavorites();
      renderBuses(currentBuses); // 同一リスト内の他の☆表示も同時に更新する
    });
  }

  // それ以外の場所をクリックした時は詳細モーダルを開く
  row.addEventListener('click', () => openStopModal(stop));

  return row;
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

  const trips = timetable
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

  if (trips.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-500 px-1">本日の残り便はありません。</p>';
    return;
  }

  trips.forEach((t) => container.appendChild(createScheduleCard(t.trip, t.firstTime)));
}

function createScheduleCard(trip, firstTime) {
  const card = document.createElement('div');
  card.className = 'bg-white rounded-xl border border-gray-200 overflow-hidden';
  card.innerHTML = `
    <div class="px-4 py-3 flex justify-between items-center cursor-pointer active:bg-gray-50" data-role="toggle">
      <span class="font-bold text-gray-800">${escapeHtml(firstTime)} 発 松本駅お城口</span>
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

/* ---------- 初期化 ---------- */
$('refresh-btn').addEventListener('click', loadAll);
loadAll();
setInterval(loadAll, POLL_MS);