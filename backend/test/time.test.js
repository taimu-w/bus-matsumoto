// utils/time.js の現在の挙動を固定する回帰テスト。DB・ネットワーク不要な純粋関数のみ対象。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeDelayMinutes,
  computeSignedDelayMinutes,
  getDayType,
  isNightTime,
  timeStrToMinutes,
  minutesToTimeStr,
  minutesToServiceTimeStr,
  parseGpsTimeToDate
} = require('../src/utils/time');

test('computeDelayMinutes: 定刻通りなら0分', () => {
  assert.equal(computeDelayMinutes('8:00', '8:00'), 0);
});

test('computeDelayMinutes: 5分遅れ', () => {
  assert.equal(computeDelayMinutes('8:00', '8:05'), 5);
});

test('computeDelayMinutes: 定刻より早着は0分に丸める', () => {
  assert.equal(computeDelayMinutes('8:00', '7:55'), 0);
});

test('computeDelayMinutes: 半日を超える差分だけ日跨ぎ補正する', () => {
  // 23:50発が翌0:05着（15分遅れ）となるケース
  assert.equal(computeDelayMinutes('23:50', '0:05'), 15);
});

test('computeDelayMinutes: 不正な時刻文字列はnull', () => {
  assert.equal(computeDelayMinutes('通過', '8:00'), null);
  assert.equal(computeDelayMinutes('8:00', null), null);
});

test('computeSignedDelayMinutes: 早発・早着は負の値で返す（computeDelayMinutesは0に丸めたまま）', () => {
  assert.equal(computeSignedDelayMinutes('8:00', '7:55'), -5);
  assert.equal(computeDelayMinutes('8:00', '7:55'), 0);
});

test('computeSignedDelayMinutes: 遅れ・定刻はcomputeDelayMinutesと同じ値', () => {
  assert.equal(computeSignedDelayMinutes('8:00', '8:05'), 5);
  assert.equal(computeSignedDelayMinutes('8:00', '8:00'), 0);
});

test('computeSignedDelayMinutes: 半日を超える差分だけ日跨ぎ補正する（早発側も同じ）', () => {
  assert.equal(computeSignedDelayMinutes('23:50', '0:05'), 15);
  // 0:05発が定刻より5分早い23:55発になったケース（日跨ぎ補正で -10 にならないこと）
  assert.equal(computeSignedDelayMinutes('0:05', '23:55'), -10);
});

test('computeSignedDelayMinutes: 不正な時刻文字列はnull', () => {
  assert.equal(computeSignedDelayMinutes('通過', '8:00'), null);
  assert.equal(computeSignedDelayMinutes('8:00', null), null);
});

test('minutesToServiceTimeStr: 24時以降を折り返さない（GTFSの運行日表記）', () => {
  assert.equal(minutesToServiceTimeStr(1500), '25:00');
  assert.equal(minutesToTimeStr(1500), '1:00');
});

test('minutesToServiceTimeStr: 1440分未満はminutesToTimeStrと完全に一致する', () => {
  for (const m of [0, 1, 59, 60, 510, 1439]) {
    assert.equal(minutesToServiceTimeStr(m), minutesToTimeStr(m));
  }
});

test('computeDelayMinutes: 定刻が24時超え表記でも実時刻と突き合わせられる', () => {
  // "25:00"（＝翌1:00）定刻の便が実時刻1:03に到着 → 3分遅れ
  assert.equal(computeDelayMinutes('25:00', '1:03'), 3);
  assert.equal(computeSignedDelayMinutes('25:00', '0:57'), -3);
});

test('getDayType: 日曜は常にholiday扱い', () => {
  assert.equal(getDayType(new Date('2026-08-16T03:00:00Z')), 'holiday'); // JST日曜
});

test('getDayType: 土曜はsaturday', () => {
  assert.equal(getDayType(new Date('2026-08-15T03:00:00Z')), 'saturday'); // JST土曜
});

test('getDayType: 平日はweekday', () => {
  assert.equal(getDayType(new Date('2026-08-17T03:00:00Z')), 'weekday'); // JST月曜
});

test('getDayType: holidaySetに含まれる平日はholiday扱い', () => {
  const holidaySet = new Set(['2026-08-17']);
  assert.equal(getDayType(new Date('2026-08-17T03:00:00Z'), holidaySet), 'holiday');
});

test('isNightTime: 全時間帯を覆う設定では常にtrue', (t) => {
  const origStart = process.env.NIGHT_START;
  const origEnd = process.env.NIGHT_END;
  t.after(() => {
    if (origStart === undefined) delete process.env.NIGHT_START; else process.env.NIGHT_START = origStart;
    if (origEnd === undefined) delete process.env.NIGHT_END; else process.env.NIGHT_END = origEnd;
  });
  process.env.NIGHT_START = '00:00';
  process.env.NIGHT_END = '23:59';
  assert.equal(isNightTime(), true);
});

test('timeStrToMinutes / minutesToTimeStr: 相互変換', () => {
  assert.equal(timeStrToMinutes('8:30'), 510);
  assert.equal(minutesToTimeStr(510), '8:30');
});

test('timeStrToMinutes: 通過扱いの記号はNaN', () => {
  assert.ok(Number.isNaN(timeStrToMinutes('↓')));
  assert.ok(Number.isNaN(timeStrToMinutes('通過')));
});

// ---- 深夜帯判定：不正な設定値のフォールバック（B-8） ----

test('isNightTime: 不正な書式の値は無視して既定値(23:00〜05:00)へ落ちる', (t) => {
  const origStart = process.env.NIGHT_START;
  const origEnd = process.env.NIGHT_END;
  t.after(() => {
    if (origStart === undefined) delete process.env.NIGHT_START; else process.env.NIGHT_START = origStart;
    if (origEnd === undefined) delete process.env.NIGHT_END; else process.env.NIGHT_END = origEnd;
  });
  delete process.env.NIGHT_START;
  delete process.env.NIGHT_END;

  // 旧実装は parseInt が NaN を返して全比較が false ＝「常に非深夜」になっていた。
  // 開始が不正なら既定の23:00が使われる。終了を22:59にすると 23:00〜22:59 の
  // 日跨ぎ範囲＝1日全体になるため、テスト実行時刻に関係なく必ず true になる。
  assert.equal(isNightTime('こわれた値', '22:59'), true);
  assert.equal(isNightTime('23', '22:59'), true);   // コロン無し
  assert.equal(isNightTime('25:00', '22:59'), true); // 範囲外の時
  assert.equal(isNightTime('23:60', '22:59'), true); // 範囲外の分

  // 正常な値は従来どおりそのまま使われる（既定値へ落ちた場合と同じ結果になる）。
  assert.equal(isNightTime('23:00', '22:59'), true);
  assert.equal(isNightTime('00:00', '23:59'), true);
  // 空文字は「未設定」として次の候補（環境変数→既定値）へ落ちる。
  assert.equal(isNightTime('', ''), isNightTime());
});

// ---- 位置情報フィードのGPS時刻パース（B-12） ----

test('parseGpsTimeToDate: 現行フィードの書式は旧実装と同じ結果になる', () => {
  const legacy = (s) => new Date(String(s).replace(/-/g, '/') + ' +0900').toISOString();
  for (const s of ['2026-09-02 10:00:00', '2026-09-02 10:00', '2026/09/02 10:00:00', '2026-09-02 5:07:09']) {
    assert.equal(parseGpsTimeToDate(s).toISOString(), legacy(s), s);
  }
});

test('parseGpsTimeToDate: ISO 8601（旧実装は全滅していた書式）を解釈できる', () => {
  const expected = '2026-09-02T01:00:00.000Z'; // = 2026-09-02 10:00 JST
  assert.equal(parseGpsTimeToDate('2026-09-02T10:00:00').toISOString(), expected);
  assert.equal(parseGpsTimeToDate('2026-09-02T10:00:00+09:00').toISOString(), expected);
  assert.equal(parseGpsTimeToDate('2026-09-02T10:00:00+0900').toISOString(), expected);
  assert.equal(parseGpsTimeToDate('2026-09-02T01:00:00Z').toISOString(), expected);
  assert.equal(parseGpsTimeToDate('2026-09-02T10:00:00.123+09:00').toISOString(), expected);
  // タイムゾーン指定が無ければJSTとして解釈する（UTCとして読んで9時間ずれないこと）
  assert.notEqual(parseGpsTimeToDate('2026-09-02T10:00:00').toISOString(), '2026-09-02T10:00:00.000Z');
});

test('parseGpsTimeToDate: 解釈できない値はnull（Invalid Dateを返さない）', () => {
  for (const s of ['', '   ', 'abc', '2026-13-45 10:00:00', '2026-09-02 25:00:00', null, undefined, '2026-09-02']) {
    assert.equal(parseGpsTimeToDate(s), null, String(s));
  }
});

test('parseGpsTimeToDate: 前後の空白は無視する', () => {
  assert.equal(
    parseGpsTimeToDate('  2026-09-02 10:00:00  ').toISOString(),
    parseGpsTimeToDate('2026-09-02 10:00:00').toISOString()
  );
});
