// Procedural planets. A planet's look is a pure function of its path and surveyed traits,
// so the same directory always becomes the same world.
import type { Planet } from './types';

export type Biome =
  | 'volcanic'
  | 'jungle'
  | 'ocean'
  | 'tundra'
  | 'desert'
  | 'crystal'
  | 'toxic'
  | 'gas'
  | 'barren';

export interface Look {
  biome: Biome;
  seed: number;
  /** Radius multiplier from repo size, ~0.8..1.25. */
  size: number;
  ring: boolean;
  ringColors: [string, string];
  ringTilt: number;
  /** Rotation speed multiplier. */
  spin: number;
  /** Axial tilt in radians. */
  tilt: number;
  /** Cloud cover 0..1. */
  clouds: number;
  /** Gas giants pick one of several band palettes. */
  variant: number;
  craters: { x: number; y: number; z: number; cos: number }[];
}

/** Which biome each surveyed language lands in. Languages not listed fall back to a seeded pick. */
const LANGUAGE_BIOME: Record<string, Biome> = {
  rust: 'volcanic',
  typescript: 'jungle',
  javascript: 'jungle',
  python: 'ocean',
  go: 'tundra',
  java: 'desert',
  csharp: 'desert',
  php: 'desert',
  ruby: 'crystal',
  elixir: 'crystal',
  swift: 'crystal',
  haskell: 'crystal',
  c: 'toxic',
  shell: 'gas',
  prose: 'barren',
};
const FALLBACK: Biome[] = ['jungle', 'ocean', 'tundra', 'desert', 'crystal'];

export const BIOME_LABEL: Record<Biome, string> = {
  volcanic: 'volcanic',
  jungle: 'jungle',
  ocean: 'ocean world',
  tundra: 'tundra',
  desert: 'desert',
  crystal: 'crystal',
  toxic: 'toxic swamp',
  gas: 'gas giant',
  barren: 'barren rock',
};

/** 32-bit FNV-1a. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function biomeFor(p: Planet, seed: number): Biome {
  if (!p.isRepo) return 'barren';
  const { language, languagePct, files } = p.traits;
  if (!language) return FALLBACK[seed % FALLBACK.length];
  // A polyglot repo with no clear winner is a swirl of everything: a gas giant.
  if (languagePct < 35 && files > 50) return 'gas';
  return LANGUAGE_BIOME[language] ?? FALLBACK[seed % FALLBACK.length];
}

const RING_COLORS: Record<Biome, [string, string]> = {
  volcanic: ['#c0603a', '#6a2e28'],
  jungle: ['#9fd0a0', '#4f7a5a'],
  ocean: ['#9ac8f0', '#4a6e9a'],
  tundra: ['#e8f4ff', '#8aaac8'],
  desert: ['#e0b878', '#8a6038'],
  crystal: ['#e0b0ff', '#7a50b0'],
  toxic: ['#c8f070', '#5a7a2a'],
  gas: ['#8a7fd0', '#5a50a0'],
  barren: ['#a0a0b8', '#5a5a70'],
};

export function look(p: Planet): Look {
  const seed = hashString(p.path);
  const r = rng(seed);
  const biome = biomeFor(p, seed);
  const { files, commits } = p.traits;
  const craterCount = biome === 'barren' ? 7 : biome === 'desert' || biome === 'tundra' ? 3 : 0;
  const craters = Array.from({ length: craterCount }, () => {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    return { x: s * Math.cos(th), y: u, z: s * Math.sin(th), cos: Math.cos(0.12 + r() * 0.25) };
  });
  return {
    biome,
    seed,
    size: 0.8 + 0.45 * clamp01(Math.log10(files + 1) / 4.5),
    // Old repos (lots of history) wear rings; gas giants often do anyway.
    ring: commits >= 1000 || (biome === 'gas' && r() < 0.6),
    ringColors: RING_COLORS[biome],
    ringTilt: 0.25 + r() * 0.2,
    spin: 0.6 + r() * 0.8,
    tilt: (r() - 0.5) * 0.6,
    clouds: { jungle: 0.35, ocean: 0.45, tundra: 0.2, toxic: 0.3 }[biome as string] ?? 0,
    variant: Math.floor(r() * 3),
    craters,
  };
}

// ---------- noise ----------

function hash3(x: number, y: number, z: number, s: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1442695041) + Math.imul(s, 2246822519);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function value3(x: number, y: number, z: number, s: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz, s);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy),
    l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}

/** Fractal value noise, 0..1. */
export function fbm(x: number, y: number, z: number, s: number, octaves = 3): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += value3(x * f, y * f, z * f, s + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

// ---------- surface ----------

const GAS_BANDS = [
  ['#2a2f6b', '#3a3f8a', '#4d4fa8', '#6a5fc0', '#8a7fd0'],
  ['#5c3a1f', '#8a5a30', '#c08a50', '#e0b878', '#a86a40'],
  ['#1f4f5c', '#2b6f78', '#3c8f8a', '#5fb0a0', '#9ad0c0'],
];

const pick = (list: string[], v: number) => list[Math.min(list.length - 1, Math.max(0, Math.floor(v * list.length)))];

/** A surface sample: base color, and whether it glows (ignores lighting). */
export interface Sample {
  c: string;
  glow: boolean;
}

/**
 * Color of the surface at a unit-sphere point already rotated into planet space.
 * `lat` is |y| before rotation, used for polar caps and gas bands. `t` animates lava and sparkles.
 */
export function surface(L: Look, x: number, y: number, z: number, t: number, px: number, py: number): Sample {
  const s = L.seed & 0xffff;
  const F = 2.2;
  const h = fbm(x * F + 11, y * F + 7, z * F + 3, s);
  const lat = Math.abs(y);
  const crater = L.craters.find((c) => x * c.x + y * c.y + z * c.z > c.cos);
  switch (L.biome) {
    case 'volcanic': {
      const crack = Math.abs(h - 0.52) < 0.016;
      if (h < 0.31) {
        const pulse = 0.5 + 0.5 * Math.sin(t / 240 + h * 40);
        return { c: pulse > 0.6 ? '#ff8a3c' : '#d4502a', glow: true };
      }
      if (crack) return { c: (px + py + Math.floor(t / 200)) & 1 ? '#ffd06a' : '#ff7a3c', glow: true };
      return { c: pick(['#3d2a33', '#4a3038', '#2a1f2a', '#5a3a3a'], (h - 0.31) / 0.69), glow: false };
    }
    case 'jungle': {
      if (lat > 0.88 - (h - 0.5) * 0.3) return { c: '#e8f4ff', glow: false };
      if (h < 0.47) return { c: h < 0.4 ? '#1d3f6e' : '#2a5f9e', glow: false };
      if (h < 0.5) return { c: '#d8c37a', glow: false };
      return { c: pick(['#4fa04a', '#2f7d3a', '#2a6a35', '#2a5a33'], (h - 0.5) / 0.5), glow: false };
    }
    case 'ocean': {
      if (lat > 0.92) return { c: '#e8f4ff', glow: false };
      if (h < 0.6) return { c: pick(['#12305a', '#173a6b', '#215a92', '#3a86c0'], h / 0.6), glow: false };
      if (h < 0.63) return { c: '#e0cf8a', glow: false };
      return { c: h < 0.7 ? '#5fae5a' : '#3a8a4a', glow: false };
    }
    case 'tundra': {
      if (crater) return { c: '#8ab8d8', glow: false };
      const ridge = Math.abs(fbm(x * 5, y * 5, z * 5, s + 7, 2) - 0.5) < 0.03;
      if (ridge) return { c: '#6a9ab8', glow: false };
      if (lat > 0.7) return { c: '#f2fbff', glow: false };
      return { c: pick(['#a8cde0', '#cfe6f2', '#e2f2fa', '#f2fbff'], h), glow: false };
    }
    case 'desert': {
      if (crater) return { c: '#8a5a32', glow: false };
      const dune = Math.sin((y * 9 + h * 6) * Math.PI) > 0.55;
      if (h < 0.38) return { c: '#7a4a2a', glow: false };
      return { c: dune ? '#e0b56a' : pick(['#a8703a', '#c9954a', '#d8a85a'], h), glow: false };
    }
    case 'crystal': {
      const facet = Math.floor(h * 7);
      const sparkle = ((px * 7 + py * 13 + s) % 23 === 0) && Math.sin(t / 150 + px) > 0.7;
      if (sparkle) return { c: '#ffffff', glow: true };
      return { c: ['#2a1f5a', '#3a2a6a', '#5a3a9a', '#6a4ab0', '#8a5ac8', '#b07ae0', '#d0a0f0'][facet] ?? '#d0a0f0', glow: false };
    }
    case 'toxic': {
      if (h < 0.42) {
        const bubble = ((px * 5 + py * 11 + Math.floor(t / 300)) % 17) === 0;
        return { c: bubble ? '#e8ff9a' : '#a8f04a', glow: true };
      }
      return { c: pick(['#5a8a2a', '#3a6a24', '#2a4a1f', '#4a3a2a'], (h - 0.42) / 0.58), glow: false };
    }
    case 'gas': {
      const turb = fbm(x * 3, y * 9, z * 3, s, 2);
      const band = (y * 0.5 + 0.5) * 6 + (turb - 0.5) * 2.2;
      const storm = (x - 0.35) ** 2 * 4 + (y + 0.3) ** 2 * 14 + (z - 0.5) ** 2 * 4 < 0.35;
      if (storm) return { c: '#e07a5a', glow: false };
      const bands = GAS_BANDS[L.variant % GAS_BANDS.length];
      return { c: bands[((Math.floor(band) % bands.length) + bands.length) % bands.length], glow: false };
    }
    case 'barren': {
      if (crater) return { c: x * crater.x + y * crater.y + z * crater.z < crater.cos + 0.012 ? '#8a8aa0' : '#3a3a4e', glow: false };
      return { c: pick(['#44445c', '#55556e', '#666680', '#77778e'], h), glow: false };
    }
  }
}

/** Cloud cover at a point (rotates on its own, slower). */
export function cloud(L: Look, x: number, y: number, z: number): boolean {
  if (!L.clouds) return false;
  return fbm(x * 3 + 40, y * 3, z * 3, (L.seed >> 8) & 0xffff, 2) > 1 - L.clouds * 0.75;
}
