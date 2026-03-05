import { Page } from 'playwright';
import { FailureReason, TierResult } from '../types';

export async function validatePageSuccess(page: Page, tier: number): Promise<TierResult> {
  let title = '';
  let bodyText = '';
  let imageCount = 0;
  let statusCode = 200;

  try {
    title = await page.title();
    bodyText = await page.evaluate(() =>
      (document.body?.innerText ?? '').substring(0, 3000)
    );
    imageCount = await page.$$eval('img', imgs => imgs.length);
  } catch {
    return { success: false, failureReason: FailureReason.EMPTY_PAGE, tier };
  }

  const titleLower = title.toLowerCase();
  const bodyLower  = bodyText.toLowerCase();

  // ── Cloudflare ────────────────────────────────────────────────────────────
  if (
    bodyLower.includes('checking your browser') ||
    bodyLower.includes('cf-browser-verification') ||
    bodyLower.includes('enable javascript and cookies') ||
    titleLower.includes('just a moment') ||
    titleLower.includes('attention required') ||
    (await page.$('#challenge-running, #cf-spinner, .cf-browser-verification')) !== null
  ) {
    return { success: false, failureReason: FailureReason.CLOUDFLARE_CHALLENGE, tier };
  }

  // ── CAPTCHA ───────────────────────────────────────────────────────────────
  if (
    bodyLower.includes('captcha') ||
    (await page.$('iframe[src*="captcha"], .g-recaptcha, .h-captcha, [data-sitekey]')) !== null
  ) {
    return { success: false, failureReason: FailureReason.CAPTCHA_DETECTED, tier };
  }

  // ── Geo-block ─────────────────────────────────────────────────────────────
  if (
    /not available.*(your|this) (region|country|location)/i.test(bodyText) ||
    /restricted.*(jurisdiction|territory)/i.test(bodyText) ||
    /this (service|site|content) is not (available|accessible)/i.test(bodyText) ||
    // Philippine PAGCOR / CICC block page
    /not licensed by philippine/i.test(bodyText) ||
    /pagcor.approved/i.test(bodyText) ||
    /eastern-tele\.com/i.test(page.url()) ||
    // Generic regulatory blocks
    /this website is (blocked|restricted|not accessible)/i.test(bodyText) ||
    /access (restricted|blocked) by/i.test(bodyText) ||
    /unavailable in your (country|region)/i.test(bodyText) ||
    // "cannot be accessed in your region" (novadreams, betninja-style)
    /cannot be accessed in your (region|country)/i.test(bodyText) ||
    /not accessible (in|from) your (region|country)/i.test(bodyText) ||
    /not available (in|from) your (region|country)/i.test(bodyText) ||
    // Proxy/VPN detection messages (tooniebet-style)
    /if you.*accessing.*proxy.*turn it off/i.test(bodyText) ||
    /turn off.*proxy.*vpn/i.test(bodyText) ||
    /disable.*proxy.*to (access|continue)/i.test(bodyText) ||
    // Title-based geo block patterns
    titleLower.includes('country blocked') ||
    titleLower.includes('restricted region') ||
    titleLower.includes('region restricted') ||
    titleLower.includes('not available in your') ||
    titleLower.includes('geo restricted') ||
    titleLower.includes('geo blocked')
  ) {
    return { success: false, failureReason: FailureReason.GEO_BLOCKED, tier };
  }

  // ── Access denied ─────────────────────────────────────────────────────────
  if (
    titleLower.includes('403 forbidden') ||
    titleLower.includes('access denied') ||
    titleLower.includes('access restricted') ||
    titleLower.includes('unauthorized') ||
    titleLower.includes('site blocked') ||
    titleLower.includes('website blocked')
  ) {
    return { success: false, failureReason: FailureReason.ACCESS_DENIED, statusCode: 403, tier };
  }

  // ── Bot detected ──────────────────────────────────────────────────────────
  if (
    /bot.*detected/i.test(bodyText) ||
    /automated.*access.*denied/i.test(bodyText) ||
    bodyLower.includes('you have been blocked')
  ) {
    return { success: false, failureReason: FailureReason.BOT_DETECTED, tier };
  }

  // ── Hard proxy block (completely blank response) ─────────────────────────
  // A datacenter IP that is hard-blocked by the site receives an empty 200 OK:
  // no title, no body text, no images. This is NOT an SPA still loading — those
  // always have at least an HTML skeleton. Use HARD_BLOCKED so the orchestrator
  // escalates the tier immediately instead of wasting time cycling through geos
  // (all exit IPs from this proxy tier are equally blocked).
  if (!title && bodyText.trim().length === 0 && imageCount === 0) {
    return { success: false, failureReason: FailureReason.HARD_BLOCKED, tier };
  }

  // ── Empty / unrendered page ───────────────────────────────────────────────
  if (imageCount < 2 && bodyText.trim().length < 300) {
    return { success: false, failureReason: FailureReason.EMPTY_PAGE, tier };
  }

  return { success: true, tier, statusCode };
}
