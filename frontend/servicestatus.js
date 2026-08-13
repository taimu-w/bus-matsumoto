const API_BASE = '/api';

function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 「平常運行」は緑、それ以外（運行情報あり・運休など）は注意喚起として黄〜赤系で表示する。
function statusBadgeClass(status) {
  if (status === '平常運行') return 'bg-green-100 text-green-800 border-green-300';
  if (status.includes('運休') || status.includes('停止')) return 'bg-red-100 text-red-800 border-red-300';
  if (status) return 'bg-amber-100 text-amber-800 border-amber-300';
  return 'bg-gray-100 text-gray-600 border-gray-300';
}

function statusCardBorderClass(status) {
  if (status === '平常運行') return 'border-gray-200';
  if (status.includes('運休') || status.includes('停止')) return 'border-red-300';
  if (status) return 'border-amber-300';
  return 'border-gray-200';
}

// スクレイピング元（アルピコ交通公式サイト）の <a href> は、backend の
// htmlToTextWithBreaks() で「[表示文字列](URL)」の記法に変換して保持されている。
// ここではまず全体をエスケープしてから、その記法と裸のURLをクリックできるリンクに変換する
// （エスケープ後の文字列に対して行うのでXSSの心配はない）。
const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
const TRAILING_PUNCT_PATTERN = /[、。，,．.）」』\)\]]+$/;

function linkifyDetail(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(LINK_PATTERN, (match, label, bracketUrl, bareUrl) => {
    if (bracketUrl) {
      return `<a href="${bracketUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline font-bold break-all">${label}</a>`;
    }
    // 文末の句読点・括弧類はURLの一部ではないことが多いので、リンクの外側に残す
    const trailingMatch = bareUrl.match(TRAILING_PUNCT_PATTERN);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    const url = trailing ? bareUrl.slice(0, bareUrl.length - trailing.length) : bareUrl;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline font-bold break-all">${url}</a>${trailing}`;
  });
}

function createRouteCard(route) {
  const status = route.status || '';
  const card = document.createElement('div');
  card.className = `bg-white rounded-xl border-2 ${statusCardBorderClass(status)} p-4 shadow-sm`;
  card.innerHTML = `
    <div class="flex justify-between items-start gap-3 mb-2">
      <h3 class="font-bold text-gray-900 leading-snug">${escapeHtml(route.name)}</h3>
      <span class="shrink-0 text-xs font-bold px-2.5 py-1 rounded border ${statusBadgeClass(status)}">${escapeHtml(status || '情報なし')}</span>
    </div>
    ${route.detail ? `<p class="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">${linkifyDetail(route.detail)}</p>` : ''}
  `;
  return card;
}

function createCategorySection(category) {
  const section = document.createElement('section');
  const routes = category.routes || [];
  const hasNotice = routes.some((r) => r.status && r.status !== '平常運行');

  section.innerHTML = `
    <h2 class="text-lg font-bold text-blue-900 flex items-center mb-4">
      <span class="w-2 h-6 ${hasNotice ? 'bg-amber-500' : 'bg-green-500'} rounded-full mr-2 shadow-sm"></span>
      ${escapeHtml(category.category)}
    </h2>
    <div class="space-y-3" data-role="routes"></div>
  `;

  const routesContainer = section.querySelector('[data-role="routes"]');
  routes.forEach((route) => routesContainer.appendChild(createRouteCard(route)));

  return section;
}

function render(data) {
  const categories = data.categories || [];
  const container = $('status-container');
  container.innerHTML = '';

  if (categories.length === 0) {
    $('empty-note').style.display = 'block';
    return;
  }
  $('empty-note').style.display = 'none';

  categories.forEach((category) => container.appendChild(createCategorySection(category)));

  $('source-updated').textContent = data.sourceUpdatedAt ? `公式サイト表示の更新日時：${data.sourceUpdatedAt}` : '';
  const scrapedAt = data.scrapedAt ? new Date(data.scrapedAt) : null;
  $('scraped-at').textContent = scrapedAt ? `本システムでの取得日時：${scrapedAt.toLocaleString('ja-JP')}` : '';
}

async function loadStatus() {
  const icon = $('refresh-icon');
  icon.classList.add('animate-spin');
  try {
    const res = await fetch(`${API_BASE}/service-status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    $('loading').style.display = 'none';
    $('app-content').style.display = 'block';
    render(data);
  } catch (err) {
    console.error('運行状況取得エラー:', err);
    $('loading').style.display = 'none';
    $('app-content').style.display = 'block';
    $('empty-note').style.display = 'block';
  } finally {
    setTimeout(() => icon.classList.remove('animate-spin'), 500);
  }
}

$('refresh-btn').addEventListener('click', loadStatus);
loadStatus();
