import { Page, BrowserContext } from 'playwright';
import { TierConfig, humanDelay } from './tiers/tier-config';
import { BannerImage, TierResult } from './types';
import { validatePageSuccess } from './tiers/validator';
import { dismissPopups } from './popup-handler';
import { advanceCarousels, scrollToLoadImages, findCarouselNext, findCarouselDots, advanceCarouselOnce } from './carousel-handler';
import { detectBanners } from './banner-detector';
import { findPromotionsUrl } from './page-navigator';
import { downloadBanners } from './image-downloader';
import { takeScreenshot } from './screenshot';
import { emitProgress } from './progress-emitter';

// ── Deduplication helpers ────────────────────────────────────────────────────

/** Canonical key for an image URL — strips size/quality params so the same
 *  artwork at different resolutions maps to the same key.
 *
 *  - /_next/image?url=/foo.jpg&w=1293  →  /foo.jpg
 *  - /cdn-cgi/image/w=664,h=312/https://host/foo.jpg  →  https://host/foo.jpg
 *  - https://cdn.site.com/foo.jpg?w=1293  →  https://cdn.site.com/foo.jpg
 */
function imageKey(src: string): string {
  try {
    const u = new URL(src);
    if (u.pathname.includes('/_next/image')) {
      // Key is the underlying image path, not the resized URL
      return u.searchParams.get('url') ?? (u.origin + u.pathname);
    }
    if (u.pathname.includes('/cdn-cgi/image/')) {
      // /cdn-cgi/image/<opts>/<source-url> → extract source-url
      const match = u.pathname.match(/\/cdn-cgi\/image\/[^/]+\/(https?:\/.+)/);
      if (match) return match[1];
    }
    // Default: origin + pathname (strip query/hash)
    return u.origin + u.pathname;
  } catch { return src; }
}

/** Scroll the page viewport-by-viewport, waiting at each step for lazy-loaded
 *  images to appear through the proxy, then collecting all detected banners.
 *
 *  This is the reliable way to handle promo pages (and any scroll-based layout)
 *  on Cloud Run: the proxy fetches images on demand per viewport position, so
 *  we must dwell at each position long enough for the fetch to complete before
 *  moving on.  A single-pass scroll + single detectBanners misses everything
 *  that wasn't loaded at the top of the page. */
async function progressiveScrollCapture(
  page: Page,
  pageType: 'homepage' | 'promotions',
  seenKeys: Set<string>
): Promise<Awaited<ReturnType<typeof detectBanners>>> {
  const collected: Awaited<ReturnType<typeof detectBanners>> = [];

  const addNew = async () => {
    const batch = await detectBanners(page, pageType);
    for (const b of batch) {
      const k = imageKey(b.src);
      if (!seenKeys.has(k)) { seenKeys.add(k); collected.push(b); }
    }
  };

  // Page / viewport dimensions
  const { pageH, viewH } = await page.evaluate(() => ({
    pageH: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    viewH: window.innerHeight,
  }));

  const STEP     = Math.round(viewH * 0.75); // 75% step → overlapping windows
  const MAX_STEPS = 25;                       // safety cap (~40 000px max)

  for (let step = 0; step <= MAX_STEPS; step++) {
    const scrollY = step * STEP;
    await page.evaluate(y => window.scrollTo(0, y), scrollY);

    // Fixed dwell: lazy-loaded images start at 0×0 until the proxy fetches them,
    // so a "smart" waitForFunction that checks dimensions exits immediately
    // (inView.length === 0 → true) before any image has loaded.
    // A guaranteed 3.5 s pause at each viewport position is simpler and reliable.
    // 3.5s covers borderline proxy latency including Cloud Run cold-start overhead.
    await page.waitForTimeout(3500);

    await addNew();

    if (scrollY + viewH >= pageH) break; // reached the bottom
  }

  // Return to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  return collected;
}

/** Given a list of banner candidates that may include the same image at
 *  multiple sizes, return only the largest version of each unique image. */
function deduplicateByIdentity<T extends { src: string; width: number; height: number }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const key = imageKey(item.src);
    const prev = best.get(key);
    if (!prev || item.width * item.height > prev.width * prev.height) {
      best.set(key, item);
    }
  }
  return Array.from(best.values());
}

export interface PageScrapeResult {
  tierResult: TierResult;
  homepageBanners: BannerImage[];
  promoBanners: BannerImage[];
}

export async function scrapeWithTier(
  url:      string,
  domain:   string,
  context:  BrowserContext,
  config:   TierConfig
): Promise<PageScrapeResult> {
  const page = await context.newPage();

  try {
    console.log(`  → Navigating to ${url}`);
    await page.goto(url, {
      waitUntil: config.waitUntil,
      timeout:    config.timeout,
    });

    // For proxy tiers: JS apps need time to hydrate after 'load' fires.
    // Wait until real content appears (images or text), up to 45 s.
    if (config.proxy !== 'none') {
      await page.waitForFunction(
        () => document.images.length >= 2 || (document.body?.innerText ?? '').trim().length >= 300,
        { timeout: 45_000 }
      ).catch(() => {}); // fall through to validator if still empty
    }

    // Extra settle time for JS-heavy / lazy-loading sites
    const settleMs = config.humanDelays ? 3000 : 1500;
    await page.waitForTimeout(settleMs);

    await takeScreenshot(page, `tier${config.tier}_loaded`);

    const validation = await validatePageSuccess(page, config.tier);
    if (!validation.success) {
      console.log(`  ✗ Tier ${config.tier} failed: ${validation.failureReason}`);
      await takeScreenshot(page, `tier${config.tier}_failed_${validation.failureReason}`);
      await page.close();
      return { tierResult: validation, homepageBanners: [], promoBanners: [] };
    }

    console.log(`  ✓ Page loaded OK — dismissing popups`);
    await dismissPopups(page);
    await takeScreenshot(page, 'popups_cleared');

    // Some sites (e.g. betway.com) do a geo-redirect 1-2s after initial load.
    // Detect it: if the URL changed after popup dismissal, wait for the new
    // destination to settle and re-dismiss popups there.
    {
      const urlAfterPopups = page.url();
      await page.waitForTimeout(2000);
      if (page.url() !== urlAfterPopups) {
        console.log(`  ↷ Post-load redirect detected → ${page.url()}`);
        await page.waitForLoadState('load').catch(() => {});
        await page.waitForTimeout(settleMs);
        await dismissPopups(page);
      }
    }

    if (config.humanDelays) await humanDelay(500, 1500);

    // ── Homepage banners (progressive carousel capture) ──────────────────────
    // Scroll to trigger lazy-loading of below-fold images first.
    await scrollToLoadImages(page).catch(async () => {
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(2000);
    });

    // Wait for initial large image to appear (JS-hydrated hero carousels on SPAs
    // take extra time through a proxy before the first slide image loads).
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('img')).some(img => {
        const r = img.getBoundingClientRect();
        return r.width >= 500 && r.height >= 150;
      }),
      { timeout: 30_000 }
    ).catch(() => {});

    // Progressive capture: sample banners BEFORE each carousel advance so every
    // slide is captured while it is active and its image is fully loaded through
    // the proxy. This is more reliable than advancing all-at-once then sampling
    // once, which misses slides whose images hadn't loaded yet.
    const homepageRaw: Awaited<ReturnType<typeof detectBanners>> = [];
    const seenHomeKeys = new Set<string>();

    const addHomeBanners = async () => {
      const batch = await detectBanners(page, 'homepage');
      for (const b of batch) {
        const k = imageKey(b.src);
        if (!seenHomeKeys.has(k)) { seenHomeKeys.add(k); homepageRaw.push(b); }
      }
    };

    // Residential proxy (Tier 4) needs longer dwell between slide advances:
    // images are fetched through a residential exit node which has higher latency
    // than a datacenter proxy. At 1800ms the next slide's image often hasn't loaded
    // yet, so it looks identical to the previous slide and gets deduped out.
    const carouselDwellMs = config.tier >= 4 ? 3500 : 1800;

    // Sample initial state (active slide)
    await addHomeBanners();

    // Try arrow-based advancement
    const nextArrow = await findCarouselNext(page);
    if (nextArrow) {
      for (let i = 0; i < 8; i++) {
        const ok = await advanceCarouselOnce(page, nextArrow, carouselDwellMs);
        if (!ok) break;
        await addHomeBanners();
      }
    } else {
      // Dot-based fallback (Swiper pagination bullets)
      const dots = await findCarouselDots(page);
      for (const dot of dots) {
        try { await dot.click(); } catch { continue; }
        await page.waitForTimeout(carouselDwellMs);
        await addHomeBanners();
      }
      if (!dots.length) {
        // Last resort: plain advanceCarousels so the carousel at least auto-rotates
        await advanceCarousels(page);
        await addHomeBanners();
      }
    }

    // Also scroll below the hero to pick up any promo-banner sections further
    // down the homepage (e.g. "Featured Promotions" grids below the carousel).
    // Reuse seenHomeKeys so already-found slides don't get counted twice.
    const belowFold = await progressiveScrollCapture(page, 'homepage', seenHomeKeys);
    homepageRaw.push(...belowFold);

    await takeScreenshot(page, `tier${config.tier}_banners_found`);
    console.log(`  Found ${homepageRaw.length} homepage banner candidate(s) (carousel + below-fold)`);

    // Deduplicate within homepage: same image at multiple sizes
    const homepageDeduped = deduplicateByIdentity(homepageRaw);
    if (homepageDeduped.length < homepageRaw.length) {
      console.log(`  ↩ Homepage: removed ${homepageRaw.length - homepageDeduped.length} size-duplicate(s)`);
    }

    const homepageBanners = await downloadBanners(context, homepageDeduped, domain, 'homepage');

    // ── Promotions page ─────────────────────────────────────────────────────
    let promoBanners: BannerImage[] = [];
    const promoUrl = await findPromotionsUrl(page, url);
    if (promoUrl) {
      console.log(`  → Promo page: ${promoUrl}`);
      emitProgress({ type: 'progress', domain, message: `Navigating to promo page…` });

      await page.goto(promoUrl, { waitUntil: config.waitUntil, timeout: config.timeout });
      if (config.proxy !== 'none') {
        await page.waitForFunction(
          () => document.images.length >= 2 || (document.body?.innerText ?? '').trim().length >= 300,
          { timeout: 45_000 }
        ).catch(() => {});
      }
      await page.waitForTimeout(settleMs);
      await takeScreenshot(page, `tier${config.tier}_promos_loaded`);

      const promoValidation = await validatePageSuccess(page, config.tier);
      if (promoValidation.success) {
        await dismissPopups(page);

        emitProgress({ type: 'progress', domain, message: `Promo page loaded — scanning for banners…` });

        // Wait for the above-fold content to hydrate before scrolling
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll('img')).some(img => {
            const r = img.getBoundingClientRect();
            return r.width >= 200 && r.height >= 100;
          }),
          { timeout: 30_000 }
        ).catch(() => {});

        // Progressive scroll capture: pauses at each viewport position and waits
        // for proxy-fetched lazy images to load before sampling and moving on.
        // This is the only reliable way to capture all promo cards when images
        // are lazy-loaded and the proxy adds latency to each image fetch.
        const promoRaw = await progressiveScrollCapture(page, 'promotions', new Set<string>());
        await takeScreenshot(page, `tier${config.tier}_promos_scraped`);
        console.log(`  Found ${promoRaw.length} promo banner candidate(s)`);

        // Deduplicate within promo page, then against homepage banners.
        const promoDeduped1 = deduplicateByIdentity(promoRaw);
        const homepageUrlSet = new Set(homepageDeduped.map(b => imageKey(b.src)));
        const promoDeduped = promoDeduped1.filter(b => !homepageUrlSet.has(imageKey(b.src)));
        const dupCount = promoRaw.length - promoDeduped.length;
        if (dupCount > 0) console.log(`  ↩ Skipped ${dupCount} duplicate(s) (within promo or already on homepage)`);

        emitProgress({ type: 'progress', domain, message: `Promo page: ${promoDeduped.length} banner(s) found` });
        promoBanners = await downloadBanners(context, promoDeduped, domain, 'promotions');
      } else {
        console.log(`  ⚠ Promo page blocked: ${promoValidation.failureReason}`);
        emitProgress({ type: 'progress', domain, message: `Promo page blocked (${promoValidation.failureReason})` });
      }
    } else {
      console.log(`  ℹ No promotions page found`);
      emitProgress({ type: 'progress', domain, message: `No promotions page found` });
    }

    await page.close();
    return {
      tierResult: { success: true, tier: config.tier },
      homepageBanners,
      promoBanners,
    };
  } catch (err) {
    console.error(`  ✗ Tier ${config.tier} error: ${(err as Error).message}`);
    await takeScreenshot(page, `tier${config.tier}_error`).catch(() => {});
    await page.close();
    return {
      tierResult: { success: false, failureReason: undefined, tier: config.tier },
      homepageBanners: [],
      promoBanners: [],
    };
  }
}
