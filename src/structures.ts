// Pixel structures that sit on planets and moons: factories + smog for crowded hosts,
// construction (cones, scaffolding, a crane) for uncommitted work.

export type Put = (x: number, y: number, c: string) => void;

const PAL: Record<string, string> = {
  w: '#4a4458', // factory wall
  d: '#2e2a3a', // dark trim
  a: '#5e4e52', // chimney
  r: '#a8324e', // chimney stripe
  o: '#f2b24c', // lit window
  c: '#f07a3c', // cone
  W: '#fff0e0', // cone stripe
  k: '#a8703a', // crate
  K: '#7a4a2a', // crate shade
  p: '#c8a060', // scaffold pole
  g: '#6a6478', // half-built wall
  y: '#f2b24c', // crane yellow
  Y: '#8a5a1a', // crane dark stripe
  i: '#1a1828', // cable / hook
};

/** Draw a sprite with its bottom-center at (x, y). '.' is transparent. */
function sprite(put: Put, rows: string[], x: number, y: number, swap: Record<string, string> = {}) {
  const w = rows[0].length, h = rows.length;
  const ox = Math.round(x - w / 2), oy = Math.round(y - h + 1);
  rows.forEach((row, j) => {
    for (let i = 0; i < w; i++) {
      const k = row[i];
      if (k === '.') continue;
      put(ox + i, oy + j, swap[k] ?? PAL[k]);
    }
  });
}

const FACTORY = [
  '.....ra',
  '.....aa',
  '.....ra',
  'd.d..aa',
  'wwwwwww',
  'wowowow',
  'wwwwwww',
];
const FACTORY_SMALL = ['..a', '..a', 'www', 'wow'];

/** Smoke puffs drifting up from a chimney top at (x, y). */
function smoke(put: Put, x: number, y: number, t: number, seed: number, scale: number) {
  for (let k = 0; k < 4; k++) {
    const ph = (t / 45 + k * 6 + seed * 3) % 24;
    const px = Math.round(x + (ph / 5) * scale + Math.sin(ph / 3 + seed)), py = Math.round(y - ph * 0.8 * scale);
    const c = ph < 10 ? '#8a7a6a' : ph < 18 ? '#6a5e58' : '#3e3848';
    put(px, py, c);
    if (ph > 7 && scale >= 1) {
      put(px + 1, py, c);
      put(px, py - 1, c);
      put(px + 1, py - 1, c);
    }
  }
}

/** A factory with a smoking chimney. Windows flicker so the place feels busy. */
export function factory(put: Put, x: number, y: number, t: number, seed: number, small = false) {
  const flicker = ((t / 300 + seed) | 0) % 3 === 0;
  sprite(put, small ? FACTORY_SMALL : FACTORY, x, y, flicker ? { o: '#c46a2c' } : {});
  const chimneyX = small ? x + 1 : x + 2, chimneyY = small ? y - 4 : y - 7;
  smoke(put, chimneyX, chimneyY, t, seed, small ? 0.6 : 1);
}

/** A brown smog belt hugging the top of a body, dithered by how polluted it is. */
export function smog(put: Put, X: number, Y: number, r: number, level: number, t: number) {
  const drift = t / 900;
  for (let a = -Math.PI; a <= 0; a += 0.6 / r) {
    for (let k = 1; k <= 3; k++) {
      const n = Math.sin(a * 7 + drift + k) * 0.5 + 0.5;
      if (n > level * 0.9) continue;
      const x = Math.round(X + Math.cos(a) * (r + k)), y = Math.round(Y + Math.sin(a) * (r + k) - 1);
      if ((x + y + k) & 1) put(x, y, k === 1 ? '#6a5a44' : '#4e4438');
    }
  }
}

const CONES = ['.c...KK', 'cWc..kk', 'ccc..kk'];
const CONE_SMALL = ['.c.', 'cWc'];
const SCAFFOLD = [
  'p.p.p..',
  'ppppp..',
  'p.p.p..',
  'ppppp..',
  'pgpgp..',
  'ppppp.K',
  'pgggp.k',
];

/** A tower crane; the trolley slides along the jib and the load bobs on its cable. */
function crane(put: Put, x: number, y: number, t: number, seed: number, small: boolean) {
  const h = small ? 8 : 15, jibL = small ? 2 : 4, jibR = small ? 5 : 11;
  const top = y - h + 1;
  for (let j = 0; j < h; j++) {
    const c = ((j + ((t / 400) | 0)) >> 1) & 1 ? 'y' : 'Y';
    put(x, y - j, PAL[c]);
    if (!small) put(x + 1, y - j, PAL[(j & 1) ? 'y' : 'Y']);
  }
  for (let i = -jibL; i <= jibR; i++) put(x + i, top, PAL[i % 3 === 0 ? 'Y' : 'y']);
  put(x, top - 1, PAL.Y);
  // Counterweight on the short arm.
  put(x - jibL, top + 1, PAL.g);
  put(x - jibL + 1, top + 1, PAL.g);
  const swing = (Math.sin(t / 700 + seed) + 1) / 2;
  const hx = Math.round(x + 2 + swing * (jibR - 3));
  const drop = Math.round((small ? 2 : 4) + ((Math.sin(t / 450 + seed * 2) + 1) / 2) * (small ? 2 : 5));
  for (let j = 1; j <= drop; j++) put(hx, top + j, PAL.i);
  put(hx, top + drop + 1, PAL.k);
  if (!small) {
    put(hx + 1, top + drop + 1, PAL.k);
    put(hx, top + drop + 2, PAL.K);
    put(hx + 1, top + drop + 2, PAL.K);
  }
}

/** Construction for a diff of the given size (see model.construction). */
export function construction(put: Put, x: number, y: number, level: number, t: number, seed: number, small = false) {
  if (level <= 0) return;
  if (small) {
    if (level === 1) sprite(put, CONE_SMALL, x, y);
    else crane(put, x, y, t, seed, true);
    return;
  }
  if (level === 1) sprite(put, CONES, x, y);
  if (level === 2) sprite(put, SCAFFOLD, x, y);
  if (level === 3) {
    sprite(put, SCAFFOLD, x + 6, y);
    crane(put, x - 2, y, t, seed, false);
  }
}

/** Galaxy-scale marker: a tiny crane so busy planets read at a glance. */
export function tinyCrane(put: Put, x: number, y: number) {
  for (let j = 0; j < 5; j++) put(x, y - j, PAL[j & 1 ? 'y' : 'Y']);
  for (let i = -1; i <= 3; i++) put(x + i, y - 4, PAL.y);
  put(x + 3, y - 3, PAL.i);
  put(x + 3, y - 2, PAL.k);
}
