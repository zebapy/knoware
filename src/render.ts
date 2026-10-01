// The pixel world: space, planets, moons and blobs, drawn into one low-res buffer per frame.
// Ported from prototypes/galaxy.html; layout now scales to any number of planets, moons and blobs.
import * as B from './biome';
import * as M from './model';
import type { Thresholds } from './model';
import type { Blob, Moon, Planet, World } from './types';

const INK = '#0b0c1c';
const GREY = '#5d5f78';
const SPEED = 0.4;

export const PAL: Record<M.Palette, string[]> = {
  work: ['#2b7f9e', '#3fb8c4', '#7fe3dc', '#5a8cf0'],
  pr: ['#5a3fb0', '#8b6cf0', '#c3a8ff', '#d06ad8'],
  green: ['#2a9a78', '#5fd3a0', '#b8f5c8', '#3fb8c4'],
  red: ['#a8324e', '#f0566e', '#ff9aa0', '#c24fa0'],
  attn: ['#c46a2c', '#f2b24c', '#ffe08a', '#f07a5a'],
};

// ---------- colors ----------

const hx = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mixCache = new Map<string, string>();
export function mix(a: string, b: string, t: number): string {
  t = Math.round(t * 32) / 32;
  if (t <= 0) return a;
  const key = a + b + t;
  let out = mixCache.get(key);
  if (!out) {
    const A = hx(a), B = hx(b);
    out = '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
    mixCache.set(key, out);
  }
  return out;
}
const packCache = new Map<string, number>();
function pack(c: string): number {
  let v = packCache.get(c);
  if (v === undefined) {
    const [r, g, b] = hx(c);
    v = (0xff << 24) | (b << 16) | (g << 8) | r;
    packCache.set(c, v >>> 0);
    v = v >>> 0;
  }
  return v;
}
function hash(a: number, b: number, c: number): number {
  let n = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
/** Stable small integer from a string id, so animations stay out of phase per blob. */
export function seed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 997;
}
const cl = (v: number) => Math.max(0, Math.min(1, v));

// ---------- scene ----------

export type Level = 'galaxy' | 'planet' | 'session';

export interface Deleting {
  kind: 'blob' | 'moon';
  id: string;
  phase: 'shock' | 'shake';
  t0: number;
}

export interface Scene {
  world: World;
  level: Level;
  planetId: string | null;
  selId: string | null;
  thresholds: Thresholds;
  deleting: Deleting | null;
  born: Map<string, number>;
}

export interface Label {
  x: number;
  y: number;
  text: string;
  fg: string;
  bg: string;
  z?: number;
  right?: boolean;
}

interface Particle {
  x: number; y: number; vx: number; vy: number; life: number; dk: number;
  cells: { dx: number; dy: number; c: string }[];
}

interface Spot { x: number; y: number }

export interface PlanetLayout {
  X0: number;
  Y0: number;
  moons: { moon: Moon; x: number; y: number }[];
  pos: Map<string, Spot>;
}

const looks = new Map<string, B.Look>();
/** A planet's procedural look, cached until its path or traits change. */
export function planetLook(p: Planet): B.Look {
  const key = `${p.path}|${p.isRepo}|${p.traits.language}|${p.traits.languagePct}|${p.traits.files}|${p.traits.commits}`;
  let l = looks.get(key);
  if (!l) {
    l = B.look(p);
    looks.set(key, l);
  }
  return l;
}

const BAYER = [0, 0.5, 0.75, 0.25];
const LIGHT = (() => {
  const v = [-0.55, -0.6, 0.58], n = Math.hypot(...v);
  return v.map((c) => c / n);
})();

/** Galaxy: planets on a loose grid, jittered per id so the map feels hand-placed but stays stable. */
export function galaxyLayout(world: World, W: number, H: number): Map<string, Spot & { r: number }> {
  const out = new Map<string, Spot & { r: number }>();
  const n = world.planets.length;
  if (!n) return out;
  const cols = Math.max(1, Math.round(Math.sqrt((n * W) / H)));
  const rows = Math.ceil(n / cols);
  const cw = W / cols, ch = (H - 12) / rows;
  world.planets.forEach((p, i) => {
    const row = Math.floor(i / cols), inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i % cols, offset = (cols - inRow) * cw / 2;
    const s = B.hashString(p.path) % 997;
    const blobs = world.blobs.filter((b) => b.planetId === p.id).length;
    const r = Math.round(Math.max(6, Math.min(9 * planetLook(p).size + blobs * 0.6, Math.min(cw, ch) / 4.5)));
    out.set(p.id, {
      x: Math.round(offset + cw * (col + 0.5) + ((s % 7) - 3) * cw / 24),
      y: Math.round(ch * (row + 0.5) + (((s >> 3) % 5) - 2) * ch / 18),
      r,
    });
  });
  return out;
}

/** Planet view: planet on top, moons beside it (alternating right, left), blobs hanging off their host in stable slots. */
export function planetLayout(world: World, planetId: string, W: number, H: number, cam: number): PlanetLayout {
  const X0 = Math.round(W / 2 + cam), Y0 = 30;
  const moonList = world.moons.filter((m) => m.planetId === planetId);
  const perSide = Math.ceil(moonList.length / 2);
  const step = perSide > 1 ? Math.min(72, (W / 2 - 70) / (perSide - 1)) : 72;
  const my = Y0 + 8;
  const moons = moonList.map((moon, i) => ({
    moon,
    x: Math.round(X0 + (i % 2 ? -1 : 1) * (52 + Math.floor(i / 2) * step)),
    y: my,
  }));
  const pos = new Map<string, Spot>();
  const groups = new Map<string, Blob[]>();
  for (const b of world.blobs.filter((b) => b.planetId === planetId)) {
    const key = b.moonId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  for (const [key, arr] of groups) {
    const host = moons.find((m) => m.moon.id === key);
    const width = host ? Math.max(48, step) : W - 40;
    const perRow = Math.max(1, Math.floor(width / (host ? 24 : 32)));
    arr.forEach((b, k) => {
      const row = Math.floor(k / perRow), inRow = Math.min(perRow, arr.length - row * perRow), col = k % perRow;
      const gap = Math.min(host ? 26 : 34, width / inRow);
      pos.set(b.id, {
        x: Math.round((host ? host.x : X0) + (col - (inRow - 1) / 2) * gap),
        y: host ? my + 40 + row * 26 : H - 20 - row * 26,
      });
    });
  }
  return { X0, Y0, moons, pos };
}

// ---------- renderer ----------

export class Renderer {
  W = 192;
  H = 124;
  scale = 4;
  private ctx: CanvasRenderingContext2D;
  private img!: ImageData;
  private buf!: Uint32Array;
  private rec: { x: number; y: number; c: string }[] | null = null;
  private parts: Particle[] = [];
  private cam = 0;
  private pool: HTMLDivElement[] = [];
  /** Where each blob was drawn last frame, for clicks and shatter capture. */
  drawn = new Map<string, { x: number; y: number; r: number; gy: number }>();
  moonsDrawn = new Map<string, { x: number; y: number }>();
  planetsDrawn = new Map<string, Spot & { r: number }>();

  constructor(private canvas: HTMLCanvasElement, private labelLayer: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    const host = this.canvas.parentElement!;
    const cw = host.clientWidth, ch = host.clientHeight;
    this.scale = cw >= 1100 ? 4 : 3;
    this.W = Math.max(120, Math.floor(cw / this.scale));
    this.H = Math.max(90, Math.floor(ch / this.scale));
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.canvas.style.width = this.W * this.scale + 'px';
    this.canvas.style.height = this.H * this.scale + 'px';
    this.img = this.ctx.createImageData(this.W, this.H);
    this.buf = new Uint32Array(this.img.data.buffer);
  }

  private px(x: number, y: number, c: string) {
    x = Math.round(x);
    y = Math.round(y);
    if (this.rec) {
      this.rec.push({ x, y, c });
      return;
    }
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    this.buf[y * this.W + x] = pack(c);
  }

  private rect(x: number, y: number, w: number, h: number, c: string) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
  }

  // ----- primitives -----

  private space(t: number) {
    const { W, H } = this;
    const bands = ['#0d0f22', '#11132b', '#151834', '#1a1c3c', '#1f1f44'];
    for (let y = 0; y < H; y++) {
      const c = pack(bands[Math.min(4, Math.floor((y / H) * 5))]);
      this.buf.fill(c, y * W, y * W + W);
    }
    const stars = Math.round((W * H) / 640);
    for (let i = 0; i < stars; i++) {
      const tw = Math.sin(t / 300 + i * 1.3);
      if (tw > -0.2) this.px((i * 67 + i * i * 3) % W, (i * 41 + i * i) % H, tw > 0.7 ? '#e0dcff' : '#6e6aa8');
    }
  }

  private ring(X: number, Y: number, r: number, L: B.Look, t: number, front: boolean) {
    const [hi, lo] = L.ringColors;
    for (let a = 0; a < 6.28; a += 0.02) {
      const rx = Math.cos(a) * r * 1.75, ry = Math.sin(a) * r * L.ringTilt;
      if (ry >= 0 !== front) continue;
      // Tilt the ring with the planet's axis.
      const x = rx * Math.cos(L.tilt) - ry * Math.sin(L.tilt), y = rx * Math.sin(L.tilt) + ry * Math.cos(L.tilt);
      const c = ((a * 20 + t / 80) | 0) % 3 ? hi : lo;
      this.px(X + x, Y + y, c);
      if (r > 12) this.px(X + x * 1.08, Y + y * 1.08, lo);
    }
  }

  /** A procedural planet: noise terrain on a rotating, tilted sphere, lit with dithered shading. */
  private planet(X: number, Y: number, r: number, L: B.Look, t: number) {
    if (L.ring) this.ring(X, Y, r, L, t, false);
    const rot = t * 0.0003 * L.spin + (L.seed % 628) / 100;
    const crot = rot * 1.35;
    const ct = Math.cos(L.tilt), st = Math.sin(L.tilt);
    const cr = Math.cos(rot), sr = Math.sin(rot), ccr = Math.cos(crot), csr = Math.sin(crot);
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const nx = x / r, ny = y / r, d = nx * nx + ny * ny;
        if (d > 1) continue;
        const nz = Math.sqrt(1 - d);
        // Tilt the axis, then spin around it.
        const tx = nx * ct - ny * st, ty = nx * st + ny * ct;
        const sample = B.surface(L, tx * cr + nz * sr, ty, -tx * sr + nz * cr, t, x + r, y + r);
        let c = sample.c, glow = sample.glow;
        if (B.cloud(L, tx * ccr + nz * csr, ty, -tx * csr + nz * ccr)) {
          c = '#eef2ff';
          glow = false;
        }
        const light = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2] + BAYER[(x & 1) + ((y & 1) << 1)] * 0.18;
        if (!glow) c = mix(c, INK, light > 0.42 ? 0 : light > 0.08 ? 0.3 : 0.55);
        if (d > 0.88) c = mix(c, INK, glow ? 0.25 : 0.5);
        this.px(X + x, Y + y, c);
      }
    if (L.ring) this.ring(X, Y, r, L, t, true);
  }

  private moon(X: number, Y: number, r: number, t: number, wobble = 0) {
    const ox = wobble ? Math.round(Math.sin(t / 60) * wobble) : 0;
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const d = (x * x + y * y) / (r * r);
        if (d > 1) continue;
        let c = (Math.floor((x + t / 300) / 2) + y) & 1 ? '#8a88b8' : '#6e6c9c';
        if (x + y > r * 0.4) c = '#4a4870';
        if (d > 0.8) c = '#34325a';
        this.px(X + x + ox, Y + y, c);
      }
  }

  /** Wavy-edged blob body. ws = wave speed (working fast, dormant near-still); dec = decay (greys, crumbles, sags). */
  private body(cx: number, gy: number, r: number, sx: number, sy: number, stt: M.Palette, dec: number, id: number, t: number, ws = 0.5) {
    const pal = PAL[stt].map((c) => mix(c, GREY, dec * 0.8));
    const O = mix(pal[0], INK, 0.55), R = Math.ceil(r * 1.4), cy = gy - r * sy, wt = t * ws;
    for (let y = -R; y <= R; y++)
      for (let x = -R; x <= R; x++) {
        const ex = x / sx, ey = y / sy, th = Math.atan2(ey, ex);
        let k = 1 + 0.08 * Math.sin(6 * th + wt / 500 + id) + 0.04 * Math.sin(4 * th - wt / 700 + id * 2);
        if (dec > 0) k += dec * 0.14 * Math.pow(Math.max(0, Math.sin(th)), 4);
        const rr = r * k, d = (ex * ex + ey * ey) / (rr * rr);
        if (d > 1) continue;
        const hh = hash(x, y, id);
        if (dec > 0 && d > 0.45 && hh < dec * 0.55) continue;
        if (dec > 0.6 && hh < (dec - 0.6) * 0.6) continue;
        const nx = ex / rr, ny = ey / rr;
        let c: string;
        if (d > 0.74) c = O;
        else {
          const sw = (x * 0.7 + y + t * 0.025 * (1 - dec * 0.9) + id * 5) / 3.2;
          let q = ((Math.floor(sw) % 4) + 4) % 4;
          if (((sw % 1) + 1) % 1 < 0.2 && (x + y) & 1) q = (q + 1) % 4;
          c = pal[q];
          if (ny > 0.45 && (x + y) & 1) c = mix(c, INK, 0.3);
          if (nx < -0.2 && ny < -0.3 && d < 0.3) c = mix(c, '#ffffff', 0.35);
        }
        this.px(cx + x, cy + y, c);
      }
    return cy;
  }

  private eyes(cx: number, cy: number, r: number, mode: string, blink: boolean) {
    const ex = Math.max(2, Math.round(r * 0.38)), ey = cy - Math.round(r * 0.12), k = INK;
    for (const s of [-1, 1]) {
      const x = cx + s * ex;
      if (mode === 'shock') {
        for (let a = -2; a <= 2; a++)
          for (let b = -2; b <= 2; b++)
            if (Math.abs(a) + Math.abs(b) < 4) this.px(x + a, ey + b, Math.abs(a) === 2 || Math.abs(b) === 2 ? k : '#f4f2ff');
        this.px(x, ey, k);
        continue;
      }
      if (mode === 'sleep' || blink) {
        this.px(x - (mode === 'sleep' ? 1 : 0), ey + 1, k); this.px(x, ey + 1, k); this.px(x + 1, ey + 1, k);
        continue;
      }
      if (mode === 'happy') {
        this.px(x - 1, ey + 1, k); this.px(x, ey, k); this.px(x + 1, ey, k); this.px(x + 2, ey + 1, k);
        continue;
      }
      if (mode === 'sad') {
        this.px(x, ey + 1, k); this.px(x + 1, ey + 1, k); this.px(x, ey + 2, k); this.px(x + 1, ey + 2, k);
        this.px(x + (s < 0 ? -1 : 2), ey - 1, k);
        continue;
      }
      if (mode === 'up') {
        this.px(x, ey - 2, k); this.px(x + 1, ey - 2, k); this.px(x, ey - 1, k); this.px(x + 1, ey - 1, k);
        this.px(x, ey, '#3a3d70'); this.px(x + 1, ey, '#3a3d70');
        continue;
      }
      for (let b = -1; b < (r > 8 ? 3 : 2); b++) { this.px(x, ey + b, k); this.px(x + 1, ey + b, k); }
      this.px(x, ey - 1, '#e8f6ff');
    }
  }

  private tear(cx: number, cy: number, r: number, t: number) {
    const ex = Math.max(2, Math.round(r * 0.38)), q = (t / 30) % 10;
    this.px(cx - ex, cy + 2 + q / 2, '#9fd8ff');
    if (q < 7) this.px(cx - ex, cy + 3 + q / 2, '#9fd8ff');
  }

  private zz(x: number, y: number, c: string) {
    [[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]].forEach(([a, b]) => this.px(x + a, y + b, c));
  }

  private bubble(cx: number, top: number, t: number) {
    const w = 9, h = 10, x = cx - 4, y = Math.round(top - h - 4 + Math.sin(t / 120));
    this.rect(x - 1, y, w + 2, h, INK);
    this.rect(x, y - 1, w, h + 2, INK);
    this.rect(x, y, w, h, '#ffe08a');
    this.rect(cx, y + h + 1, 1, 2, INK);
    this.rect(cx, y + 2, 2, 4, INK);
    this.rect(cx, y + 7, 2, 2, INK);
  }

  private tether(x1: number, y1: number, x2: number, y2: number, c: string, t: number) {
    const n = Math.hypot(x2 - x1, y2 - y1) | 0;
    for (let i = 0; i < n; i += 2) {
      const f = i / n;
      if ((i + ((t / 60) | 0)) % 6 < 3) this.px(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f + Math.sin(f * Math.PI) * 3, c);
    }
  }

  private drawBlob(sc: Scene, b: Blob, x: number, y: number, r: number, t: number, now: number, sel: boolean) {
    const th = sc.thresholds, id = seed(b.id);
    const dec = M.decay(b, Date.now(), th), dorm = M.isDormant(b, Date.now(), th), stt = M.palette(b);
    const blocked = M.isBlocked(b), turn = M.isYourTurn(b, Date.now(), th), working = M.isWorking(b);
    let hop = 0, sx = 1, sy = 1, mode: string = M.mood(b);
    const ws = dorm ? 0.08 : working ? 1.6 : 0.5;
    if (mode === 'sad') { sx = 1.08; sy = 0.9; }
    if (!dorm && !blocked && !turn) {
      if (working) hop = Math.abs(Math.sin(t / 140 + id)) * 1.5;
      if (stt === 'green') { const q = (t / 900 + id) % 2; if (q < 0.6) hop = Math.sin((q / 0.6) * Math.PI) * 4; }
    }
    if (turn) { mode = 'up'; hop = Math.sin(t / 500 + id) * 0.8; }
    if (blocked) { const q = Math.abs(Math.sin(t / 160)); hop = q * 5; if (q < 0.2) { sx = 1.18; sy = 0.82; } }
    if (dorm) { mode = 'sleep'; hop = 0; sy *= 0.92; sx *= 1.04; }
    if (dec > 0) { sx *= 1 + dec * 0.3; sy *= 1 - dec * 0.35; hop *= 1 - dec; }
    const born = sc.born.get(b.id);
    if (born) { const e = cl((now - born) / 600); r *= e < 1 ? (1 + Math.sin(e * Math.PI) * 0.25) * e : 1; }
    let dx = 0, dy = 0;
    const D = sc.deleting?.kind === 'blob' && sc.deleting.id === b.id ? sc.deleting : null;
    if (D) {
      mode = 'shock';
      const e = now - D.t0;
      if (D.phase === 'shock') hop = Math.sin(cl(e / 350) * Math.PI) * 5;
      else {
        const k = cl(e / 1400), a = k * k * 3;
        dx = Math.round((Math.random() - 0.5) * 2 * a);
        dy = Math.round((Math.random() - 0.5) * a);
        sx *= 1 + k * 0.1; sy *= 1 + k * 0.1;
      }
    }
    for (let j = 1; j <= Math.min(b.subagents, 4); j++) {
      const qx = Math.round(x - (r + 4) * j);
      const c = this.body(qx, Math.round(y - Math.abs(Math.sin(t / 110 + j)) * 2), 3, 1, 1, stt, dec, id * 10 + j, t, ws);
      this.eyes(qx, c, 3, dorm ? 'sleep' : 'neutral', false);
    }
    const cx = x + dx, cy = this.body(cx, Math.round(y - hop + dy), r, sx, sy, stt, dec, id, t, ws);
    b.issues.slice(0, 4).forEach((_, i) => {
      const a = -2.3 + i * 0.7, ix = Math.round(cx + Math.cos(a) * r * sx), iy = Math.round(cy + Math.sin(a) * r * sy);
      this.rect(ix - 1, iy - 1, 4, 4, INK);
      this.rect(ix, iy, 2, 2, mix('#f2b24c', GREY, dec * 0.7));
    });
    this.eyes(cx, cy, r, mode, !D && mode === 'neutral' && (now / 1000 + id * 0.7) % 3.4 < 0.12);
    if (mode === 'sad' && !D) this.tear(cx, cy, r, t);
    if (dorm && !D) { const q = (t / 40 + id * 13) % 24; this.zz(cx + r - 1 + q / 8, cy - r * sy - 2 - q / 2, q < 18 ? '#9a98d8' : '#55547a'); }
    if (blocked && !D) this.bubble(cx, cy - r * sy, t);
    if (dec > 0.65) { const a = t / 180; this.px(cx + Math.cos(a) * (r + 3), cy - r * sy + Math.sin(a * 1.6) * 3 - 3, '#9a98b8'); }
    if (sel) for (let a = 0; a < 6.28; a += 0.12) if (((a * 8 + t / 200) | 0) % 2) this.px(cx + Math.cos(a) * (r * sx + 4), cy + Math.sin(a) * (r * sy + 4), '#e8f6ff');
    this.drawn.set(b.id, { x: cx, y: cy, r, gy: y });
  }

  /** Record a blob's or moon's pixels and turn them into drifting chunks. */
  shatter(sc: Scene, id: string, t: number) {
    const b = sc.world.blobs.find((q) => q.id === id);
    const at = b ? this.drawn.get(id) : this.moonsDrawn.get(id);
    if (!at) return;
    this.rec = [];
    let cy = at.y;
    if (b) {
      const d = at as { x: number; y: number; r: number; gy: number };
      cy = this.body(d.x, d.gy, d.r, 1, 1, M.palette(b), M.decay(b, Date.now(), sc.thresholds), seed(b.id), t);
      this.eyes(d.x, cy, d.r, 'shock', false);
    } else this.moon(at.x, at.y, 6, t);
    const pts = this.rec;
    this.rec = null;
    const chunks = new Map<string, typeof pts>();
    for (const p of pts) {
      const k = (p.x >> 1) + ',' + (p.y >> 1);
      chunks.set(k, [...(chunks.get(k) ?? []), p]);
    }
    for (const c of chunks.values()) {
      const p = c[0], dx = p.x - at.x, dy = p.y - cy, d = Math.hypot(dx, dy) || 1, sp = (b ? 0.4 : 0.9) + Math.random() * 1.2;
      this.parts.push({
        x: p.x, y: p.y,
        vx: (dx / d) * sp + (Math.random() - 0.5) * 0.4,
        vy: (dy / d) * sp + (Math.random() - 0.5) * 0.4,
        cells: c.map((q) => ({ dx: q.x - p.x, dy: q.y - p.y, c: q.c })),
        life: 1, dk: 0.003 + Math.random() * 0.003,
      });
    }
  }

  // ----- levels -----

  private drawGalaxy(sc: Scene, t: number, lb: Label[]) {
    const lay = galaxyLayout(sc.world, this.W, this.H);
    this.planetsDrawn = lay;
    for (const P of sc.world.planets) {
      const g = lay.get(P.id)!;
      const moons = sc.world.moons.filter((m) => m.planetId === P.id);
      this.planet(g.x, g.y, g.r, planetLook(P), t);
      moons.forEach((_, i) => {
        const a = i * 2.4 + t / 5000;
        this.moon(Math.round(g.x + Math.cos(a) * (g.r + 8)), Math.round(g.y + Math.sin(a) * (g.r + 8) * 0.5), 2, t);
      });
      const bs = sc.world.blobs.filter((b) => b.planetId === P.id);
      bs.forEach((b, k) => {
        const a = t / 6000 + (k * 6.28) / bs.length;
        const bx = Math.round(g.x + Math.cos(a) * (g.r + 14)), by = Math.round(g.y + Math.sin(a) * (g.r + 9) + 4);
        const blocked = M.isBlocked(b), hop = blocked ? Math.abs(Math.sin(t / 160)) * 3 : 0;
        const cy = this.body(bx, by - hop, 3, 1, 1, M.palette(b), M.decay(b, Date.now(), sc.thresholds), seed(b.id), t);
        this.eyes(bx, cy, 3, M.isDormant(b, Date.now(), sc.thresholds) ? 'sleep' : 'neutral', false);
        if (blocked) { this.rect(bx, cy - 8, 1, 3, '#ffe08a'); this.rect(bx, cy - 4, 1, 1, '#ffe08a'); }
      });
      const sel = P.id === sc.planetId;
      if (sel) for (let a = 0; a < 6.28; a += 0.1) if (((a * 8 + t / 200) | 0) % 2) this.px(g.x + Math.cos(a) * (g.r + 20), g.y + Math.sin(a) * (g.r + 14) + 2, '#e8f6ff');
      lb.push({ x: g.x, y: g.y + g.r + (bs.length ? 16 : 6), text: `${P.name} · ${bs.length}`, fg: sel ? '#e8f6ff' : '#8a88b8', bg: 'rgba(11,12,28,.6)' });
    }
  }

  private drawPlanet(sc: Scene, t: number, now: number, lb: Label[]) {
    const P = sc.world.planets.find((p) => p.id === sc.planetId);
    if (!P) return;
    const L0 = planetLayout(sc.world, P.id, this.W, this.H, 0);
    const s0 = sc.selId ? L0.pos.get(sc.selId) : undefined;
    // In session view, pan so the selected blob sits centered in the left (visible) half.
    const tgt = sc.level === 'session' && s0 ? Math.round(this.W * 0.25) - s0.x : 0;
    this.cam += (tgt - this.cam) * 0.12;
    const L = planetLayout(sc.world, P.id, this.W, this.H, Math.round(this.cam));
    const blobs = sc.world.blobs.filter((b) => b.planetId === P.id);
    const look = planetLook(P), pr = Math.round(18 * look.size);

    for (const b of blobs) {
      const q = L.pos.get(b.id)!, host = L.moons.find((m) => m.moon.id === b.moonId);
      const h = host ? { x: host.x, y: host.y + 12 } : { x: L.X0, y: L.Y0 + pr + 9 };
      this.tether(h.x, h.y, q.x, q.y - 4 - (4 + M.ctx(b) * 8) * 2, mix(PAL[M.palette(b)][1], GREY, M.decay(b, Date.now(), sc.thresholds) * 0.8), t);
    }
    this.planet(L.X0, L.Y0, pr, look, t);
    this.moonsDrawn.clear();
    for (const m of L.moons) {
      const dying = sc.deleting?.kind === 'moon' && sc.deleting.id === m.moon.id;
      this.moon(m.x, m.y, 6, t, dying ? (sc.deleting!.phase === 'shake' ? 2 : 1) : m.moon.dirty ? 0.6 : 0);
      this.moonsDrawn.set(m.moon.id, { x: m.x, y: m.y });
      lb.push({ x: m.x, y: m.y + 8, text: M.trunc(m.moon.branch, 16) + (m.moon.dirty ? ' *' : ''), fg: '#6e6aa8', bg: 'transparent' });
    }
    const kind = B.BIOME_LABEL[look.biome] + (P.isRepo ? '' : ' · no repo');
    lb.push({ x: L.X0, y: L.Y0 + pr + 3, text: `${P.name} · ${kind}`, fg: '#8a88b8', bg: 'transparent' });
    if (!blobs.length) lb.push({ x: L.X0, y: L.Y0 + 70, text: 'n spawns an agent here', fg: '#6e6aa8', bg: 'transparent' });

    for (const b of blobs) {
      const q = L.pos.get(b.id)!, r = 4 + M.ctx(b) * 8, f = b.id === sc.selId;
      this.drawBlob(sc, b, q.x, q.y, r, t, now, f);
      const blocked = M.isBlocked(b), show = f || blocked;
      const pal = PAL[M.palette(b)];
      lb.push({
        x: q.x, y: q.y + 2,
        text: show ? M.trunc(b.last || b.name, 24) : M.trunc(b.name, 12),
        fg: f ? INK : blocked ? '#ffe08a' : '#b9b6e8',
        bg: f ? pal[2] : 'rgba(11,12,28,.7)',
        z: f ? 3 : 1,
      });
    }

    // Edge markers point at blocked blobs on other planets.
    sc.world.blobs
      .filter((b) => M.isBlocked(b) && b.planetId !== P.id)
      .forEach((b, i) => {
        const y = 10 + i * 14, pulse = ((t / 200) | 0) % 2, W = this.W;
        const c = pulse ? '#ffe08a' : '#c46a2c';
        this.rect(W - 4, y - 3, 2, 7, c); this.rect(W - 6, y - 2, 2, 5, c); this.rect(W - 8, y - 1, 2, 3, c);
        if (sc.level === 'planet') {
          const pn = sc.world.planets.find((p) => p.id === b.planetId)?.name ?? '?';
          lb.push({ x: W - 10, y: y - 5, text: pn + ' !', fg: '#ffe08a', bg: 'rgba(11,12,28,.7)', right: true });
        }
      });
  }

  frame(sc: Scene, now: number) {
    const t = now * SPEED;
    this.space(t);
    const lb: Label[] = [];
    this.drawn.clear();
    if (sc.level === 'galaxy') {
      this.cam = 0;
      this.drawGalaxy(sc, t, lb);
      if (!sc.world.planets.length)
        lb.push({ x: this.W / 2, y: this.H / 2 - 4, text: 'Press a to add a planet: a repo or any folder', fg: '#b9b6e8', bg: 'rgba(11,12,28,.7)' });
    } else this.drawPlanet(sc, t, now, lb);

    this.parts = this.parts.filter((p) => {
      p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy *= 0.985; p.life -= p.dk;
      if (p.life <= 0) return false;
      for (const c of p.cells) {
        if (p.life < 0.4 && Math.random() > p.life / 0.4) continue;
        this.px(p.x + c.dx, p.y + c.dy, p.life < 0.3 ? mix(c.c, '#1a1c3c', 0.5) : c.c);
      }
      return true;
    });
    this.ctx.putImageData(this.img, 0, 0);
    this.labels(lb);
  }

  private labels(lb: Label[]) {
    const s = this.scale;
    lb.forEach((l, i) => {
      let d = this.pool[i];
      if (!d) {
        d = document.createElement('div');
        d.className = 'lb';
        this.labelLayer.appendChild(d);
        this.pool.push(d);
      }
      if (d.textContent !== l.text) d.textContent = l.text;
      d.style.display = 'block';
      d.style.left = l.x * s + 'px';
      d.style.top = l.y * s + 'px';
      d.style.transform = l.right ? 'translateX(-100%)' : 'translateX(-50%)';
      d.style.color = l.fg;
      d.style.background = l.bg;
      d.style.zIndex = String(l.z ?? 1);
    });
    for (let i = lb.length; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }
}
