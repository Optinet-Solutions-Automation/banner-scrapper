# Casino & Gaming Site Banner Scraper

## Project Overview

An automated web scraper that extracts **banner images only** (not logos, game thumbnails, icons, or UI elements) from casino/gaming websites. It visits the homepage for banners, then navigates to the promotions page and scrapes banners there too. Scraped images feed into an n8n automation pipeline for AI-powered image analysis and prompt reverse-engineering.

**Core Principle: Progressive Escalation.** Not all sites need heavy artillery. The scraper starts with the lightest, cheapest, fastest method and only escalates to heavier methods when the current tier fails. This saves proxy costs, reduces latency, and avoids unnecessary complexity per site.

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

  // Check for empty/broken page (JS didn't render)
  const imageCount = await page.$$eval('img', imgs => imgs.length);
  if (imageCount < 3 && bodyText.length < 500) {
    return { success: false, failureReason: FailureReason.EMPTY_PAGE };
  }

  return { success: true };
}
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

The system remembers which tier worked for each site so it doesn't waste time re-escalating on future runs:

```typescript
// sites.json stores the last successful tier per domain
{
  "bet365.com": { "lastSuccessfulTier": 4, "lastScraped": "2025-03-01T..." },
  "pokerstars.com": { "lastSuccessfulTier": 1, "lastScraped": "2025-03-01T..." },
  "888casino.com": { "lastSuccessfulTier": 2, "lastScraped": "2025-02-28T..." }
}

// On subsequent runs, START at the last known successful tier
// But periodically retry lower tiers (every 7 days) in case site changed
```

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
Cloud Run (Container)
├── Tier Orchestrator (escalation engine)
├── Playwright (headless Chromium)
│   ├── Tier 1: Vanilla
│   ├── Tier 2: + Stealth plugin
│   ├── Tier 3: + Datacenter proxy
│   └── Tier 4: + Residential proxy (geo-targeted)
├── Banner detection & filtering logic
├── Site memory (remembers which tier works per domain)
├── Screenshot system (debug + verification)
└── Image output (Cloud Storage / webhook to n8n)
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
**Strong alternative: Crawlee (built on Playwright) if you want batteries-included framework with built-in retry/proxy logic.**

---

## Tech Stack

- **Runtime**: Node.js 20+ (TypeScript)
- **Browser automation**: Playwright + `playwright-extra` + `puppeteer-extra-plugin-stealth` (loaded conditionally per tier)
- **Proxy**: Datacenter proxy (Tier 3) + Residential proxy (Tier 4) — services like BrightData, Oxylabs, or SmartProxy
- **Anti-detection**: Stealth plugin, random user agents, human-like delays, fingerprint spoofing (Tier 2+)
- **Container**: Docker on Google Cloud Run
- **Storage**: Google Cloud Storage bucket for scraped images (or direct webhook to n8n)
- **Site memory**: JSON file in GCS or Firestore (persists which tier works per domain)
- **Orchestration**: Cloud Scheduler (cron) or n8n trigger to invoke the scraper
- **Language**: TypeScript for type safety and better maintainability

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
   - **Size filtering**: Only images wider than 600px AND taller than 150px (banners are large, landscape-oriented)
   - **Aspect ratio**: Width/height ratio between 1.5:1 and 5:1 (banners are wide, not square)
   - **Position**: Images in hero sections, sliders, carousels, or prominent page sections
   - **CSS class/ID hints**: Look for classes containing `banner`, `hero`, `slider`, `carousel`, `promo`, `promotion`, `featured`, `spotlight`
   - **Exclusion rules**: Skip images matching `logo`, `icon`, `avatar`, `thumbnail`, `game-tile`, `provider`, `badge`, `button`, `footer`, `header-logo`, `payment`, `certification`
   - **Container context**: Prefer images inside `<section>`, `<div>` with banner-like classes, swiper/slick/owl containers
2. For carousels/sliders: interact with navigation arrows or wait for auto-rotation to capture ALL slides
3. Download each qualifying image at highest available resolution
4. Take a **post-scrape screenshot** showing what was captured

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
1. Save images with metadata:
   - Source URL
   - Page (homepage or promotions)
   - Image dimensions
   - Timestamp
   - Alt text if available
   - **Tier used** (for analytics on which sites need heavier methods)
2. Upload to Cloud Storage or send via webhook to n8n
3. Update site memory with successful tier
4. Generate a summary report of what was scraped

---

## Banner Detection Algorithm (Detailed)

```
FOR each <img>, <picture>, CSS background-image on page:
  1. Get rendered dimensions (not natural dimensions — some are CSS-scaled)
  2. SKIP if width < 600px OR height < 150px
  3. SKIP if aspect ratio < 1.5 or > 6.0
  4. SKIP if src/class/id matches exclusion keywords (logo, icon, game, etc.)
  5. BOOST score if inside banner/hero/slider/carousel container
  6. BOOST score if image has lazy-loading attributes (important banners often lazy-load)
  7. BOOST score if alt text contains promotional keywords
  8. COLLECT image src, dimensions, score, context
  
SORT by score descending
RETURN top N images (configurable, default: all that pass threshold)
```

---

## Anti-Detection Strategy (Applied Progressively Per Tier)

| Technique | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| Stealth plugin | ✗ | ✓ | ✓ | ✓ |
| UA rotation | ✗ | ✓ | ✓ | ✓ |
| Human-like delays | ✗ | ✓ | ✓ | ✓ |
| Proxy | ✗ | ✗ | Datacenter | Residential |
| Geo-targeting | ✗ | ✗ | ✗ | ✓ |
| Viewport randomization | ✗ | ✓ | ✓ | ✓ |
| Resource blocking | ✗ | ✗ | ✓ | ✓ |
| Mouse movement simulation | ✗ | ✗ | ✗ | ✓ |
| Canvas/WebGL spoofing | ✗ | ✓ | ✓ | ✓ |

---

## Screenshot Function for Claude (Debug & Remote Fix)

### Purpose
Every major step takes a screenshot so Claude can visually inspect the page state, verify banner detection accuracy, and diagnose issues without relying on the user.

### Implementation
```typescript
async function takeDebugScreenshot(page: Page, label: string): Promise<string> {
  const filename = `debug_${label}_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ fullPage: true, path: filepath });
  // Also save a viewport-only version for quick inspection
  const viewportFile = `debug_${label}_viewport_${Date.now()}.png`;
  await page.screenshot({ fullPage: false, path: path.join(SCREENSHOT_DIR, viewportFile) });
  return filepath;
}
```

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

### How Claude Uses Screenshots
When running the scraper in development:
1. Claude executes the scraper via bash
2. Screenshots are saved to `/home/claude/screenshots/`
3. Claude uses the `view` tool to inspect each screenshot
4. If something looks wrong (blocked page, missed banners, wrong images), Claude modifies the code and re-runs
5. This loop continues until the scraping result is correct
6. Screenshots from failed tiers help Claude understand *why* escalation was needed and whether the detection logic is working

---

## Project Structure

```
casino-banner-scraper/
├── src/
│   ├── index.ts                 # Entry point, HTTP handler for Cloud Run
│   ├── orchestrator.ts          # Tier escalation engine (core logic)
│   ├── tiers/
│   │   ├── tier-config.ts       # Tier definitions and settings
│   │   ├── browser-launcher.ts  # Launches browser with tier-specific config
│   │   └── validator.ts         # Success/failure detection after page load
│   ├── scraper.ts               # Core banner scraping logic
│   ├── banner-detector.ts       # Banner identification & filtering
│   ├── page-navigator.ts        # Finds and navigates to promo pages
│   ├── popup-handler.ts         # Cookie consent, age gates, overlay dismissal
│   ├── carousel-handler.ts      # Slider/carousel interaction logic
│   ├── image-downloader.ts      # Downloads and validates images
│   ├── screenshot.ts            # Debug screenshot utility
│   ├── site-memory.ts           # Remembers which tier works per domain
│   ├── output.ts                # Saves to GCS or sends to n8n webhook
│   ├── config.ts                # Configuration and environment vars
│   └── types.ts                 # TypeScript type definitions
├── Dockerfile                   # Cloud Run container
├── docker-compose.yml           # Local development
├── package.json
├── tsconfig.json
├── .env.example                 # Proxy credentials, GCS bucket, etc.
├── sites.json                   # Target sites + tier memory
├── claude.md                    # This file
└── skills/
    └── web-scraper/
        └── SKILL.md             # Skill file for Claude
```

---

## Configuration (Environment Variables)

```env
# Datacenter Proxy (Tier 3)
DC_PROXY_HOST=your-dc-proxy-host
DC_PROXY_PORT=your-dc-proxy-port
DC_PROXY_USERNAME=your-username
DC_PROXY_PASSWORD=your-password

# Residential Proxy (Tier 4)
RES_PROXY_HOST=your-res-proxy-host
RES_PROXY_PORT=your-res-proxy-port
RES_PROXY_USERNAME=your-username
RES_PROXY_PASSWORD=your-password
RES_PROXY_GEO_COUNTRIES=US,UK,CA,AU,NZ  # comma-separated allowed exit countries

# Google Cloud Storage
GCS_BUCKET=casino-banners
GCS_PROJECT_ID=your-project-id

# n8n webhook (alternative to GCS)
N8N_WEBHOOK_URL=https://your-n8n-instance/webhook/banner-scraper

# Scraper settings
MAX_TIER=4                  # max tier to escalate to (set to 2 to disable proxy entirely)
TIER_RECHECK_DAYS=7         # days before re-trying lower tiers
PAGE_TIMEOUT=60000
SCREENSHOT_ON_ERROR=true
DEBUG_SCREENSHOTS=true
MIN_BANNER_WIDTH=600
MIN_BANNER_HEIGHT=150
```

---

## Cloud Run Deployment

### Dockerfile Key Points
- Base image: `mcr.microsoft.com/playwright:v1.48.0-noble` (includes Chromium)
- Install Node.js dependencies
- Set `PLAYWRIGHT_BROWSERS_PATH` if needed
- Memory: Allocate at least 1GB (Chromium is memory-hungry), 2GB recommended for Tier 4
- Timeout: Set Cloud Run timeout to 300s (some sites load slowly, especially through proxies)
- Concurrency: Set to 1 (each instance handles one scrape job at a time)

### Triggering
- **Cloud Scheduler**: Cron job hits Cloud Run HTTP endpoint with site URL(s)
- **n8n**: HTTP request node triggers the scraper with target sites
- **Pub/Sub**: For batch processing multiple sites

---

## Error Handling & Edge Cases

- **Cloudflare challenge**: Detected by validator → escalate tier
- **Age verification gate**: Auto-click "I am 18+" or equivalent (all tiers)
- **Cookie consent**: Auto-dismiss cookie banners (all tiers)
- **Geo-blocked**: Detected by validator → escalate to Tier 4 with geo-targeted proxy
- **No promotions page**: Log and skip, still return homepage banners
- **Infinite scroll promos**: Scroll incrementally, cap at reasonable limit
- **WebP/AVIF images**: Convert to PNG/JPG for n8n compatibility if needed
- **Lazy-loaded images**: Scroll to trigger loading before scraping
- **Shadow DOM**: Check for images inside shadow roots
- **iframes**: Check for banner images in iframes (some sites embed promos in iframes)
- **Promo page needs higher tier**: Homepage may load on Tier 1 but promo page may be more protected. Allow per-page tier escalation within the same site.
- **All tiers exhausted**: Flag site for manual review, include last screenshot for diagnosis

---

## Development Workflow with Claude

1. Claude reads this `claude.md` to understand the full project
2. Claude writes/modifies code in `/home/claude/casino-banner-scraper/`
3. Claude runs the scraper against a test site
4. Claude inspects debug screenshots using `view` tool at every tier transition
5. Claude verifies: Did the right tier succeed? Are the failure detections accurate?
6. Claude checks banner results: Right images? Missed any? False positives?
7. Claude fixes the code and re-runs
8. Repeat until perfect results across multiple test sites
9. Claude packages the final code for Cloud Run deployment

---

## Success Criteria

- [ ] Tier 1 (vanilla) works for simple, unprotected sites
- [ ] Tier 2 (stealth) handles basic bot detection
- [ ] Tier 3 (datacenter proxy) handles IP-based blocks
- [ ] Tier 4 (residential proxy) handles geo-restrictions and heavy Cloudflare
- [ ] Failure detection accurately identifies block type and escalates appropriately
- [ ] Site memory persists and is used on subsequent runs
- [ ] Correctly identifies and downloads banner images only (no logos, icons, game tiles)
- [ ] Navigates to promotions page automatically
- [ ] Handles carousels/sliders to get all banner slides
- [ ] Screenshots at each step allow Claude to verify correctness
- [ ] Runs in Docker container suitable for Cloud Run
- [ ] Outputs images with metadata to GCS or n8n webhook
- [ ] Handles at least 90% of target casino sites without manual intervention
- [ ] Cost-efficient: majority of sites resolve at Tier 1 or 2 without proxy costs