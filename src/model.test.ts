import { describe, expect, it } from 'vitest';
import * as M from './model';
import type { Blob } from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 1);
const t = M.DEFAULT_THRESHOLDS;

const blob = (o: Partial<Blob> = {}): Blob => ({
  id: 'b',
  planetId: 'p',
  moonId: null,
  agent: 'claude',
  sessionId: 's',
  name: 'x',
  cwd: '/x',
  activity: 'idle',
  blocked: null,
  yourTurn: false,
  last: '',
  ctxUsed: 0,
  ctxSize: 0,
  lastActivityMs: NOW,
  pr: null,
  issues: [],
  subagents: 0,
  ...o,
});
const blocked = { title: 'rm -rf build', options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }, { optionId: 'ok', name: 'Allow', kind: 'allow_once' }] };

describe('time states', () => {
  it('sleeps after the idle threshold, or when offline', () => {
    expect(M.isDormant(blob({ lastActivityMs: NOW - HOUR }), NOW, t)).toBe(false);
    expect(M.isDormant(blob({ lastActivityMs: NOW - 3 * HOUR }), NOW, t)).toBe(true);
    expect(M.isDormant(blob({ activity: 'offline' }), NOW, t)).toBe(true);
    expect(M.isDormant(blob({ activity: 'offline', blocked }), NOW, t)).toBe(false);
  });

  it('decays on the worse of the session and PR clocks', () => {
    expect(M.decay(blob({ lastActivityMs: NOW - DAY }), NOW, t)).toBe(0);
    expect(M.decay(blob({ lastActivityMs: NOW - 8 * DAY }), NOW, t)).toBeCloseTo(0.5);
    expect(M.decay(blob({ lastActivityMs: NOW - 30 * DAY }), NOW, t)).toBe(1);
    const stalePr = { number: 1, url: '', state: 'open' as const, ci: 'running' as const, updatedMs: NOW - 12 * DAY };
    expect(M.decay(blob({ pr: stalePr }), NOW, t)).toBeCloseTo(0.5);
    expect(M.decay(blob({ pr: { ...stalePr, state: 'merged' } }), NOW, t)).toBe(0);
    expect(M.decay(blob({ activity: 'working', lastActivityMs: NOW - 30 * DAY }), NOW, t)).toBe(0);
  });
});

describe('look', () => {
  it('maps signals to palette and mood, blocked first', () => {
    const pr = (ci: 'running' | 'passing' | 'failing') => ({ number: 1, url: '', state: 'open' as const, ci, updatedMs: NOW });
    expect(M.palette(blob())).toBe('work');
    expect(M.palette(blob({ pr: pr('running') }))).toBe('pr');
    expect(M.palette(blob({ pr: pr('passing') }))).toBe('green');
    expect(M.mood(blob({ pr: pr('passing') }))).toBe('happy');
    expect(M.palette(blob({ pr: pr('failing') }))).toBe('red');
    expect(M.mood(blob({ pr: pr('failing') }))).toBe('sad');
    expect(M.palette(blob({ pr: pr('failing'), blocked }))).toBe('attn');
  });

  it('sizes by context used', () => {
    expect(M.ctx(blob({ ctxUsed: 50, ctxSize: 200 }))).toBe(0.25);
    expect(M.ctx(blob())).toBe(0.15);
  });
});

describe('attention', () => {
  it('orders blocked, then your turn, then the rest', () => {
    const list = [
      blob({ id: 'asleep', activity: 'offline' }),
      blob({ id: 'turn', yourTurn: true }),
      blob({ id: 'work', activity: 'working' }),
      blob({ id: 'blocked', activity: 'working', blocked }),
    ];
    const sorted = [...list].sort((a, b) => M.urgency(a, NOW, t) - M.urgency(b, NOW, t)).map((b) => b.id);
    expect(sorted).toEqual(['blocked', 'turn', 'work', 'asleep']);
  });

  it('y picks a one-time allow', () => {
    expect(M.allowOption(blocked.options)?.optionId).toBe('ok');
    expect(M.allowOption([{ optionId: 'a', name: 'Always', kind: 'allow_always' }])?.optionId).toBe('a');
    expect(M.allowOption([{ optionId: 'r', name: 'No', kind: 'reject_once' }])).toBeUndefined();
  });

  it('Space cycles through blocked blobs across planets', () => {
    const list = [blob({ id: 'a', blocked }), blob({ id: 'b' }), blob({ id: 'c', planetId: 'q', blocked })];
    expect(M.nextBlocked(list, null)?.id).toBe('a');
    expect(M.nextBlocked(list, 'a')?.id).toBe('c');
    expect(M.nextBlocked(list, 'c')?.id).toBe('a');
    expect(M.nextBlocked([blob()], null)).toBeUndefined();
  });
});
