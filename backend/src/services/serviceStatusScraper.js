// アルピコ交通 公式サイトの「現在の運行状況」ページをスクレイピングし、
// 路線ごとの運行状況（平常運行／運行情報あり、等）をDBにキャッシュするモジュール。
const fetch = require('cross-fetch');
const cheerio = require('cheerio');
const pool = require('../config/db');

const STATUS_URL = process.env.ALPICO_STATUS_URL || 'https://www.alpico.co.jp/traffic/trafficinfo/matsumoto/';

// <br> を改行文字に変換してからテキスト化する（お知らせ本文の改行を保持するため）
function htmlToTextWithBreaks($, el) {
  const clone = $(el).clone();
  clone.find('br').replaceWith('\n');
  return clone
    .text()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * ページを取得しパースする。DBへの保存は行わない（scrapeAndStoreが担当）。
 */
async function fetchServiceStatus(url = STATUS_URL) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BusStatusBot/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const sourceUpdatedAt = $('.text_date').first().text().trim() || null;

  const categories = [];
  $('.con_rosen').each((_, rosenEl) => {
    const categoryName = $(rosenEl).find('h3.jp').first().text().trim();
    const routes = [];

    $(rosenEl)
      .find('.box_list')
      .each((__, boxEl) => {
        const name = $(boxEl).find('.header p').first().text().trim();
        const status = $(boxEl).find('.data .status span').first().text().trim();
        const detailEl = $(boxEl).find('.data .details p').first();
        const detail = detailEl.length ? htmlToTextWithBreaks($, detailEl) : '';
        if (name) routes.push({ name, status, detail });
      });

    if (categoryName || routes.length > 0) {
      categories.push({ category: categoryName || '運行状況', routes });
    }
  });

  return { sourceUpdatedAt, categories, fetchedFromUrl: url };
}

/**
 * スクレイピングを実行し、結果をDBにキャッシュする。
 */
async function scrapeAndStore(url = STATUS_URL) {
  const result = await fetchServiceStatus(url);
  await pool.query(
    `INSERT INTO service_status_cache (id, payload, source_updated_at, scraped_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE
       SET payload = EXCLUDED.payload,
           source_updated_at = EXCLUDED.source_updated_at,
           scraped_at = EXCLUDED.scraped_at`,
    [JSON.stringify(result.categories), result.sourceUpdatedAt]
  );
  return result;
}

/**
 * DBにキャッシュされた最新の運行状況を返す。まだキャッシュが無ければその場でスクレイピングする。
 */
async function getCachedServiceStatus() {
  const res = await pool.query('SELECT payload, source_updated_at, scraped_at FROM service_status_cache WHERE id = 1');
  if (res.rows.length === 0) {
    const scraped = await scrapeAndStore();
    return {
      categories: scraped.categories,
      sourceUpdatedAt: scraped.sourceUpdatedAt,
      scrapedAt: new Date().toISOString()
    };
  }
  const row = res.rows[0];
  return {
    categories: row.payload,
    sourceUpdatedAt: row.source_updated_at,
    scrapedAt: row.scraped_at
  };
}

module.exports = { fetchServiceStatus, scrapeAndStore, getCachedServiceStatus };
