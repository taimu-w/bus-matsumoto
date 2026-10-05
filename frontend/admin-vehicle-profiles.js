// 車両詳細情報（公開）：車両ID＝car_id ⇔ バスアイコン・ノンステップ・車いす対応・お支払い方法。
// docs/vehicle-profiles.md
//
// ここで登録した内容は利用者向け画面（リアルタイム時刻表のカード表示・基本表示、バスマップ、
// 便詳細ページの「車両詳細」ポップアップ）にそのまま出る。管理専用の「車両名・メモ」
// （admin-vehicle-labels.js）とは別の情報なので、管理用車両名は対象車両の検索と一覧での識別の補助に使うだけ。
//
// 対象車両は車両IDのほか車両名（vehicle_labels.name、重複不可）でも探せる。入力欄は検索欄を兼ね、
// 保存時は resolveCarId() で「車両IDとして完全一致 → 車両名として完全一致 → 入力値をそのまま新しい車両ID」
// の順に解決する（車両IDを優先するのは、ある車両の名前が別の車両のIDと同じ文字列でも取り違えないため）。
(function () {
  const carIdInput = () => document.getElementById('vehicle-profile-car-id');
  const suggestBox = () => document.getElementById('vehicle-profile-suggest');
  const targetLine = () => document.getElementById('vehicle-profile-target');
  const nonStepSelect = () => document.getElementById('vehicle-profile-non-step');
  const wheelchairSelect = () => document.getElementById('vehicle-profile-wheelchair');
  const paymentNoteInput = () => document.getElementById('vehicle-profile-payment-note');

  const MAX_SUGGESTIONS = 10;

  // GET の結果（アイコン・支払い方法の選択肢と登録一覧）。フォームの描画・編集に使う。
  let catalog = { icons: [], paymentMethods: [], profiles: [] };
  let selectedIcon = '';
  // 検索候補：car_id → { carId, name, routeNames }（観測済み車両・車両名の登録・公開情報の登録の和集合）
  let candidates = new Map();
  let suggestItems = [];
  let suggestIndex = -1;

  // 全角・半角、大文字・小文字、空白の違いを無視して部分一致させる。
  function normalizeSearch(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  }

  function buildCandidates(knownVehicles, vehicleNames) {
    const map = new Map();
    const ensure = (carId) => {
      if (!map.has(carId)) map.set(carId, { carId, name: null, routeNames: [] });
      return map.get(carId);
    };
    knownVehicles.forEach((v) => { ensure(v.carId).routeNames = v.routeNames || []; });
    vehicleNames.forEach((v) => { ensure(v.carId).name = v.name; });
    catalog.profiles.forEach((p) => {
      const c = ensure(p.carId);
      if (!c.name && p.labelName) c.name = p.labelName;
    });
    candidates = map;
  }

  /** 入力値 → 対象の car_id（上のファイル冒頭コメントの順で解決）。空なら空文字。 */
  function resolveCarId(value) {
    const text = String(value || '').trim();
    if (!text || candidates.has(text)) return text;
    const byName = [...candidates.values()].find((c) => c.name === text);
    return byName ? byName.carId : text;
  }

  function profileOf(carId) {
    return catalog.profiles.find((row) => row.carId === carId) || null;
  }

  function updateTargetLine() {
    const el = targetLine();
    const carId = resolveCarId(carIdInput().value);
    if (!carId) { el.innerHTML = ''; return; }
    const c = candidates.get(carId);
    const nameText = c && c.name ? `（${escapeHtml(c.name)}）` : '';
    const state = profileOf(carId)
      ? '<span class="text-green-700 font-bold">登録済み</span>'
      : c
        ? '<span class="text-slate-500">未登録</span>'
        : '<span class="text-amber-700">観測・車両名の登録がない車両ID（新規として保存されます）</span>';
    el.innerHTML = `対象：車両ID <span class="font-mono font-bold text-slate-700">${escapeHtml(carId)}</span>${nameText}　${state}`;
  }

  function hideSuggest() {
    suggestBox().classList.add('hidden');
    suggestItems = [];
    suggestIndex = -1;
  }

  function renderSuggest() {
    const query = normalizeSearch(carIdInput().value);
    const all = [...candidates.values()];
    suggestItems = (query
      ? all.filter((c) => normalizeSearch(c.carId).includes(query) || (c.name && normalizeSearch(c.name).includes(query)))
      : all
    ).slice(0, MAX_SUGGESTIONS);
    if (suggestItems.length === 0) { hideSuggest(); return; }
    if (suggestIndex >= suggestItems.length) suggestIndex = -1;

    const box = suggestBox();
    box.innerHTML = suggestItems.map((c, i) => {
      const registered = !!profileOf(c.carId);
      const routeText = c.routeNames && c.routeNames.length ? c.routeNames.join('・') : '';
      return `<button type="button" data-index="${i}"
        class="vehicle-profile-suggest-item w-full text-left px-3 py-2 border-b last:border-b-0 ${i === suggestIndex ? 'bg-blue-50' : 'hover:bg-slate-50'}">
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs">${escapeHtml(c.carId)}</span>
          ${c.name ? `<span class="font-bold text-sm truncate">${escapeHtml(c.name)}</span>` : ''}
          ${registered ? '<span class="ml-auto text-[10px] font-bold text-green-700 bg-green-50 border border-green-200 rounded-full px-1.5">登録済み</span>' : ''}
        </div>
        ${routeText ? `<div class="text-[11px] text-slate-400 truncate">${escapeHtml(routeText)}</div>` : ''}
      </button>`;
    }).join('');
    box.classList.remove('hidden');
    // blur より先に確定させるため mousedown で拾う（click だと入力欄の blur で候補が消えて押せない）。
    box.querySelectorAll('.vehicle-profile-suggest-item').forEach((btn) => {
      btn.addEventListener('mousedown', (event) => {
        event.preventDefault();
        chooseCandidate(suggestItems[Number(btn.dataset.index)]);
      });
    });
  }

  function chooseCandidate(candidate) {
    if (!candidate) return;
    hideSuggest();
    fillForm(candidate.carId, profileOf(candidate.carId));
  }

  function triStateToSelectValue(value) {
    return value === true ? 'true' : value === false ? 'false' : '';
  }

  function selectValueToTriState(value) {
    return value === 'true' ? true : value === 'false' ? false : null;
  }

  function triStateLabel(value) {
    if (value === true) return '<span class="text-green-700 font-bold">対応</span>';
    if (value === false) return '<span class="text-slate-500 font-bold">非対応</span>';
    return '<span class="text-slate-300">—</span>';
  }

  function renderIconPicker() {
    const container = document.getElementById('vehicle-profile-icons');
    const options = [{ file: '', url: null }, ...catalog.icons];
    // 登録済みのアイコンの画像ファイルが消えている場合も、選択中であることが分かるよう残す。
    if (selectedIcon && !catalog.icons.some((icon) => icon.file === selectedIcon)) {
      options.push({ file: selectedIcon, url: null, missing: true });
    }
    container.innerHTML = options.map((icon) => {
      const selected = icon.file === selectedIcon;
      const preview = icon.url
        ? `<img src="${escapeHtml(icon.url)}" alt="" class="max-w-full max-h-full object-contain">`
        : `<span class="text-xs ${icon.missing ? 'text-red-600' : 'text-slate-400'} font-bold">${icon.missing ? '画像なし' : '未設定'}</span>`;
      return `<button type="button" data-icon="${escapeHtml(icon.file)}"
        class="vehicle-profile-icon-option w-32 border-2 rounded-xl p-2 text-left ${selected ? 'border-blue-600 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-400'}">
        <div class="h-16 flex items-center justify-center">${preview}</div>
        <div class="mt-1 text-[11px] font-mono truncate ${selected ? 'text-blue-800 font-bold' : 'text-slate-500'}" title="${escapeHtml(icon.file || '未設定')}">${escapeHtml(icon.file || '（アイコンなし）')}</div>
      </button>`;
    }).join('');

    if (catalog.icons.length === 0) {
      container.insertAdjacentHTML('beforeend', '<p class="text-xs text-slate-400 self-center">frontend/images/ に画像ファイルがありません。</p>');
    }

    container.querySelectorAll('.vehicle-profile-icon-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedIcon = btn.dataset.icon;
        renderIconPicker();
      });
    });
  }

  function renderPaymentCheckboxes(checkedKeys = []) {
    const container = document.getElementById('vehicle-profile-payments');
    container.innerHTML = catalog.paymentMethods.map((m) => `
      <label class="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" class="vehicle-profile-payment" value="${escapeHtml(m.key)}" ${checkedKeys.includes(m.key) ? 'checked' : ''} />
        <span>${escapeHtml(m.label)}</span>
      </label>`).join('');
  }

  function fillForm(carId, profile) {
    carIdInput().value = carId || '';
    nonStepSelect().value = triStateToSelectValue(profile ? profile.nonStep : null);
    wheelchairSelect().value = triStateToSelectValue(profile ? profile.wheelchair : null);
    paymentNoteInput().value = profile ? (profile.paymentNote || '') : '';
    selectedIcon = profile ? (profile.icon || '') : '';
    renderIconPicker();
    renderPaymentCheckboxes(profile ? profile.paymentMethods : []);
    updateTargetLine();
  }

  function paymentLabels(keys) {
    const labelByKey = new Map(catalog.paymentMethods.map((m) => [m.key, m.label]));
    return (keys || []).map((key) => labelByKey.get(key) || key);
  }

  function renderProfiles() {
    const tbody = document.getElementById('vehicle-profiles-list');
    const profiles = catalog.profiles;
    if (profiles.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-3 text-slate-400">登録されている車両詳細情報はありません。</td></tr>';
      return;
    }
    tbody.innerHTML = profiles.map((p) => {
      const iconCell = p.iconUrl
        ? `<div class="w-16 h-11 flex items-center justify-center"><img src="${escapeHtml(p.iconUrl)}" alt="" class="max-w-full max-h-full object-contain"></div>`
        : p.icon
          ? `<span class="text-xs text-red-600 font-bold" title="${escapeHtml(p.icon)}">画像なし</span>`
          : '<span class="text-slate-300">—</span>';
      const payments = paymentLabels(p.paymentMethods);
      return `
        <tr class="border-t align-middle">
          <td class="px-3 py-2">${iconCell}</td>
          <td class="px-3 py-2">
            <div class="font-mono text-xs">${escapeHtml(p.carId)}</div>
            ${p.labelName ? `<div class="text-[11px] text-slate-400" title="管理用の車両名（非公開）">${escapeHtml(p.labelName)}</div>` : ''}
          </td>
          <td class="px-3 py-2">${triStateLabel(p.nonStep)}</td>
          <td class="px-3 py-2">${triStateLabel(p.wheelchair)}</td>
          <td class="px-3 py-2 text-slate-600">
            ${payments.length ? escapeHtml(payments.join('・')) : '<span class="text-slate-300">—</span>'}
            ${p.paymentNote ? `<div class="text-[11px] text-slate-400">${escapeHtml(p.paymentNote)}</div>` : ''}
          </td>
          <td class="px-3 py-2 text-slate-400 text-xs whitespace-nowrap">${fmtDateTime(p.updatedAt)}</td>
          <td class="px-3 py-2 text-right whitespace-nowrap">
            <button data-car-id="${escapeHtml(p.carId)}" class="edit-vehicle-profile-btn text-blue-600 hover:text-blue-800 hover:underline font-bold text-xs mr-3">編集</button>
            <button data-car-id="${escapeHtml(p.carId)}" class="delete-vehicle-profile-btn text-red-600 hover:text-red-800 hover:underline font-bold text-xs">削除</button>
          </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.edit-vehicle-profile-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const profile = profiles.find((row) => row.carId === btn.dataset.carId);
        if (!profile) return;
        fillForm(profile.carId, profile);
        carIdInput().scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    tbody.querySelectorAll('.delete-vehicle-profile-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm(`車両ID「${btn.dataset.carId}」の車両詳細情報を削除しますか？`)) return;
        try {
          await api(`/api/admin/vehicle-profiles/${encodeURIComponent(btn.dataset.carId)}`, { method: 'DELETE' });
          await loadVehicleProfiles();
          showStatus('車両詳細情報を削除しました。');
        } catch (err) {
          showStatus(err.message, 'error');
        }
      });
    });
  }

  function renderKnownVehicles(knownVehicles) {
    const registered = new Set(catalog.profiles.map((p) => p.carId));
    const container = document.getElementById('vehicle-profiles-known');
    if (knownVehicles.length === 0) {
      container.innerHTML = '<span class="text-slate-400">最近観測された車両はありません。</span>';
      return;
    }
    container.innerHTML = knownVehicles.map((v) => {
      const done = registered.has(v.carId);
      const routeText = v.routeNames && v.routeNames.length ? `（${v.routeNames.join('・')}）` : '';
      const c = candidates.get(v.carId);
      const nameHtml = c && c.name ? ` <span class="font-sans font-bold">${escapeHtml(c.name)}</span>` : '';
      return `<button type="button" data-car-id="${escapeHtml(v.carId)}"
        class="known-vehicle-profile-chip border rounded-full px-2.5 py-1 font-mono ${done ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white hover:border-slate-400'}"
        title="${done ? '登録済み' : '未登録'}${escapeHtml(routeText)}">
        ${done ? '✓ ' : ''}${escapeHtml(v.carId)}${nameHtml}
      </button>`;
    }).join('');

    container.querySelectorAll('.known-vehicle-profile-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const profile = catalog.profiles.find((row) => row.carId === btn.dataset.carId) || null;
        fillForm(btn.dataset.carId, profile);
        carIdInput().scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  async function loadVehicleProfiles() {
    const data = await api('/api/admin/vehicle-profiles');
    catalog = {
      icons: data.icons || [],
      paymentMethods: data.paymentMethods || [],
      profiles: data.profiles || []
    };
    buildCandidates(data.knownVehicles || [], data.vehicleNames || []);
    // 入力途中のフォームは保ったまま、選択肢だけ最新化する。
    const checked = Array.from(document.querySelectorAll('.vehicle-profile-payment:checked')).map((el) => el.value);
    renderIconPicker();
    renderPaymentCheckboxes(checked);
    renderProfiles();
    renderKnownVehicles(data.knownVehicles || []);
    updateTargetLine();
  }

  async function handleSave() {
    const carId = resolveCarId(carIdInput().value);
    if (!carId) {
      showStatus('車両IDまたは車両名を入力してください。', 'error');
      return;
    }
    const body = {
      icon: selectedIcon,
      nonStep: selectValueToTriState(nonStepSelect().value),
      wheelchair: selectValueToTriState(wheelchairSelect().value),
      paymentMethods: Array.from(document.querySelectorAll('.vehicle-profile-payment:checked')).map((el) => el.value),
      paymentNote: paymentNoteInput().value.trim()
    };
    try {
      const result = await api(`/api/admin/vehicle-profiles/${encodeURIComponent(carId)}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      fillForm('', null);
      await loadVehicleProfiles();
      showStatus(result.deleted ? 'すべて未設定のため、この車両の登録を削除しました。' : '車両詳細情報を保存しました。');
    } catch (err) {
      showStatus(err.message, 'error');
    }
  }

  document.getElementById('save-vehicle-profile-btn').addEventListener('click', handleSave);
  document.getElementById('reset-vehicle-profile-btn').addEventListener('click', () => fillForm('', null));
  // 検索欄：入力のたびに候補（車両ID・車両名の部分一致）を出し、↑↓＋Enter またはクリックで確定する。
  carIdInput().addEventListener('input', () => {
    suggestIndex = -1;
    renderSuggest();
    updateTargetLine();
  });
  carIdInput().addEventListener('focus', renderSuggest);
  carIdInput().addEventListener('blur', () => setTimeout(hideSuggest, 100));
  carIdInput().addEventListener('keydown', (event) => {
    const open = !suggestBox().classList.contains('hidden') && suggestItems.length > 0;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) { renderSuggest(); return; }
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      suggestIndex = (suggestIndex + step + suggestItems.length) % suggestItems.length;
      renderSuggest();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open && suggestIndex >= 0) chooseCandidate(suggestItems[suggestIndex]);
      else commitTypedValue();
    } else if (event.key === 'Escape') {
      hideSuggest();
    }
  });
  // 候補を選ばずに入力欄を離れたときも、車両ID・車両名に完全一致すればその登録内容を読み込む
  // （既に登録のある車両を空のフォームで上書き保存する事故を防ぐ）。
  carIdInput().addEventListener('change', commitTypedValue);

  function commitTypedValue() {
    hideSuggest();
    const carId = resolveCarId(carIdInput().value);
    const profile = profileOf(carId);
    if (profile) fillForm(carId, profile);
    else updateTargetLine();
  }

  window.AdminVehicleProfiles = { load: loadVehicleProfiles };
})();
