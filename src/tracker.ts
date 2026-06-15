/**
 * Cross-refresh state tracking: remembers each session's last state so the UI
 * can flash a row when it transitions, and so we can emit a macOS notification
 * when a session finishes a turn (aktiv → wartet) and is waiting for input.
 *
 * State is module-global on purpose — the render layer reads `isFlashing()`
 * while the loop calls `updateStates()` once per data refresh; both share this
 * single map without threading it through params.
 */
import type { InstanceState } from "./collect.ts";

export type SessState = "aktiv" | "monitor" | "wartet" | "stale";

const FLASH_MS = 1800;

interface Track {
  state: SessState;
  flashUntil: number;
}

const tracks = new Map<string, Track>();

export interface Transition {
  sessionId: string;
  title: string;
  folder: string;
  instance: string;
  from: SessState;
  to: SessState;
}

/**
 * Reconcile tracked state with a fresh collection. Returns the transitions that
 * just happened (empty on first sight of a session, so startup doesn't flash
 * everything). Sets a flash window on any changed session.
 */
export function updateStates(states: InstanceState[], now: number): Transition[] {
  const transitions: Transition[] = [];
  const seen = new Set<string>();
  for (const inst of states) {
    for (const ss of inst.sessions) {
      seen.add(ss.sessionId);
      const to = ss.state;
      const prev = tracks.get(ss.sessionId);
      if (!prev) {
        tracks.set(ss.sessionId, { state: to, flashUntil: 0 });
        continue;
      }
      if (prev.state !== to) {
        transitions.push({
          sessionId: ss.sessionId,
          title: ss.title || "(ohne Titel)",
          folder: ss.cwd,
          instance: inst.def.label,
          from: prev.state,
          to,
        });
        prev.state = to;
        prev.flashUntil = now + FLASH_MS;
      }
    }
  }
  // prune sessions that dropped out of the window so the map stays small
  if (tracks.size > 400) {
    for (const id of tracks.keys()) if (!seen.has(id)) tracks.delete(id);
  }
  return transitions;
}

export function isFlashing(sessionId: string, now: number): boolean {
  const t = tracks.get(sessionId);
  return !!t && now < t.flashUntil;
}
