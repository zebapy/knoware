// Typed wrappers over the Tauri commands and events in src-tauri/src/lib.rs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Blob, Entry, Settings, World } from './types';

/** A newly made blob's id plus the world that already contains it. */
export interface Created {
  id: string;
  world: World;
}

export const api = {
  getState: () => invoke<{ world: World; settings: Settings }>('get_state'),
  getTranscript: (blobId: string) => invoke<Entry[]>('get_transcript', { blobId }),
  addPlanet: (path: string) => invoke<Created>('add_planet', { path }),
  removePlanet: (planetId: string) => invoke<void>('remove_planet', { planetId }),
  spawnBlob: (planetId: string, moonId: string | null) => invoke<Created>('spawn_blob', { planetId, moonId }),
  newMoon: (planetId: string, branch: string) => invoke<Created>('new_moon', { planetId, branch }),
  deleteMoon: (moonId: string, force: boolean) => invoke<void>('delete_moon', { moonId, force }),
  deleteBlob: (blobId: string) => invoke<void>('delete_blob', { blobId }),
  prompt: (blobId: string, text: string) => invoke<void>('prompt', { blobId, text }),
  wake: (blobId: string) => invoke<void>('wake', { blobId }),
  fork: (blobId: string) => invoke<Created>('fork_blob', { blobId }),
  cancel: (blobId: string) => invoke<void>('cancel', { blobId }),
  answerPermission: (blobId: string, optionId: string | null) => invoke<void>('answer_permission', { blobId, optionId }),
  refreshSignals: () => invoke<void>('refresh_signals'),
  discoverSessions: () => invoke<void>('discover_sessions'),
};

export const events = {
  onWorld: (f: (w: World) => void) => listen<World>('world', (e) => f(e.payload)),
  onBlob: (f: (b: Blob) => void) => listen<Blob>('blob', (e) => f(e.payload)),
  onEntry: (f: (e: { blobId: string; index: number; entry: Entry }) => void) =>
    listen<{ blobId: string; index: number; entry: Entry }>('entry', (e) => f(e.payload)),
  onMoonsDropped: (f: (ids: string[]) => void) => listen<string[]>('moons-dropped', (e) => f(e.payload)),
};
