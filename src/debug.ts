/**
 * Debug script — keeps screenshots so you can inspect them.
 * Usage:
 *   npx ts-node src/debug.ts https://www.casumo.com
 *   npx ts-node src/debug.ts https://www.casumo.com --proxy   (uses Tier 3 proxy from .env)
 */
import { Page, chromium } from 'playwright';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { detectBanners } from './banner-detector';
import { dismissPopups } from './popup-handler';
import { advanceCarousels, scrollToLoadImages } from './carousel-handler';
import { proxyServer, config as appConfig } from './config';

const screenshotDir = path.join(process.cwd(), 'temp_screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

async function snap(page: Page, label: string) {
  const f = path.join(screenshotDir, `${label}_${Date.now()}.png`);
  await page.screenshot({ path: f, fullPage: false });
  console.log(`📸 ${label} → ${path.basename(f)}`);
  return f;
}

async function debug(url: string, useProxy: boolean, headed: boolean) {
  const chromiumExtra = addExtra(chromium);
  chromiumExtra.use(StealthPlugin());

  const proxyUrl = useProxy ? proxyServer('datacenter') : undefined;
  if (proxyUrl) {
    const geoSuffix = appConfig.dcProxy.geo ? ` [geo: ${appConfig.dcProxy.geo.toUpperCase()}]` : '';
    console.log(`Using proxy: ${proxyUrl}${geoSuffix}`);
  }

  const browser = await (chromiumExtra as typeof chromium).launch({
    headless: !headed,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--dns-prefetch-disable', '--dns-server-list=8.8.8.8,1.1.1.1'],
    proxy: proxyUrl ? {
      server:   proxyUrl,
      username: appConfig.dcProxy.username || undefined,
      password: appConfig.dcProxy.password || undefined,
    } : undefined,
  });
  const debugHeaders: Record<string, string> = {};
  if (useProxy && appConfig.dcProxy.geo) {
    debugHeaders['x-oxylabs-geo-location'] = appConfig.dcProxy.geo.toUpperCase();
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    extraHTTPHeaders: debugHeaders,
  });
  const page = await context.newPage();

  console.log(`\nNavigating to ${url}`);
  const waitUntil = useProxy ? 'load' : 'domcontentloaded';
  await page.goto(url, { waitUntil, timeout: 90_000 });
  if (useProxy) {
    await page.waitForFunction(
      () => document.images.length >= 2 || (document.body?.innerText ?? '').trim().length >= 300,
      { timeout: 45_000 }
    ).catch(() => {});
  }
  await page.waitForTimeout(3000);
  await snap(page, '01_loaded');

  const title = await page.title();
  const bodyLen = (await page.evaluate(() => document.body?.innerText?.length ?? 0));
  const imgCount = await page.$$eval('img', imgs => imgs.length);
  console.log(`Title: "${title}" | body chars: ${bodyLen} | imgs: ${imgCount}`);

  await dismissPopups(page);
  await snap(page, '02_popups_cleared');

  await scrollToLoadImages(page);
  await advanceCarousels(page);
  await snap(page, '03_scrolled');

  // Print all img src + dimensions
  const allImgs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('img')).map(img => {
      const r = img.getBoundingClientRect();
      return { type: 'img', src: (img.getAttribute('src') || img.getAttribute('data-src') || '').substring(0, 80), w: Math.round(r.width), h: Math.round(r.height) };
    })
  );
  const allVideos = await page.evaluate(() =>
    Array.from(document.querySelectorAll('video[poster]')).map(v => {
      const r = v.getBoundingClientRect();
      return { type: 'video-poster', src: ((v as HTMLVideoElement).getAttribute('poster') || '').substring(0, 80), w: Math.round(r.width), h: Math.round(r.height) };
    })
  );
  console.log('\nAll images + video posters (ALL sizes including unloaded 0x0):');
  [...allImgs, ...allVideos].forEach(i => console.log(`  [${i.type}] ${i.w}x${i.h}  ${i.src}`));

  // Deep-inspect the slider/hero area
  const heroInfo = await page.evaluate(() => {
    const slider = document.querySelector('[class*="slider"],[class*="hero"],[class*="carousel"],[class*="swiper"]');
    if (!slider) return ['(no slider/hero element found)'];
    const r = slider.getBoundingClientRect();
    const lines: string[] = [];
    lines.push(`Container: ${(slider as HTMLElement).className.substring(0,80)} | ${Math.round(r.width)}x${Math.round(r.height)}`);
    lines.push(`Child count: ${slider.children.length}`);
    // all img tags inside
    const imgs = Array.from(slider.querySelectorAll('img')).map(i =>
      `  img ${Math.round(i.getBoundingClientRect().width)}x${Math.round(i.getBoundingClientRect().height)} src="${(i.getAttribute('src') || i.getAttribute('data-src') || i.getAttribute('data-lazy') || '').substring(0,80)}" srcset="${(i.getAttribute('srcset') || '').substring(0,60)}"`
    );
    if (imgs.length) { lines.push('imgs:'); imgs.forEach(l => lines.push(l)); }
    else lines.push('(no <img> inside slider)');
    // picture/source
    const sources = Array.from(slider.querySelectorAll('source')).map(s =>
      `  source srcset="${(s.getAttribute('srcset') || '').substring(0,80)}" type="${s.getAttribute('type') || ''}"`
    );
    if (sources.length) { lines.push('sources:'); sources.forEach(l => lines.push(l)); }
    // first slide innerHTML snippet
    const firstSlide = slider.querySelector('[class*="slide"]') as HTMLElement | null;
    if (firstSlide) lines.push(`First slide class="${firstSlide.className.substring(0,60)}" innerHTML snippet: ${firstSlide.innerHTML.substring(0,200)}`);
    return lines;
  });
  console.log('\nHero/Slider DOM inspection:');
  heroInfo.forEach(l => console.log(' ', l));

  const banners = await detectBanners(page, 'homepage');
  console.log(`\nDetected banners: ${banners.length}`);
  banners.forEach(b => console.log(`  score=${b.score} ${b.width}x${b.height} ${b.src.substring(0, 80)}`));

  await snap(page, '04_final');
  await browser.close();
  console.log(`\nScreenshots in: ${screenshotDir}`);
}

const url      = process.argv[2] ?? 'https://www.casumo.com';
const useProxy = process.argv.includes('--proxy');
const headed   = process.argv.includes('--headed');

// Optional --geo=XX override (e.g. --geo=gb)
const geoFlag = process.argv.find(a => a.startsWith('--geo='));
if (geoFlag) {
  const geo = geoFlag.split('=')[1]?.trim();
  if (geo) {
    appConfig.dcProxy.geo = geo;
    console.log(`Geo override: ${geo.toUpperCase()}`);
  }
}

debug(url, useProxy, headed).catch(console.error);
