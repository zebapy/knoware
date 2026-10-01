// Pure rules that turn world data into what a blob looks like and where focus moves.
import type { Blob, DiffStat, PermissionChoice, Settings } from './types';

export type Palette = 'work' | 'pr' | 'green' | 'red' | 'attn';
export type Mood = 'neutral' | 'happy' | 'sad';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export type Thresholds = Pick<
  Settings,
  'dormantAfterHours' | 'sessionDecayStartDays' | 'sessionDecayFullDays' | 'prDecayStartDays' | 'prDecayFullDays'
>;

export const DEFAULT_THRESHOLDS: Thresholds = {
  dormantAfterHours: 2,
  sessionDecayStartDays: 2,
  sessionDecayFullDays: 14,
  prDecayStartDays: 3,
  prDecayFullDays: 21,
};

export const isBlocked = (b: Blob) => b.blocked !== null;
export const isWorking = (b: Blob) => b.activity === 'working' || b.activity === 'starting';

/** Asleep: no live process, or idle for a while. A blocked blob never sleeps. */
export function isDormant(b: Blob, now: number, t: Thresholds): boolean {
  if (isBlocked(b) || isWorking(b)) return false;
  if (b.activity === 'offline') return true;
  return now - b.lastActivityMs >= t.dormantAfterHours * HOUR;
}

/** "Your turn": the turn ended recently and the user hasn't replied. */
export function isYourTurn(b: Blob, now: number, t: Thresholds): boolean {
  return b.yourTurn && b.activity === 'idle' && !isBlocked(b) && !isDormant(b, now, t);
}

/** 0..1 — the worse of the session clock and the PR clock. Merged or closed PRs stop the PR clock. */
export function decay(b: Blob, now: number, t: Thresholds): number {
  if (isWorking(b) || isBlocked(b)) return 0;
  const ramp = (ms: number, start: number, full: number) => clamp01((ms / DAY - start) / Math.max(0.01, full - start));
  const session = b.lastActivityMs ? ramp(now - b.lastActivityMs, t.sessionDecayStartDays, t.sessionDecayFullDays) : 0;
  const pr =
    b.pr && b.pr.state === 'open' && b.pr.updatedMs
      ? ramp(now - b.pr.updatedMs, t.prDecayStartDays, t.prDecayFullDays)
      : 0;
  return Math.max(session, pr);
}

export function palette(b: Blob): Palette {
  if (isBlocked(b)) return 'attn';
  if (b.pr?.state === 'open') {
    if (b.pr.ci === 'failing') return 'red';
    if (b.pr.ci === 'passing') return 'green';
    return 'pr';
  }
  return 'work';
}

export function mood(b: Blob): Mood {
  const p = palette(b);
  return p === 'green' ? 'happy' : p === 'red' ? 'sad' : 'neutral';
}

/** Context used, 0..1. Unknown context draws as a small blob. */
export function ctx(b: Blob): number {
  return b.ctxSize > 0 ? clamp01(b.ctxUsed / b.ctxSize) : 0.15;
}

/** Lower is more urgent. Drives arrow-key order on a planet. */
export function urgency(b: Blob, now: number, t: Thresholds): number {
  if (isBlocked(b)) return 0;
  if (isYourTurn(b, now, t)) return 1;
  if (palette(b) === 'red') return 2;
  if (isWorking(b)) return 3;
  if (!isDormant(b, now, t)) return 4;
  return 5 + decay(b, now, t);
}

export function describe(b: Blob, now: number, t: Thresholds): string {
  if (isBlocked(b)) return 'blocked on permission';
  if (b.activity === 'starting') return 'starting';
  if (isWorking(b)) return 'working';
  if (isYourTurn(b, now, t)) return 'your turn';
  const pr = b.pr?.state === 'open' ? ` · PR #${b.pr.number} ${{ none: 'open', running: 'CI running', passing: 'CI passing', failing: 'CI failing' }[b.pr.ci]}` : '';
  return (isDormant(b, now, t) ? 'dormant' : 'idle') + pr;
}

/** The option `y` picks: a one-time allow, else any allow. */
export function allowOption(options: PermissionChoice[]): PermissionChoice | undefined {
  return options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind.startsWith('allow'));
}

export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Next blocked blob after `current`, across planets, in a stable order. */
export function nextBlocked(blobs: Blob[], current: string | null): Blob | undefined {
  const blocked = blobs.filter(isBlocked);
  if (!blocked.length) return undefined;
  const i = blocked.findIndex((b) => b.id === current);
  return blocked[(i + 1) % blocked.length];
}

/** 0..1 — how polluted a planet root or moon looks once too many agents crowd onto it. */
export function pollution(agents: number, crowdedAt: number): number {
  if (agents < crowdedAt) return 0;
  return clamp01((agents - crowdedAt + 1) / 4);
}

/** Construction size for uncommitted work: 0 none, 1 cones, 2 scaffolding, 3 crane. */
export function construction(d: DiffStat | undefined): 0 | 1 | 2 | 3 {
  if (!d || !d.files) return 0;
  const churn = d.insertions + d.deletions;
  return churn < 40 ? 1 : churn < 400 ? 2 : 3;
}

export function diffSummary(d: DiffStat): string {
  if (!d.files) return 'clean';
  const files = `${d.files} file${d.files === 1 ? '' : 's'}`;
  const untracked = d.untracked ? ` (${d.untracked} new)` : '';
  return `+${d.insertions} −${d.deletions} · ${files}${untracked}`;
}

/** Add up several checkouts' diffs, e.g. a planet root and all its moons. */
export function sumDiffs(list: DiffStat[]): DiffStat {
  const out: DiffStat = { files: 0, insertions: 0, deletions: 0, untracked: 0, top: [] };
  for (const d of list) {
    out.files += d.files;
    out.insertions += d.insertions;
    out.deletions += d.deletions;
    out.untracked += d.untracked;
  }
  return out;
}
