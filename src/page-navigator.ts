import { Page } from 'playwright';

const PROMO_NAV_PATTERNS = [
  /promo/i, /bonus/i, /offer/i, /reward/i, /campaign/i, /deal/i,
];

const PROMO_PATH_GUESSES = [
  '/promotions', '/promos', '/bonuses', '/offers', '/bonus',
  '/deals', '/rewards', '/campaigns', '/specials',
];

/** Try to find and return the URL of the promotions/bonuses page. */
export async function findPromotionsUrl(page: Page, baseUrl: string): Promise<string | null> {
  // 1. Scan nav links for promo-like text
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map(a => ({
      href: (a as HTMLAnchorElement).href,
      text: (a as HTMLAnchorElement).innerText?.trim() ?? '',
    }))
  );

  for (const link of links) {
    if (!link.href.startsWith('http')) continue;
    // Same origin only
    const linkOrigin = new URL(link.href).origin;
    const baseOrigin = new URL(baseUrl).origin;
    if (linkOrigin !== baseOrigin) continue;

    const combined = `${link.href} ${link.text}`.toLowerCase();
    for (const pat of PROMO_NAV_PATTERNS) {
      if (pat.test(combined)) {
        return link.href;
      }
    }
  }

  // 2. Try common path guesses
  const origin = new URL(baseUrl).origin;
  for (const path of PROMO_PATH_GUESSES) {
    const candidate = `${origin}${path}`;
    try {
      const res = await page.request.head(candidate, { timeout: 10_000 });
      if (res.ok()) return candidate;
    } catch { /* not found */ }
  }

  return null;
}
