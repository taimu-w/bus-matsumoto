// 管理画面のルーティング（ハッシュ）・セクション表示切替・ログイン/ログアウト。
// admin-core.js と全admin-<section>.jsの読み込み後、最後に読み込むこと
// （各セクションのwindow.Admin<Xxx>を参照するため）。

const POLL_INTERVALS_MS = {
  dashboard: 15000,
  alerts: 15000,
  viewers: 15000,
  assignment: 30000,
  'today-overview': 30000,
  'job-monitor': 30000
};

const SECTION_LOADERS = {
  dashboard: () => window.AdminDashboard.load(),
  'vehicle-operation-status': () => window.AdminVehicleOperationStatus.load(),
  assignment: () => window.AdminAssignment.load(),
  'prediction-accuracy': () => window.AdminPredictionAccuracy.load(),
  'today-overview': () => window.AdminTodayOverview.load(),
  alerts: () => window.AdminAlerts.load(),
  'gtfs-feeds': () => window.AdminGtfsFeeds.load(),
  'location-feeds': () => window.AdminLocationFeeds.load(),
  'api-stats': () => window.AdminApiStats.load(),
  'job-monitor': () => window.AdminJobMonitor.load(),
  notices: () => window.AdminNotices.load(),
  'busstop-notices': () => window.AdminBusstopNotices.load(),
  holidays: () => window.AdminHolidays.load(),
  'route-mappings': () => window.AdminRouteMappings.load(),
  'display-abbreviations': () => window.AdminDisplayAbbreviations.load(),
  'direction-rules': () => window.AdminDirectionRules.load(),
  'realtime-suspension': () => window.AdminRuntimeSuspension.load(),
  'runtime-settings': () => window.AdminRuntimeSettings.load(),
  'tourist-spots': () => window.AdminTouristSpots.load(),
  'tourist-spot-clicks': () => window.AdminTouristSpotClicks.load(),
  'vehicle-labels': () => window.AdminVehicleLabels.load(),
  viewers: () => window.AdminViewers.load(),
  'operation-records': () => window.AdminOperationRecords.load()
};

function updatePageTitleBar(id) {
  const navBtn = document.querySelector(`[data-section="${id}"]`);
  if (!navBtn) return;
  const svg = navBtn.querySelector('svg');
  document.getElementById('page-title-icon').innerHTML = svg ? svg.outerHTML : '';
  document.getElementById('page-title-text').textContent = navBtn.dataset.label || '';
}

// ==========================================================
// ハッシュルーティング
// ==========================================================
function knownSectionIds() {
  return Array.from(document.querySelectorAll('[data-section]')).map((btn) => btn.dataset.section);
}

function currentHashSectionId() {
  const id = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  return knownSectionIds().includes(id) ? id : 'dashboard';
}

function renderSection(id) {
  hideStatus(); // 前のセクションのエラー・完了通知を持ち越さない
  document.querySelectorAll('.section').forEach((el) => el.classList.add('hidden'));
  const target = document.getElementById(`section-${id}`);
  if (target) target.classList.remove('hidden');

  document.querySelectorAll('[data-section]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === id);
  });
  updatePageTitleBar(id);

  stopAllPollers();
  const loader = SECTION_LOADERS[id];
  if (loader) loader().catch((err) => showStatus(err.message, 'error'));
  startPollerFor(id);
}

document.querySelectorAll('[data-section]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.section;
    if (currentHashSectionId() === id) {
      renderSection(id); // 現在のセクションを再クリック→従来どおり手動更新として再読み込み
    } else {
      location.hash = `/${id}`; // hashchangeイベント経由でrenderSectionが呼ばれる
    }
  });
});

window.addEventListener('hashchange', () => {
  if (!state.authenticated) return; // 未ログイン時はルーティングを無視
  renderSection(currentHashSectionId());
});

function applyEditorState() {
  loginCardWrap.classList.add('hidden');
  appShell.classList.remove('hidden');
  const id = currentHashSectionId();
  if (location.hash.replace(/^#\/?/, '') !== id) {
    history.replaceState(null, '', `#/${id}`); // 未指定/不正なハッシュを正規化してブックマーク可能にする
  }
  renderSection(id);
}

// ==========================================================
// ログイン・ログアウト
// ==========================================================
async function handleLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (!username || !password) {
    showLoginStatus('ユーザー名とパスワードを入力してください。', 'error');
    return;
  }

  const loginBtn = document.getElementById('login-btn');
  loginBtn.disabled = true;
  try {
    await login(username, password); // サーバー側セッションを発行してもらう（admin-core.js）
    startAuthenticatedSession();
  } catch (err) {
    showLoginStatus(err.message, 'error');
  } finally {
    loginBtn.disabled = false;
  }
}

// ログイン済み画面を出し、アラートバッジのポーリングを開始する。
// 初回ログインとセッション復帰（再訪問）で共通。
function startAuthenticatedSession() {
  applyEditorState();
  if (badgeTimer) clearInterval(badgeTimer);
  badgeTimer = setInterval(refreshAlertsBadge, 20000);
  refreshAlertsBadge();
}

document.getElementById('login-btn').addEventListener('click', handleLogin);
// ユーザー名・パスワード欄でEnterキーを押してもログインできるようにする
['username', 'password'].forEach((id) => {
  document.getElementById(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleLogin();
    }
  });
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  if (badgeTimer) {
    clearInterval(badgeTimer);
    badgeTimer = null;
  }
  await logout(); // サーバー側セッションの破棄まで行う（admin-core.js）
  showLoginStatus('ログアウトしました。', 'info');
});

// 旧実装がlocalStorageへ保存していた資格情報（base64の user:pass）が残っている端末では、
// この機会に必ず消す。移行後は書き込まないので、この1行だけで確実に消える。
localStorage.removeItem('adminToken');

// httpOnly CookieのセッションはJSから読めないため、サーバーに問い合わせて生死を確かめる。
// 生きていればそのままログイン済み画面へ。無ければログイン画面のまま（初回訪問なので何も出さない）。
api('/api/admin/session')
  .then(() => {
    state.authenticated = true;
    startAuthenticatedSession();
  })
  .catch(() => { /* 未ログイン。ログインフォームを表示したまま待つ */ });
