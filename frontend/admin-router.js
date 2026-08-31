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
  if (!state.token) return; // 未ログイン時はルーティングを無視
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
  setAuthToken(username, password);
  try {
    await api('/api/admin/settings'); // 認証確認を兼ねる
    localStorage.setItem('adminToken', state.token);
    applyEditorState();
    if (badgeTimer) clearInterval(badgeTimer);
    badgeTimer = setInterval(refreshAlertsBadge, 20000);
    refreshAlertsBadge();
  } catch (err) {
    state.token = null;
    showLoginStatus(err.message, 'error');
  } finally {
    loginBtn.disabled = false;
  }
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

document.getElementById('logout-btn').addEventListener('click', () => {
  if (badgeTimer) {
    clearInterval(badgeTimer);
    badgeTimer = null;
  }
  clearAuthToken();
  showLoginStatus('ログアウトしました。', 'info');
});

const storedToken = localStorage.getItem('adminToken');
if (storedToken) {
  state.token = storedToken;
  api('/api/admin/settings')
    .then(() => {
      applyEditorState();
      badgeTimer = setInterval(refreshAlertsBadge, 20000);
      refreshAlertsBadge();
    })
    .catch(() => {
      state.token = null;
      localStorage.removeItem('adminToken');
      showLoginStatus('保存済みセッションが無効です。再度ログインしてください。', 'error');
    });
}
