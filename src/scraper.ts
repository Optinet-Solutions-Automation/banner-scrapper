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

  // Capture initial state (above-fold content)
  await addNew();

  // Measure viewport and identify the scroll target.
  // Many SPAs (React/Next.js) render inside a custom overflow:auto/scroll div rather
  // than scrolling the window — we must scroll THAT container or IO never fires for
  // below-fold cards.
  const { viewH, viewW } = await page.evaluate(() => ({
    viewH: window.innerHeight,
    viewW: window.innerWidth,
  }));

  const STEP     = Math.round(viewH * 0.7);   // ~70 % of viewport per step
  const MAX_STEPS = 30;
  let noNewCount  = 0;                         // consecutive steps with no new images

  // Position mouse at centre for mouse.wheel IO-trigger (avoids interactive elements
  // like carousel arrows near the edges).
  await page.mouse.move(Math.round(viewW / 2), Math.round(viewH / 2));

  for (let step = 0; step < MAX_STEPS; step++) {
    const targetY = (step + 1) * STEP;

    // ── Scroll via JS — handles both window and custom scroll containers ──
    const { windowScrollY, docScrollTop, containerScrollTop, pageH: pageHBefore } = await page.evaluate((y: number) => {
      // 1. Window-level scroll (all known variants)
      window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior });
      document.documentElement.scrollTop = y;
      document.body.scrollTop = y;

      // 2. Find and scroll the deepest container with excess scrollable content
      //    (extended: any overflow value, not just auto/scroll)
      let best: Element | null = null;
      let bestExcess = 0;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (el === document.body || el === document.documentElement) continue;
        const excess = (el as HTMLElement).scrollHeight - (el as HTMLElement).clientHeight;
        if (excess > 200 && excess > bestExcess) { bestExcess = excess; best = el; }
      }
      if (best) (best as HTMLElement).scrollTop = y;

      // 3. Dispatch native scroll events for Intersection Observer + event listeners
      window.dispatchEvent(new Event('scroll', { bubbles: true }));
      document.dispatchEvent(new Event('scroll', { bubbles: true }));
      if (best) best.dispatchEvent(new Event('scroll', { bubbles: true }));

      // 4. jQuery scroll trigger — jQuery plugins (.lazyload, slick, etc.) bind
      //    via $.fn.on('scroll') which sometimes doesn't fire on native dispatchEvent.
      //    Calling $(window).trigger('scroll') goes through jQuery's own event system.
      const jq = (window as any).jQuery || (window as any).$;
      if (jq && typeof jq.fn !== 'undefined') {
        try { jq(window).trigger('scroll'); }   catch {}
        try { jq(document).trigger('scroll'); } catch {}
        if (best) try { jq(best).trigger('scroll'); } catch {}
      }

      return {
        windowScrollY: window.scrollY,
        docScrollTop:  document.documentElement.scrollTop,
        containerScrollTop: best ? (best as HTMLElement).scrollTop : -1,
        pageH: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      };
    }, targetY);

    // ── Physical scroll events (browser-native, cannot be prevented by JS) ──
    await page.mouse.wheel(0, STEP);   // large WheelEvent delta
    await page.keyboard.press('PageDown'); // moves focused element's scroll container

    // Give IO callbacks, jQuery lazy handlers, and proxy image fetches time to run.
    await page.waitForTimeout(2500);

    // Wait until near-viewport images have finished loading (or 7 s timeout).
    await page.waitForFunction(
      () => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const nearView = imgs.filter(img => {
          const r = img.getBoundingClientRect();
          return r.top < window.innerHeight + 200 && r.bottom > -200;
        });
        return nearView.every(img => {
          const src = img.getAttribute('src') ?? '';
          if (!src || src.startsWith('data:')) return true;
          return img.complete;
        });
      },
      { timeout: 7000 }
    ).catch(() => {});

    // Read pageH AFTER the wait — AJAX pagination may have added new rows during the dwell.
    // (Reading it before the wait gives stale data and pageHGrew was always false.)
    const pageHAfter = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    );

    const countBefore = collected.length;
    await addNew();

    const pageHGrew = pageHAfter > pageHBefore + 100;
    if (collected.length === countBefore && !pageHGrew) {
      noNewCount++;
    } else {
      noNewCount = 0; // reset — new banners found OR AJAX added new rows
    }

    // Debug: emit per-step info to terminal
    emitProgress({ type: 'progress', domain: '', message:
      `Scroll step ${step + 1}: target=${targetY} win=${windowScrollY} doc=${docScrollTop} cont=${containerScrollTop} pageH=${pageHBefore}→${pageHAfter} imgs=${collected.length} noNew=${noNewCount}` });

    // Only early-exit when we've covered ≥80% of the (possibly grown) page AND had 6 empty steps.
    const pctCovered = (targetY + viewH) / pageHAfter;
    if (targetY + viewH >= pageHAfter || (noNewCount >= 6 && pctCovered >= 0.8)) break;
  }

  // ── Force-load pass ─────────────────────────────────────────────────────
  // Strategy A: data-src copy — handle attribute-based lazy loaders (jQuery lazyload, etc.)
  // This is pure DOM manipulation — not detectable as bot-like scrolling.
  const forcedDataSrc = await page.evaluate(() => {
    let n = 0;
    for (const img of Array.from(document.querySelectorAll('img')) as HTMLImageElement[]) {
      const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy')
                   || img.getAttribute('data-original') || img.getAttribute('data-lazysrc') || '';
      if (dataSrc && (!img.src || img.src.startsWith('data:') || img.src === window.location.href)) {
        img.src = dataSrc; n++;
      }
    }
    return n;
  });

  // Strategy B: slow reverse scroll (bottom → top) — re-triggers IO for any images
  // the forward pass missed, without the rapid per-element jumping that bot detectors catch.
  // We do this with gentle mouse.wheel nudges, spaced out to look human.
  {
    const { pageH: finalPageH, viewH: finalViewH } = await page.evaluate(() => ({
      pageH: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      viewH: window.innerHeight,
    }));
    // Scroll to absolute bottom first (catches anything at very end of page)
    await page.evaluate((h) => window.scrollTo(0, h), finalPageH);
    await page.mouse.wheel(0, 3);
    await page.waitForTimeout(2000);
    await addNew();

    // Now scroll back up in 3 big steps — gives IO another chance per section
    const reverseStep = Math.round(finalViewH * 1.5);
    for (let pos = finalPageH - reverseStep; pos > 0; pos -= reverseStep) {
      await page.evaluate((y) => window.scrollTo(0, y), pos);
      await page.mouse.wheel(0, -3);
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(forcedDataSrc > 0 ? 3000 : 2000);
  }

  // Final sweep — catches anything loaded during the force-load pass.
  const beforeFinal = collected.length;
  await addNew();
  emitProgress({ type: 'progress', domain: '', message:
    `Force-load pass: dataSrc=${forcedDataSrc} new=${collected.length - beforeFinal}` });

  // Return to top.
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

    let validation = await validatePageSuccess(page, config.tier);

    // On residential proxy (Tier 4): Cloudflare Turnstile sometimes auto-solves
    // within 10-20 s for residential IPs. Wait and re-check before giving up.
    if (!validation.success && validation.failureReason === 'cloudflare_challenge' && config.tier >= 4) {
      console.log(`  ⏳ CF challenge on residential proxy — waiting 18s for auto-resolve…`);
      emitProgress({ type: 'progress', domain, message: 'CF challenge detected — waiting for auto-resolve…' });
      await page.waitForTimeout(18_000);
      validation = await validatePageSuccess(page, config.tier);
      if (validation.success) {
        console.log(`  ✓ CF challenge resolved after wait`);
      }
    }

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
    // 8s timeout: CSS-background carousels (e.g. mystake888 g-slide) have no
    // <img> elements at banner size — don't waste 30s waiting for them.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('img')).some(img => {
        const r = img.getBoundingClientRect();
        return r.width >= 500 && r.height >= 150;
      }),
      { timeout: 8_000 }
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
        // No clickable controls found — auto-rotating carousel (e.g. vertical-slider).
        // Sample at intervals so each slide gets captured as it cycles through.
        // advanceCarousels also tries keyboard ArrowRight as a last resort.
        await advanceCarousels(page);
        for (let i = 0; i < 3; i++) {
          await addHomeBanners();
          await page.waitForTimeout(5000);
        }
        await addHomeBanners(); // final sample
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

      // Pause like a human before clicking away to another section.
      // Sites with Cloudflare Turnstile or bot-score checks flag immediate
      // programmatic navigation (< 1 s after page load) as suspicious.
      await humanDelay(1500, 3500);

      // Prefer click-based navigation over raw page.goto() — it preserves
      // session state and looks more human-like to anti-bot systems.
      const promoPath = new URL(promoUrl).pathname + new URL(promoUrl).search;
      const navLink = await page.$(`a[href="${promoPath}"], a[href="${promoUrl}"]`).catch(() => null);
      let navigatedViaClick = false;
      if (navLink && await navLink.isVisible().catch(() => false)) {
        await navLink.scrollIntoViewIfNeeded().catch(() => {});
        await humanDelay(300, 700);
        await navLink.click().catch(() => {});
        await page.waitForLoadState(config.waitUntil as 'load' | 'domcontentloaded' | 'networkidle').catch(() => {});
        navigatedViaClick = true;
        console.log(`  → Navigated via nav click`);
      }
      if (!navigatedViaClick) {
        await page.goto(promoUrl, { waitUntil: config.waitUntil, timeout: config.timeout });
      }
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

        // Wait for promotional content to load.
        // Handles two cases:
        //   1. <img>-based promo cards (Next.js SPAs that fetch data via API after hydration)
        //   2. CSS-background promo cards (e.g. mystake888.com uses div.promo-img with
        //      background-image URLs — no <img> elements at all on the promo page)
        await page.waitForFunction(
          () => {
            // Case 1: <img> elements (API-loaded promo cards)
            const imgs = Array.from(document.querySelectorAll('img'));
            const largeImgs = imgs.filter(img => {
              const r = img.getBoundingClientRect();
              return (r.width >= 400 && r.height >= 80) ||
                     (img.naturalWidth >= 400 && img.naturalHeight >= 80);
            });
            if (largeImgs.length >= 3) return true;

            // Case 2: CSS background promo cards
            const bgEls = Array.from(document.querySelectorAll(
              '[class*="promo"],[class*="banner"],[class*="offer"],[class*="card"],[class*="deal"]'
            ));
            const largeBg = bgEls.filter(el => {
              const r = el.getBoundingClientRect();
              const bg = (window.getComputedStyle(el) as CSSStyleDeclaration).backgroundImage;
              return r.width >= 300 && r.height >= 80 && bg !== 'none' && bg.includes('url(');
            });
            return largeBg.length >= 3;
          },
          { timeout: 30_000 }
        ).catch(() => {});

        // Progressive scroll capture: pauses at each viewport position and waits
        // for proxy-fetched lazy images to load before sampling and moving on.
        // This is the only reliable way to capture all promo cards when images
        // are lazy-loaded and the proxy adds latency to each image fetch.
        const promoRaw = await progressiveScrollCapture(page, 'promotions', new Set<string>());
        await takeScreenshot(page, `tier${config.tier}_promos_scraped`);
        console.log(`  Found ${promoRaw.length} promo banner candidate(s)`);
        emitProgress({ type: 'progress', domain, message: `Promo raw: ${promoRaw.length} detected` });

        // Deduplicate within promo page, then against homepage banners.
        const promoDeduped1 = deduplicateByIdentity(promoRaw);
        const homepageUrlSet = new Set(homepageDeduped.map(b => imageKey(b.src)));
        const urlFiltered = promoDeduped1.filter(b => homepageUrlSet.has(imageKey(b.src)));
        const promoDeduped = promoDeduped1.filter(b => !homepageUrlSet.has(imageKey(b.src)));
        const dupCount = promoRaw.length - promoDeduped.length;
        if (dupCount > 0) console.log(`  ↩ Skipped ${dupCount} duplicate(s) (within promo or already on homepage)`);
        if (urlFiltered.length > 0) {
          emitProgress({ type: 'progress', domain, message: `URL-deduped away: ${urlFiltered.map(b => `${b.width}×${b.height}`).join(', ')}` });
        }

        emitProgress({ type: 'progress', domain, message: `Promo unique: ${promoDeduped.length} (after URL dedup vs homepage)` });
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
