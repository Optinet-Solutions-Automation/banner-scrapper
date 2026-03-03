import { Page } from 'playwright';

// Selectors for common popups on casino/gaming sites
const COOKIE_SELECTORS = [
  // Accept buttons
  'button[id*="accept"]', 'button[class*="accept"]',
  'button[id*="cookie"]', 'button[class*="cookie"]',
  'button[id*="consent"]', 'button[class*="consent"]',
  'a[id*="accept"]', 'a[class*="accept"]',
  '[data-testid*="cookie-accept"]',
  // Common text patterns
  'button:text-is("Accept")', 'button:text-is("Accept All")',
  'button:text-is("ACCEPT ALL")', 'button:text-is("ACCEPT")',
  'button:text-is("Accept Cookies")', 'button:text-is("I Accept")',
  'button:text-is("OK")', 'button:text-is("Got it")',
  'button:text-is("Allow All")', 'button:text-is("ALLOW ALL")',
  'button:text-is("Allow Cookies")',
  'button:text-is("Agree")', 'button:text-is("I Agree")',
];

const AGE_GATE_SELECTORS = [
  // Enter-site / I am 18+ buttons
  'button:text-is("Enter")', 'button:text-is("Enter Site")',
  'button:text-is("I am 18+")', 'button:text-is("I\'m 18+")',
  'button:text-is("I am over 18")', 'button:text-is("Enter Now")',
  'button:text-is("Yes, I am 18+")', 'button:text-is("I\'m of legal age")',
  '[class*="age-gate"] button', '[id*="age-gate"] button',
  '[class*="age-verify"] button', '[id*="age-verify"] button',
];

const MODAL_CLOSE_SELECTORS = [
  'button[aria-label="Close"]', 'button[aria-label="close"]',
  'button[aria-label="Dismiss"]', '[class*="modal"] button[class*="close"]',
  '[class*="modal"] button[class*="dismiss"]',
  '[class*="popup"] button[class*="close"]',
  '.modal-close', '.popup-close', '.dialog-close',
  'button.close', 'a.close',
];

// Unsupported-browser wall — some sites (e.g. Unibet) show this before rendering
const UNSUPPORTED_BROWSER_SELECTORS = [
  'a:text("Continue with unsupported browser")',
  'button:text("Continue with unsupported browser")',
  ':text("Continue with unsupported browser")',
  'a:text("continue anyway")',
  'a:text("Continue anyway")',
  'button:text("Continue anyway")',
];

// Language selector — click "English" to proceed past language picker modals
const LANGUAGE_SELECTORS = [
  'button:text-is("English")',
  'a:text-is("English")',
  'li:text-is("English")',
  '[class*="language"] :text("English")',
  '[class*="lang"] :text("English")',
  ':text-is("English")',  // broadest fallback
];

async function tryClick(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        return true;
      }
    } catch { /* selector not found */ }
  }
  return false;
}

export async function dismissPopups(page: Page): Promise<void> {
  // 0. Unsupported-browser wall — click through before anything else renders
  const browserWallClicked = await tryClick(page, UNSUPPORTED_BROWSER_SELECTORS);
  if (browserWallClicked) {
    await page.waitForFunction(
      () => document.images.length >= 2 || (document.body?.innerText ?? '').trim().length >= 300,
      { timeout: 20_000 }
    ).catch(() => {});
  }

  // 1. Language selector — must go first so the page actually renders
  const langClicked = await tryClick(page, LANGUAGE_SELECTORS);
  if (langClicked) {
    // Wait for the page to re-render after language selection
    await page.waitForFunction(
      () => document.images.length >= 2 || (document.body?.innerText ?? '').trim().length >= 300,
      { timeout: 20_000 }
    ).catch(() => {});
  }

  // 2. Age gates (may block everything else)
  await tryClick(page, AGE_GATE_SELECTORS);

  // 3. Cookie consent
  await tryClick(page, COOKIE_SELECTORS);

  // 4. Modals / overlays
  await tryClick(page, MODAL_CLOSE_SELECTORS);

  // Small settle after dismissals
  await page.waitForTimeout(500);
}
