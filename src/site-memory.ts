import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { SiteMemory, SiteMemoryEntry } from './types';
import { config } from './config';

// ── GCS sync helpers ──────────────────────────────────────────────────────────

async function getGCSToken(): Promise<string> {
  if (process.env.GCS_ACCESS_TOKEN) return process.env.GCS_ACCESS_TOKEN;
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

async function downloadFromGCS(): Promise<SiteMemory | null> {
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) return null;
  return new Promise((resolve) => {
    const req = https.get(
      `https://storage.googleapis.com/${bucket}/sites.json`,
      (res) => {
        if (res.statusCode === 404) { resolve(null); return; }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
  });
}

async function uploadToGCS(memory: SiteMemory): Promise<void> {
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) return;
  const token = await getGCSToken();
  if (!token) return;
  const body = Buffer.from(JSON.stringify(memory, null, 2), 'utf-8');
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=sites.json`;
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': body.length,
        'Authorization':  `Bearer ${token}`,
      },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', (e) => { console.warn('  ⚠ GCS sites.json upload failed:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Core ──────────────────────────────────────────────────────────────────────

function load(): SiteMemory {
  try {
    if (fs.existsSync(config.siteMemoryPath)) {
      return JSON.parse(fs.readFileSync(config.siteMemoryPath, 'utf-8'));
    }
  } catch { /* corrupt file */ }
  return {};
}

function save(memory: SiteMemory): void {
  fs.writeFileSync(config.siteMemoryPath, JSON.stringify(memory, null, 2), 'utf-8');
  // Fire-and-forget GCS sync — keeps memory alive across container restarts
  uploadToGCS(memory).catch(e => console.warn('  ⚠ GCS memory sync failed:', (e as Error).message));
}

/**
 * Called once at server startup. Downloads sites.json from GCS (if configured)
 * and writes it to the local path so the container starts with full memory.
 */
export async function initializeMemory(): Promise<void> {
  if (!process.env.GCS_BUCKET) return;
  try {
    const remote = await downloadFromGCS();
    if (remote && Object.keys(remote).length > 0) {
      fs.writeFileSync(config.siteMemoryPath, JSON.stringify(remote, null, 2), 'utf-8');
      console.log(`  ℹ Site memory restored from GCS (${Object.keys(remote).length} site(s))`);
    }
  } catch (e) {
    console.warn('  ⚠ Could not load site memory from GCS:', (e as Error).message);
  }
}

export function getSiteMemory(domain: string): SiteMemoryEntry | null {
  return load()[domain] ?? null;
}

export function saveSiteMemory(domain: string, entry: SiteMemoryEntry): void {
  const memory = load();
  memory[domain] = entry;
  save(memory);
}

export function deleteSiteMemory(domain: string): void {
  const memory = load();
  delete memory[domain];
  save(memory);
}

/**
 * Returns the tier to start from for this domain.
 * If we've succeeded before within the recheck window, start at that tier.
 * Otherwise start at 1 (so we don't pay for proxies if no longer needed).
 */
export function effectiveStartTier(domain: string): number {
  const entry = getSiteMemory(domain);
  if (!entry) return 1;
  const daysSince = (Date.now() - new Date(entry.lastScraped).getTime()) / 86_400_000;
  if (daysSince > config.tierRecheckDays) return 1;
  return entry.lastSuccessfulTier;
}
