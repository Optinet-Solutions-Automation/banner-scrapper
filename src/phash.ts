import sharp from 'sharp';
import * as fs from 'fs';

/** Average Hash (aHash) — resize to 8×8 greyscale, return 64-char binary string. */
export async function aHash(filePath: string): Promise<string> {
  try {
    const pixels = await sharp(filePath)
      .resize(8, 8, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();
    const avg = pixels.reduce((s, v) => s + v, 0) / pixels.length;
    return Array.from(pixels).map(v => (v >= avg ? '1' : '0')).join('');
  } catch {
    return '';
  }
}

/** Hamming distance between two 64-char binary strings. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length || a.length === 0) return 999;
  let dist = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++;
  return dist;
}

/** Returns true if two hashes represent visually the same image (threshold ≤ 8 / 64 bits). */
export function isSimilar(a: string, b: string): boolean {
  return hammingDistance(a, b) <= 8;
}

/** Remove visual duplicates from a list of file paths. Returns deduplicated list. */
export async function deduplicateByVisualHash<T extends { localPath?: string }>(
  items: T[]
): Promise<T[]> {
  const seen: string[] = [];
  const result: T[] = [];

  for (const item of items) {
    if (!item.localPath || !fs.existsSync(item.localPath)) {
      result.push(item);
      continue;
    }
    const hash = await aHash(item.localPath);
    if (hash && seen.some(h => isSimilar(hash, h))) {
      console.log(`  ⟳ Visual duplicate skipped — ${item.localPath.split(/[\\/]/).pop()}`);
      continue;
    }
    if (hash) seen.push(hash);
    result.push(item);
  }

  return result;
}
