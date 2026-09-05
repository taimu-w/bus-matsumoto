// 車両運用状況：車両ごとの「直近の運行履歴」（直近の平日1日分・直近の土休日1日分）の一覧。
//
// 便のクローズ時に vehicle_operation_history へ car_id × 曜日区分で記録される
// （backend: services/vehicleOperationHistory.js）。各バケットは「最も新しく運行した1日」の
// 全便を保持する。completed_trips と違い保持期間の影響を受けないため、たまにしか走らない
// 予備車・応援車の運用状況も確認できる。車両名（vehicle_labels）を登録している車両は名前で表示する。
//
// 表示は1台につき「平日」「土休日」の2段。以前は平日と土休日を左右に並べて「便」列を
// 2本置いていたが、路線名を含む whitespace-nowrap の行が2列ぶんになり PC 幅に収まらなかったため、
// 便一覧を1列にして縦に積む形にした（運行ダッシュボードの車両詳細パネルと同じ並び）。
(function () {
  // 1バケット（平日 or 土休日）ぶんのセル3つ：曜日区分 / 運行日 / 便一覧（始発時刻・路線名・行先）。
  // 先頭の車両セルは呼び出し側が rowspan=2 で別に描くため、ここには含めない。
  function bucketCells(label, trips) {
    const labelCell = `<td class="px-3 py-2 border-l whitespace-nowrap font-bold text-slate-500 align-top">${label}</td>`;
    if (!trips || !trips.length) {
      return labelCell
        + '<td colspan="2" class="px-3 py-2 border-l text-slate-400 align-top">運行履歴なし</td>';
    }
    const dateCell = `<td class="px-3 py-2 border-l whitespace-nowrap align-top font-bold">`
      + `${escapeHtml(fmtServiceDate(trips[0].serviceDate))}`
      + `<div class="text-[10px] text-slate-400 font-normal">${trips.length}便</div></td>`;
    const list = trips.map((t) =>
      `<div class="whitespace-nowrap">${escapeHtml(t.startTime || '—')}発 ／ ${escapeHtml(t.routeName || '—')} ／ ${escapeHtml(t.headsign || '—')}行</div>`
    ).join('');
    return `${labelCell}${dateCell}<td class="px-3 py-2 border-l align-top space-y-0.5">${list}</td>`;
  }

  function render(vehicles) {
    const tbody = document.getElementById('vehicle-operation-status-tbody');
    if (!vehicles.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="px-3 py-6 text-center text-slate-400">運行履歴のある車両がまだありません。便が運行を終えると記録されます。</td></tr>';
      return;
    }
    tbody.innerHTML = vehicles.map((v) => {
      const nameCell = v.name
        ? `<span class="font-bold">${escapeHtml(v.name)}</span><div class="text-[10px] text-slate-400 font-mono">${escapeHtml(v.carId)}</div>`
        : `<span class="font-mono text-xs">${escapeHtml(v.carId)}</span>`;
      const history = v.history || {};
      // 車両ごとに2行（平日・土休日）。1行目の上端に太めの境界線を引いて車両の切れ目を示す。
      return `
        <tr class="border-t-2 border-slate-300">
          <td rowspan="2" class="px-3 py-2 align-top">${nameCell}</td>
          ${bucketCells('平日', history.weekday)}
        </tr>
        <tr>
          ${bucketCells('土休日', history.weekendHoliday)}
        </tr>`;
    }).join('');
  }

  async function load() {
    const data = await api('/api/admin/vehicle-operation-status');
    render(data.vehicles || []);
  }

  document.getElementById('refresh-vehicle-operation-status-btn').addEventListener('click', () => {
    load().catch((err) => showStatus(err.message, 'error'));
  });

  window.AdminVehicleOperationStatus = { load };
})();
