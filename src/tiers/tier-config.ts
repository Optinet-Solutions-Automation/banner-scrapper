import { TierConfig } from '../types';
export type { TierConfig };

export const TIER_CONFIGS: Record<number, TierConfig> = {
  1: {
    tier: 1,
    name: 'Vanilla Playwright',
    stealth: false,
    proxy: 'none',
    userAgentRotation: false,
    humanDelays: false,
    geoTargeting: false,
    timeout: 30_000,
    retries: 1,
    waitUntil: 'networkidle',
  },
  2: {
    tier: 2,
    name: 'Playwright + Stealth',
    stealth: true,
    proxy: 'none',
    userAgentRotation: true,
    humanDelays: true,
    geoTargeting: false,
    timeout: 45_000,
    retries: 2,
    waitUntil: 'networkidle',
  },
  3: {
    tier: 3,
    name: 'Stealth + Datacenter Proxy',
    stealth: true,
    proxy: 'datacenter',
    userAgentRotation: true,
    humanDelays: true,
    geoTargeting: false,
    timeout: 90_000,
    retries: 2,
    // 'domcontentloaded' fires as soon as HTML is parsed — much faster than 'load'
    // which waits for ALL resources (fonts, analytics, CDN scripts) and easily
    // times out through a proxy chain. The real content-ready check is the
    // waitForFunction in scraper.ts that follows the goto().
    waitUntil: 'domcontentloaded',
  },
  4: {
    tier: 4,
    name: 'Stealth + Residential Proxy',
    stealth: true,
    proxy: 'residential',
    userAgentRotation: true,
    humanDelays: true,
    geoTargeting: true,
    timeout: 90_000,
    retries: 3,
    waitUntil: 'domcontentloaded',
  },
};

// Only Chrome/Chromium UAs — never Firefox or Safari.
// The stealth plugin patches Chromium-specific APIs (WebGL, canvas, navigator.*).
// If we claim to be Firefox/Safari but expose Chromium internals, bot detectors
// flag the mismatch immediately.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export function humanDelay(min = 500, max = 2000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return new Promise(r => setTimeout(r, ms));
}
