// vehicleProfiles.js のうち、DBアクセスを伴わない関数（normalizeVehicleProfileInput /
// serializePublicProfile）の回帰テスト。アイコンは「現存するファイル」だけ受け付けること、
// ノンステップ・車いすの3値（対応/非対応/未登録）、支払い方法の検証と並び順の正規化を固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVehicleProfileInput, serializePublicProfile } = require('../src/services/vehicleProfiles');

const ICONS = ['alpicobus.png', 'townsneakergreen.png'];

test('normalizeVehicleProfileInput: 全項目を正規化し、支払い方法を定義順に並べ重複を落とす', () => {
  const result = normalizeVehicleProfileInput({
    icon: ' alpicobus.png ',
    nonStep: true,
    wheelchair: false,
    paymentMethods: ['qr', 'cash', 'qr'],
    paymentNote: ' 1日乗車券も利用できます '
  }, ICONS);
  assert.equal(result.ok, true);
  assert.equal(result.empty, false);
  assert.deepEqual(result.value, {
    icon: 'alpicobus.png',
    nonStep: true,
    wheelchair: false,
    paymentMethods: ['cash', 'qr'],
    paymentNote: '1日乗車券も利用できます'
  });
});

test('normalizeVehicleProfileInput: 何も指定しなければ empty（＝行削除）', () => {
  const result = normalizeVehicleProfileInput({ icon: '', nonStep: null, paymentMethods: [] }, ICONS);
  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  assert.deepEqual(result.value, { icon: '', nonStep: null, wheelchair: null, paymentMethods: [], paymentNote: '' });
});

test('normalizeVehicleProfileInput: false（非対応）だけでも empty ではない', () => {
  const result = normalizeVehicleProfileInput({ nonStep: false }, ICONS);
  assert.equal(result.ok, true);
  assert.equal(result.empty, false);
});

test('normalizeVehicleProfileInput: 存在しないアイコン・パス指定を拒否する', () => {
  assert.equal(normalizeVehicleProfileInput({ icon: 'missing.png' }, ICONS).ok, false);
  assert.equal(normalizeVehicleProfileInput({ icon: '../admin.html' }, ICONS).ok, false);
});

test('normalizeVehicleProfileInput: 3値以外・未知の支払い方法・長すぎる補足を拒否する', () => {
  assert.equal(normalizeVehicleProfileInput({ nonStep: 'yes' }, ICONS).ok, false);
  assert.equal(normalizeVehicleProfileInput({ wheelchair: 1 }, ICONS).ok, false);
  assert.equal(normalizeVehicleProfileInput({ paymentMethods: ['bitcoin'] }, ICONS).ok, false);
  assert.equal(normalizeVehicleProfileInput({ paymentMethods: 'cash' }, ICONS).ok, false);
  assert.equal(normalizeVehicleProfileInput({ paymentNote: 'あ'.repeat(201) }, ICONS).ok, false);
});

test('serializePublicProfile: 行が無ければnull、支払い方法はラベル付き・未知キーは落とす', () => {
  assert.equal(serializePublicProfile(null), null);
  assert.deepEqual(serializePublicProfile({
    icon: null,
    non_step: true,
    wheelchair: null,
    payment_methods: ['transit_ic', 'removed_key', 'cash'],
    payment_note: null
  }), {
    iconUrl: null,
    nonStep: true,
    wheelchair: null,
    paymentMethods: [
      { key: 'cash', label: '現金' },
      { key: 'transit_ic', label: '交通系ICカード' }
    ],
    paymentNote: ''
  });
});

test('serializePublicProfile: 画像ファイルが存在しないアイコンは iconUrl を出さない', () => {
  const profile = serializePublicProfile({ icon: 'no-such-icon-file.png', payment_methods: [] });
  assert.equal(profile.iconUrl, null);
});
