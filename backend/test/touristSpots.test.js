// touristSpots.js のうち、DBアクセスを伴わない純粋関数（parseTouristSpotsText）の回帰テスト。
// 1列目のID（識別子）のバリデーション、別称（5列目）を "," 区切りで受け付ける挙動、
// 写真URLを "," 区切りで複数枚受け付ける挙動、タブ区切り17列のバリデーションを固定する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTouristSpotsText } = require('../src/services/touristSpots');

// ID〜表示の17列をタブで組み立てるヘルパー（未指定列は空文字）。
function row(overrides = {}) {
  const cols = [
    'id', 'name', 'kana', 'romaji', 'aliases', 'lat', 'lng', 'url', 'hours', 'stayDuration', 'description',
    'hoursEn', 'stayDurationEn', 'descriptionEn', 'photoUrls', 'category', 'displayTag'
  ];
  const base = { id: 'matsumotojo', name: '松本城', lat: '36.2381', lng: '137.9686' };
  const merged = { ...base, ...overrides };
  return cols.map((c) => merged[c] || '').join('\t');
}

test('parseTouristSpotsText: 1列目のIDを識別子として取り込む', () => {
  const result = parseTouristSpotsText(row({ id: 'spot-001' }));
  assert.equal(result.ok, true);
  assert.equal(result.spots[0].id, 'spot-001');
  assert.equal(result.spots[0].name, '松本城');
});

test('parseTouristSpotsText: IDが空欄ならエラー', () => {
  const result = parseTouristSpotsText(row({ id: '' }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /IDは必須です/);
});

test('parseTouristSpotsText: ID重複はエラー（名称は違っても）', () => {
  const text = `${row({ id: 'a', name: '松本城' })}\n${row({ id: 'a', name: '旧開智学校' })}`;
  const result = parseTouristSpotsText(text);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /IDが重複しています/);
});

test('parseTouristSpotsText: 名称が重複してもIDが違えば別スポットとして登録できる', () => {
  const text = `${row({ id: 'a', name: '駐車場' })}\n${row({ id: 'b', name: '駐車場' })}`;
  const result = parseTouristSpotsText(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.spots.map((s) => s.id), ['a', 'b']);
});

test('parseTouristSpotsText: IDに "/" を含むとエラー', () => {
  const result = parseTouristSpotsText(row({ id: 'a/b' }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /IDは64文字以内/);
});

test('parseTouristSpotsText: 別称を "," 区切りで受け取り正規化して連結する', () => {
  const result = parseTouristSpotsText(row({ aliases: 'からす城, 国宝 ,,烏城' }));
  assert.equal(result.ok, true);
  assert.equal(result.spots[0].aliases, 'からす城,国宝,烏城');
});

test('parseTouristSpotsText: 別称列が空なら aliases は null', () => {
  const result = parseTouristSpotsText(row());
  assert.equal(result.ok, true);
  assert.equal(result.spots[0].aliases, null);
});

test('parseTouristSpotsText: 別称の位置はローマ字と緯度の間（他の列がずれない）', () => {
  const result = parseTouristSpotsText(row({ aliases: 'からす城', category: '史跡', displayTag: '観光' }));
  assert.equal(result.ok, true);
  assert.equal(result.spots[0].lat, 36.2381);
  assert.equal(result.spots[0].lng, 137.9686);
  assert.equal(result.spots[0].category, '史跡');
  assert.equal(result.spots[0].displayTag, '観光');
});

test('parseTouristSpotsText: 写真URLを "," 区切りで複数枚受け付ける', () => {
  const result = parseTouristSpotsText(row({ photoUrls: 'https://cdn.example/a.jpg,https://cdn.example/b.jpg' }));
  assert.equal(result.ok, true);
  assert.equal(result.spots[0].photoUrls, 'https://cdn.example/a.jpg,https://cdn.example/b.jpg');
});

test('parseTouristSpotsText: 写真URLの前後空白・空要素を正規化する', () => {
  const result = parseTouristSpotsText(row({ photoUrls: ' https://cdn.example/a.jpg , ,https://cdn.example/b.jpg ' }));
  assert.equal(result.ok, true);
  assert.equal(result.spots[0].photoUrls, 'https://cdn.example/a.jpg,https://cdn.example/b.jpg');
});

test('parseTouristSpotsText: 写真URLが1枚でも従来どおり登録できる', () => {
  const result = parseTouristSpotsText(row({ photoUrls: 'https://cdn.example/a.jpg' }));
  assert.equal(result.ok, true);
  assert.equal(result.spots[0].photoUrls, 'https://cdn.example/a.jpg');
});

test('parseTouristSpotsText: 写真URL列が空なら photoUrls は null', () => {
  const result = parseTouristSpotsText(row());
  assert.equal(result.ok, true);
  assert.equal(result.spots[0].photoUrls, null);
});

test('parseTouristSpotsText: 複数写真のうち1つでも https:// でなければエラー', () => {
  const result = parseTouristSpotsText(row({ photoUrls: 'https://cdn.example/a.jpg,http://cdn.example/b.jpg' }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /写真URLはhttps:\/\/で始めてください/);
});

test('parseTouristSpotsText: 列数が17を超えるとエラー（写真列は1タブ列のまま）', () => {
  const result = parseTouristSpotsText(`${row()}\t余分`);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /列数が多すぎます/);
});
