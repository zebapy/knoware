import { describe, expect, it } from 'vitest';
import * as B from './biome';
import type { Planet, PlanetTraits } from './types';

const planet = (path: string, traits: Partial<PlanetTraits> = {}, isRepo = true): Planet => ({
  id: Math.random().toString(36),
  name: path,
  path,
  isRepo,
  traits: { language: 'rust', languagePct: 80, files: 300, commits: 120, ...traits },
});

describe('planet looks', () => {
  it('are deterministic per directory, whatever the id', () => {
    const a = B.look(planet('/src/api'));
    const b = B.look(planet('/src/api'));
    expect(a).toEqual(b);
    expect(B.look(planet('/src/web')).seed).not.toBe(a.seed);
  });

  it('pick a biome from the dominant language', () => {
    expect(B.look(planet('/a', { language: 'rust' })).biome).toBe('volcanic');
    expect(B.look(planet('/a', { language: 'typescript' })).biome).toBe('jungle');
    expect(B.look(planet('/a', { language: 'python' })).biome).toBe('ocean');
    expect(B.look(planet('/a', { language: 'go' })).biome).toBe('tundra');
    expect(B.look(planet('/a', { language: 'c' })).biome).toBe('toxic');
    expect(B.look(planet('/a', { language: 'ruby' })).biome).toBe('crystal');
  });

  it('make polyglot repos gas giants and plain folders barren', () => {
    expect(B.look(planet('/a', { languagePct: 20, files: 400 })).biome).toBe('gas');
    expect(B.look(planet('/notes', {}, false)).biome).toBe('barren');
  });

  it('fall back to a seeded biome for unknown languages', () => {
    const biomes = new Set(['/a', '/b', '/c', '/d', '/e', '/f', '/g'].map((p) => B.look(planet(p, { language: null })).biome));
    expect(biomes.size).toBeGreaterThan(1);
  });

  it('grow with repo size and wear rings with long history', () => {
    expect(B.look(planet('/a', { files: 20000 })).size).toBeGreaterThan(B.look(planet('/a', { files: 10 })).size);
    expect(B.look(planet('/a', { commits: 5000 })).ring).toBe(true);
    expect(B.look(planet('/a', { commits: 5 })).ring).toBe(false);
  });

  it('noise stays in range', () => {
    for (let i = 0; i < 200; i++) {
      const v = B.fbm(i * 0.37, i * 0.11, i * 0.73, 42);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
