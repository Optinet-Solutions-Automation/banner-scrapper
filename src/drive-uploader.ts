/**
 * drive-uploader.ts — Uploads scraped banner images directly to Google Drive.
 *
 * Folder structure created automatically:
 *   {ROOT_FOLDER}/
 *   └── bet365.com/
 *       ├── 2026-03-10_14-22/   ← one folder per scrape run
 *       │   ├── hp_banner_01.webp
 *       │   ├── hp_banner_02.jpg
 *       │   └── pr_banner_01.jpg
 *       └── 2026-03-11_09-05/
 *
 * Auth: Service Account JSON stored in GOOGLE_SERVICE_ACCOUNT_KEY env var
 *       (base64-encoded). The service account email must have Editor access
 *       to the root BannerBot folder in your Google Drive.
 */
import { google, drive_v3 } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import { BannerImage } from './types';

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png')  return 'image/png';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.gif')  return 'image/gif';
  return 'image/jpeg';
}

function getAuthClient() {
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set');

  // Support both plain JSON and base64-encoded JSON
  let keyJson: string;
  try {
    JSON.parse(keyRaw);          // already valid JSON
    keyJson = keyRaw;
  } catch {
    keyJson = Buffer.from(keyRaw, 'base64').toString('utf-8');  // decode base64
  }

  const key = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
}

/** Finds an existing Drive folder by name under a given parent, or creates one. */
async function ensureFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string
): Promise<string> {
  const safeQ = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${safeQ}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id!;
  }

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  return folder.data.id!;
}

export interface DriveUploadResult {
  folderId:  string;
  folderUrl: string;
}

/** Uploads all banners to Drive and returns the folder ID + shareable URL. */
export async function uploadBannersToDrive(
  banners: BannerImage[],
  domain: string
): Promise<DriveUploadResult | null> {
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return null;

  try {
    const auth  = getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    // Timestamp: 2026-03-10_14-22
    const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');

    // Create nested folder: ROOT/domain/timestamp
    const domainFolderId = await ensureFolder(drive, domain, rootFolderId);
    const runFolderId    = await ensureFolder(drive, ts, domainFolderId);

    // Upload each banner (track page type for prefix)
    const hpCount: Record<string, number> = {};
    const prCount: Record<string, number> = {};

    for (const banner of banners) {
      if (!banner.localPath || !fs.existsSync(banner.localPath)) {
        console.warn(`  ⚠ Drive: file not found — ${banner.localPath}`);
        continue;
      }

      const isPromo = banner.page === 'promotions';
      const counter = isPromo ? prCount : hpCount;
      const prefix  = isPromo ? 'pr' : 'hp';
      counter[prefix] = (counter[prefix] ?? 0) + 1;
      const idx      = String(counter[prefix]).padStart(2, '0');
      const ext      = path.extname(banner.localPath) || '.jpg';
      const filename = `${prefix}_${idx}${ext}`;

      await drive.files.create({
        requestBody: {
          name:    filename,
          parents: [runFolderId],
        },
        media: {
          mimeType: getMimeType(banner.localPath),
          body:     fs.createReadStream(banner.localPath),
        },
      });

      console.log(`  ☁ Drive: uploaded ${filename}`);
    }

    const folderUrl = `https://drive.google.com/drive/folders/${runFolderId}`;
    console.log(`  ☁ Drive folder: ${folderUrl}`);
    return { folderId: runFolderId, folderUrl };
  } catch (err) {
    console.warn(`  ⚠ Google Drive upload error: ${(err as Error).message}`);
    return null;
  }
}
