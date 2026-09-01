// 管理画面の基盤（認証・共有fetch・共通ヘルパー・ポーリング機構）。
// ルーティングやセクション固有の処理は持たない。admin-router.js / admin-<section>.js より先に読み込むこと。

// 認証状態はこのフラグだけ。**資格情報もトークンもブラウザ側には一切保持しない**
// （認証はサーバー側セッション＝httpOnly Cookieで、JSからは読めない）。
// 旧実装は btoa("user:pass") を localStorage に保存していたが、base64は暗号化ではなく
// XSSが1件でもあれば資格情報ごと抜かれるため廃止した（docs/system-review-2026-09.md S-2）。
const state = { authenticated: false };

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

// "YYYY-MM-DD"（運行日＝GTFSサービス日）を "M/D（曜）" で表示する。
// Date.UTC ベースで曜日を出すため、閲覧側のタイムゾーンに依存しない。
function fmtServiceDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return String(dateStr);
  const wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}（${wd}）`;
}

// ペース比率（実績÷定刻。1.0=定刻通り、大きいほど遅い。etaPredictor.jsのcombinePaceFactor等が
// 0.5〜2.5にクランプ済み）を色分けする共通ヘルパー。「ETA予測根拠」「当日の状況」（路線別
// サマリ・メッシュ地図）のいずれからも使うため、hex（Leafletの塗り色用）とTailwindクラス
// （バッジ用）の両方を返す。
function paceFactorColor(factor) {
  if (factor === null || factor === undefined) return { text: 'text-slate-400', bg: 'bg-slate-100', hex: '#94a3b8' };
  if (factor < 0.85) return { text: 'text-blue-700', bg: 'bg-blue-100', hex: '#2563eb' };
  if (factor <= 1.15) return { text: 'text-green-700', bg: 'bg-green-100', hex: '#16a34a' };
  if (factor <= 1.5) return { text: 'text-amber-700', bg: 'bg-amber-100', hex: '#d97706' };
  return { text: 'text-red-700', bg: 'bg-red-100', hex: '#dc2626' };
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}秒`;
}

// ペース補正の内訳（本便＝直近3区間／今日の前便実績／周辺道路実績／総合）をバッジ列で描画する
// 共通ヘルパー。paceBreakdown が null（source が 'historical'/'schedule_paced' 以外）なら空文字。
// 「ETA予測根拠」タブと「運行ダッシュボード」のバス停別モーダルの両方で使う。
function paceBreakdownBadges(pb) {
  if (!pb) return '';
  const badge = (label, factor, title) => {
    if (factor === null || factor === undefined) return '';
    const c = paceFactorColor(factor);
    return `<span class="px-1.5 py-0.5 rounded ${c.bg} ${c.text}" title="${escapeHtml(title)}">${label}×${Number(factor).toFixed(2)}</span>`;
  };
  const parts = [badge('本便', pb.liveFactor, '直近3区間の実績ペース（当該便自身）')];
  if (pb.todayPreviousTripFactor != null) {
    parts.push(badge('前便', pb.todayPreviousTripFactor, `同一路線・同方向の当日直前便の実績（一致区間${pb.todayPreviousTripSamples}件）`));
  }
  if (pb.nearbyFactor != null) {
    parts.push(badge('周辺', pb.nearbyFactor, `周辺500m以内・直近60分の他便実績（${pb.nearbyFactorSamples}件、重み合計${Number(pb.nearbyWeightMass).toFixed(1)}）`));
  }
  if (pb.combinedPaceFactor != null) {
    const total = paceFactorColor(pb.combinedPaceFactor);
    parts.push(`<span class="px-1.5 py-0.5 rounded ${total.bg} ${total.text} font-black" title="上記を確信度に応じた動的重みでブレンドした最終補正係数">総合×${Number(pb.combinedPaceFactor).toFixed(2)}</span>`);
  }
  return `<div class="mt-1 flex flex-wrap gap-1 text-[10px]">${parts.filter(Boolean).join('')}</div>`;
}

// 上部の通知バーは、セクションを切り替えても消えずに残ると混乱の元になるため、
// 表示から5秒で自動的に隠す（読むには十分な時間）。次のメッセージが来たら前のタイマーは破棄する。
let statusHideTimer = null;

function hideStatus() {
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  statusBox.classList.add('hidden');
}

function showStatus(message, tone = 'info') {
  if (statusHideTimer) clearTimeout(statusHideTimer);
  statusBox.textContent = message;
  statusBox.className = `rounded-lg px-4 py-3 text-sm font-bold ${tone === 'error' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`;
  statusBox.classList.remove('hidden');
  statusHideTimer = setTimeout(() => {
    statusBox.classList.add('hidden');
    statusHideTimer = null;
  }, 5000);
}

function showLoginStatus(message, tone = 'info') {
  loginStatusBox.textContent = message;
  loginStatusBox.className = `mt-4 rounded-lg px-4 py-3 text-sm font-bold ${tone === 'error' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`;
  loginStatusBox.classList.remove('hidden');
}

// ==========================================================
// 認証（サーバー側セッション。POST/DELETE /api/admin/session）
// ==========================================================

// ログイン。資格情報をネットワークに載せるのはこの1回だけで、以後はCookieが認証を担う。
async function login(username, password) {
  await api('/api/admin/session', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  state.authenticated = true;
  sessionExpiredHandled = false;
}

// ログアウト。サーバー側のセッションも確実に破棄する（クライアント側だけ消しても
// トークンが生き残る、という旧実装の弱点をなくすため）。
async function logout() {
  try {
    await api('/api/admin/session', { method: 'DELETE' });
  } catch (err) {
    // 通信に失敗しても画面はログアウト状態にする（次回アクセス時に401で弾かれる）
  }
  applyLoggedOutState();
}

function applyLoggedOutState() {
  state.authenticated = false;
  stopAllPollers();
  appShell.classList.add('hidden');
  loginCardWrap.classList.remove('hidden');
}

// セッション切れ（＝サーバー再起動・有効期限超過）でログイン画面へ戻す。
// 複数のポーラーが同時に401を受け取るため、1回だけ処理する。
let sessionExpiredHandled = false;

function handleSessionExpired() {
  if (!state.authenticated || sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  if (badgeTimer) {
    clearInterval(badgeTimer);
    badgeTimer = null;
  }
  applyLoggedOutState();
  showLoginStatus('セッションの有効期限が切れました。再度ログインしてください。', 'error');
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  // 認証はhttpOnly Cookie。同一オリジンなので既定で送られるが、意図を明示しておく。
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) handleSessionExpired();
    const error = new Error(data.error || '処理に失敗しました');
    error.status = response.status;
    throw error;
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
