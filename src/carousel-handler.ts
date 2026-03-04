import { Page, ElementHandle } from 'playwright';

const NEXT_ARROW_SELECTORS = [
  // ── Library-specific ──────────────────────────────────────────────────────
  '.swiper-button-next',
  '.slick-next',
  '.owl-next',
  // ── aria-label patterns ───────────────────────────────────────────────────
  'button[aria-label*="next" i]',
  '[aria-label*="next slide" i]',
  '[aria-label*="forward" i]',
  // ── Class keyword patterns (covers most custom carousels) ─────────────────
  '[class*="arrow--next"]',      // e.g. slider__arrow--next
  '[class*="arrow--right"]',
  '[class*="arrow-next"]',
  '[class*="carousel-control-next"]',  // Bootstrap
  '[class*="next-slide"]',
  '[class*="arrow-right"]',
  '[class*="nav-next"]',
  '[class*="btn-next"]',
  '[class*="slide-next"]',
  // ── Generic containers fallback ───────────────────────────────────────────
  '[class*="carousel"] [aria-label*="next" i]',
  '[class*="slider"] [aria-label*="next" i]',
];

/** Click through carousel slides to ensure all banner images are loaded. */
export async function advanceCarousels(page: Page): Promise<void> {
  let didAdvance = false;

  for (const sel of NEXT_ARROW_SELECTORS) {
    try {
      const arrows = await page.$$(sel);
      for (const arrow of arrows) {
        if (!await arrow.isVisible()) continue;
        // Click up to 8 times per carousel — more time per click so slow
        // proxy connections finish loading the new slide's image before we move on.
        for (let i = 0; i < 8; i++) {
          await arrow.click().catch(() => {});
          await page.waitForTimeout(1000);
        }
        didAdvance = true;
      }
    } catch { /* selector not present */ }
  }

  // ── Pagination-dot fallback ────────────────────────────────────────────────
  // Sites like spinsup.com use Swiper pagination bullets (◉○○○○) rather than
  // visible arrow buttons. Click each dot to visit every slide.
  if (!didAdvance) {
    const dotSelectors = [
      '.swiper-pagination-bullet',
      '[class*="pagination-bullet"]',
      '[class*="carousel-dot"]',
      '[class*="slide-dot"]',
      '[class*="dot-indicator"]',
    ];
    for (const sel of dotSelectors) {
      try {
        const dots = await page.$$(sel);
        if (dots.length < 2) continue;
        for (const dot of dots) {
          if (!await dot.isVisible()) continue;
          await dot.click().catch(() => {});
          await page.waitForTimeout(1000); // wait for slide image to load
        }
        didAdvance = true;
        break;
      } catch { /* not found */ }
    }
  }

  // ── Keyboard fallback ──────────────────────────────────────────────────────
  // Last resort: focus on a carousel container and press ArrowRight.
  if (!didAdvance) {
    const heroSel = '[class*="swiper"],[class*="slider"],[class*="carousel"],[class*="hero"]';
    const hero = await page.$(heroSel).catch(() => null);
    if (hero) {
      await hero.focus().catch(() => {});
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(800);
      }
    }
  }

  // Let auto-rotating carousels settle
  await page.waitForTimeout(1500);
}

// ── Incremental carousel API (used by scraper for progressive capture) ────────

const DOT_SELECTORS = [
  '.swiper-pagination-bullet',
  '[class*="pagination-bullet"]',
  '[class*="carousel-dot"]',
  '[class*="slide-dot"]',
  '[class*="dot-indicator"]',
];

/** Returns the first visible "next slide" arrow element, or null if none found. */
export async function findCarouselNext(page: Page): Promise<ElementHandle | null> {
  for (const sel of NEXT_ARROW_SELECTORS) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        if (await el.isVisible()) return el;
      }
    } catch { /* selector absent */ }
  }
  return null;
}

/** Returns all visible pagination dots, or empty array if none found. */
export async function findCarouselDots(page: Page): Promise<ElementHandle[]> {
  for (const sel of DOT_SELECTORS) {
    try {
      const dots = await page.$$(sel);
      const visible = [];
      for (const d of dots) {
        if (await d.isVisible()) visible.push(d);
      }
      if (visible.length >= 2) return visible;
    } catch { /* selector absent */ }
  }
  return [];
}

/** Click the carousel next button once, wait for transition + image load.
 *  Returns false if the arrow is gone / not clickable. */
export async function advanceCarouselOnce(page: Page, arrow: ElementHandle): Promise<boolean> {
  try {
    await arrow.click();
    // Allow time for the slide transition animation and for the proxy to
    // fetch the new slide's image before the caller samples the DOM.
    await page.waitForTimeout(1800);
    return true;
  } catch {
    return false;
  }
}

/** Scroll the page to trigger lazy-loading. */
export async function scrollToLoadImages(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>(resolve => {
      let totalHeight = 0;
      let steps = 0;
      const distance = 200;  // smaller steps — gives IntersectionObserver time to fire
      const maxSteps = 100;  // cap at ~20 000px — prevents infinite-scroll loops
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        steps++;
        if (totalHeight >= document.body.scrollHeight || steps >= maxSteps) {
          clearInterval(timer);
          // Pause at the bottom so all lazy images finish loading,
          // then scroll back to top so getBoundingClientRect() is stable.
          setTimeout(() => {
            window.scrollTo(0, 0);
            resolve();
          }, 3000);
        }
      }, 150);
    });
  });
  await page.waitForTimeout(1500);  // extra wait after returning to top
}
