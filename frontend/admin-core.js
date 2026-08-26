// 管理画面の基盤（認証・共有fetch・共通ヘルパー・ポーリング機構）。
// ルーティングやセクション固有の処理は持たない。admin-router.js / admin-<section>.js より先に読み込むこと。

const state = { token: null };

const loginCardWrap = document.getElementById('login-card-wrap');
const appShell = document.getElementById('app-shell');
const statusBox = document.getElementById('status');
const loginStatusBox = document.getElementById('login-status');

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}秒`;
}

function showStatus(message, tone = 'info') {
  statusBox.textContent = message;
  statusBox.className = `rounded-lg px-4 py-3 text-sm font-bold ${tone === 'error' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`;
  statusBox.classList.remove('hidden');
}

function showLoginStatus(message, tone = 'info') {
  loginStatusBox.textContent = message;
  loginStatusBox.className = `mt-4 rounded-lg px-4 py-3 text-sm font-bold ${tone === 'error' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`;
  loginStatusBox.classList.remove('hidden');
}

function setAuthToken(username, password) {
  state.token = btoa(`${username}:${password}`);
}

function clearAuthToken() {
  state.token = null;
  localStorage.removeItem('adminToken');
  stopAllPollers();
  appShell.classList.add('hidden');
  loginCardWrap.classList.remove('hidden');
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (state.token) headers['Authorization'] = `Basic ${state.token}`;

  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || '処理に失敗しました');
  }
  return data;
}

// 路線一覧（id -> 日本語名）。複数タブ（予測精度の監視・運行実績ダウンロード）で
// 共有するため1回だけ取得してキャッシュする。
let cachedRoutesPromise = null;
function getRoutesList() {
  if (!cachedRoutesPromise) {
    cachedRoutesPromise = api('/api/routes').then((data) => data.routes || []).catch((err) => {
      cachedRoutesPromise = null; // 失敗時は次回呼び出しで再取得できるようキャッシュを空にする
      throw err;
    });
  }
  return cachedRoutesPromise;
}

// ==========================================================
// セクション切替時のポーリング管理
// POLL_INTERVALS_MS / SECTION_LOADERS は admin-router.js が定義するが、
// startPollerFor は呼び出し時（ログイン後）まで実行されないため、
// 読み込み順（router.jsが後）でも問題なく参照できる。
// ==========================================================
let activePollTimer = null;

function stopAllPollers() {
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
}

function startPollerFor(id) {
  const intervalMs = POLL_INTERVALS_MS[id];
  if (!intervalMs) return;
  activePollTimer = setInterval(() => {
    const loader = SECTION_LOADERS[id];
    if (loader) loader().catch((err) => console.error(`[admin] ${id} 自動更新エラー:`, err.message));
  }, intervalMs);
}

// 異常アラートの件数をサイドバーのバッジに反映（どのセクションを見ていても更新されるよう軽量ポーリング）
async function refreshAlertsBadge() {
  try {
    const data = await api('/api/admin/alerts');
    const badge = document.getElementById('alerts-nav-badge');
    const total = data.alerts.length;
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (err) {
    // バッジ更新の失敗はサイレントに無視（メイン機能ではないため）
  }
}
let badgeTimer = null;
