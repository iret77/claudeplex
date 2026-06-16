/**
 * ManagedAgent: one headless `claude -p` process the dashboard owns and drives.
 *
 * It is spawned with the OWNING INSTANCE's CLAUDE_CONFIG_DIR so it authenticates
 * via that subscription's OAuth login (we have 4 separate logins — input must
 * route to the right one). We scrub ANTHROPIC_API_KEY so it can never fall back
 * to a pay-per-use key instead of the subscription, and scrub CLAUDECODE so the
 * child isn't treated as a nested session.
 *
 * Input goes in via stdin (stream-json); output is parsed from stdout into a
 * live render buffer the dashboard shows in real time.
 */
import { join } from "node:path";
import { userLine, parseEvent, type ParsedEvent } from "./stream.ts";
import { ICONS } from "./ui.ts";

export type AgentState = "starting" | "ready" | "busy" | "dead";

export interface AgentLine {
  role: "user" | "assistant" | "tool" | "result" | "system";
  text: string;
}

export interface AgentOpts {
  /** owning instance config dir — selects the subscription login */
  configDir: string;
  /** working directory for the session */
  cwd: string;
  /** resume an existing session id IN PLACE (same id — caller takes it over) */
  resume?: string;
  /** for a fresh agent: the session id to create (so it's known + native-resumable) */
  desiredId?: string;
  /** display name shown in the native /resume picker + terminal title */
  name?: string;
  /** instance key, for labelling */
  instanceKey: string;
  /** default account → spawn with CLAUDE_CONFIG_DIR unset (don't override the login) */
  isDefault?: boolean;
}

const MAX_LINES = 2000;

export class ManagedAgent {
  readonly opts: AgentOpts;
  /** launch id — stable handle before the real session id is known */
  readonly launchId: string;
  sessionId = ""; // filled from the init event
  state: AgentState = "starting";
  model = "";
  ctxTokens = 0; // context-window fill of the latest turn
  outTokens = 0; // cumulative output tokens
  costUsd = 0; // cumulative session cost (USD)
  error = "";

  /** committed transcript lines */
  readonly lines: AgentLine[] = [];
  /** in-flight streaming assistant text (deltas not yet committed) */
  pending = "";
  /** monotonically bumped whenever the buffer changes — render dirty flag */
  rev = 0;

  private proc: import("bun").Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private sink: import("bun").FileSink | null = null;
  private stderrBuf: string[] = [];

  constructor(opts: AgentOpts, launchId: string) {
    this.opts = opts;
    this.launchId = launchId;
    // we know the id up front (resume in place, or our own --session-id)
    this.sessionId = opts.resume || opts.desiredId || "";
  }

  /**
   * Path to this session's transcript .jsonl — the resumed agent appends to the
   * same file, so reading it shows the FULL prior conversation + new turns.
   * cwd is the launch/project dir (we keep the first transcript cwd), so its
   * mangle matches the project dir Claude files the session under.
   */
  get transcriptPath(): string {
    if (!this.sessionId) return "";
    // Claude sanitizes the cwd to its project-dir name by replacing every
    // non-alphanumeric char with "-" (so "/", ".", "+" etc. all become "-").
    const proj = this.opts.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    return join(this.opts.configDir, "projects", proj, `${this.sessionId}.jsonl`);
  }

  /** Build a scrubbed child env that pins the login and avoids nesting. */
  private childEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.ANTHROPIC_API_KEY; // force subscription OAuth, not an API key
    delete env.CLAUDECODE; // don't look like a nested claude session
    delete env.CLAUDE_CODE_ENTRYPOINT;
    // the default account lives at ~/.claude.json (CLAUDE_CONFIG_DIR unset);
    // setting it to ~/.claude would make claude lose that login.
    if (this.opts.isDefault) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = this.opts.configDir;
    return env;
  }

  private argv(): string[] {
    const a = [
      "claude",
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose", // required by Claude Code for --print + stream-json output
      "--dangerously-skip-permissions",
    ];
    if (this.opts.name) a.push("--name", this.opts.name); // visible in native /resume picker
    if (this.opts.resume) a.push("--resume", this.opts.resume); // SAME id (caller took it over)
    else if (this.opts.desiredId) a.push("--session-id", this.opts.desiredId);
    return a;
  }

  start(): void {
    if (this.proc) return;
    try {
      this.proc = Bun.spawn(this.argv(), {
        cwd: this.opts.cwd,
        env: this.childEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      this.state = "dead";
      this.error = String(e);
      this.commit("system", `spawn failed: ${this.error}`);
      return;
    }
    this.sink = this.proc.stdin as unknown as import("bun").FileSink;
    this.commit("system", `agent starting in ${this.opts.cwd}`);
    this.readStdout();
    this.readStderr();
    this.proc.exited.then((code) => {
      this.state = "dead";
      // surface claude's own stderr so a code-1 exit shows the real reason,
      // not just the EPIPE we get from writing into a dead pipe afterwards
      if (code && this.stderrBuf.length) {
        for (const l of this.stderrBuf.slice(-6)) this.commit("result", `stderr: ${l}`);
      }
      this.commit("system", `agent exited (code ${code})`);
    });
  }

  private async readStdout(): Promise<void> {
    if (!this.proc?.stdout) return;
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) this.onEvent(parseEvent(line));
        }
      }
    } catch {
      /* stream closed */
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.proc?.stderr) return;
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of this.proc.stderr as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) {
            this.stderrBuf.push(line);
            if (this.stderrBuf.length > 50) this.stderrBuf.shift();
            this.error = line; // keep the latest diagnostic
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  private onEvent(ev: ParsedEvent | null): void {
    if (!ev) return;
    switch (ev.kind) {
      case "init":
        if (ev.sessionId) this.sessionId = ev.sessionId;
        if (ev.model) this.model = ev.model;
        if (this.state === "starting") this.state = "ready";
        this.touch();
        break;
      case "delta":
        if (ev.text) {
          this.pending += ev.text;
          this.touch();
        }
        break;
      case "assistant":
        // commit authoritative final content, drop the streamed preview
        this.pending = "";
        if (ev.assistantText) this.commit("assistant", ev.assistantText);
        for (const t of ev.tools ?? []) this.commit("tool", t.summary);
        if (ev.model) this.model = ev.model;
        if (typeof ev.ctxTokens === "number") this.ctxTokens = ev.ctxTokens;
        break;
      case "result":
        this.pending = "";
        if (typeof ev.ctxTokens === "number" && ev.ctxTokens > 0) this.ctxTokens = ev.ctxTokens;
        if (typeof ev.outTokens === "number") this.outTokens += ev.outTokens;
        if (typeof ev.costUsd === "number") this.costUsd = ev.costUsd; // total_cost_usd is cumulative
        if (ev.isError && ev.resultText) this.commit("result", `error: ${ev.resultText}`);
        this.state = this.state === "dead" ? "dead" : "ready";
        this.touch();
        break;
      default:
        break; // "user"/"other" are noise for the live view
    }
  }

  private commit(role: AgentLine["role"], text: string): void {
    const t = text.replace(/\r/g, "").trimEnd();
    if (!t) return;
    this.lines.push({ role, text: t });
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.touch();
  }

  private touch(): void {
    this.rev++;
  }

  /** Send a user message / slash command (optionally with pasted images). */
  send(text: string, images?: { mediaType: string; data: string }[]): boolean {
    const t = text.trim();
    if ((!t && !images?.length) || !this.sink || this.state === "dead") return false;
    this.commit("user", t + (images?.length ? ` ${ICONS.attach.repeat(images.length)}` : ""));
    this.state = "busy";
    try {
      this.sink.write(userLine(t, images));
      this.sink.flush();
      this.touch();
      return true;
    } catch (e) {
      this.error = String(e);
      return false;
    }
  }

  kill(): void {
    try {
      this.sink?.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.state = "dead";
  }
}
