/**
 * drive-uploader.ts — Uploads scraped banner images directly to Google Drive.
 *
 * Folder structure created automatically:
 *   {ROOT_FOLDER}/
 *   └── bet365.com/          ← one folder per domain, images accumulate here
 *       ├── hp_01.webp
 *       ├── hp_02.jpg
 *       └── pr_01.jpg
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
  // Prefer OAuth2 user credentials (avoids service-account quota issue on personal Drive)
  const clientId     = process.env.GOOGLE_OAUTH2_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH2_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH2_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return oauth2 as unknown as InstanceType<typeof google.auth.GoogleAuth>;
  }

  // Fall back to service account (works with Shared Drives / GCS, not personal Drive)
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) throw new Error('No Drive auth configured. Set GOOGLE_OAUTH2_* or GOOGLE_SERVICE_ACCOUNT_KEY.');

  let keyJson: string;
  try {
    JSON.parse(keyRaw);
    keyJson = keyRaw;
  } catch {
    keyJson = Buffer.from(keyRaw, 'base64').toString('utf-8');
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
  const hasAuth = process.env.GOOGLE_OAUTH2_REFRESH_TOKEN || process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!rootFolderId || !hasAuth) return null;

  try {
    const auth  = getAuthClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drive = google.drive({ version: 'v3', auth: auth as any });

    // Upload directly into ROOT/domain/ (no timestamp subfolder — images accumulate)
    const domainFolderId = await ensureFolder(drive, domain, rootFolderId);

    // Count existing files to avoid overwriting previous banners
    const existingRes = await drive.files.list({
      q: `'${domainFolderId}' in parents and trashed=false`,
      fields: 'files(name)',
      spaces: 'drive',
    });
    const existingNames = new Set((existingRes.data.files ?? []).map(f => f.name ?? ''));

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
      const ext      = path.extname(banner.localPath) || '.jpg';
      // Find a filename that doesn't already exist in the folder
      let idx = counter[prefix]!;
      let filename = `${prefix}_${String(idx).padStart(2, '0')}${ext}`;
      while (existingNames.has(filename)) {
        idx++;
        filename = `${prefix}_${String(idx).padStart(2, '0')}${ext}`;
      }
      existingNames.add(filename); // reserve for this run

      await drive.files.create({
        requestBody: {
          name:    filename,
          parents: [domainFolderId],
        },
        media: {
          mimeType: getMimeType(banner.localPath),
          body:     fs.createReadStream(banner.localPath),
        },
      });

      console.log(`  ☁ Drive: uploaded ${filename}`);
    }

    const folderUrl = `https://drive.google.com/drive/folders/${domainFolderId}`;
    console.log(`  ☁ Drive folder: ${folderUrl}`);
    return { folderId: domainFolderId, folderUrl };
  } catch (err) {
    console.warn(`  ⚠ Google Drive upload error: ${(err as Error).message}`);
    return null;
  }
}
