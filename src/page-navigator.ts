import { Page } from 'playwright';

const PROMO_NAV_PATTERNS = [
  /promo/i, /bonus/i, /offer/i, /reward/i, /campaign/i, /deal/i,
];

// Paths that indicate an action page (claim bonus, login, account) — NOT a promo listing page.
// E.g. mystake888.com has a "Claim Bonus" CTA → /tl/account/freespins?bonus
// which matches /bonus/i but is NOT the promotions page we want to scrape.
const ACCOUNT_PATH_EXCLUDE = [
  '/account/', '/login', '/register', '/signup', '/user/', '/profile/',
  '/deposit', '/withdrawal', '/freespins', '/free-spin', '/cashier',
  '/my-account', '/myaccount',
];

const PROMO_PATH_GUESSES = [
  '/promotions', '/promos', '/bonuses', '/offers', '/bonus',
  '/deals', '/rewards', '/campaigns', '/specials',
  '/static/promos', '/static/promotions',   // goldenbet.com and similar
  // Language-prefixed paths common on multilingual casino sites (e.g. mystake888.com /en/...)
  '/en/promotions', '/en/promos', '/en/bonuses', '/en/offers',
  '/en/casino/promotions', '/en/static/promos',
  '/tl/static/promos', '/tl/promotions', '/tl/promos',
  '/ph/promotions', '/ph/promos',
  '/casino/promotions', '/casino/bonuses',
];

/** Normalise an origin for comparison — strips www. so that
 *  "https://mystake888.com" and "https://www.mystake888.com" match. */
function normaliseOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname.replace(/^www\./, '')}`;
  } catch { return url; }
}

/** Try to find and return the URL of the promotions/bonuses page. */
export async function findPromotionsUrl(page: Page, baseUrl: string): Promise<string | null> {
  // Use the CURRENT page URL (after any redirects) — not the original baseUrl.
  // If the page redirected from example.com → www.example.com, nav links will have
  // the www. origin. Comparing against the original URL would filter them all out.
  const currentUrl = page.url() || baseUrl;
  const baseOriginNorm = normaliseOrigin(currentUrl);

  // 1. Scan all links on the page for promo-like text or href
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map(a => ({
      href: (a as HTMLAnchorElement).href,
      text: (a as HTMLAnchorElement).innerText?.trim() ?? '',
    }))
  );

  for (const link of links) {
    if (!link.href.startsWith('http')) continue;
    // Same-site only (normalised — ignores www. difference)
    if (normaliseOrigin(link.href) !== baseOriginNorm) continue;

    // Skip action/account links — they match /bonus/i etc. but are not promo listing pages.
    // e.g. /tl/account/freespins?bonus, /account/deposit, /login
    const hrefLower = link.href.toLowerCase();
    if (ACCOUNT_PATH_EXCLUDE.some(ex => hrefLower.includes(ex))) continue;

    const combined = `${link.href} ${link.text}`.toLowerCase();
    for (const pat of PROMO_NAV_PATTERNS) {
      if (pat.test(combined)) {
        return link.href;
      }
    }
  }

  // 2. Try common path guesses — fire all HEAD requests concurrently, return first 200
  const origin = new URL(currentUrl).origin;
  const checkPath = async (p: string): Promise<string | null> => {
    const candidate = `${origin}${p}`;
    try {
      const res = await page.request.head(candidate, { timeout: 8_000 });
      return res.ok() ? candidate : null;
    } catch { return null; }
  };

  const headResults = await Promise.allSettled(PROMO_PATH_GUESSES.map(checkPath));
  for (const r of headResults) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }

  return null;
}
