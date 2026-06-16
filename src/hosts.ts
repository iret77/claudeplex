/**
 * Host registry — the Commander's "Ebene 0" (network neighbourhood). Unions three
 * sources and dedupes them: the user's ~/.ssh/config aliases, live Tailscale peers
 * (`tailscale status --json`, best-effort), and a manual list. The machine running
 * Claudeplex is always present as the "local" host. Pure discovery — no side
 * effects, no connections opened here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";

const HOME = homedir();

export type HostSource = "local" | "ssh-config" | "tailscale" | "manual";

export interface Host {
  /** display name / ssh alias */
  name: string;
  /** address to connect to (alias is fine — ssh resolves it via config) */
  hostname: string;
  user?: string;
  port?: number;
  source: HostSource;
  /** Tailscale online state when known; undefined for sources without liveness */
  online?: boolean;
  /** OS as reported by Tailscale, when known */
  os?: string;
}

/** Parse ~/.ssh/config into hosts. Wildcard patterns (Host *, ?) are skipped. */
function fromSshConfig(): Host[] {
  let text: string;
  try {
    text = readFileSync(join(HOME, ".ssh", "config"), "utf8");
  } catch {
    return [];
  }
  const out: Host[] = [];
  let aliases: string[] = [];
  let hostName = "";
  let user: string | undefined;
  let port: number | undefined;

  const flush = () => {
    for (const a of aliases) {
      if (a.includes("*") || a.includes("?")) continue; // patterns aren't connectable hosts
      out.push({ name: a, hostname: hostName || a, user, port, source: "ssh-config" });
    }
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(\w+)\s+(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "host") {
      flush();
      aliases = val.split(/\s+/);
      hostName = "";
      user = undefined;
      port = undefined;
    } else if (key === "hostname") {
      hostName = val;
    } else if (key === "user") {
      user = val;
    } else if (key === "port") {
      port = Number(val) || undefined;
    }
  }
  flush();
  return out;
}

/** Live Tailscale peers via `tailscale status --json` (best-effort, may be absent). */
function fromTailscale(): Host[] {
  let json: any;
  try {
    const r = Bun.spawnSync(["tailscale", "status", "--json"]);
    if (r.exitCode !== 0) return [];
    json = JSON.parse(r.stdout.toString());
  } catch {
    return [];
  }
  const peers = json?.Peer ?? {};
  const out: Host[] = [];
  for (const k of Object.keys(peers)) {
    const p = peers[k];
    const dns: string = (p.DNSName ?? "").replace(/\.$/, "");
    const name = dns.split(".")[0] || p.HostName || "";
    const addr = dns || (Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs[0] : "") || name;
    if (!name) continue;
    out.push({ name, hostname: addr, source: "tailscale", online: !!p.Online, os: p.OS });
  }
  return out;
}

/** Optional user-curated hosts: ~/.config/claudeplex/hosts.json (array of Host). */
function fromManual(): Host[] {
  try {
    const arr = JSON.parse(readFileSync(join(HOME, ".config", "claudeplex", "hosts.json"), "utf8"));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((h) => h && typeof h.name === "string" && typeof h.hostname === "string")
      .map((h) => ({ name: h.name, hostname: h.hostname, user: h.user, port: h.port, source: "manual" as const }));
  } catch {
    return [];
  }
}

/**
 * The full host list: local first, then ssh-config, Tailscale and manual hosts,
 * deduped by name (earlier sources win, but a later source can fill in liveness).
 */
export function discoverHosts(): Host[] {
  const local: Host = { name: hostname(), hostname: "localhost", source: "local", online: true };
  const all = [local, ...fromSshConfig(), ...fromManual(), ...fromTailscale()];
  const byName = new Map<string, Host>();
  for (const h of all) {
    const prev = byName.get(h.name);
    if (!prev) {
      byName.set(h.name, h);
    } else {
      // keep the first source, but adopt liveness/os info a later source provides
      if (prev.online === undefined && h.online !== undefined) prev.online = h.online;
      if (!prev.os && h.os) prev.os = h.os;
    }
  }
  return [...byName.values()];
}

/** Is this the local machine (no SSH hop needed)? */
export function isLocal(h: Host): boolean {
  return h.source === "local";
}

/** ssh destination string ("user@host"), alias-aware. */
export function sshTarget(h: Host): string {
  return h.user ? `${h.user}@${h.hostname}` : h.hostname;
}
