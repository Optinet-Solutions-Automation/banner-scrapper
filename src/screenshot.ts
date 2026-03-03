import * as fs from 'fs';
import * as path from 'path';
import { Page } from 'playwright';
import { config } from './config';

fs.mkdirSync(config.screenshotDir, { recursive: true });

const taken: string[] = [];

export async function takeScreenshot(page: Page, label: string): Promise<string> {
  if (!config.debugScreenshots) return '';
  const filename = `${label}_${Date.now()}.png`;
  const filepath = path.join(config.screenshotDir, filename);
  // 10s timeout — prevents hanging on sites that keep fonts/resources loading indefinitely
  await page.screenshot({ fullPage: false, path: filepath, timeout: 10_000 }).catch(() => {});
  taken.push(filepath);
  console.log(`  📸 Screenshot: ${filename}`);
  return filepath;
}

/** Delete all temp screenshots taken this run. */
export function cleanupScreenshots(): void {
  for (const f of taken) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  taken.length = 0;
  console.log('  🧹 Temp screenshots deleted.');
}

/** Return paths of screenshots taken so far (so Claude can inspect them). */
export function getScreenshotPaths(): string[] {
  return [...taken];
}
