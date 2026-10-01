// Dev-only fixture scenes for screenshots and visual checks (gallery.html).
// The clock is driven from outside via window.advance(ms), so captures are reproducible.
import '@fontsource/vt323';
import './styles.css';
import * as M from './model';
import { Renderer, type Deleting, type Scene } from './render';
import type { Blob, DiffStat, Planet, World } from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const CLEAN: DiffStat = { files: 0, insertions: 0, deletions: 0, untracked: 0, top: [] };

const planet: Planet = {
  id: 'p',
  name: 'blob zoo',
  path: '/gallery/blob-zoo',
  isRepo: true,
  traits: { language: 'python', languagePct: 90, files: 400, commits: 50 },
  diff: CLEAN,
};

let n = 0;
const blob = (name: string, o: Partial<Blob> = {}): Blob => ({
  id: `g${n++}`,
  planetId: 'p',
  moonId: null,
  agent: 'claude',
  sessionId: 's',
  name,
  cwd: '/gallery',
  activity: 'idle',
  blocked: null,
  yourTurn: false,
  last: name,
  ctxUsed: 70_000,
  ctxSize: 200_000,
  lastActivityMs: NOW - 10 * 60_000,
  pr: null,
  issues: [],
  subagents: 0,
  ...o,
});
const pr = (ci: 'running' | 'passing' | 'failing', ageDays = 0) => ({
  number: 482,
  url: '',
  state: 'open' as const,
  ci,
  updatedMs: NOW - ageDays * DAY,
});

const SCENES: Record<string, () => Blob[]> = {
  states: () => [
    // Sub-agents trail to the left, so this one leads its row.
    blob('sub-agents', { activity: 'working', subagents: 2 }),
    blob('working', { activity: 'working' }),
    blob('blocked', {
      activity: 'working',
      last: 'Allow: rm -rf',
      blocked: { title: 'rm -rf build/', options: [] },
    }),
    blob('your turn', { yourTurn: true }),
    blob('PR · CI run', { pr: pr('running') }),
    blob('CI passing', { pr: pr('passing') }),
    blob('CI failing', { pr: pr('failing') }),
    blob('issues', { activity: 'working', issues: ['ENG-142', 'ENG-150'] }),
    blob('tiny context', { activity: 'working', ctxUsed: 6_000 }),
    blob('big context', { activity: 'working', ctxUsed: 190_000 }),
    blob('dormant', { lastActivityMs: NOW - 5 * HOUR }),
    blob('decaying', { activity: 'offline', lastActivityMs: NOW - 7 * DAY }),
    blob('crumbling', { activity: 'offline', lastActivityMs: NOW - 13 * DAY, pr: pr('running', 19) }),
  ],
  delete: () => [blob('keeper', { activity: 'working' }), blob('doomed', { activity: 'working' }), blob('bystander', { yourTurn: true })],
};

const params = new URLSearchParams(location.search);
const sceneName = params.get('scene') ?? 'states';
const num = (key: string, fallback = 0) => Number(params.get(key) ?? fallback);
const diffOf = (lines: number): DiffStat => (lines ? { ...CLEAN, files: Math.max(1, Math.round(lines / 60)), insertions: lines } : CLEAN);

/**
 * `scene=planet`: one planet built from query params, for biome and surface-state captures.
 * name, lang (omit for a plain folder), files, commits, diff (lines), agents (on the root),
 * worktrees=1 adds two moons: one crowded with a big diff, one with a small diff.
 */
function planetScene(): World {
  const lang = params.get('lang');
  const p: Planet = {
    ...planet,
    name: params.get('name') ?? 'planet',
    path: `/gallery/${params.get('seed') ?? params.get('name') ?? 'planet'}`,
    isRepo: lang !== null,
    traits: { language: lang, languagePct: num('pct', 90), files: num('files', 400), commits: num('commits', 50) },
    diff: diffOf(num('diff')),
  };
  const moons = num('worktrees')
    ? [
        { id: 'm1', planetId: 'p', branch: 'eng-142-parser', path: '/gallery/m1', dirty: true, diff: diffOf(900) },
        { id: 'm2', planetId: 'p', branch: 'fix-typo', path: '/gallery/m2', dirty: true, diff: diffOf(8) },
      ]
    : [];
  const blobs = [
    ...Array.from({ length: num('agents') }, (_, i) => blob(`agent-${i}`, { activity: 'working' })),
    ...(num('worktrees') ? Array.from({ length: 5 }, (_, i) => blob(`moon-${i}`, { moonId: 'm1', activity: 'working' })) : []),
  ];
  return { planets: [p], moons, blobs };
}

const world: World = sceneName === 'planet' ? planetScene() : { planets: [planet], moons: [], blobs: SCENES[sceneName]() };

const renderer = new Renderer(document.getElementById('cv') as HTMLCanvasElement, document.getElementById('labels')!);

/** In the delete scene, the shock starts at 600ms; the shake and shatter follow like in the app. */
const DELETE_AT = 600;
let deleting: Deleting | null = null;
let shattered = false;

function scene(now: number): Scene {
  if (sceneName === 'delete') {
    const doomed = world.blobs.find((b) => b.name === 'doomed');
    if (doomed && now >= DELETE_AT) {
      const e = now - DELETE_AT;
      deleting = e < 900 ? { kind: 'blob', id: doomed.id, phase: 'shock', t0: DELETE_AT } : { kind: 'blob', id: doomed.id, phase: 'shake', t0: DELETE_AT + 900 };
    }
  }
  return {
    world,
    level: 'planet',
    planetId: 'p',
    selId: null,
    thresholds: M.DEFAULT_THRESHOLDS,
    deleting,
    born: new Map(),
    // Only the planet scene shows pollution; the blob scenes keep the surface clean.
    crowdedAt: sceneName === 'planet' ? 4 : 99,
  };
}

let clock = 0;
/** Render frames at 60fps steps up to `ms`, so particles and easing match the app's frame rate. */
function advance(ms: number) {
  while (clock < ms) {
    clock = Math.min(ms, clock + 1000 / 60);
    const sc = scene(clock);
    if (sceneName === 'delete' && !shattered && clock >= DELETE_AT + 900 + 1400) {
      shattered = true;
      renderer.shatter(sc, sc.deleting!.id, clock * 0.4);
      world.blobs = world.blobs.filter((b) => b.id !== sc.deleting!.id);
      deleting = null;
    }
    renderer.frame(scene(clock), clock);
  }
}

declare global {
  interface Window {
    advance: (ms: number) => void;
    galleryReady: Promise<void>;
  }
}
window.advance = advance;
window.galleryReady = document.fonts.ready.then(() => {
  renderer.resize();
  advance(1);
});
