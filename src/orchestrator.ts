import { ScrapeResult, FailureReason } from './types';
import { TIER_CONFIGS } from './tiers/tier-config';
import { launchBrowser } from './tiers/browser-launcher';
import { effectiveStartTier, saveSiteMemory, getSiteMemory } from './site-memory';
import { scrapeWithTier } from './scraper';
import { cleanupScreenshots } from './screenshot';
import { deliverOutput } from './output';
import { config, proxyServer } from './config';
import { emitProgress } from './progress-emitter';

// Geo order to try when a site has no stored geo (cheapest/most permissive first)
const GEO_AUTO_ORDER = ['ca', 'gb', 'au', 'se', 'in', 'us'];

// Failure reasons where changing geo might help
const GEO_SENSITIVE = new Set<FailureReason | undefined>([
  FailureReason.GEO_BLOCKED,
  FailureReason.ACCESS_DENIED,
  FailureReason.EMPTY_PAGE,
  FailureReason.CONTENT_MISSING,
]);

// Failure reasons where geo change won't help — escalate tier immediately
const TIER_ESCALATE = new Set<FailureReason | undefined>([
  FailureReason.CLOUDFLARE_CHALLENGE,
  FailureReason.BOT_DETECTED,
  FailureReason.CAPTCHA_DETECTED,
]);

export async function scrapeSite(url: string, geoOverride?: string): Promise<ScrapeResult> {
  const domain = new URL(url).hostname.replace(/^www\./, '');
  const startTier = effectiveStartTier(domain);
  const maxTier   = config.maxTier;
  const savedEntry = getSiteMemory(domain);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Scraping: ${url}`);
  console.log(`Starting at Tier ${startTier} (max: ${maxTier})`);
  console.log('='.repeat(60));

  emitProgress({ type: 'site_start', domain, url });

  const result: ScrapeResult = {
    url,
    domain,
    tier:            -1,
    homepageBanners: [],
    promoBanners:    [],
    success:         false,
    scrapedAt:       new Date().toISOString(),
  };

  // Save original global geo so we can restore after this site finishes
  const originalGeo = config.dcProxy.geo;

  // Priority: explicit override > site memory > leave global config unchanged
  const preferredGeo = geoOverride || savedEntry?.workingGeo || null;
  if (preferredGeo) {
    config.dcProxy.geo = preferredGeo;
    console.log(`  Geo: ${preferredGeo.toUpperCase()} (${geoOverride ? 'override' : 'from memory'})`);
  }

  try {
    for (let tier = startTier; tier <= maxTier; tier++) {
      const tierCfg = TIER_CONFIGS[tier];
      console.log(`\n[Tier ${tier}] ${tierCfg.name}`);
      emitProgress({ type: 'tier', domain, tier, message: `[Tier ${tier}] ${tierCfg.name}` });

      // Check proxy availability
      if (tierCfg.proxy !== 'none') {
        const server = proxyServer(tierCfg.proxy);
        if (!server) {
          console.log(`  ⚠ Tier ${tier} requires ${tierCfg.proxy} proxy but none configured — skipping`);
          emitProgress({ type: 'progress', domain, message: `Tier ${tier} skipped — ${tierCfg.proxy} proxy not configured` });
          continue;
        }
      }

      // ── Datacenter proxy tier: auto-geo detection ─────────────────────────────
      if (tierCfg.proxy === 'datacenter') {
        // If we have a preferred geo (from memory or override), use just that.
        // Otherwise cycle through all geos until one works.
        const geosToTry = preferredGeo ? [preferredGeo] : GEO_AUTO_ORDER;
        let tier3Succeeded = false;

        geoLoop: for (const geo of geosToTry) {
          config.dcProxy.geo = geo;
          if (geosToTry.length > 1) {
            console.log(`  [Auto-geo] Trying ${geo.toUpperCase()}…`);
            emitProgress({ type: 'geo_try', domain, tier, geo, message: `Trying geo: ${geo.toUpperCase()}` });
          }

          for (let attempt = 1; attempt <= tierCfg.retries; attempt++) {
            if (attempt > 1) console.log(`  Retry ${attempt}/${tierCfg.retries}`);

            const { browser, context } = await launchBrowser(tierCfg, attempt - 1);
            try {
              const pageResult = await scrapeWithTier(url, domain, context, tierCfg);

              if (pageResult.tierResult.success) {
                // Page loaded OK but no banners found.
                // Could be a cold-start / proxy-latency issue (images didn't load in
                // the dwell window) OR genuine geo-targeted content.
                // Retry the same geo once before giving up — this catches cold-start
                // cases where the second attempt on a warm container succeeds.
                // Only move to the next geo after ALL retries return 0 banners.
                if (pageResult.homepageBanners.length === 0 && geosToTry.length > 1) {
                  if (attempt < tierCfg.retries) {
                    console.log(`  ⚠ 0 banners at ${geo.toUpperCase()} — retrying same geo (attempt ${attempt}/${tierCfg.retries})`);
                    emitProgress({ type: 'progress', domain, message: `0 banners at ${geo.toUpperCase()} — retrying` });
                    continue; // retry same geo with same attempt counter
                  }
                  console.log(`  ⚠ 0 banners at ${geo.toUpperCase()} after ${attempt} attempts — trying next geo`);
                  emitProgress({ type: 'progress', domain, message: `0 banners at ${geo.toUpperCase()} — trying next geo` });
                  break; // break attempt loop → continue geoLoop
                }

                result.tier            = tier;
                result.geo             = geo;
                result.homepageBanners = pageResult.homepageBanners;
                result.promoBanners    = pageResult.promoBanners;
                result.success         = true;

                saveSiteMemory(domain, {
                  lastSuccessfulTier: tier,
                  lastScraped:        new Date().toISOString(),
                  workingGeo:         geo,
                });

                console.log(`\n✅ SUCCESS — Tier ${tier} (${geo.toUpperCase()}) | ${result.homepageBanners.length} homepage + ${result.promoBanners.length} promo banners`);
                await deliverOutput(result);
                emitProgress({ type: 'site_done', domain, result });
                tier3Succeeded = true;
                return result;
              }

              const reason = pageResult.tierResult.failureReason;
              console.log(`  ✗ Tier ${tier} (${geo.toUpperCase()}) failed: ${reason}`);
              emitProgress({ type: 'tier_fail', domain, tier, geo, reason: reason as string });

              if (TIER_ESCALATE.has(reason)) {
                break geoLoop;  // CF/bot block — geo won't help, escalate tier
              }
              if (GEO_SENSITIVE.has(reason)) {
                break;  // geo-specific block — break attempt loop, try next geo
              }
              // timeout or other → attempt loop retries same geo

            } finally {
              await context.close().catch(() => {});
              await browser.close().catch(() => {});
            }
          }
        }

        if (!tier3Succeeded) {
          emitProgress({ type: 'progress', domain, message: `Tier ${tier} exhausted — escalating` });
          console.log(`  → Escalating to Tier ${tier + 1}…`);
        }
        continue;  // move to next tier
      }

      // ── Standard tiers (1, 2, 4) ─────────────────────────────────────────────
      let attempt = 0;
      while (attempt < tierCfg.retries) {
        attempt++;
        if (attempt > 1) console.log(`  Retry ${attempt}/${tierCfg.retries}`);

        const { browser, context } = await launchBrowser(tierCfg, attempt - 1);
        try {
          const pageResult = await scrapeWithTier(url, domain, context, tierCfg);

          if (pageResult.tierResult.success) {
            // Page loaded but 0 banners — geo-targeted content from this IP.
            // Escalate so Tier 3 can try with a proxy/different exit country.
            if (pageResult.homepageBanners.length === 0 && tier < maxTier) {
              console.log(`  ⚠ 0 banners found at Tier ${tier} — escalating for geo diversity`);
              emitProgress({ type: 'progress', domain, message: `0 banners at Tier ${tier} — escalating` });
              break; // break attempt loop → outer for-loop moves to tier+1
            }

            result.tier            = tier;
            result.geo             = config.dcProxy.geo || undefined;
            result.homepageBanners = pageResult.homepageBanners;
            result.promoBanners    = pageResult.promoBanners;
            result.success         = true;

            // Preserve any stored geo when saving (non-proxy tiers don't change geo)
            saveSiteMemory(domain, {
              lastSuccessfulTier: tier,
              lastScraped:        new Date().toISOString(),
              workingGeo:         savedEntry?.workingGeo,
            });

            console.log(`\n✅ SUCCESS — Tier ${tier} | ${result.homepageBanners.length} homepage + ${result.promoBanners.length} promo banners`);
            await deliverOutput(result);
            emitProgress({ type: 'site_done', domain, result });
            return result;
          }

          const reason = pageResult.tierResult.failureReason;
          emitProgress({ type: 'tier_fail', domain, tier, reason: reason as string });
          if (reason === FailureReason.GEO_BLOCKED || reason === FailureReason.CLOUDFLARE_CHALLENGE) break;

        } finally {
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        }
      }

      console.log(`  → Escalating to Tier ${tier + 1}…`);
    }
  } finally {
    // Always restore the global geo setting so next site starts fresh
    config.dcProxy.geo = originalGeo;
  }

  // Give the user a specific, actionable error rather than a generic one.
  // Inspect what the last known failure mode was so they know what to do.
  const maxConfigured = config.maxTier;
  if (maxConfigured < 4) {
    result.error =
      'Needs Tier 4 (residential proxy) — datacenter proxy is blocked by this site. ' +
      'Set MAX_TIER=4 and configure RES_PROXY_* env vars to scrape it.';
  } else {
    result.error =
      'All tiers exhausted — site is unreachable even with residential proxy. ' +
      'It may require manual login, age-gate bypass, or is region-locked worldwide.';
  }
  console.log(`\n❌ FAILED — ${result.error}`);
  emitProgress({ type: 'site_done', domain, result });
  return result;
}

export async function runScraper(urls: string[], geoOverride?: string): Promise<ScrapeResult[]> {
  const results: ScrapeResult[] = [];

  emitProgress({ type: 'start', total: urls.length });

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];

    // Give the proxy a cooldown between sites to avoid rate-limiting.
    // 15 s is enough for Oxylabs Web Unblocker to recycle its session pool.
    if (i > 0) {
      console.log(`\n  ⏳ Cooling down 15 s before next site…`);
      emitProgress({ type: 'progress', message: 'Cooling down 15s before next site…' });
      await new Promise(r => setTimeout(r, 15_000));
    }

    try {
      const res = await scrapeSite(url, geoOverride);
      results.push(res);
    } catch (err) {
      console.error(`Fatal error scraping ${url}:`, err);
      const domain = (() => { try { return new URL(url).hostname; } catch { return url; } })();
      const failResult: ScrapeResult = {
        url,
        domain,
        tier:            -1,
        homepageBanners: [],
        promoBanners:    [],
        success:         false,
        error:           (err as Error).message,
        scrapedAt:       new Date().toISOString(),
      };
      results.push(failResult);
      emitProgress({ type: 'site_done', domain, result: failResult });
    } finally {
      cleanupScreenshots();
    }
  }

  emitProgress({ type: 'done', results });
  return results;
}
