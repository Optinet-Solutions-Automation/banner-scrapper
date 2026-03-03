import { Page } from 'playwright';

const NEXT_ARROW_SELECTORS = [
  '.swiper-button-next',
  '.slick-next',
  '.owl-next',
  '[class*="carousel"] [aria-label*="next" i]',
  '[class*="slider"] [aria-label*="next" i]',
  'button[aria-label*="Next" i]',
  '[class*="next-slide"]',
  '[class*="arrow-right"]',
];

/** Click through carousel slides to ensure all banner images are loaded. */
export async function advanceCarousels(page: Page): Promise<void> {
  for (const sel of NEXT_ARROW_SELECTORS) {
    try {
      const arrows = await page.$$(sel);
      for (const arrow of arrows) {
        if (!await arrow.isVisible()) continue;
        // Click up to 6 times per carousel to cycle through slides
        for (let i = 0; i < 6; i++) {
          await arrow.click().catch(() => {});
          await page.waitForTimeout(600);
        }
      }
    } catch { /* selector not present */ }
  }

  // Also wait a moment for auto-rotating carousels
  await page.waitForTimeout(1500);
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
