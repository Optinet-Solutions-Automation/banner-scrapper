import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env if present
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

export const config = {
  // Datacenter proxy (Tier 3)
  // Supports DC_PROXY_PORTS=8001,8002,8003 for rotation, or DC_PROXY_PORT for single
  dcProxy: {
    host:     process.env.DC_PROXY_HOST      ?? '',
    ports:    (process.env.DC_PROXY_PORTS ?? process.env.DC_PROXY_PORT ?? '').split(',').map(p => p.trim()).filter(Boolean),
    protocol: process.env.DC_PROXY_PROTOCOL  ?? 'http',
    username: process.env.DC_PROXY_USERNAME  ?? '',
    password: process.env.DC_PROXY_PASSWORD  ?? '',
    // Optional country targeting — appends "-country-XX" to username (e.g. "ca", "us", "gb")
    geo:      process.env.DC_PROXY_GEO       ?? '',
  },

  // Residential proxy (Tier 4)
  resProxy: {
    host:     process.env.RES_PROXY_HOST     ?? '',
    port:     process.env.RES_PROXY_PORT     ?? '',
    username: process.env.RES_PROXY_USERNAME ?? '',
    password: process.env.RES_PROXY_PASSWORD ?? '',
    geoCountries: (process.env.RES_PROXY_GEO_COUNTRIES ?? 'US,UK,CA,AU,NZ').split(','),
  },

  // Output
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL ?? '',

  // Scraper behaviour
  maxTier:         parseInt(process.env.MAX_TIER         ?? '4', 10),
  tierRecheckDays: parseInt(process.env.TIER_RECHECK_DAYS ?? '7', 10),
  pageTimeout:     parseInt(process.env.PAGE_TIMEOUT      ?? '60000', 10),
  debugScreenshots: (process.env.DEBUG_SCREENSHOTS ?? 'true') === 'true',
  minBannerWidth:  parseInt(process.env.MIN_BANNER_WIDTH  ?? '600', 10),
  minBannerHeight: parseInt(process.env.MIN_BANNER_HEIGHT ?? '150', 10),

  // Paths
  outputDir:     path.join(process.cwd(), 'output'),
  screenshotDir: path.join(process.cwd(), 'temp_screenshots'),
  siteMemoryPath: path.join(process.cwd(), 'sites.json'),
};

/** Returns the proxy server URL for a given type, or undefined if not configured.
 *  @param attempt — used to rotate through DC proxy ports (0-indexed). */
export function proxyServer(type: 'datacenter' | 'residential', attempt = 0): string | undefined {
  if (type === 'datacenter') {
    const p = config.dcProxy;
    if (!p.host || p.ports.length === 0) return undefined;
    const port = p.ports[attempt % p.ports.length];
    return `${p.protocol}://${p.host}:${port}`;
  }
  const p = config.resProxy;
  if (!p.host || !p.port) return undefined;
  return `http://${p.host}:${p.port}`;
}
