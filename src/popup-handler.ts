import { Page } from 'playwright';

// Selectors for common popups on casino/gaming sites
const COOKIE_SELECTORS = [
  // Accept buttons
  'button[id*="accept"]', 'button[class*="accept"]',
  'button[id*="cookie"]', 'button[class*="cookie"]',
  'button[id*="consent"]', 'button[class*="consent"]',
  'a[id*="accept"]', 'a[class*="accept"]',
  '[data-testid*="cookie-accept"]', '[data-testid*="accept-cookies"]',
  // Common text patterns
  'button:text-is("Accept")', 'button:text-is("Accept All")',
  'button:text-is("ACCEPT ALL")', 'button:text-is("ACCEPT")',
  'button:text-is("Accept Cookies")', 'button:text-is("I Accept")',
  'button:text-is("OK")', 'button:text-is("Got it")',
  'button:text-is("Allow All")', 'button:text-is("ALLOW ALL")',
  'button:text-is("Allow Cookies")', 'button:text-is("Allow all cookies")',
  'button:text-is("Agree")', 'button:text-is("I Agree")',
  'button:text-is("Accept and close")', 'button:text-is("Accept & close")',
  'button:text("Yes, I agree")', 'button:text("Yes, accept")',
  // CMP/Consent Management Platforms
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '.cc-accept', '.cookie-accept', '#cookieAccept',
  '[aria-label*="Accept cookies"]', '[aria-label*="accept all"]',
];

const AGE_GATE_SELECTORS = [
  // Simple button click
  'button:text-is("Enter")', 'button:text-is("Enter Site")',
  'button:text-is("I am 18+")', 'button:text-is("I\'m 18+")',
  'button:text-is("I am over 18")', 'button:text-is("Enter Now")',
  'button:text-is("Yes, I am 18+")', 'button:text-is("I\'m of legal age")',
  'button:text-is("I am of legal age")', 'button:text-is("I\'m 18 or older")',
  'button:text("Yes, I\'m 18+")', 'button:text("Yes")',
  'button:text-is("Continue")', 'button:text-is("Proceed")',
  '[class*="age-gate"] button', '[id*="age-gate"] button',
  '[class*="age-verify"] button', '[id*="age-verify"] button',
  '[class*="age-check"] button', '[id*="age-check"] button',
  // Play for fun / Guest access (bypasses login-only promo pages)
  'button:text("Play for fun")', 'button:text("Play as guest")',
  'button:text("Continue as guest")', 'a:text("Play for fun")',
  // "I confirm I am 18" checkbox pattern (check it, then look for submit button)
  'input[type="checkbox"][id*="age"]', 'input[type="checkbox"][name*="age"]',
  'input[type="checkbox"][id*="legal"]', 'input[type="checkbox"][name*="legal"]',
];

const MODAL_CLOSE_SELECTORS = [
  'button[aria-label="Close"]', 'button[aria-label="close"]',
  'button[aria-label="Dismiss"]', 'button[aria-label="dismiss"]',
  '[class*="modal"] button[class*="close"]',
  '[class*="modal"] button[class*="dismiss"]',
  '[class*="popup"] button[class*="close"]',
  '[class*="popup"] .close', '[class*="overlay"] .close',
  '.modal-close', '.popup-close', '.dialog-close', '.lightbox-close',
  'button.close', 'a.close', '[data-dismiss="modal"]',
  'button[class*="CloseButton"]', 'button[class*="close-button"]',
  // SVG close icons inside buttons
  'button:has(svg[class*="close"])', 'button:has([aria-label="close"])',
  // X/× text close buttons
  'button:text("×")', 'button:text("✕")', 'button:text("✖")',
];

// Unsupported-browser wall
const UNSUPPORTED_BROWSER_SELECTORS = [
  'a:text("Continue with unsupported browser")',
  'button:text("Continue with unsupported browser")',
  ':text("Continue with unsupported browser")',
  'a:text("continue anyway")', 'a:text("Continue anyway")',
  'button:text("Continue anyway")', 'button:text("Continue anyway")',
];

// Language selector
const LANGUAGE_SELECTORS = [
  'button:text-is("English")', 'a:text-is("English")',
  'li:text-is("English")', '[class*="language"] :text("English")',
  '[class*="lang"] :text("English")',
  // Canada-English variant (some sites show CA/EN picker)
  'button:text-is("English (CA)")', 'a:text-is("English (CA)")',
  'button:text-is("EN")', ':text-is("English")',  // broadest fallback
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

/** Handle DOB-form age gates: fill year, month, day dropdowns/inputs then submit. */
async function tryDobAgeGate(page: Page): Promise<boolean> {
  // Look for a DOB form — year dropdown or input that's visible
  const hasDobForm = await page.evaluate(() => {
    const yearEl = document.querySelector(
      'select[name*="year"], select[id*="year"], input[name*="year"], input[placeholder*="Year"], input[placeholder*="YYYY"]'
    );
    return !!(yearEl && (yearEl as HTMLElement).offsetParent !== null);
  });
  if (!hasDobForm) return false;

  try {
    // Fill year (use 1990 — clearly over 18)
    const yearSel = page.locator('select[name*="year"], select[id*="year"]').first();
    if (await yearSel.isVisible({ timeout: 1000 }).catch(() => false)) {
      await yearSel.selectOption('1990');
    } else {
      const yearInput = page.locator('input[name*="year"], input[placeholder*="Year"], input[placeholder*="YYYY"]').first();
      if (await yearInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await yearInput.fill('1990');
      }
    }

    // Fill month
    const monthSel = page.locator('select[name*="month"], select[id*="month"]').first();
    if (await monthSel.isVisible({ timeout: 1000 }).catch(() => false)) {
      await monthSel.selectOption('6');
    } else {
      const monthInput = page.locator('input[name*="month"], input[placeholder*="Month"], input[placeholder*="MM"]').first();
      if (await monthInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await monthInput.fill('06');
      }
    }

    // Fill day
    const daySel = page.locator('select[name*="day"], select[id*="day"]').first();
    if (await daySel.isVisible({ timeout: 1000 }).catch(() => false)) {
      await daySel.selectOption('15');
    } else {
      const dayInput = page.locator('input[name*="day"], input[placeholder*="Day"], input[placeholder*="DD"]').first();
      if (await dayInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await dayInput.fill('15');
      }
    }

    await page.waitForTimeout(300);

    // Submit: look for confirm/enter button near the form
    const submitted = await tryClick(page, [
      'button:text-is("Confirm")', 'button:text-is("CONFIRM")',
      'button:text-is("Submit")', 'button:text-is("Enter")',
      'button:text-is("Verify")', 'button:text-is("Continue")',
      '[class*="age-gate"] button[type="submit"]',
      '[class*="age-verify"] button[type="submit"]',
      'button[type="submit"]',
    ]);

    if (submitted) {
      await page.waitForTimeout(1500);
      return true;
    }
  } catch { /* DOB form failed */ }
  return false;
}

/** Check and click age-confirmation checkboxes, then look for the submit button. */
async function tryAgeCheckbox(page: Page): Promise<boolean> {
  const checkboxSels = [
    'input[type="checkbox"][id*="age"]',
    'input[type="checkbox"][name*="age"]',
    'input[type="checkbox"][id*="legal"]',
    'input[type="checkbox"][id*="18"]',
    'input[type="checkbox"][name*="confirm"]',
  ];
  for (const sel of checkboxSels) {
    try {
      const cb = page.locator(sel).first();
      if (await cb.isVisible({ timeout: 1000 })) {
        const checked = await cb.isChecked();
        if (!checked) await cb.check();
        await page.waitForTimeout(300);
        // Try to submit after checking
        await tryClick(page, [
          'button:text-is("Enter")', 'button:text-is("Continue")',
          'button:text-is("Proceed")', 'button[type="submit"]',
        ]);
        return true;
      }
    } catch { /* skip */ }
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
    await page.waitForFunction(
      () => document.images.length >= 2 || (document.body?.innerText ?? '').trim().length >= 300,
      { timeout: 20_000 }
    ).catch(() => {});
  }

  // 2. Age gates — try simple button first, then DOB form, then checkbox
  const simpleAgeClicked = await tryClick(page, AGE_GATE_SELECTORS);
  if (!simpleAgeClicked) {
    const dobDone = await tryDobAgeGate(page);
    if (!dobDone) {
      await tryAgeCheckbox(page);
    }
  }

  // 3. Cookie consent
  await tryClick(page, COOKIE_SELECTORS);

  // 4. Modals / overlays
  await tryClick(page, MODAL_CLOSE_SELECTORS);

  // 5. Escape key as last resort (dismisses some modal dialogs)
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  // Small settle after dismissals
  await page.waitForTimeout(500);
}
