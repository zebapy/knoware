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

async function open(query) {
  await page.goto(`${base}?scene=${query}`);
  await page.evaluate(() => window.galleryReady);
}

/** One planet's tile: the planet, its surface and label, cropped from the planet view. */
const TILE = { x: 290, y: 0, width: 520, height: 300 };
/** Wider, so worktree moons beside the planet fit. */
const WIDE_TILE = { x: 250, y: 0, width: 600, height: 300 };

const BIOMES = [
  ['Rust', 'lang=rust'],
  ['TypeScript', 'lang=typescript'],
  ['Python', 'lang=python'],
  ['Go', 'lang=go'],
  ['Java', 'lang=java'],
  ['Ruby', 'lang=ruby'],
  ['C', 'lang=c'],
  ['polyglot', 'lang=c&pct=20&files=900'],
  ['~/notes', ''],
];

// Same planet (same seed) in every tile, so only the state changes.
const STATES = [
  ['clean', ''],
  ['small diff', 'diff=12'],
  ['medium diff', 'diff=200'],
  ['big diff', 'diff=900'],
  ['crowded', 'agents=4'],
  ['very crowded', 'agents=8'],
  ['long history', 'commits=2000'],
  ['tiny repo', 'files=8'],
  ['worktrees', 'worktrees=1'],
].map(([name, q]) => [name, `lang=python&seed=zoo&${q}`]);

const planetQuery = (name, q) => `planet&name=${encodeURIComponent(name)}&${q}`;

/** Grid of still tiles, three across. */
async function tileStill(name, tiles) {
  const dir = mkdtempSync(join(tmpdir(), 'knoware-tiles-'));
  for (const [i, [label, q]] of tiles.entries()) {
    await open(planetQuery(label, q));
    await page.evaluate(() => window.advance(1500));
    await page.screenshot({ path: join(dir, `t${i}.png`), clip: TILE });
  }
  execFileSync('montage', [...tiles.map((_, i) => join(dir, `t${i}.png`)), '-tile', '3x', '-geometry', '+0+0', join(out, name)]);
  rmSync(dir, { recursive: true });
}

/** Grid of animated tiles, three across, stacked with ffmpeg's xstack. */
async function tileGif(name, tiles, frames, clip = TILE) {
  const dir = mkdtempSync(join(tmpdir(), 'knoware-tiles-'));
  for (const [i, [label, q]] of tiles.entries()) {
    mkdirSync(join(dir, `${i}`));
    await open(planetQuery(label, q));
    for (let f = 0; f < frames; f++) {
      await page.evaluate((ms) => window.advance(ms), 1500 + f * FRAME_MS);
      await page.screenshot({ path: join(dir, `${i}`, `f${String(f).padStart(4, '0')}.png`), clip });
    }
  }
  const { width: w, height: h } = clip;
  const layout = tiles.map((_, i) => `${(i % 3) * w}_${Math.floor(i / 3) * h}`).join('|');
  const inputs = tiles.flatMap((_, i) => ['-framerate', String(1000 / FRAME_MS), '-i', join(dir, `${i}`, 'f%04d.png')]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex',
    `${tiles.map((_, i) => `[${i}]`).join('')}xstack=inputs=${tiles.length}:layout=${layout},split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none`,
    join(out, name)]);
  rmSync(dir, { recursive: true });
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
await gif('blob-states.gif', 2000, 5200);

await open('delete');
await gif('blob-delete.gif', 0, 6000);

await tileStill('planet-biomes.png', BIOMES);
await tileGif('planet-states.gif', STATES, 30, WIDE_TILE);

await browser.close();
console.log('captured into', out);
