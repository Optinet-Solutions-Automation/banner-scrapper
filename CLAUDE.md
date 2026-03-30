# Casino & Gaming Site Banner Scraper

## Project Overview

An automated web scraper that extracts **banner images only** (not logos, game thumbnails, icons, or UI elements) from casino/gaming websites. It visits the homepage for banners, then navigates to the promotions page and scrapes banners there too. Scraped images feed into an n8n automation pipeline for AI-powered image analysis and prompt reverse-engineering.

**Core Principle: Progressive Escalation.** Not all sites need heavy artillery. The scraper starts with the lightest, cheapest, fastest method and only escalates to heavier methods when the current tier fails. This saves proxy costs, reduces latency, and avoids unnecessary complexity per site.

- **Backend / Scraper**: Node.js 24 + TypeScript + Playwright — deployed on Google Cloud Run
- **Frontend**: Next.js 15 (React, Tailwind) — deployed on Vercel
- **Proxy**: Oxylabs Web Unblocker (Tier 3 datacenter) — Tier 4 residential not yet configured
- **Storage**: Google Cloud Storage + n8n webhook (`https://automateoptinet.app.n8n.cloud/webhook/analyze`)
- **GCP Project**: `formidable-sol-490711-f0` (sandbox@optinetsolutions.com)
- **Cloud Run URL**: `https://banner-scraper-69452143295.us-central1.run.app`
- **Vercel URL**: `https://banner-scrapper.vercel.app`
- **Repo**: GitHub (auto-deploys Vercel on push)

---

## Summary

**What this project is:** Casino banner scraper with 4-tier progressive anti-detection escalation
**Main rule:** Only escalate proxy/stealth cost when the cheaper tier actually fails
**Never break:** tier escalation logic, site memory, banner detection scoring, auto-geo detection
**Always do:** auto-commit + push + Cloud Run deploy after every change, screenshot UI changes

---

## How the App Works

```
1. User pastes casino URL(s) into the web UI (Vercel frontend)
   ↓
2. Frontend streams SSE from Cloud Run backend (/scrape-stream)
   ↓
3. Orchestrator picks starting tier from sites.json (or Tier 1 if new site)
   ↓
4. Playwright loads the site → validates (no captcha/block/geo-restriction)
   ↓
5. If blocked → escalate to next tier (up to Tier 4)
   ↓
6. On success: scrape homepage banners + navigate to /promotions → scrape promo banners
   ↓
7. Images uploaded to Google Drive + n8n webhook triggers AI prompt analysis
   ↓
8. Results + thumbnails shown in web UI; site memory updated with working tier + geo
```

---

## What Should NOT Change

- The 4-tier escalation order and logic in `orchestrator.ts`
- The banner scoring algorithm in `banner-detector.ts` (min score 14, SVG/GIF/portrait hard-excluded)
- The `sites.json` schema (domain → `{ lastSuccessfulTier, workingGeo, lastScraped }`)
- The SSE streaming protocol between frontend and backend (`/scrape-stream`)
- The auto-geo detection order: `ca → ph → gb → au → se → in → us → de → sg → nz`
- Google Drive folder structure: `BannerBot/{domain}/{YYYY-MM-DD_HH-MM}/hp_01.webp`

---

## Known Constraints

- Cloud Run timeout: 3600s (set), memory: 2Gi — do not reduce
- Cloud Run concurrency: 1 (each instance handles one scrape job — Playwright is memory-hungry)
- Oxylabs Web Unblocker: single port 60000, protocol HTTPS, geo via username suffix
- `MAX_TIER=3` in `.env` — Tier 4 residential proxy not yet configured (needs `RES_PROXY_*` vars)
- 15s inter-site cooldown in `orchestrator.ts` — prevents Oxylabs rate-limiting, do not remove
- `MIN_BANNER_WIDTH=500`, `MIN_BANNER_HEIGHT=150` — current production values
- n8n webhook expects `{ sites: [{ domain, driveFolderId, driveFolderUrl }] }` shape
- Google Drive uses OAuth2 refresh token (not service account) — token for hannahporter1905@gmail.com
- Windows dev environment: use `powershell -ExecutionPolicy Bypass -Command "..."` for all shell commands

---

## Progressive Escalation Strategy (The Heart of the System)

The scraper attempts **4 tiers** in order. Each tier only activates if the previous one fails. Failure is detected automatically via success validators (page loaded? content present? not blocked?).

```
┌─────────────────────────────────────────────────────────────────────┐
│                     TIER 1: Vanilla Playwright                      │
│  Plain headless Chromium. No proxy. No stealth. No tricks.          │
│  Cost: FREE | Speed: FASTEST | Works for: ~40% of sites            │
│                                                                     │
│  ✓ Success → Scrape banners → Done                                  │
│  ✗ Fail (blocked/captcha/geo-block/timeout) → Escalate to Tier 2   │
├─────────────────────────────────────────────────────────────────────┤
│                  TIER 2: Playwright + Stealth                       │
│  Stealth plugin enabled. Patches fingerprints, navigator props.     │
│  Still NO proxy. Random UA, human-like delays.                      │
│  Cost: FREE | Speed: FAST | Works for: ~25% more sites             │
│                                                                     │
│  ✓ Success → Scrape banners → Done                                  │
│  ✗ Fail → Escalate to Tier 3                                        │
├─────────────────────────────────────────────────────────────────────┤
│              TIER 3: Playwright + Stealth + Datacenter Proxy        │
│  Add datacenter proxy (cheaper than residential).                   │
│  Stealth still active. Rotates proxy on retry.                      │
│  Cost: LOW | Speed: MODERATE | Works for: ~20% more sites          │
│                                                                     │
│  ✓ Success → Scrape banners → Done                                  │
│  ✗ Fail → Escalate to Tier 4                                        │
├─────────────────────────────────────────────────────────────────────┤
│          TIER 4: Playwright + Stealth + Residential Proxy           │
│  Full power. Residential proxy (hardest to detect).                 │
│  Geo-targeted exit node to match site's allowed regions.            │
│  Maximum human-like behavior. Longer delays.                        │
│  Cost: HIGH | Speed: SLOWEST | Works for: remaining ~15% of sites  │
│                                                                     │
│  ✓ Success → Scrape banners → Done                                  │
│  ✗ Fail → Log as unreachable, flag for manual review                │
└─────────────────────────────────────────────────────────────────────┘
```

### Failure Detection (How to Know When to Escalate)

The system checks these signals after each tier attempt:

```typescript
interface TierResult {
  success: boolean;
  failureReason?: FailureReason;
  screenshot?: string;       // always captured for Claude to inspect
  pageContent?: string;      // raw HTML snippet for analysis
  statusCode?: number;
  tier: number;
}

enum FailureReason {
  CLOUDFLARE_CHALLENGE = 'cloudflare_challenge',   // detected CF challenge page
  CAPTCHA_DETECTED = 'captcha_detected',           // CAPTCHA present
  GEO_BLOCKED = 'geo_blocked',                     // region restriction page
  ACCESS_DENIED = 'access_denied',                 // 403/401 response
  TIMEOUT = 'timeout',                             // page didn't load in time
  EMPTY_PAGE = 'empty_page',                       // page loaded but no content (JS not rendered)
  BOT_DETECTED = 'bot_detected',                   // explicit "bot detected" message
  CONNECTION_REFUSED = 'connection_refused',        // network-level block
  CONTENT_MISSING = 'content_missing',             // page loaded but expected elements missing
  HARD_BLOCKED = 'hard_blocked',                   // completely blank page — IP-level block
}
```

### Detection Logic

```typescript
async function validatePageSuccess(page: Page): Promise<TierResult> {
  const url = page.url();
  const title = await page.title();
  const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '');

  // Check for Cloudflare challenge
  if (bodyText.includes('Checking your browser') ||
      bodyText.includes('cf-browser-verification') ||
      title.includes('Just a moment')) {
    return { success: false, failureReason: FailureReason.CLOUDFLARE_CHALLENGE };
  }

  // Check for CAPTCHA
  if (bodyText.includes('captcha') ||
      await page.$('iframe[src*="captcha"]') ||
      await page.$('.g-recaptcha, .h-captcha')) {
    return { success: false, failureReason: FailureReason.CAPTCHA_DETECTED };
  }

  // Check for geo-blocking
  if (bodyText.match(/not available.*(your|this) (region|country|location)/i) ||
      bodyText.match(/restricted.*(jurisdiction|territory)/i)) {
    return { success: false, failureReason: FailureReason.GEO_BLOCKED };
  }

  // Check for bot detection
  if (bodyText.match(/bot.*detected/i) ||
      bodyText.match(/automated.*access.*denied/i)) {
    return { success: false, failureReason: FailureReason.BOT_DETECTED };
  }

  // Hard block: completely blank page (IP-level, no geo cycling will help)
  const imageCount = await page.$$eval('img', imgs => imgs.length);
  if (title === '' && bodyText.length === 0 && imageCount === 0) {
    return { success: false, failureReason: FailureReason.HARD_BLOCKED };
  }

  // Check for empty/broken page (JS didn't render)
  if (imageCount < 3 && bodyText.length < 500) {
    return { success: false, failureReason: FailureReason.EMPTY_PAGE };
  }

  return { success: true };
}
```

### Geo Failure Classification

```
GEO_SENSITIVE (try next geo, same tier):
  geo_blocked, access_denied, empty_page, content_missing, bot_detected

TIER_ESCALATE (skip remaining geos, move to next tier):
  cloudflare_challenge, captcha_detected, hard_blocked
```

### Tier-Specific Configurations

```typescript
const TIER_CONFIGS = {
  1: {
    name: 'Vanilla Playwright',
    stealth: false,
    proxy: null,
    userAgentRotation: false,
    humanDelays: false,
    timeout: 30_000,
    retries: 1,
  },
  2: {
    name: 'Playwright + Stealth',
    stealth: true,
    proxy: null,
    userAgentRotation: true,
    humanDelays: true,
    timeout: 45_000,
    retries: 2,
  },
  3: {
    name: 'Stealth + Datacenter Proxy',
    stealth: true,
    proxy: 'datacenter',
    userAgentRotation: true,
    humanDelays: true,
    timeout: 60_000,
    retries: 2,
  },
  4: {
    name: 'Stealth + Residential Proxy',
    stealth: true,
    proxy: 'residential',
    userAgentRotation: true,
    humanDelays: true,
    geoTargeting: true,
    timeout: 90_000,
    retries: 3,
  },
};
```

### Site Memory (Learn From Past Attempts)

The system remembers which tier and geo worked for each site so it doesn't waste time re-escalating on future runs:

```typescript
// sites.json stores the last successful tier + geo per domain
{
  "bet365.com": { "lastSuccessfulTier": 4, "workingGeo": "gb", "lastScraped": "2025-03-01T..." },
  "leovegas.com": { "lastSuccessfulTier": 3, "workingGeo": "ca", "lastScraped": "2025-03-01T..." }
}

// On subsequent runs, START at the last known successful tier + geo
// But periodically retry lower tiers (every 7 days) in case site changed
```

### Auto-Geo Detection

On Tier 3 for sites with no stored geo, orchestrator tries geos in order:
`ca → ph → gb → au → se → in → us → de → sg → nz`

Working geo is saved to `sites.json` as `workingGeo` field. Subsequent runs use stored geo directly.
`--geo=XX` CLI flag and UI geo dropdown both override stored geo.

### Orchestrator Flow

```typescript
async function scrapeSite(url: string): Promise<ScrapeResult> {
  const domain = new URL(url).hostname;
  const siteMemory = await loadSiteMemory(domain);

  // Start at last known tier, or tier 1 if first time
  const startTier = siteMemory?.lastSuccessfulTier ?? 1;
  // Periodically retry from tier 1 to check if lower tier works now
  const daysSinceLastScrape = siteMemory ? daysBetween(siteMemory.lastScraped, now()) : Infinity;
  const effectiveStartTier = daysSinceLastScrape > 7 ? 1 : startTier;

  for (let tier = effectiveStartTier; tier <= 4; tier++) {
    const config = TIER_CONFIGS[tier];
    console.log(`[${domain}] Attempting Tier ${tier}: ${config.name}`);

    const browser = await launchBrowser(config);
    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: config.timeout });
      await dismissPopups(page);
      await takeDebugScreenshot(page, `tier${tier}_loaded`);

      const validation = await validatePageSuccess(page);

      if (!validation.success) {
        console.log(`[${domain}] Tier ${tier} failed: ${validation.failureReason}`);
        await takeDebugScreenshot(page, `tier${tier}_failed_${validation.failureReason}`);
        await browser.close();
        continue; // escalate to next tier
      }

      // SUCCESS — scrape banners
      console.log(`[${domain}] Tier ${tier} SUCCESS — scraping banners`);
      const homepageBanners = await scrapeBanners(page);
      await takeDebugScreenshot(page, `tier${tier}_banners_found`);

      // Navigate to promotions
      const promoUrl = await findPromotionsPage(page);
      let promoBanners: BannerImage[] = [];
      if (promoUrl) {
        await page.goto(promoUrl, { waitUntil: 'networkidle', timeout: config.timeout });
        await dismissPopups(page);
        await takeDebugScreenshot(page, `tier${tier}_promos_loaded`);
        promoBanners = await scrapeBanners(page);
        await takeDebugScreenshot(page, `tier${tier}_promos_scraped`);
      }

      // Save successful tier to memory
      await saveSiteMemory(domain, { lastSuccessfulTier: tier, lastScraped: new Date() });

      await browser.close();
      return {
        url,
        tier,
        homepageBanners,
        promoBanners,
        success: true,
      };
    } catch (error) {
      console.log(`[${domain}] Tier ${tier} error: ${error.message}`);
      await takeDebugScreenshot(page, `tier${tier}_error`);
      await browser.close();
      continue; // escalate
    }
  }

  // All tiers exhausted
  console.log(`[${domain}] ALL TIERS FAILED — flagging for manual review`);
  return { url, tier: -1, homepageBanners: [], promoBanners: [], success: false };
}
```

---

## Architecture

```
Vercel (Next.js frontend)
  └── EventSource → Cloud Run backend (port 8080)

Cloud Run (Container)
├── HTTP server (index.ts, port 8080)
├── Tier Orchestrator (escalation engine)
├── Playwright (headless Chromium)
│   ├── Tier 1: Vanilla
│   ├── Tier 2: + playwright-extra stealth plugin
│   ├── Tier 3: + Oxylabs Web Unblocker (datacenter)
│   └── Tier 4: + Residential proxy (geo-targeted) — not yet active
├── Banner detection & filtering logic
├── Site memory (sites.json — remembers tier + geo per domain)
├── Screenshot system (debug + verification)
├── Google Drive upload (OAuth2)
└── n8n webhook output
```

### Why This Architecture?

- **Cost efficient**: ~40% of sites scrape fine with zero proxy cost. Only the hardest sites burn expensive residential proxy bandwidth.
- **Fast**: Tier 1 is 2-3x faster than Tier 4 (no proxy latency, no artificial delays).
- **Smart**: Site memory means repeat scrapes skip straight to what works, and periodically re-check if cheaper tiers work again.
- **Resilient**: If a site updates its protections, the escalation catches it automatically.

### Alternatives Considered

| Approach | Verdict |
|---|---|
| Puppeteer + proxy | Works, but Playwright has better multi-browser support and built-in waiting strategies. Playwright preferred. |
| Selenium | Heavier, slower, more detectable. Not recommended. |
| HTTP + BeautifulSoup | Cannot handle JS-rendered pages or SPAs. Ruled out for this use case. |
| Scrapy + Splash | Splash adds complexity and is less reliable with modern Cloudflare. Not recommended. |
| Browserless.io | Viable cloud alternative. More expensive at scale but zero infra management. Consider as fallback if Cloud Run setup is painful. |
| Crawlee (Apify) | Solid framework built on Playwright. Worth evaluating — handles anti-bot, retries, and proxy rotation out of the box. Strong alternative. |

**Primary choice: Playwright with progressive tier escalation on Cloud Run.**

---

## Tech Stack

- **Runtime**: Node.js 24 (TypeScript)
- **Browser automation**: Playwright 1.51.0 + `playwright-extra` + `puppeteer-extra-plugin-stealth` (loaded conditionally per tier)
- **Proxy (Tier 3)**: Oxylabs Web Unblocker — `unblock.oxylabs.io:60000` (HTTPS protocol)
- **Proxy (Tier 4)**: Residential proxy — not yet configured (needs `RES_PROXY_*` env vars)
- **Anti-detection**: Stealth plugin, Chrome-only random UAs, human-like delays, fingerprint spoofing (Tier 2+)
- **Container**: Docker on Google Cloud Run (2Gi memory, 2 CPU, concurrency 1, timeout 3600s)
- **Storage**: Google Drive (OAuth2, BannerBot folder) + n8n webhook
- **Site memory**: `sites.json` in project root (persists which tier + geo works per domain)
- **Frontend**: Next.js 15, Tailwind CSS, "Obsidian Intelligence" design system
- **Orchestration**: n8n trigger or direct HTTP call to Cloud Run

---

## Key Files & Structure

```
src/
  index.ts              Entry point — HTTP server (PORT=8080) + CLI
  orchestrator.ts       Tier escalation engine (core logic + auto-geo)
  scraper.ts            Per-page scrape: navigate → validate → detect → download
  banner-detector.ts    Banner image scoring + filtering (min score 14)
  popup-handler.ts      Cookie consent, age gates, modal dismissal
  carousel-handler.ts   Slider/carousel interaction + lazy scroll
  page-navigator.ts     Finds /promotions page URL
  image-downloader.ts   Downloads banner images to output/
  screenshot.ts         Temp screenshot capture + cleanup (10s timeout)
  site-memory.ts        sites.json — remembers tier + geo per domain
  progress-emitter.ts   EventEmitter for SSE real-time progress events
  output.ts             Uploads to Google Drive + n8n webhook
  config.ts             Env vars + paths
  types.ts              TypeScript types
  debug.ts              Debug script — keeps screenshots, prints all img dimensions
  tiers/
    tier-config.ts      TIER_CONFIGS 1-4, randomUserAgent (Chrome-only UAs)
    browser-launcher.ts Launches browser with correct proxy/stealth config
    validator.ts        Detects blocks: CF, captcha, geo, access_denied, bot, empty
web/                    Next.js 15 web UI (separate package.json)
  app/
    layout.tsx          Root layout (Inter + JetBrains Mono fonts)
    page.tsx            Dashboard: URL input, SSE progress, results, site memory
    globals.css         Tailwind + "Obsidian Intelligence" design system CSS vars
test/
  mock-casino.html      Local test page (picsum hero + carousel banners)
output/                 Downloaded banner images + summary.json
sites.json              Site memory (tier + geo per domain)
Dockerfile              Multi-stage: node:20-slim compile → playwright runtime
cloudbuild.yaml         Cloud Run CI/CD pipeline
```

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DC_PROXY_HOST` | Oxylabs Web Unblocker host (`unblock.oxylabs.io`) |
| `DC_PROXY_PORT` | Oxylabs port (`60000`) |
| `DC_PROXY_PROTOCOL` | `https` |
| `DC_PROXY_USERNAME` | Oxylabs username |
| `DC_PROXY_PASSWORD` | Oxylabs password |
| `DC_PROXY_GEO` | Default geo for Tier 3 (`ca`) — overridden per-site by auto-geo |
| `RES_PROXY_HOST` | Residential proxy host (Tier 4 — not yet set) |
| `RES_PROXY_PORT` | Residential proxy port |
| `RES_PROXY_USERNAME` | Residential proxy username |
| `RES_PROXY_PASSWORD` | Residential proxy password |
| `RES_PROXY_GEO_COUNTRIES` | Allowed exit countries (e.g. `US,UK,CA,AU,NZ`) |
| `GCS_BUCKET` | Google Cloud Storage bucket name |
| `GCS_PROJECT_ID` | GCP project ID (`formidable-sol-490711-f0`) |
| `GOOGLE_OAUTH2_CLIENT_ID` | OAuth2 client ID for Google Drive |
| `GOOGLE_OAUTH2_CLIENT_SECRET` | OAuth2 client secret |
| `GOOGLE_OAUTH2_REFRESH_TOKEN` | OAuth2 refresh token (hannahporter1905@gmail.com) |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | BannerBot root folder in Drive |
| `N8N_WEBHOOK_URL` | n8n analyze webhook URL |
| `MAX_TIER` | Max tier to escalate to (`3` — set to 4 when residential proxy configured) |
| `TIER_RECHECK_DAYS` | Days before re-trying lower tiers (`7`) |
| `PAGE_TIMEOUT` | Page load timeout ms (`60000`) |
| `SCREENSHOT_ON_ERROR` | Capture screenshots on error (`true`) |
| `DEBUG_SCREENSHOTS` | Capture debug screenshots at each step (`true`) |
| `MIN_BANNER_WIDTH` | Minimum banner width px (`500`) |
| `MIN_BANNER_HEIGHT` | Minimum banner height px (`150`) |
| `NEXT_PUBLIC_BACKEND_URL` | Cloud Run URL (set in Vercel env) |

---

## Core Scraping Logic

### Step 1: Open the site (via Tier Orchestrator)
1. Tier Orchestrator selects starting tier (from site memory or Tier 1)
2. Launch Playwright with tier-appropriate config
3. Navigate to the target casino/gaming URL
4. Wait for full page load (networkidle + extra delay for lazy content)
5. **Validate success** — check for blocks, captchas, geo-restrictions
6. If failed → close browser, escalate to next tier, goto step 2
7. If success → handle cookie consent / age verification / popups, dismiss them
8. Take a **debug screenshot** (for Claude to verify page state)

### Step 2: Scrape homepage banners
1. Identify banner images using these heuristics:
   - **Size filtering**: Only images wider than 500px AND taller than 150px (banners are large, landscape-oriented)
   - **Aspect ratio**: Width/height ratio between 1.5:1 and 5:1 (banners are wide, not square)
   - **Score threshold**: Minimum score 14 (filters square game thumbnails scored ~11)
   - **Position**: Images in hero sections, sliders, carousels, or prominent page sections
   - **CSS class/ID hints**: Look for classes containing `banner`, `hero`, `slider`, `carousel`, `promo`, `promotion`, `featured`, `spotlight`
   - **Exclusion rules**: Skip images matching `logo`, `icon`, `avatar`, `thumbnail`, `game-tile`, `provider`, `badge`, `button`, `footer`, `header-logo`, `payment`, `certification`
   - **Hard exclusions**: SVG, GIF, portrait AR < 0.7 — excluded with score -999
   - **Container context**: Prefer images inside `<section>`, `<div>` with banner-like classes, swiper/slick/owl containers
2. For carousels/sliders: interact with navigation arrows or wait for auto-rotation to capture ALL slides. Detect banners after EACH slide advance (not once at end) — inactive slides have naturalWidth=0 through proxy.
3. After carousel phase: run `progressiveScrollCapture` (2.5s dwell per step) for promo sections below hero
4. Download each qualifying image at highest available resolution
5. Take a **post-scrape screenshot** showing what was captured

### Step 3: Navigate to Promotions page
1. Find the promotions/bonuses page link:
   - Look for nav links containing: `promo`, `bonus`, `offer`, `deal`, `reward`, `campaign`, `promotion`
   - Try common URL patterns: `/promotions`, `/promos`, `/bonuses`, `/offers`
   - If no link found, try direct URL navigation to common paths
2. Wait for full page load
3. **Re-validate success** (some sites block promo pages differently than homepage)
4. If blocked on promo page, try with next tier up (even if homepage worked on lower tier)
5. Take a **debug screenshot** of promotions page

### Step 4: Scrape promotions page banners
1. Apply the same banner detection logic as Step 2
2. Promotions pages often have grid/list layouts — detect promo cards with banner images
3. For promo cards: extract the main promotional image (usually the largest image in each card)
4. Download all qualifying images
5. Take a **post-scrape screenshot**

### Step 5: Output
1. Save images with metadata: source URL, page (homepage/promotions), dimensions, timestamp, alt text, tier used
2. Upload to Google Drive (`BannerBot/{domain}/{YYYY-MM-DD_HH-MM}/hp_01.webp`)
3. Send to n8n webhook for AI prompt analysis
4. Update site memory with successful tier + geo
5. Generate summary report

---

## Banner Detection Algorithm (Detailed)

```
FOR each <img>, <picture>, CSS background-image on page:
  1. Get rendered dimensions (not natural dimensions — some are CSS-scaled)
  2. HARD EXCLUDE if SVG, GIF, or portrait AR < 0.7 → score = -999
  3. SKIP if width < 500px OR height < 150px
  4. SKIP if aspect ratio < 1.5 or > 6.0
  5. SKIP if src/class/id matches exclusion keywords (logo, icon, game, etc.)
  6. SKIP if inside a <p> ancestor (betting widgets)
  7. SKIP if inside a fixed/sticky positioned ancestor (overlays, chat widgets)
  8. BOOST score if inside banner/hero/slider/carousel container
  9. BOOST score if image has lazy-loading attributes (important banners often lazy-load)
  10. BOOST score if alt text contains promotional keywords
  11. COLLECT image src, dimensions, score, context

MINIMUM SCORE: 14 (filters game thumbnails that score ~11)
SORT by score descending
RETURN all images that pass threshold
```

---

## Anti-Detection Strategy (Applied Progressively Per Tier)

| Technique | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| Stealth plugin | ✗ | ✓ | ✓ | ✓ |
| UA rotation | ✗ | ✓ | ✓ | ✓ |
| Human-like delays | ✗ | ✓ | ✓ | ✓ |
| Proxy | ✗ | ✗ | Datacenter | Residential |
| Geo-targeting | ✗ | ✗ | Auto-detect | ✓ |
| Viewport randomization | ✗ | ✓ | ✓ | ✓ |
| Resource blocking | ✗ | ✗ | ✓ | ✓ |
| Mouse movement simulation | ✗ | ✗ | ✗ | ✓ |
| Canvas/WebGL spoofing | ✗ | ✓ | ✓ | ✓ |

---

## Screenshot Function for Claude (Debug & Remote Fix)

### Purpose
Every major step takes a screenshot so Claude can visually inspect the page state, verify banner detection accuracy, and diagnose issues without relying on the user.

### Screenshot Points
| Step | Label | What Claude checks |
|---|---|---|
| After page load (per tier) | `tier{N}_loaded` | Did the page load? Any captcha/block? |
| After tier failure | `tier{N}_failed_{reason}` | Why did this tier fail? What does the block look like? |
| After popup dismissal | `popups_cleared` | Are overlays gone? Is content visible? |
| After banner detection | `tier{N}_banners_found` | Are the right images highlighted? Any missed? |
| After promo page nav | `tier{N}_promos_loaded` | Did we land on the right page? |
| After promo scrape | `tier{N}_promos_scraped` | Were promo banners captured correctly? |
| On error | `tier{N}_error` | What went wrong? Page state at failure. |

---

## Error Handling & Edge Cases

- **Cloudflare challenge**: Detected by validator → escalate tier
- **Hard block (blank page)**: Detected as `hard_blocked` → skip geo cycling, escalate tier immediately
- **Age verification gate**: Auto-click "I am 18+" or equivalent (all tiers)
- **Cookie consent**: Auto-dismiss cookie banners (all tiers)
- **Geo-blocked**: Try next geo in auto-geo sequence (same tier)
- **No promotions page**: Log and skip, still return homepage banners
- **Infinite scroll promos**: Scroll incrementally with 2.5s dwell per step, cap at reasonable limit
- **WebP/AVIF images**: Convert to PNG/JPG for n8n compatibility if needed
- **Lazy-loaded images**: Scroll to trigger loading before scraping
- **Shadow DOM**: Check for images inside shadow roots
- **iframes**: Check for banner images in iframes (some sites embed promos in iframes)
- **Promo page needs higher tier**: Homepage may load on Tier 1 but promo page may be more protected. Allow per-page tier escalation within the same site.
- **All tiers exhausted**: Flag site for manual review with "Needs Tier 4 (residential proxy)" message
- **Inter-site cooldown**: 15s delay between sites in `runScraper()` to prevent Oxylabs rate-limiting

---

## Learned Site Patterns (Baked Into the Scraper)

Each time a new site reveals a new scraping challenge, the fix is added here and to the code so future runs handle it automatically. This is the self-improvement loop — every site tested makes the scraper smarter.

### Layered Promotional Images (e.g. lokicasino37.com)
**Problem**: Some sites build each promo/hero card with two `<img>` elements stacked inside a `position: relative` container — one for the background (castle, sky, scenery) and one for a character cutout positioned absolutely on top. The browser composites them into one visual, but the banner detector captured each layer separately, producing duplicate pairs.

**Fix**: `detectLayeredContainers()` in `banner-detector.ts` scans for containers where ≥2 `<img>` children have `position: absolute`. It tags each qualifying container with `data-bannerbot-layered="N"`. In `scraper.ts`, `captureLayeredComposites()` then:
1. Filters the individual layer images out of the results (before download)
2. Screenshots each tagged container with `locator.screenshot()` — capturing the final composed visual exactly as the user sees it
3. Saves the composite as a banner file and appends to results

This is additive — if a page has no layered containers the code path is skipped entirely, so existing sites are not affected.

### Betting Widget False Positives (e.g. goldenbet.com)
**Problem**: Some sites embed betting coupon widgets (live odds tables, bet slips) as `<img>` tags inside `<p>` elements within promo card description text. These passed size filters but were not banners.

**Fix**: Any `<img>` inside a `<p>` ancestor is excluded in `banner-detector.ts` (`img.closest('p')` check).

### UI Overlay False Positives
**Problem**: Chat widgets, cookie consent bars, and sticky notification overlays can render at banner-like dimensions and pass the size filter.

**Fix**: Any `<img>` inside a `fixed` or `sticky` positioned ancestor is excluded in `banner-detector.ts`.

### Game Tile False Positives on Promo Pages
**Problem**: Some promotions pages include a "featured games" section below the actual promo cards. Individual game thumbnails (square, small) can pass the banner filter if their natural image dimensions are large even though they render small in a CSS grid.

**Status**: Identified on lokicasino37.com. Under investigation — fix pending.

### Progressive Carousel Capture
**Problem**: Inactive carousel slides have naturalWidth=0 through proxy — capturing all slides at end missed them.

**Fix**: Detect banners after EACH slide advance. Only the active slide's image actually loads.

### Progressive Scroll Capture (2.5s Dwell)
**Problem**: Lazy-loaded promo images start at 0×0. `waitForFunction` exits immediately when no in-view elements found.

**Fix**: Fixed 2.5s dwell per scroll step is the only reliable approach for lazy-loaded promo grids.

---

## Verified Working Sites

| Site | Geo | Result |
|------|-----|--------|
| novadreams.com | CA | Tier 3 ✅ 6 homepage |
| betway.com | CA | Tier 3 ✅ 8-11 homepage |
| casino.netbet.com | CA | Tier 3 ✅ 1 home + 2 promo |
| leovegas.com | CA | Tier 3 ✅ 2 home + 1-3 promo |
| casumo.com | CA | Tier 3 ✅ 4 home + 2 promo |
| jackpotcity.com | CA | Tier 3 ✅ 7 homepage |
| unibet.co.uk | GB | Tier 3 ✅ 1 homepage (CSS bg) |
| videoslots.com | CA | Tier 3 ✅ 7 carousel banners |
| 32red.com | GB | Tier 3 ✅ 1 homepage |
| betsafe.com | SE | Tier 3 ✅ 1 homepage |
| wildz.com | GB | Tier 3 ✅ 2 banners |

## Needs Tier 4 (Hard Datacenter Block)

Sites returning completely blank page (0 title, 0 body, 0 images) through datacenter proxy.
These are NOT code bugs — they need `RES_PROXY_*` env vars configured.
- 888casino.com, casinodays.com, mrgreen.com, playmojo.com

---

# Claude Behavior Rules
## These apply to every session in this project.

---

## 1. Auto-Deploy Every Change

**After every file edit or creation, immediately run all 3 steps:**
```bash
# Step 1: commit + push (triggers Vercel auto-deploy)
git add <changed files>
git commit -m "clear description of what changed"
git push origin main

# Step 2: deploy Cloud Run
powershell -ExecutionPolicy Bypass -Command "& 'C:\Users\User\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' builds submit --config cloudbuild.yaml --project formidable-sol-490711-f0 2>&1"
```

- Do not wait for the user to ask
- Do not batch multiple changes into one commit — commit as you go
- Use clear, specific commit messages (not "update files")
- Always co-author: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

---

## 2. Screenshot-Driven Development

**For any UI change (web/ directory):**
1. Start the dev server if not running: `cd web && npm run dev` (background, port 3000)
2. Take a screenshot of the relevant page/component
3. Make the change
4. Take another screenshot to verify it looks correct
5. If it looks wrong — iterate until it looks right before moving on
6. Never rely on the user to spot visual bugs

**Dev server:** `http://localhost:3000` (frontend) / `http://localhost:3001` (backend)

---

## 3. Token-Saving: Read Only Relevant Files

**Before reading files, run:**
```bash
node scripts/find-relevant.js "<keyword>" --show-lines
```

This returns only the files that actually contain the relevant code. Read those files. Do not scan the whole codebase.

**Examples:**
```bash
node scripts/find-relevant.js "validatePageSuccess" --show-lines
node scripts/find-relevant.js "carousel" --type ts
node scripts/find-relevant.js "workingGeo" --show-lines
```

---

## 4. Coding Standards

### Do
- Make small, focused changes — one feature or fix per commit
- Add loading and error states for every async operation
- Use environment variables for all URLs, credentials, and config values
- Keep files under ~400 lines — split if larger
- Explain decisions briefly in comments when logic isn't obvious

### Don't
- Don't add features beyond what was asked
- Don't refactor surrounding code when fixing a bug
- Don't add error handling for impossible scenarios
- Don't create abstractions for one-time patterns (3 similar lines > premature abstraction)
- Don't leave `console.log` statements in production code
- Don't hardcode proxy credentials, URLs, or config values
- Don't call external services (Drive, n8n, Oxylabs) directly from the Next.js frontend

---

## 5. Error Handling Pattern

Every fetch call in the web UI should follow this pattern:
```tsx
const [data,    setData]    = useState(null);
const [loading, setLoading] = useState(false);
const [error,   setError]   = useState<string | null>(null);

const load = async () => {
  setLoading(true);
  setError(null);
  try {
    const res = await fetch('/api/...');
    if (!res.ok) throw new Error(`Failed (${res.status})`);
    setData(await res.json());
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Something went wrong');
  } finally {
    setLoading(false);
  }
};
```

---

## Token-Saving Setup

### `.claudeignore` (project root)
```
node_modules/
dist/
.next/
build/
out/
package-lock.json
bun.lockb
yarn.lock
pnpm-lock.yaml
*.min.js
*.min.css
*.map
output/
screenshots/
*.log
```

### `scripts/find-relevant.js`
```js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args      = process.argv.slice(2);
const keyword   = args.find(a => !a.startsWith('--'));
const showLines = args.includes('--show-lines');
const typeFlag  = args.indexOf('--type');
const extFilter = typeFlag !== -1 ? `.${args[typeFlag + 1]}` : null;

if (!keyword) {
  console.error('Usage: node scripts/find-relevant.js <keyword> [--show-lines] [--type ts|tsx|js]');
  process.exit(1);
}

const SKIP_DIRS  = new Set(['node_modules','dist','.next','build','out','.git','coverage','output','screenshots']);
const SEARCH_EXTS = new Set(['.ts','.tsx','.js','.jsx','.mjs','.json','.md','.env']);
const results = [];

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); continue; }
    const ext = path.extname(entry.name).toLowerCase();
    if (extFilter && ext !== extFilter) continue;
    if (!SEARCH_EXTS.has(ext)) continue;
    try { if (fs.statSync(full).size > 300_000) continue; } catch { continue; }
    let content;
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (!re.test(content)) continue;
    const matchLines = [];
    content.split('\n').forEach((line, i) => { if (re.test(line)) matchLines.push({ n: i+1, text: line.trim() }); });
    results.push({ file: path.relative(process.cwd(), full), lines: matchLines });
  }
}

walk(process.cwd());
if (results.length === 0) { console.log(`No files found containing "${keyword}"`); process.exit(0); }
results.sort((a, b) => b.lines.length - a.lines.length);
console.log(`\nFiles relevant to "${keyword}" (${results.length} found):\n`);
for (const r of results) {
  console.log(`  ${r.file}  (${r.lines.length} match${r.lines.length !== 1 ? 'es' : ''})`);
  if (showLines) {
    for (const l of r.lines.slice(0, 5)) console.log(`    L${l.n}: ${l.text.slice(0, 120)}`);
    if (r.lines.length > 5) console.log(`    … and ${r.lines.length - 5} more`);
  }
}
console.log('\nTip: Read only these files to save tokens.');
```

---

## Quick Reference

| Task | Command |
|------|---------|
| Start backend (dev) | `powershell -ExecutionPolicy Bypass -Command "cd 'C:\Users\User\Desktop\BannerScrapper'; npm run server"` |
| Start frontend (dev) | `powershell -ExecutionPolicy Bypass -Command "cd 'C:\Users\User\Desktop\BannerScrapper\web'; npm run dev"` |
| Start both | `powershell -ExecutionPolicy Bypass -Command "cd 'C:\Users\User\Desktop\BannerScrapper'; npm run app"` |
| Scrape a URL (CLI) | `powershell -ExecutionPolicy Bypass -Command "cd 'C:\Users\User\Desktop\BannerScrapper'; npx ts-node src/index.ts https://site.com"` |
| Debug scrape | `powershell -ExecutionPolicy Bypass -Command "cd 'C:\Users\User\Desktop\BannerScrapper'; npx ts-node src/debug.ts https://site.com --proxy --geo=gb"` |
| Find relevant files | `node scripts/find-relevant.js "keyword" --show-lines` |
| Deploy Cloud Run | `powershell -ExecutionPolicy Bypass -Command "& 'C:\Users\User\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' builds submit --config cloudbuild.yaml --project formidable-sol-490711-f0 2>&1"` |
| Build frontend | `cd web && npm run build` |
| Deploy frontend | `git push` (auto-deploys via Vercel) |

---

## HTTP Server Endpoints (PORT=8080 in production, 3001 in dev)

| Endpoint | Description |
|----------|-------------|
| `GET /scrape-stream?urls=url1,url2&geo=XX` | SSE real-time progress |
| `POST /scrape` | Blocking JSON response `{ urls: [...], geo: "XX" }` |
| `GET /sites` | Return sites.json |
| `PUT /sites/:domain` | Update entry (e.g. change workingGeo) |
| `DELETE /sites/:domain` | Reset site from memory |
| `GET /banners/:domain/:filename` | Serve scraped banner images |
| `POST /analyze-prompts` | Forward to n8n webhook for AI analysis |
| `GET /health` | Health check |

---

## Development Workflow with Claude

1. Claude reads this `CLAUDE.md` to understand the full project
2. Find relevant files: `node scripts/find-relevant.js "<keyword>" --show-lines`
3. Read only the relevant files (not the whole codebase)
4. Run the scraper against a test site, inspect debug screenshots at every tier transition
5. Verify: Did the right tier succeed? Are failure detections accurate? Right banners captured?
6. Fix the code and re-run
7. Repeat until correct results across multiple test sites
8. Auto-deploy: git commit + push + Cloud Run build

---

## Success Criteria

- [ ] Tier 1 (vanilla) works for simple, unprotected sites
- [ ] Tier 2 (stealth) handles basic bot detection
- [ ] Tier 3 (datacenter proxy) handles IP-based blocks with auto-geo detection
- [ ] Tier 4 (residential proxy) handles geo-restrictions and heavy Cloudflare
- [ ] Failure detection accurately identifies block type and escalates appropriately
- [ ] `hard_blocked` pages skip geo cycling and escalate tier immediately
- [ ] Site memory persists tier + geo and is used on subsequent runs
- [ ] Correctly identifies and downloads banner images only (no logos, icons, game tiles)
- [ ] Banner score threshold (14) filters game tile false positives
- [ ] Navigates to promotions page automatically
- [ ] Handles carousels/sliders to get all banner slides (progressive per-slide detection)
- [ ] Progressive scroll capture handles lazy-loaded promo grids (2.5s dwell)
- [ ] Screenshots at each step allow Claude to verify correctness
- [ ] Runs in Docker container suitable for Cloud Run
- [ ] Uploads images to Google Drive + sends to n8n webhook
- [ ] Handles at least 90% of target casino sites without manual intervention
- [ ] Cost-efficient: majority of sites resolve at Tier 1-2 without proxy costs
- [ ] 15s inter-site cooldown prevents Oxylabs rate-limiting

---

## Company GitHub Workflows

Copy these into every new project under `.github/workflows/`.

### `.github/workflows/auto-assign.yml`
```yaml
name: Auto Assign
on:
  issues:
    types: [opened]
  pull_request:
    types: [opened]
jobs:
  run:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
    steps:
    - name: 'Auto-assign issue'
      uses: pozil/auto-assign-issue@v1
      with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          assignees: optinet-solutions-sandbx
          numOfAssignee: 1
```
