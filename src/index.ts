/**
 * index.ts — Entry point.
 *
 * CLI mode:   npx ts-node src/index.ts <url1> [url2] ... [--geo=XX]
 *
 * HTTP mode:  Set PORT env var → starts HTTP server
 *   GET  /health
 *   POST /scrape                  { "urls": [...], "geo": "XX" }  → JSON
 *   GET  /scrape-stream           ?urls=url1,url2&geo=XX          → SSE
 *   GET  /sites                   → sites.json contents
 *   PUT  /sites/:domain           { "workingGeo": "XX", ... }
 *   DELETE /sites/:domain         remove from memory
 *   GET  /banners/:domain/:file   serve banner image
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { runScraper } from './orchestrator';
import { config } from './config';
import { progressEmitter, ProgressEvent } from './progress-emitter';
import { getSiteMemory, saveSiteMemory, deleteSiteMemory, initializeMemory } from './site-memory';

fs.mkdirSync(config.outputDir,     { recursive: true });
fs.mkdirSync(config.screenshotDir, { recursive: true });

// ── Scraping mutex ────────────────────────────────────────────────────────────
// Cloud Run can receive concurrent HTTP requests. Playwright + proxy is NOT safe
// to run concurrently (shared progressEmitter, proxy rate limits, RAM pressure).
// Reject new scrape requests while one is already in progress.
let scrapingInProgress = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseUrls(raw: string[]): string[] {
  const valid: string[] = [];
  for (const arg of raw) {
    try {
      const parsed = new URL(arg);
      if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) continue;
      valid.push(arg);
    } catch { /* skip */ }
  }
  return valid;
}

function setCorsHeaders(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function writeSummary(results: Awaited<ReturnType<typeof runScraper>>) {
  const summaryPath = path.join(config.outputDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf-8');
  return summaryPath;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function startHttpServer(port: number) {
  const server = http.createServer(async (req, res) => {
    // CORS on every response
    setCorsHeaders(res);

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const rawUrl = req.url ?? '/';

    // ── GET /health ──────────────────────────────────────────────────────
    if (req.method === 'GET' && rawUrl === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', busy: scrapingInProgress }));
      return;
    }

    // ── GET /scrape-stream  (SSE real-time progress) ─────────────────────
    if (req.method === 'GET' && rawUrl.startsWith('/scrape-stream')) {
      if (scrapingInProgress) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A scrape is already in progress. Please wait.' }));
        return;
      }

      const qp = new URL(rawUrl, 'http://localhost').searchParams;
      const rawUrls = (qp.get('urls') ?? '')
        .split(',').map(u => u.trim()).filter(Boolean);
      const geoParam = qp.get('geo') ?? undefined;
      const validUrls = parseUrls(rawUrls);

      if (validUrls.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid URLs provided' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      const send = (data: object) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      };

      const onProgress = (event: ProgressEvent) => send(event);
      progressEmitter.on('progress', onProgress);

      req.on('close', () => {
        progressEmitter.off('progress', onProgress);
      });

      scrapingInProgress = true;
      try {
        const results = await runScraper(validUrls, geoParam);
        await writeSummary(results);
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      } finally {
        scrapingInProgress = false;
        progressEmitter.off('progress', onProgress);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // ── POST /scrape  (blocking JSON response) ───────────────────────────
    if (req.method === 'POST' && rawUrl === '/scrape') {
      if (scrapingInProgress) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A scrape is already in progress. Please wait.' }));
        return;
      }
      const body = await readBody(req);
      try {
        const { urls: rawUrls, geo } = JSON.parse(body) as { urls?: string[]; geo?: string };
        if (!rawUrls || !Array.isArray(rawUrls) || rawUrls.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Body must be { "urls": ["https://..."] }' }));
          return;
        }
        const validUrls = parseUrls(rawUrls);
        scrapingInProgress = true;
        const results = await runScraper(validUrls, geo);
        await writeSummary(results);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      } catch (err) {
        console.error('POST /scrape error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      } finally {
        scrapingInProgress = false;
      }
      return;
    }

    // ── GET /sites ───────────────────────────────────────────────────────
    if (req.method === 'GET' && rawUrl === '/sites') {
      try {
        const data = fs.existsSync(config.siteMemoryPath)
          ? JSON.parse(fs.readFileSync(config.siteMemoryPath, 'utf-8'))
          : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
      return;
    }

    // ── PUT /sites/:domain  (update geo/tier for a site) ─────────────────
    if (req.method === 'PUT' && rawUrl.startsWith('/sites/')) {
      const domain = decodeURIComponent(rawUrl.slice('/sites/'.length));
      const body   = await readBody(req);
      try {
        const updates = JSON.parse(body);
        const existing = getSiteMemory(domain) ?? {
          lastSuccessfulTier: 1,
          lastScraped: new Date().toISOString(),
        };
        saveSiteMemory(domain, { ...existing, ...updates });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      return;
    }

    // ── DELETE /sites/:domain ────────────────────────────────────────────
    if (req.method === 'DELETE' && rawUrl.startsWith('/sites/')) {
      const domain = decodeURIComponent(rawUrl.slice('/sites/'.length));
      deleteSiteMemory(domain);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── GET /banners/:domain/:filename  (serve scraped images) ───────────
    if (req.method === 'GET' && rawUrl.startsWith('/banners/')) {
      const parts    = rawUrl.slice('/banners/'.length).split('/');
      const domain   = decodeURIComponent(parts[0] ?? '');
      const filename = decodeURIComponent(parts.slice(1).join('/'));
      const filePath = path.join(config.outputDir, domain, filename);

      if (domain && filename && fs.existsSync(filePath)) {
        const ext = path.extname(filename).toLowerCase();
        const contentType = ({
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.png': 'image/png',  '.webp': 'image/webp',
          '.gif': 'image/gif',  '.avif': 'image/avif',
        } as Record<string, string>)[ext] ?? 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type':  contentType,
          'Cache-Control': 'public, max-age=3600',
        });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      return;
    }

    // ── POST /analyze-prompts — proxy to n8n, returns prompts from Claude Vision ──
    if (req.method === 'POST' && rawUrl === '/analyze-prompts') {
      const n8nUrl = config.n8nWebhookUrl;
      if (!n8nUrl) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'N8N_WEBHOOK_URL not configured' }));
        return;
      }
      const body = await readBody(req);
      try {
        const parsed = new URL(n8nUrl);
        const lib = parsed.protocol === 'https:' ? https : http;
        const n8nResponseText = await new Promise<string>((resolve, reject) => {
          const n8nReq = lib.request(n8nUrl, {
            method: 'POST',
            headers: {
              'Content-Type':   'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          }, (r) => {
            let data = '';
            r.on('data', c => data += c);
            r.on('end', () => resolve(data));
          });
          n8nReq.setTimeout(180_000, () => {
            n8nReq.destroy(new Error('n8n request timed out after 180s'));
          });
          n8nReq.on('error', reject);
          n8nReq.write(body);
          n8nReq.end();
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(n8nResponseText);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `n8n request failed: ${(err as Error).message}` }));
      }
      return;
    }

    // ── POST /approve-prompt — records approval; forwards to Airtable webhook when configured ──
    if (req.method === 'POST' && rawUrl === '/approve-prompt') {
      const body = await readBody(req);
      const airtableUrl = process.env.AIRTABLE_WEBHOOK_URL;
      if (airtableUrl) {
        try {
          const parsed = new URL(airtableUrl);
          const lib = parsed.protocol === 'https:' ? https : http;
          await new Promise<void>((resolve) => {
            const r = lib.request(airtableUrl, {
              method: 'POST',
              headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
            }, (rr) => { rr.resume(); rr.on('end', resolve); });
            r.on('error', () => resolve());
            r.write(body);
            r.end();
          });
        } catch { /* Airtable webhook is optional — swallow errors */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── 404 ──────────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown endpoint' }));
  });

  server.listen(port, () => {
    console.log(`\nCasino Banner Scraper — HTTP server on port ${port}`);
    console.log(`  GET  /scrape-stream?urls=url1,url2&geo=XX   (SSE)`);
    console.log(`  POST /scrape                                  (JSON)`);
    console.log(`  GET  /sites  |  PUT/DELETE /sites/:domain`);
    console.log(`  GET  /banners/:domain/:filename`);
    console.log(`  GET  /health`);
    console.log(`\nOpen the web UI: cd web && npm run dev → http://localhost:3000\n`);
  });
}

// ── CLI mode ──────────────────────────────────────────────────────────────────

async function runCli() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Casino Banner Scraper
─────────────────────────────────────────────────────
CLI:   npx ts-node src/index.ts <url1> [url2] ... [--geo=XX]

Options:
  --geo=XX   Override geo-targeting for this run (e.g. --geo=gb, --geo=us)
             Overrides DC_PROXY_GEO from .env for this session only.

Examples:
  npx ts-node src/index.ts https://www.novadreams.com
  npx ts-node src/index.ts https://www.unibet.co.uk --geo=gb

Tiers: 1=Vanilla → 2=Stealth → 3=DC Proxy (auto-geo) → 4=Residential Proxy

Output saved to: ./output/<domain>/
Summary JSON:    ./output/summary.json
─────────────────────────────────────────────────────
`);
    process.exit(0);
  }

  // Parse --geo=XX flag
  const geoFlag = args.find(a => a.startsWith('--geo='));
  let geoOverride: string | undefined;
  if (geoFlag) {
    geoOverride = geoFlag.split('=')[1]?.trim();
    if (geoOverride) {
      config.dcProxy.geo = geoOverride;
      console.log(`  Geo override: ${geoOverride.toUpperCase()} (from --geo flag)`);
    }
  }

  const urlArgs = args.filter(a => !a.startsWith('--'));
  const urls = parseUrls(urlArgs);
  if (urls.length === 0) {
    console.error('No valid URLs provided.');
    process.exit(1);
  }

  const results = await runScraper(urls, geoOverride);
  const summaryPath = await writeSummary(results);

  console.log(`\n${'─'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('─'.repeat(60));
  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    const geoTag = r.geo ? ` (${r.geo.toUpperCase()})` : '';
    console.log(
      `${status} ${r.domain.padEnd(35)} Tier ${r.tier}${geoTag} | ` +
      `${r.homepageBanners.length} homepage + ${r.promoBanners.length} promo banners`
    );
  }
  console.log(`\nFull results → ${summaryPath}`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const httpPort = parseInt(process.env.PORT ?? '', 10);
if (httpPort > 0) {
  // Restore site memory from GCS before accepting requests (survives scale-to-zero)
  initializeMemory().then(() => startHttpServer(httpPort));
} else {
  runCli().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
