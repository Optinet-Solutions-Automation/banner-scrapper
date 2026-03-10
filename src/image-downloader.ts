import * as fs from 'fs';
import * as path from 'path';
import { BrowserContext } from 'playwright';
import { BannerImage } from './types';
import { config } from './config';

function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9_\-\.]/g, '_').substring(0, 80);
}

function inferExtension(src: string, contentType: string): string {
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('png'))  return '.png';
  if (contentType.includes('gif'))  return '.gif';
  if (contentType.includes('svg'))  return '.svg';
  if (contentType.includes('avif')) return '.avif';
  const ext = path.extname(new URL(src, 'https://x.com').pathname).split('?')[0];
  return ext || '.jpg';
}

export async function downloadBanners(
  context: BrowserContext,
  banners: BannerImage[],
  domain: string,
  pageType: 'homepage' | 'promotions'
): Promise<BannerImage[]> {
  const dir = path.join(config.outputDir, sanitizeFilename(domain), pageType);
  fs.mkdirSync(dir, { recursive: true });

  // Derive origin for Referer header (CDNs and Next.js image proxy reject headerless requests)
  const siteOrigin = (() => {
    try { return new URL(`https://${domain}`).origin; } catch { return `https://${domain}`; }
  })();

  const downloadOne = async (banner: BannerImage, i: number): Promise<BannerImage | null> => {
    // Use the image's own origin as Referer — avoids www. vs non-www mismatch
    const referer = (() => {
      try { return new URL(banner.src).origin + '/'; } catch { return `${siteOrigin}/`; }
    })();

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await context.request.get(banner.src, {
          timeout: 45_000,
          headers: {
            'Referer':        referer,
            'Accept':         'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language':'en-US,en;q=0.9',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'same-site',
          },
        });
        if (!response.ok()) {
          console.warn(`    ⚠ Download failed (${response.status()}): ${banner.src}`);
          return null;  // non-retriable HTTP error
        }

        const body        = await response.body();
        const contentType = response.headers()['content-type'] ?? '';

        // Integrity check: reject HTML error pages served as 200
        if (!contentType.startsWith('image/') && !contentType.includes('octet-stream')) {
          console.warn(`    ⚠ Non-image content-type "${contentType.split(';')[0]}" — skipping: ${banner.src.substring(0, 80)}`);
          return null;
        }
        if (body.length < 2048) {
          console.warn(`    ⚠ Suspiciously small file (${body.length}B) — skipping: ${banner.src.substring(0, 80)}`);
          return null;
        }

        const ext      = inferExtension(banner.src, contentType);
        const filename = `banner_${String(i + 1).padStart(2, '0')}${ext}`;
        const filepath = path.join(dir, filename);
        fs.writeFileSync(filepath, body);
        console.log(`    ✓ Saved ${filename} (${banner.width}x${banner.height}) score=${banner.score}`);
        return { ...banner, localPath: filepath };
      } catch (err) {
        const msg = (err as Error).message ?? '';
        const isRetriable = msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') ||
                            msg.includes('timeout') || msg.includes('socket');
        if (attempt < 3 && isRetriable) {
          console.warn(`    ↻ Retry ${attempt}/3 for ${path.basename(banner.src)}: ${msg.split('\n')[0]}`);
          await new Promise(r => setTimeout(r, 2000 * attempt)); // 2s, 4s backoff
        } else {
          console.warn(`    ⚠ Error downloading ${banner.src.substring(0, 80)}: ${msg.split('\n')[0]}`);
          return null;
        }
      }
    }
    return null;
  };

  // Download all banners in parallel (up to 5 concurrent)
  const CONCURRENCY = 5;
  const downloaded: BannerImage[] = [];
  for (let offset = 0; offset < banners.length; offset += CONCURRENCY) {
    const batch = banners.slice(offset, offset + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((banner, j) => downloadOne(banner, offset + j))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) downloaded.push(r.value);
    }
  }

  return downloaded;
}
