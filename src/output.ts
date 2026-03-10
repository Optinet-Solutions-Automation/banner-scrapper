/**
 * output.ts — Delivers scraped banners to GCS or n8n webhook.
 * If neither is configured, images are already saved locally by image-downloader.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { ScrapeResult } from './types';
import { config } from './config';

// ── GCS upload (uses Cloud Run metadata server for auth automatically) ────────
// On Cloud Run the compute service account token is fetched from the metadata
// server — no extra credentials needed. Falls back to GCS_ACCESS_TOKEN env var
// for local development.
async function getGCSToken(): Promise<string> {
  // Prefer explicit env var (local dev)
  if (process.env.GCS_ACCESS_TOKEN) return process.env.GCS_ACCESS_TOKEN;

  // On Cloud Run: fetch from metadata server
  return new Promise((resolve) => {
    const req = http.get({
      host: 'metadata.google.internal',
      path: '/computeMetadata/v1/instance/service-accounts/default/token',
      headers: { 'Metadata-Flavor': 'Google' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).access_token ?? ''); }
        catch { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
  });
}

async function uploadToGCS(localPath: string, domain: string): Promise<string | null> {
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) return null;

  // Reconstruct the GCS object path from the local file path:
  // output/<domain>/<pageType>/banner_01.webp → <domain>/<pageType>/banner_01.webp
  const parts = localPath.split(/[\\/]/);
  const filename  = parts[parts.length - 1];  // banner_01.webp
  const pageType  = parts[parts.length - 2];  // homepage | promotions
  const objectKey = `${domain}/${pageType}/${filename}`;
  const objectName = encodeURIComponent(objectKey);

  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${objectName}`;

  const body = fs.readFileSync(localPath);
  const contentType = localPath.endsWith('.webp') ? 'image/webp'
    : localPath.endsWith('.png')  ? 'image/png'
    : localPath.endsWith('.gif')  ? 'image/gif'
    : localPath.endsWith('.avif') ? 'image/avif'
    : 'image/jpeg';

  const token = await getGCSToken();

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type':   contentType,
        'Content-Length': body.length,
        'Authorization':  `Bearer ${token}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const obj = JSON.parse(data);
          // Public URL — readable by anyone since bucket has allUsers objectViewer
          resolve(`https://storage.googleapis.com/${bucket}/${obj.name ?? objectKey}`);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── n8n webhook ───────────────────────────────────────────────────────────────

/** Converts a local banner file path → a public URL served by this backend.
 *  e.g. /output/bet365_com/homepage/banner_01.webp → http://host/banners/bet365_com/homepage/banner_01.webp */
function toImageUrl(localPath: string | undefined): string {
  if (!localPath) return '';
  const normalized = localPath.replace(/\\/g, '/');
  const outputDir  = config.outputDir.replace(/\\/g, '/').replace(/\/?$/, '/');
  const relative   = normalized.startsWith(outputDir)
    ? normalized.slice(outputDir.length)            // bet365_com/homepage/banner_01.webp
    : normalized.split('/').slice(-3).join('/');    // fallback: last 3 segments
  return `${config.backendUrl}/banners/${relative}`;
}

async function sendToN8n(result: ScrapeResult): Promise<void> {
  const webhookUrl = config.n8nWebhookUrl;
  if (!webhookUrl) return;

  const mapBanner = (b: typeof result.homepageBanners[0]) => ({
    src:       b.src,
    imageUrl:  toImageUrl(b.localPath),   // downloadable URL for n8n
    localPath: b.localPath,
    width:     b.width,
    height:    b.height,
    page:      b.page,
    altText:   b.altText,
    context:   b.context,
    score:     b.score,
  });

  const payload = JSON.stringify({
    url:             result.url,
    domain:          result.domain,
    tier:            result.tier,
    geo:             result.geo ?? '',
    success:         result.success,
    scrapedAt:       result.scrapedAt,
    homepageBanners: result.homepageBanners.map(mapBanner),
    promoBanners:    result.promoBanners.map(mapBanner),
  });

  const parsed   = new URL(webhookUrl);
  const isHttps  = parsed.protocol === 'https:';
  const lib      = isHttps ? https : http;

  await new Promise<void>((resolve) => {
    const req = lib.request(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', (e) => { console.warn('  ⚠ n8n webhook error:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });

  console.log(`  → Sent result to n8n webhook`);
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function deliverOutput(result: ScrapeResult): Promise<void> {
  const hasGCS  = !!process.env.GCS_BUCKET;
  const hasN8n  = !!config.n8nWebhookUrl;

  // Upload to GCS if configured
  if (hasGCS) {
    const allBanners = [...result.homepageBanners, ...result.promoBanners];
    for (const banner of allBanners) {
      if (!banner.localPath) continue;
      const gcsUrl = await uploadToGCS(banner.localPath, result.domain);
      if (gcsUrl) {
        console.log(`  ☁  GCS: ${gcsUrl}`);
        banner.gcsUrl = gcsUrl;
      }
    }
  }

  // Send summary to n8n if configured
  if (hasN8n) {
    await sendToN8n(result);
  }

  if (!hasGCS && !hasN8n) {
    console.log(`  ℹ No GCS_BUCKET or N8N_WEBHOOK_URL set — images saved locally only`);
  }
}
