import '@fontsource/vt323';
import './styles.css';
import { api, events, type Created } from './api';
import * as M from './model';
import { Renderer, planetLayout, type Deleting, type Level, type Scene } from './render';
import type { Blob, DiffStat, Entry, World } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const panel = $<HTMLElement>('panel');
const head = $<HTMLElement>('panel-head');
const transcriptEl = $<HTMLDivElement>('transcript');
const permissionEl = $<HTMLDivElement>('permission');
const reply = $<HTMLTextAreaElement>('reply');
const crumb = $<HTMLSpanElement>('crumb');
const statusEl = $<HTMLSpanElement>('status');
const askBox = $<HTMLDivElement>('ask');
const askForm = $<HTMLFormElement>('ask-form');
const askLabel = $<HTMLLabelElement>('ask-label');
const askInput = $<HTMLInputElement>('ask-input');
const help = $<HTMLDivElement>('help');
const tip = $<HTMLDivElement>('tip');

const renderer = new Renderer($<HTMLCanvasElement>('cv'), $<HTMLDivElement>('labels'));

const S = {
  world: { planets: [], moons: [], blobs: [] } as World,
  thresholds: M.DEFAULT_THRESHOLDS,
  crowdedAt: 4,
  level: 'galaxy' as Level,
  planetId: null as string | null,
  selId: null as string | null,
  deleting: null as Deleting | null,
  born: new Map<string, number>(),
  transcripts: new Map<string, Entry[]>(),
  /** A moon whose delete failed because it was dirty; deleting it again soon forces it. */
  forceMoon: null as { id: string; until: number } | null,
  asking: false,
};

const say = (m: string) => (statusEl.textContent = m);
const fail = (e: unknown) => say(String(e));

// ---------- selection ----------

const planet = () => S.world.planets.find((p) => p.id === S.planetId);
const selected = () => (S.level === 'galaxy' ? undefined : S.world.blobs.find((b) => b.id === S.selId));

/** Blobs on the current planet in arrow-key order: most urgent first, then by slot. */
function order(): Blob[] {
  if (!S.planetId) return [];
  const lay = planetLayout(S.world, S.planetId, renderer.W, renderer.H, 0);
  const now = Date.now();
  return S.world.blobs
    .filter((b) => b.planetId === S.planetId)
    .map((b) => ({ b, u: Math.floor(M.urgency(b, now, S.thresholds)), p: lay.pos.get(b.id)! }))
    .sort((a, c) => a.u - c.u || a.p.y - c.p.y || a.p.x - c.p.x)
    .map((x) => x.b);
}

function select(id: string | null) {
  if (id !== S.selId) {
    S.selId = id;
    if (id && !S.transcripts.has(id)) {
      api.getTranscript(id).then((list) => {
        S.transcripts.set(id, list);
        drawPanel();
      }, fail);
    }
  }
  ui();
}

function keepSelectionValid() {
  if (S.planetId && !planet()) {
    S.planetId = S.world.planets[0]?.id ?? null;
    S.level = 'galaxy';
  }
  if (!S.planetId) S.planetId = S.world.planets[0]?.id ?? null;
  if (S.level !== 'galaxy' && !selected()) {
    const first = order()[0];
    S.selId = first?.id ?? null;
    if (!first && S.level === 'session') S.level = 'planet';
  }
}

// ---------- panel ----------

let panelQueued = false;
function drawPanel() {
  if (panelQueued) return;
  panelQueued = true;
  requestAnimationFrame(() => {
    panelQueued = false;
    renderPanel();
  });
}

function el(tag: string, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderPanel() {
  const b = selected();
  panel.hidden = S.level !== 'session' || !b;
  stage.classList.toggle('split', !panel.hidden);
  if (panel.hidden || !b) return;
  const now = Date.now();
  const P = planet();
  const moon = S.world.moons.find((m) => m.id === b.moonId);
  const pal = M.palette(b);

  head.replaceChildren();
  const title = el('div', 'title');
  const dot = el('span', `dot ${pal}`);
  title.append(dot, el('span', '', b.name));
  const ctxPct = b.ctxSize ? ` · ${Math.round((b.ctxUsed / b.ctxSize) * 100)}% ctx` : '';
  const meta = el(
    'div',
    'meta',
    `${b.agent} · ${P?.name ?? '?'}${moon ? ' › ' + moon.branch : ' root'} · ${M.describe(b, now, S.thresholds)}${ctxPct}` +
      (M.decay(b, now, S.thresholds) > 0.05 ? ' · decaying' : '') +
      (b.issues.length ? ' · ' + b.issues.join(', ') : ''),
  );
  head.append(title, meta);
  if (b.pr) head.append(el('div', 'meta', `PR #${b.pr.number} ${b.pr.state} · ${b.pr.url}`));
  const hostDiff = moon ? moon.diff : P?.diff;
  if (hostDiff?.files) head.append(el('div', 'meta diff', `diff ${M.diffSummary(hostDiff)}`));

  const list = S.transcripts.get(b.id) ?? [];
  const stick = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
  transcriptEl.replaceChildren();
  if (!list.length) {
    const hint = b.activity === 'offline' && b.sessionId
      ? 'Dormant session. Press w to wake it and load its history, or just reply.'
      : b.activity === 'starting' ? 'Starting the agent…' : 'Say what to work on.';
    transcriptEl.append(el('div', 'entry notice', hint));
  }
  for (const e of list) transcriptEl.append(renderEntry(e));
  if (stick) transcriptEl.scrollTop = transcriptEl.scrollHeight;

  permissionEl.hidden = !b.blocked;
  permissionEl.replaceChildren();
  if (b.blocked) {
    permissionEl.append(el('div', 'perm-title', b.blocked.title));
    const row = el('div', 'perm-row');
    b.blocked.options.forEach((o, i) => {
      const btn = el('button', `perm ${o.kind}`, `${i + 1} ${o.name}`) as HTMLButtonElement;
      btn.type = 'button';
      btn.onclick = () => answer(b, o.optionId);
      row.append(btn);
    });
    permissionEl.append(row);
  }
  reply.placeholder = `Reply to ${M.trunc(b.name, 20)}… (Enter sends, Shift+Enter newline, Esc back to world)`;
}

function renderEntry(e: Entry): HTMLElement {
  switch (e.kind) {
    case 'user':
      return el('div', 'entry user', e.text);
    case 'agent':
      return el('div', 'entry agent', e.text);
    case 'thought':
      return el('div', 'entry thought', e.text);
    case 'notice':
      return el('div', 'entry notice', e.text);
    case 'tool': {
      const row = el('div', `entry tool ${e.status}`);
      row.append(el('span', 'tool-dot'), el('span', '', e.title));
      return row;
    }
    case 'plan': {
      const box = el('div', 'entry plan');
      for (const item of e.items) box.append(el('div', `plan-item ${item.status}`, item.content));
      return box;
    }
  }
}

// ---------- chrome ----------

function ui() {
  keepSelectionValid();
  const P = planet(), b = selected();
  crumb.textContent =
    S.level === 'galaxy'
      ? 'Galaxy'
      : `Galaxy › ${P?.name ?? ''}${b ? ' › ' + b.name : ''}${S.level === 'session' ? ' (session)' : ''}`;
  const blocked = S.world.blobs.filter(M.isBlocked).length;
  document.title = blocked ? `(${blocked}) Knoware` : 'Knoware';
  drawPanel();
}

function ask(label: string, value = ''): Promise<string | null> {
  S.asking = true;
  askLabel.textContent = label;
  askInput.value = value;
  askBox.hidden = false;
  askInput.focus();
  askInput.select();
  return new Promise((resolve) => {
    const done = (v: string | null) => {
      askBox.hidden = true;
      S.asking = false;
      askForm.onsubmit = null;
      askInput.onkeydown = null;
      stage.focus();
      resolve(v);
    };
    askForm.onsubmit = (ev) => {
      ev.preventDefault();
      done(askInput.value.trim() || null);
    };
    askInput.onkeydown = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        done(null);
      }
    };
  });
}

const WORDS = ['comet', 'nebula', 'quasar', 'orbit', 'pulsar', 'nova', 'aurora', 'zenith', 'halo', 'drift'];
const branchSuggestion = () => `knoware/${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(Math.random() * 900 + 100)}`;

// ---------- actions ----------

function answer(b: Blob, optionId: string | null) {
  api.answerPermission(b.id, optionId).then(() => say(optionId ? 'Answered' : 'Denied'), fail);
}

function spawned({ id, world }: Created) {
  S.world = world;
  S.born.set(id, performance.now());
  S.level = 'session';
  select(id);
  // The reply box must be visible before it can take focus.
  renderPanel();
  reply.focus();
}

function jumpToBlocked() {
  const b = M.nextBlocked(S.world.blobs, S.selId);
  if (!b) return say('Nothing is blocked');
  S.planetId = b.planetId;
  S.level = 'session';
  select(b.id);
  say('Jumped to ' + b.name);
}

function startDelete(kind: Deleting['kind'], id: string, name: string) {
  S.deleting = { kind, id, phase: 'shock', t0: performance.now() };
  say(`Deleting ${name}… Esc or u to undo`);
}

function finishDelete(d: Deleting, t: number) {
  const scene = sceneNow();
  if (d.kind === 'blob') {
    renderer.shatter(scene, d.id, t);
    api.deleteBlob(d.id).catch(fail);
    if (S.selId === d.id) S.selId = null;
    if (S.level === 'session') S.level = 'planet';
    return;
  }
  const force = S.forceMoon?.id === d.id && S.forceMoon.until > Date.now();
  api.deleteMoon(d.id, force).then(
    () => {
      renderer.shatter(scene, d.id, t);
      S.forceMoon = null;
      say('Moon deleted; its blobs dropped to the planet');
    },
    (e) => {
      S.forceMoon = { id: d.id, until: Date.now() + 8000 };
      fail(e);
    },
  );
}

function key(ev: KeyboardEvent) {
  const k = ev.key;
  if (S.deleting) {
    if (k === 'Escape' || k === 'u') {
      say('Spared');
      S.deleting = null;
    }
    return true;
  }
  if (!help.hidden) {
    if (k === 'Escape' || k === '?') help.hidden = true;
    return true;
  }
  if (k === '?') {
    help.hidden = false;
    return true;
  }
  if (k === ' ') {
    jumpToBlocked();
    return true;
  }
  if (k === 'a') {
    ask('Add a planet: path to a repo or folder', '~/').then((path) => {
      if (!path) return;
      api.addPlanet(path).then(({ id, world }) => {
        S.world = world;
        S.planetId = id;
        say('Planet added');
        ui();
      }, fail);
    });
    return true;
  }
  if (k === 'r') {
    api.refreshSignals().catch(fail);
    api.discoverSessions().catch(fail);
    say('Refreshing signals and looking for sessions…');
    return true;
  }

  const planets = S.world.planets;
  if (S.level === 'galaxy') {
    const i = planets.findIndex((p) => p.id === S.planetId);
    if (k === 'ArrowRight' || k === 'ArrowDown') S.planetId = planets[(i + 1) % planets.length]?.id ?? null;
    else if (k === 'ArrowLeft' || k === 'ArrowUp') S.planetId = planets[(i - 1 + planets.length) % planets.length]?.id ?? null;
    else if (k === 'Enter' && S.planetId) {
      S.level = 'planet';
      S.selId = null;
      select(order()[0]?.id ?? null);
    } else if ((k === 'Delete' || k === 'Backspace') && S.planetId) {
      api.removePlanet(S.planetId).then(() => say('Planet removed'), fail);
    } else if (k === 'n' && S.planetId) {
      api.spawnBlob(S.planetId, null).then(spawned, fail);
    } else return false;
    ui();
    return true;
  }

  const P = planet();
  const list = order();
  const b = selected();
  const i = list.findIndex((x) => x.id === S.selId);
  const n = list.length;
  switch (k) {
    case 'ArrowRight':
    case 'ArrowDown':
      if (n) select(list[(i + 1) % n].id);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      if (n) select(list[(i - 1 + n) % n].id);
      break;
    case 'Enter':
      if (S.level === 'session') reply.focus();
      else if (b) S.level = 'session';
      break;
    case 'Escape':
      S.level = S.level === 'session' ? 'planet' : 'galaxy';
      break;
    case 'n':
      if (P) api.spawnBlob(P.id, b?.moonId ?? null).then(spawned, fail);
      break;
    case 'N':
      if (!P) break;
      if (!P.isRepo) {
        say('No repo here, so no worktrees');
        break;
      }
      ask('New moon: branch name', branchSuggestion()).then((branch) => {
        if (branch) api.newMoon(P.id, branch).then(spawned, fail);
      });
      break;
    case 'Delete':
    case 'Backspace':
      if (ev.shiftKey) {
        const moon = S.world.moons.find((m) => m.id === b?.moonId);
        if (moon) startDelete('moon', moon.id, moon.branch);
        else say('Select a blob on a moon to delete that moon');
      } else if (b) startDelete('blob', b.id, b.name);
      break;
    case 'y': {
      const opt = b?.blocked && M.allowOption(b.blocked.options);
      if (b && opt) answer(b, opt.optionId);
      else say('Nothing to allow here');
      break;
    }
    case 'f':
      if (b) api.fork(b.id).then(spawned, fail);
      break;
    case 's':
      if (b) api.cancel(b.id).then(() => say('Stopping the turn'), fail);
      break;
    case 'w':
      if (b) api.wake(b.id).then(() => say('Waking ' + b.name), fail);
      break;
    default: {
      const num = Number(k);
      if (S.level === 'session' && b?.blocked && num >= 1 && num <= b.blocked.options.length) {
        answer(b, b.blocked.options[num - 1].optionId);
        break;
      }
      return false;
    }
  }
  ui();
  return true;
}

document.addEventListener('keydown', (ev) => {
  if (S.asking) return;
  if (document.activeElement === reply) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      reply.blur();
      stage.focus();
    }
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (key(ev)) ev.preventDefault();
});

reply.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
  ev.preventDefault();
  const b = selected();
  const text = reply.value.trim();
  if (!b || !text) return;
  reply.value = '';
  api.prompt(b.id, text).catch(fail);
});
$<HTMLFormElement>('reply-form').onsubmit = (ev) => ev.preventDefault();

stage.addEventListener('click', (ev) => {
  stage.focus();
  const r = stage.getBoundingClientRect();
  const x = (ev.clientX - r.left) / renderer.scale, y = (ev.clientY - r.top) / renderer.scale;
  const nearest = <T>(m: Map<string, T & { x: number; y: number }>, max: number) => {
    let best: string | null = null, bd = max;
    for (const [id, p] of m) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };
  if (S.level === 'galaxy') {
    const id = nearest(renderer.planetsDrawn, 2000);
    if (!id) return;
    if (id === S.planetId) {
      S.level = 'planet';
      select(order()[0]?.id ?? null);
    } else S.planetId = id;
    return ui();
  }
  const id = nearest(renderer.drawn, 400);
  if (!id) return;
  if (id === S.selId) S.level = 'session';
  select(id);
});

// ---------- hover ----------

function diffBlock(box: HTMLElement, title: string, d: DiffStat, agents: number) {
  box.append(el('div', 'tip-title', title));
  box.append(el('div', 'tip-sum', M.diffSummary(d)));
  for (const f of d.top) {
    const row = el('div', 'tip-file');
    row.append(el('span', 'tip-path', f.path), el('span', 'ins', `+${f.insertions}`), el('span', 'del', `−${f.deletions}`));
    box.append(row);
  }
  const smog = M.pollution(agents, S.crowdedAt);
  box.append(el('div', 'tip-meta', `${agents} agent${agents === 1 ? '' : 's'}${smog ? ' · crowded, consider fewer' : ''}`));
}

function showTip(kind: 'planet' | 'moon', id: string, cx: number, cy: number) {
  tip.replaceChildren();
  const agentsOn = (planetId: string, moonId: string | null) =>
    S.world.blobs.filter((b) => b.planetId === planetId && b.moonId === moonId).length;
  if (kind === 'moon') {
    const m = S.world.moons.find((q) => q.id === id);
    if (!m) return hideTip();
    diffBlock(tip, m.branch, m.diff, agentsOn(m.planetId, m.id));
  } else {
    const P = S.world.planets.find((q) => q.id === id);
    if (!P) return hideTip();
    if (S.level === 'galaxy') {
      // Whole planet: root plus every moon, one line each.
      const moons = S.world.moons.filter((m) => m.planetId === P.id);
      tip.append(el('div', 'tip-title', P.name));
      tip.append(el('div', 'tip-sum', M.diffSummary(M.sumDiffs([P.diff, ...moons.map((m) => m.diff)]))));
      for (const [name, d] of [['root', P.diff] as const, ...moons.map((m) => [m.branch, m.diff] as const)])
        if (d.files) tip.append(el('div', 'tip-file', `${name}: ${M.diffSummary(d)}`));
      const n = S.world.blobs.filter((b) => b.planetId === P.id).length;
      tip.append(el('div', 'tip-meta', `${n} agent${n === 1 ? '' : 's'} · ${moons.length} moon${moons.length === 1 ? '' : 's'}`));
    } else diffBlock(tip, `${P.name} · root checkout`, P.diff, agentsOn(P.id, null));
  }
  tip.hidden = false;
  const r = document.getElementById('app')!.getBoundingClientRect();
  tip.style.left = Math.min(cx + 14, r.width - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(cy + 14, r.height - tip.offsetHeight - 8) + 'px';
}

function hideTip() {
  tip.hidden = true;
}

stage.addEventListener('mousemove', (ev) => {
  const r = stage.getBoundingClientRect();
  const x = (ev.clientX - r.left) / renderer.scale, y = (ev.clientY - r.top) / renderer.scale;
  const hit = renderer.hoverables
    .map((h) => ({ h, d: Math.hypot(h.x - x, h.y - y) }))
    .filter(({ h, d }) => d <= h.r)
    .sort((a, b) => a.d - b.d)[0];
  if (hit) showTip(hit.h.kind, hit.h.id, ev.clientX, ev.clientY);
  else hideTip();
});
stage.addEventListener('mouseleave', hideTip);

// ---------- loop ----------

function sceneNow(): Scene {
  return {
    world: S.world,
    level: S.level,
    planetId: S.planetId,
    selId: S.selId,
    thresholds: S.thresholds,
    deleting: S.deleting,
    crowdedAt: S.crowdedAt,
    born: S.born,
  };
}

function frame(now: number) {
  const d = S.deleting;
  if (d) {
    const e = now - d.t0;
    if (d.phase === 'shock' && e > 900) S.deleting = { ...d, phase: 'shake', t0: now };
    else if (d.phase === 'shake' && e > 1400) {
      S.deleting = null;
      finishDelete(d, now * 0.4);
      ui();
    }
  }
  renderer.frame(sceneNow(), now);
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => renderer.resize());

// ---------- backend sync ----------

events.onWorld((w) => {
  S.world = w;
  ui();
});
events.onBlob((b) => {
  const i = S.world.blobs.findIndex((x) => x.id === b.id);
  if (i < 0) return;
  S.world.blobs[i] = b;
  ui();
});
events.onEntry(({ blobId, index, entry }) => {
  const list = S.transcripts.get(blobId) ?? [];
  list[index] = entry;
  S.transcripts.set(blobId, list);
  if (blobId === S.selId) drawPanel();
});
events.onMoonsDropped((ids) => say(`${ids.length} merged moon${ids.length > 1 ? 's' : ''} cleaned up`));

api.getState().then(({ world, settings }) => {
  S.world = world;
  S.thresholds = settings;
  S.crowdedAt = settings.crowdedAt ?? 4;
  S.planetId = world.planets[0]?.id ?? null;
  say(world.planets.length ? 'Arrows pick a planet, Enter zooms in, ? for keys' : 'Press a to add your first planet');
  ui();
}, fail);

stage.focus();
requestAnimationFrame(frame);
