/**
 * Filesystem helpers for the working-folder picker: tilde expansion, directory
 * existence, and directory-name completion for an editable path field.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

export function expandTilde(p: string): string {
  const t = p.trim();
  if (t === "~") return HOME;
  if (t.startsWith("~/")) return HOME + t.slice(1);
  return t;
}

export function isDir(p: string): boolean {
  try {
    return statSync(expandTilde(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Directory suggestions for the current buffer. If the buffer ends in "/", list
 * that directory's subfolders; otherwise complete the last path segment against
 * its siblings. Recent cwds matching the fragment are surfaced first.
 */
export function dirSuggestions(buffer: string, recents: string[], limit = 8): string[] {
  const b = expandTilde(buffer);
  let baseDir: string;
  let frag: string;
  if (b.endsWith("/")) {
    baseDir = b;
    frag = "";
  } else {
    const i = b.lastIndexOf("/");
    baseDir = i >= 0 ? b.slice(0, i + 1) : "";
    frag = i >= 0 ? b.slice(i + 1) : b;
  }
  const fl = frag.toLowerCase();
  const out: string[] = [];

  // recent project folders matching the fragment come first
  for (const r of recents) {
    if (!r) continue;
    const seg = r.split("/").pop() ?? "";
    if (!fl || seg.toLowerCase().includes(fl) || r.toLowerCase().includes(fl)) {
      if (!out.includes(r)) out.push(r);
    }
  }

  // live filesystem completion of the current segment
  if (baseDir) {
    try {
      for (const name of readdirSync(baseDir)) {
        if (name.startsWith(".")) continue; // hide dotfolders by default
        if (fl && !name.toLowerCase().startsWith(fl)) continue;
        const full = join(baseDir, name);
        try {
          if (statSync(full).isDirectory() && !out.includes(full)) out.push(full);
        } catch {
          /* unreadable entry */
        }
      }
    } catch {
      /* baseDir not readable */
    }
  }
  return out.slice(0, limit);
}
