// Mirrors the Rust world model (src-tauri/src/world.rs, state.rs). Field names are camelCase on the wire.

export type Activity = 'offline' | 'starting' | 'working' | 'idle';
export type PrState = 'open' | 'merged' | 'closed';
export type CiState = 'none' | 'running' | 'passing' | 'failing';

export interface Planet {
  id: string;
  name: string;
  path: string;
  isRepo: boolean;
  traits: PlanetTraits;
  /** Uncommitted work in the root checkout. */
  diff: DiffStat;
}

export interface FileDiff {
  path: string;
  insertions: number;
  deletions: number;
}

/** Uncommitted work in one checkout (src-tauri/src/diff.rs). */
export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  untracked: number;
  /** Biggest changes first, at most a handful. */
  top: FileDiff[];
}

/** Surveyed from the directory (src-tauri/src/survey.rs); drives the planet's biome and shape. */
export interface PlanetTraits {
  language: string | null;
  languagePct: number;
  files: number;
  commits: number;
}

export interface Moon {
  id: string;
  planetId: string;
  branch: string;
  path: string;
  dirty: boolean;
  diff: DiffStat;
}

export interface PermissionChoice {
  optionId: string;
  name: string;
  kind: string;
}

export interface Blocked {
  title: string;
  options: PermissionChoice[];
}

export interface PrSignal {
  number: number;
  url: string;
  state: PrState;
  ci: CiState;
  updatedMs: number;
}

export interface Blob {
  id: string;
  planetId: string;
  moonId: string | null;
  agent: string;
  sessionId: string | null;
  name: string;
  cwd: string;
  activity: Activity;
  blocked: Blocked | null;
  yourTurn: boolean;
  last: string;
  ctxUsed: number;
  ctxSize: number;
  lastActivityMs: number;
  pr: PrSignal | null;
  issues: string[];
  subagents: number;
}

export interface World {
  planets: Planet[];
  moons: Moon[];
  blobs: Blob[];
}

export interface Settings {
  agents: Record<string, { command: string; args: string[] }>;
  defaultAgent: string;
  dormantAfterHours: number;
  sessionDecayStartDays: number;
  sessionDecayFullDays: number;
  prDecayStartDays: number;
  prDecayFullDays: number;
  autoCleanupMergedMoons: boolean;
  crowdedAt: number;
}

export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; id: string; title: string; status: string }
  | { kind: 'plan'; items: { content: string; status: string }[] }
  | { kind: 'notice'; text: string };
