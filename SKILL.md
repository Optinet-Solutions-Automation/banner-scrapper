---
name: casino-banner-scraper
description: >
  Automated web scraper for extracting banner images from casino and gaming websites using a
  progressive escalation strategy (4 tiers: vanilla → stealth → datacenter proxy → residential proxy).
  Only escalates to heavier/costlier methods when lighter ones fail. Uses Playwright with stealth
  plugins and proxy rotation to bypass Cloudflare, geo-restrictions, and bot detection. Scrapes
  homepage banners and promotions page banners, filtering out logos, icons, game thumbnails, and
  other non-banner images. Includes site memory to remember which tier works per domain, and a debug
  screenshot system so Claude can visually verify scraping accuracy and fix issues in real-time.
  Deploys on Google Cloud Run. Use this skill whenever the user wants to: scrape casino/gaming site
  images, extract promotional banners from websites, build a web scraper that handles anti-bot
  protections with progressive escalation, set up Playwright with proxy on Cloud Run, or anything
  related to automated banner image collection from protected websites. Also trigger when user
  mentions n8n image analysis pipeline, reverse-engineering image prompts, tier-based scraping,
  or geo-restricted site scraping.
---

# Casino Banner Scraper Skill

## Quick Start

When this skill triggers, Claude should:
1. Read the project's `claude.md` for full architecture and requirements
2. Check if the project structure already exists, if not scaffold it
3. Begin implementing or modifying code as requested
4. Use the screenshot verification loop for testing

---

## Key Concepts

### Progressive Escalation (Core Pattern)

**Never start with the heaviest approach.** Always try lighter tiers first:

```
Tier 1: Vanilla Playwright (FREE, fastest)
  ↓ fails?
Tier 2: + Stealth plugin (FREE, fast)
  ↓ fails?
Tier 3: + Datacenter proxy (LOW cost, moderate speed)
  ↓ fails?
Tier 4: + Residential proxy + geo-targeting (HIGH cost, slowest)
  ↓ fails?
Flag for manual review
```

The system detects failures automatically (Cloudflare challenge pages, CAPTCHAs, geo-blocks, 403s, empty pages, bot detection messages) and escalates only when needed. Site memory remembers which tier worked last time so repeat scrapes skip unnecessary attempts.

### What counts as a "banner"?
- Large landscape images (width > 600px, height > 150px, aspect ratio 1.5:1 to 6:1)
- Found in hero sections, sliders, carousels, promotion cards
- Contains promotional content (bonuses, offers, events)

### What to EXCLUDE
- Logos (any size)
- Game tile thumbnails (typically square, small)
- Icons, badges, buttons
- Payment provider images
- Footer/header decorative elements
- Avatar images
- Provider/certification logos

### Anti-Detection Stack (Applied Per Tier)

| Technique | T1 | T2 | T3 | T4 |
|---|---|---|---|---|
| Stealth plugin | ✗ | ✓ | ✓ | ✓ |
| UA rotation | ✗ | ✓ | ✓ | ✓ |
| Human-like delays | ✗ | ✓ | ✓ | ✓ |
| Proxy | ✗ | ✗ | DC | Residential |
| Geo-targeting | ✗ | ✗ | ✗ | ✓ |
| Mouse simulation | ✗ | ✗ | ✗ | ✓ |

---

## Screenshot-Driven Development Loop

This is the core development workflow. Claude uses screenshots to verify each step:

```
┌─────────────────────────────────┐
│  1. Run scraper on test URL     │
├─────────────────────────────────┤
│  2. Check screenshot:           │
│     - Page loaded?              │
│     - Blocked/captcha?          │
│     - Right tier escalation?    │
├─────────────────────────────────┤
│  3. If issue → fix code         │
│     If OK → continue            │
├─────────────────────────────────┤
│  4. Check banner results:       │
│     - Right images found?       │
│     - Missed any?               │
│     - False positives?          │
├─────────────────────────────────┤
│  5. If issue → adjust           │
│     detection logic             │
│     If OK → move to next        │
│     page/site                   │
└─────────────────────────────────┘
```

### Screenshot Labels
- `tier{N}_loaded` — After page load attempt per tier
- `tier{N}_failed_{reason}` — Why tier failed (for escalation debugging)
- `popups_cleared` — After dismissing overlays
- `tier{N}_banners_found` — After banner detection
- `tier{N}_promos_loaded` — After navigating to promotions page
- `tier{N}_promos_scraped` — After scraping promo banners
- `tier{N}_error` — On unexpected errors

---

## Implementation Checklist

### Phase 1: Core Setup + Tier 1
- [ ] Initialize Node.js/TypeScript project
- [ ] Install playwright (no stealth yet — that's Tier 2)
- [ ] Create basic page loader (vanilla Chromium)
- [ ] Implement screenshot utility
- [ ] Implement success/failure validator
- [ ] Test: Load an easy casino site with Tier 1, verify with screenshot

### Phase 2: Tier Escalation Engine
- [ ] Implement tier config definitions (all 4 tiers)
- [ ] Implement escalation orchestrator loop
- [ ] Add `playwright-extra` + stealth plugin (Tier 2)
- [ ] Add datacenter proxy support (Tier 3)
- [ ] Add residential proxy with geo-targeting (Tier 4)
- [ ] Implement site memory (save/load last successful tier per domain)
- [ ] Test: Run against 5 sites with varying difficulty, verify correct tier escalation

### Phase 3: Banner Detection
- [ ] Implement image element discovery (img, picture, CSS backgrounds)
- [ ] Implement size/aspect ratio filtering
- [ ] Implement keyword-based exclusion (logos, icons, etc.)
- [ ] Implement container-context scoring (hero, slider, carousel detection)
- [ ] Implement carousel/slider interaction (click arrows, wait for transitions)
- [ ] Test: Run on 3 different casino sites, verify banner accuracy via screenshots

### Phase 4: Navigation
- [ ] Implement promotions page finder (nav link scanning + URL pattern matching)
- [ ] Implement popup/cookie/age-gate dismissal
- [ ] Handle edge cases (no promo page, different URL structures)
- [ ] Support per-page tier escalation (promo page may need higher tier than homepage)
- [ ] Test: Navigate to promo pages on 5 sites, verify with screenshots

### Phase 5: Output & Integration
- [ ] Implement image download with metadata (including tier used)
- [ ] Set up Google Cloud Storage upload
- [ ] Set up n8n webhook integration (alternative)
- [ ] Generate scrape summary report

### Phase 6: Containerization & Deployment
- [ ] Create Dockerfile based on Playwright image
- [ ] Create docker-compose.yml for local dev
- [ ] Test container locally
- [ ] Deploy to Cloud Run
- [ ] Set up Cloud Scheduler or n8n trigger
- [ ] Verify site memory persists across runs (GCS or Firestore)

---

## Common Issues & Fixes

| Problem | Solution |
|---|---|
| Tier 1 fails on most sites | Expected for casino sites. Verify Tier 2 stealth kicks in properly |
| Cloudflare blocks all tiers | Check stealth plugin is latest version, verify residential proxy country matches |
| Page shows captcha on Tier 3 | Datacenter IPs are often flagged. Normal — Tier 4 residential should work |
| Carousel doesn't rotate | Try both click-based and wait-based approaches, check for swiper/slick/owl |
| Images are lazy-loaded placeholders | Scroll page fully before scraping, wait for intersection observer |
| Promo page not found | Try URL patterns: /promotions, /promos, /bonuses, /offers, /deals |
| Site memory not persisting | Verify GCS/Firestore write permissions, check JSON serialization |
| Container OOM on Cloud Run | Increase memory to 2GB, close browser between tiers and sites |
| Tier escalation too slow | Reduce Tier 1 timeout to 15s for known-hard sites, trust site memory |
| Geo-block persists on Tier 4 | Verify proxy exit country matches site's allowed regions, try multiple countries |

---

## Code Patterns

### Browser Launch Per Tier
```typescript
async function launchBrowser(tierConfig: TierConfig): Promise<Browser> {
  const launchOptions: any = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };

  // Add proxy for Tier 3 and 4
  if (tierConfig.proxy === 'datacenter') {
    launchOptions.proxy = {
      server: `http://${DC_PROXY_HOST}:${DC_PROXY_PORT}`,
      username: DC_PROXY_USERNAME,
      password: DC_PROXY_PASSWORD,
    };
  } else if (tierConfig.proxy === 'residential') {
    launchOptions.proxy = {
      server: `http://${RES_PROXY_HOST}:${RES_PROXY_PORT}`,
      username: RES_PROXY_USERNAME,
      password: RES_PROXY_PASSWORD,
    };
  }

  // Use stealth for Tier 2+
  if (tierConfig.stealth) {
    const { chromium } = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth');
    chromium.use(stealth());
    return chromium.launch(launchOptions);
  } else {
    const { chromium } = require('playwright');
    return chromium.launch(launchOptions);
  }
}
```

### Banner Image Filter
```typescript
const EXCLUDE_KEYWORDS = [
  'logo', 'icon', 'avatar', 'thumbnail', 'game-tile',
  'provider', 'badge', 'button', 'footer', 'payment',
  'certification', 'flag', 'social', 'app-store'
];

const BOOST_KEYWORDS = [
  'banner', 'hero', 'slider', 'carousel', 'promo',
  'promotion', 'featured', 'spotlight', 'offer', 'bonus'
];

function isBanner(img: ImageCandidate): boolean {
  if (img.width < 600 || img.height < 150) return false;
  if (img.aspectRatio < 1.5 || img.aspectRatio > 6.0) return false;
  const context = (img.src + ' ' + img.classes + ' ' + img.altText).toLowerCase();
  if (EXCLUDE_KEYWORDS.some(kw => context.includes(kw))) return false;
  return true;
}
```

---

## Testing Sites (Start With These)

Ordered by expected difficulty to validate tier escalation:

```json
[
  { "url": "https://www.pokerstars.com", "expectedTier": 1, "notes": "Light protection, good for Tier 1 testing" },
  { "url": "https://www.888casino.com", "expectedTier": 2, "notes": "Basic bot detection, stealth should handle it" },
  { "url": "https://www.betway.com", "expectedTier": 3, "notes": "IP-based blocking likely" },
  { "url": "https://www.bet365.com", "expectedTier": 4, "notes": "Heavy Cloudflare + geo-restriction" },
  { "url": "https://www.draftkings.com", "expectedTier": 2, "notes": "US-focused SPA, stealth usually enough" }
]
```

---

## Reference: Cloud Run Dockerfile

```dockerfile
FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY dist/ ./dist/
COPY sites.json ./

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8080

CMD ["node", "dist/index.js"]
```

Memory: 2Gi minimum. Timeout: 300s. Concurrency: 1.