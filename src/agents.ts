/**
 * AgentRegistry: owns every ManagedAgent the dashboard has spawned. Provides
 * launch / resume / start-all / restart and lookup by session id so the
 * read-only collector can mark a monitored session as "managed" (✎) when its id
 * matches a live agent we drive.
 */
import { ManagedAgent, type AgentOpts } from "./agent.ts";
import type { InstanceDef } from "./instances.ts";

export class AgentRegistry {
  private agents = new Map<string, ManagedAgent>(); // by launchId
  private counter = 0;

  list(): ManagedAgent[] {
    return [...this.agents.values()];
  }

  get(launchId: string): ManagedAgent | undefined {
    return this.agents.get(launchId);
  }

  bySession(sessionId: string): ManagedAgent | undefined {
    if (!sessionId) return undefined;
    for (const a of this.agents.values()) if (a.sessionId === sessionId) return a;
    return undefined;
  }

  /**
   * Find a live agent that already represents this session — either its own id
   * or the original id it was resumed/forked from. Lets "enter a session" reuse
   * the existing agent instead of spawning a duplicate fork on every Enter.
   */
  forSession(sessionId: string): ManagedAgent | undefined {
    if (!sessionId) return undefined;
    for (const a of this.agents.values()) {
      if (a.state === "dead") continue;
      if (a.sessionId === sessionId || a.opts.resume === sessionId) return a;
    }
    return undefined;
  }

  byInstance(key: string): ManagedAgent[] {
    return this.list().filter((a) => a.opts.instanceKey === key && a.state !== "dead");
  }

  /** Custom display names, keyed by session id — also fed to the native --name. */
  private names = new Map<string, string>();

  rename(sessionId: string, name: string): void {
    const n = name.trim();
    if (sessionId && n) this.names.set(sessionId, n);
    else if (sessionId) this.names.delete(sessionId);
  }

  nameOverride(sessionId: string): string | undefined {
    return sessionId ? this.names.get(sessionId) : undefined;
  }

  /** Native session name: custom override if set, else "dash <key> <folder>". */
  private nameFor(def: InstanceDef, cwd: string, sessionId?: string): string {
    const override = sessionId ? this.names.get(sessionId) : undefined;
    if (override) return override;
    const base = cwd.replace(/\/+$/, "").split("/").pop() || "~";
    return `dash ${def.key} ${base}`;
  }

  private spawn(opts: AgentOpts): ManagedAgent {
    const id = `L${++this.counter}`;
    const a = new ManagedAgent(opts, id);
    this.agents.set(id, a);
    a.start();
    return a;
  }

  /** Launch a fresh, native-resumable agent (own session id + display name). */
  launch(def: InstanceDef, cwd: string): ManagedAgent {
    const desiredId = crypto.randomUUID();
    return this.spawn({
      configDir: def.configDir, cwd, instanceKey: def.key,
      desiredId, name: this.nameFor(def, cwd, desiredId),
    });
  }

  /** Continue an existing session IN PLACE (same id). */
  resume(def: InstanceDef, sessionId: string, cwd: string): ManagedAgent {
    // Do NOT set a generic --name here: claude's --name overwrites the real
    // session title. Only pass a name if the user explicitly renamed it.
    const name = this.names.get(sessionId);
    return this.spawn({ configDir: def.configDir, cwd, instanceKey: def.key, resume: sessionId, name });
  }

  /** One agent per instance. Skips instances that already have a live agent. */
  startAll(defs: InstanceDef[], cwdFor: (def: InstanceDef) => string): ManagedAgent[] {
    const started: ManagedAgent[] = [];
    for (const def of defs) {
      if (this.byInstance(def.key).length > 0) continue;
      started.push(this.launch(def, cwdFor(def)));
    }
    return started;
  }

  /**
   * Restart an agent so it picks up newly installed plugins/MCP/skills. Resumes
   * the same session id (forked) so the conversation history is preserved.
   */
  restart(a: ManagedAgent): ManagedAgent {
    const resume = a.sessionId || a.opts.resume;
    a.kill();
    this.agents.delete(a.launchId);
    const name = (resume && this.names.get(resume)) || a.opts.name;
    return this.spawn({ ...a.opts, resume, desiredId: undefined, name });
  }

  killAll(): void {
    for (const a of this.agents.values()) a.kill();
    this.agents.clear();
  }
}
