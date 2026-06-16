/**
 * SSH/SFTP IO for the Commander's file pane (Ebene 1) and shell-out. The local
 * host is served from the Node fs directly (no hop); remote hosts go over ssh.
 *
 * Listings use GNU `find -printf` (the dev hosts are Linux) for a clean,
 * unambiguous, parseable format — far safer than scraping `ls`. Copies are scp
 * (`scp -3` bridges host↔host through the client). Shell-out hands index.ts an
 * argv to exec while the TUI is suspended, giving a real remote PTY.
 */
import { readdirSync, statSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Host } from "./hosts.ts";
import { isLocal, sshTarget } from "./hosts.ts";

export interface FsEntry {
  name: string;
  type: "dir" | "file" | "link" | "other";
  size: number;
  mtime: number; // epoch ms
}

/** Single-quote a string for safe interpolation into a remote shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Common ssh options: no prompts that would hang the TUI, fast fail. */
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new"];

function sshArgs(host: Host): string[] {
  const a = [...SSH_OPTS];
  if (host.port) a.push("-p", String(host.port));
  a.push(sshTarget(host));
  return a;
}

/** ssh connection args (opts + port + target), without the leading "ssh". */
export function sshConn(host: Host): string[] {
  return sshArgs(host);
}

/**
 * Run a shell command string on a host and capture it. Local runs via the user's
 * shell; remote goes over ssh (the command is parsed by the remote shell, so
 * callers must shell-quote any embedded paths). Used for the remote supervisor.
 */
export async function runOn(host: Host, command: string): Promise<{ ok: boolean; out: string; err: string }> {
  const argv = isLocal(host) ? ["bash", "-lc", command] : ["ssh", ...sshArgs(host), command];
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, out, err };
  } catch (e: any) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}

const typeOf = (y: string): FsEntry["type"] =>
  y === "d" ? "dir" : y === "f" ? "file" : y === "l" ? "link" : "other";

/** List a directory's immediate children (dirs first, then case-insensitive name). */
export async function listDir(host: Host, path: string): Promise<FsEntry[]> {
  const entries = isLocal(host) ? listLocal(path) : await listRemote(host, path);
  entries.sort((a, b) => {
    const ad = a.type === "dir" ? 0 : 1;
    const bd = b.type === "dir" ? 0 : 1;
    return ad - bd || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return entries;
}

function listLocal(path: string): FsEntry[] {
  const out: FsEntry[] = [];
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    try {
      const ls = lstatSync(full);
      let type: FsEntry["type"] = ls.isSymbolicLink() ? "link" : ls.isDirectory() ? "dir" : ls.isFile() ? "file" : "other";
      let size = ls.size;
      if (type === "link") {
        try {
          const st = statSync(full); // resolve to mark link-to-dir as navigable
          if (st.isDirectory()) type = "dir";
          size = st.size;
        } catch {
          /* dangling link */
        }
      }
      out.push({ name, type, size, mtime: ls.mtimeMs });
    } catch {
      /* unreadable entry */
    }
  }
  return out;
}

async function listRemote(host: Host, path: string): Promise<FsEntry[]> {
  // %y type · %s size · %T@ mtime(epoch.frac) · %f basename — NUL-record safe via \n + tab
  const remote = `find ${shellQuote(path)} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null`;
  const proc = Bun.spawn(["ssh", ...sshArgs(host), remote], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !out) throw new Error(err.trim() || `ssh exited ${code}`);
  const entries: FsEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [y, size, mt, ...rest] = line.split("\t");
    const name = rest.join("\t");
    if (!name) continue;
    entries.push({ name, type: typeOf(y), size: Number(size) || 0, mtime: Math.round(Number(mt) * 1000) || 0 });
  }
  return entries;
}

export interface CopyEndpoint {
  host: Host;
  path: string; // absolute path of the file/dir to copy (src) or destination dir (dst)
}

/** scp-style destination token for a host (alias-aware). */
function scpToken(host: Host, path: string): string {
  return isLocal(host) ? path : `${sshTarget(host)}:${path}`;
}

/**
 * Copy a file/dir from one endpoint to a directory on another. Local→local uses
 * cp; anything involving a remote uses scp (`-3` so host↔host streams through the
 * client without a direct peer connection). Recursive for directories.
 */
export async function copyEntry(src: CopyEndpoint, dstDir: CopyEndpoint): Promise<{ ok: boolean; error?: string }> {
  const bothLocal = isLocal(src.host) && isLocal(dstDir.host);
  let argv: string[];
  if (bothLocal) {
    argv = ["cp", "-a", src.path, dstDir.path];
  } else {
    const portFlags = src.host.port || dstDir.host.port ? ["-P", String(src.host.port || dstDir.host.port)] : [];
    argv = ["scp", "-3", "-r", "-q", ...SSH_OPTS, ...portFlags, scpToken(src.host, src.path), scpToken(dstDir.host, dstDir.path) + "/"];
  }
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return code === 0 ? { ok: true } : { ok: false, error: err.trim() || `exit ${code}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Default starting directory for a host's file pane (sync best-effort). */
export function homePath(host: Host): string {
  return isLocal(host) ? homedir() : "/";
}

/** Resolve a host's home to an ABSOLUTE path so navigation + quoting stay clean. */
export async function resolveHome(host: Host): Promise<string> {
  if (isLocal(host)) return homedir();
  try {
    const proc = Bun.spawn(["ssh", ...sshArgs(host), "pwd"], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const p = out.trim().split("\n").pop() ?? "";
    return code === 0 && p.startsWith("/") ? p : "/";
  } catch {
    return "/";
  }
}

/** POSIX path join + ".." normalization (remote paths are POSIX). */
export function pathJoin(base: string, name: string): string {
  if (name === "..") {
    const i = base.replace(/\/+$/, "").lastIndexOf("/");
    return i <= 0 ? "/" : base.replace(/\/+$/, "").slice(0, i);
  }
  return (base === "/" ? "" : base.replace(/\/+$/, "")) + "/" + name;
}

export interface ShellOutSpec {
  /** working dir to land in (remote or local) */
  cwd?: string;
  /** attach to this tmux session instead of a plain login shell */
  tmux?: string;
  /** resume a specific claude session id */
  resume?: string;
  /** config dir to pin (for claude --resume on the right account) */
  configDir?: string;
}

/**
 * Build the argv to exec for a real interactive PTY. index.ts suspends the TUI,
 * runs this with inherited stdio, and re-enters on exit. `ssh -t` forces a PTY;
 * for the local host we exec the command directly.
 */
export function shellOutArgv(host: Host, spec: ShellOutSpec = {}): string[] {
  // the remote command to run inside the PTY
  let inner: string;
  if (spec.tmux) {
    inner = `tmux attach -t ${shellQuote(spec.tmux)}`;
  } else if (spec.resume) {
    const env = spec.configDir ? `CLAUDE_CONFIG_DIR=${shellQuote(spec.configDir)} ` : "";
    const cd = spec.cwd ? `cd ${shellQuote(spec.cwd)} && ` : "";
    inner = `${cd}${env}claude --resume ${shellQuote(spec.resume)}`;
  } else {
    inner = spec.cwd ? `cd ${shellQuote(spec.cwd)} && exec "$SHELL" -l` : `exec "$SHELL" -l`;
  }

  if (isLocal(host)) return ["bash", "-lc", inner];
  return ["ssh", "-t", ...sshArgs(host), inner];
}
