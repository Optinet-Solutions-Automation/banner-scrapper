import { Page, BrowserContext } from 'playwright';
import { TierConfig, humanDelay } from './tiers/tier-config';
import { BannerImage, TierResult } from './types';
import { validatePageSuccess } from './tiers/validator';
import { dismissPopups } from './popup-handler';
import { advanceCarousels, scrollToLoadImages } from './carousel-handler';
import { detectBanners } from './banner-detector';
import { findPromotionsUrl } from './page-navigator';
import { downloadBanners } from './image-downloader';
import { takeScreenshot } from './screenshot';

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
  url:     string,
  domain:  string,
  context: BrowserContext,
  config:  TierConfig
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

    // ── Homepage banners ────────────────────────────────────────────────────
    await scrollToLoadImages(page).catch(async () => {
      // Navigation mid-scroll (context destroyed) — wait for it to settle
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(2000);
    });
    await advanceCarousels(page);

    // Some sites (e.g. betway.com, spinsup.com) use JS-hydrated carousels whose
    // images only appear after React/Vue/Rails initialises. Through a proxy the
    // JS takes longer — wait up to 30 s for a large image before giving up.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('img')).some(img => {
        const r = img.getBoundingClientRect();
        return r.width >= 500 && r.height >= 150;
      }),
      { timeout: 30_000 }
    ).catch(() => {}); // proceed even if none appear

    const homepageRaw = await detectBanners(page, 'homepage');
    await takeScreenshot(page, `tier${config.tier}_banners_found`);
    console.log(`  Found ${homepageRaw.length} homepage banner candidate(s)`);

    // Deduplicate within homepage: same image served at multiple sizes
    // (e.g. hero carousel at 1293×420 + promo card grid at 664×312).
    // Group by normalized image identity; keep the largest version of each.
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
        await scrollToLoadImages(page).catch(async () => {
          await page.waitForLoadState('load').catch(() => {});
          await page.waitForTimeout(2000);
        });

        // Wait for promo page images to hydrate — JS-heavy promo pages (SPAs,
        // Rails/React sites) render their cards after JS initialises, same as
        // the homepage carousel. Use 300 px width floor to match promo cards in
        // multi-column grids. Falls through immediately if nothing appears in 30 s.
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll('img')).some(img => {
            const r = img.getBoundingClientRect();
            return r.width >= 300 && r.height >= 150;
          }),
          { timeout: 30_000 }
        ).catch(() => {});

        const promoRaw = await detectBanners(page, 'promotions');
        await takeScreenshot(page, `tier${config.tier}_promos_scraped`);
        console.log(`  Found ${promoRaw.length} promo banner candidate(s)`);

        // Deduplicate within promo page, then against homepage banners.
        const promoDeduped1 = deduplicateByIdentity(promoRaw);
        const homepageUrlSet = new Set(homepageDeduped.map(b => imageKey(b.src)));
        const promoDeduped = promoDeduped1.filter(b => !homepageUrlSet.has(imageKey(b.src)));
        const dupCount = promoRaw.length - promoDeduped.length;
        if (dupCount > 0) console.log(`  ↩ Skipped ${dupCount} duplicate(s) (within promo or already on homepage)`);

        promoBanners = await downloadBanners(context, promoDeduped, domain, 'promotions');
      } else {
        console.log(`  ⚠ Promo page blocked: ${promoValidation.failureReason}`);
      }
    } else {
      console.log(`  ℹ No promotions page found`);
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
