// Captures the blob gallery (gallery.html) as stills and GIFs for the README.
// Needs the Vite dev server running (pnpm dev), Playwright, and ffmpeg.
// Usage: node scripts/capture-gallery.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'docs/screenshots';
const base = process.env.GALLERY_URL ?? 'http://localhost:1420/gallery.html';
const FRAME_MS = 80;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });

async function open(scene) {
  await page.goto(`${base}?scene=${scene}`);
  await page.evaluate(() => window.galleryReady);
}

async function gif(name, from, to) {
  const dir = mkdtempSync(join(tmpdir(), 'knoware-frames-'));
  let i = 0;
  for (let t = from; t < to; t += FRAME_MS) {
    await page.evaluate((ms) => window.advance(ms), t);
    await page.locator('#stage').screenshot({ path: join(dir, `f${String(i++).padStart(4, '0')}.png`) });
  }
  const fps = String(1000 / FRAME_MS);
  // Two-pass palette keeps the pixel art crisp and the file small.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps, '-i', join(dir, 'f%04d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none',
    join(out, name)]);
  rmSync(dir, { recursive: true });
}

mkdirSync(out, { recursive: true });

await open('states');
await page.evaluate(() => window.advance(2000));
await page.locator('#stage').screenshot({ path: join(out, 'blob-states.png') });
await gif('blob-states.gif', 2000, 5200);

await open('delete');
await gif('blob-delete.gif', 0, 6000);

await browser.close();
console.log('captured into', out);
