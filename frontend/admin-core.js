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
