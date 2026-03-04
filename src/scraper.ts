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

    const homepageBanners = await downloadBanners(context, homepageRaw, domain, 'homepage');

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

        // Deduplicate against homepage: skip promo images whose URL path already
        // appeared as a homepage banner (same visual, different page context).
        // Strip query params for comparison UNLESS the URL is a proxy path where
        // the query string IS the image identity (Next.js /_next/image, Cloudflare
        // /cdn-cgi/image) — in those cases use the full URL.
        const normalizeUrl = (src: string) => {
          try {
            const u = new URL(src);
            if (u.pathname.includes('/_next/image') || u.pathname.includes('/cdn-cgi/image')) {
              return src;
            }
            return u.origin + u.pathname;
          } catch { return src; }
        };
        const homepageUrlSet = new Set(homepageRaw.map(b => normalizeUrl(b.src)));
        const promoDeduped = promoRaw.filter(b => !homepageUrlSet.has(normalizeUrl(b.src)));
        const dupCount = promoRaw.length - promoDeduped.length;
        if (dupCount > 0) console.log(`  ↩ Skipped ${dupCount} duplicate(s) already on homepage`);

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
