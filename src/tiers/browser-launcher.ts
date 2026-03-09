import { Browser, BrowserContext, chromium as vanillaChromium } from 'playwright';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { TierConfig, randomUserAgent } from './tier-config';
import { config, proxyServer } from '../config';

// Stealth-patched chromium instance (reused across stealth tiers)
const stealthChromium = addExtra(vanillaChromium);
stealthChromium.use(StealthPlugin());

export interface BrowserBundle {
  browser: Browser;
  context: BrowserContext;
}

export async function launchBrowser(tierCfg: TierConfig, attempt = 0): Promise<BrowserBundle> {
  const proxyType = tierCfg.proxy;
  // Pass attempt index so DC proxy rotates through ports 8001→8002→8003…
  const server    = proxyType !== 'none' ? proxyServer(proxyType, attempt) : undefined;
  if (server) console.log(`  Proxy: ${server}`);

  const proxyCredentials = (() => {
    if (proxyType === 'datacenter') return config.dcProxy;
    if (proxyType === 'residential') {
      // Geo targeting varies by provider — embed it directly in the username/password
      // when configuring RES_PROXY_USERNAME (e.g. pl-user_area-PH for ProxyLite).
      return config.resProxy;
    }
    return null;
  })();

  const launchProxy = server
    ? {
        server,
        username: proxyCredentials?.username || undefined,
        password: proxyCredentials?.password || undefined,
      }
    : undefined;

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Fix DNS resolution in restricted shell environments (Windows / Cloud Run)
      '--dns-prefetch-disable',
      '--dns-server-list=8.8.8.8,1.1.1.1',
    ],
    proxy: launchProxy,
  };

  const chromiumToUse = tierCfg.stealth ? stealthChromium : vanillaChromium;
  const browser = await (chromiumToUse as typeof vanillaChromium).launch(launchOptions);

  const viewport = tierCfg.userAgentRotation
    ? { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) }
    : { width: 1440, height: 900 };

  // Build extra headers — add Oxylabs geo-location when country targeting is configured
  const extraHeaders: Record<string, string> = { 'Accept-Language': 'en-US,en;q=0.9' };
  if (proxyType === 'datacenter' && config.dcProxy.geo) {
    extraHeaders['x-oxylabs-geo-location'] = config.dcProxy.geo.toUpperCase();
    console.log(`  Geo: ${config.dcProxy.geo.toUpperCase()} (via x-oxylabs-geo-location header)`);
  }

  const context = await browser.newContext({
    viewport,
    userAgent: tierCfg.userAgentRotation ? randomUserAgent() : undefined,
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    extraHTTPHeaders: extraHeaders,
  });

  // Block heavy resources on Tier 3/4 to speed up loading
  if (tierCfg.tier >= 3) {
    await context.route('**/*.{woff,woff2,ttf,otf}', r => r.abort());
    await context.route('**/analytics**', r => r.abort());
    await context.route('**/gtag**', r => r.abort());
    await context.route('**/google-analytics**', r => r.abort());
  }

  // Tier 4: inject mouse movement simulation on every new page
  if (tierCfg.tier >= 4) {
    context.on('page', async (page) => {
      await page.addInitScript(() => {
        // Simulate natural mouse presence — moves cursor on document load
        let x = Math.random() * window.innerWidth;
        let y = Math.random() * window.innerHeight;
        const jitter = () => {
          x += (Math.random() - 0.5) * 20;
          y += (Math.random() - 0.5) * 20;
          x = Math.max(0, Math.min(window.innerWidth,  x));
          y = Math.max(0, Math.min(window.innerHeight, y));
          document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
        };
        const iv = setInterval(jitter, 300 + Math.random() * 400);
        window.addEventListener('beforeunload', () => clearInterval(iv));
      });
    });
  }

  return { browser, context };
}
