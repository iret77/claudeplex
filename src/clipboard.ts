/**
 * Read an image from the macOS clipboard (e.g. a screenshot) and return it as
 * base64 PNG, the way claude-cli ingests pasted images. Terminals don't deliver
 * image bytes over stdin, so we pull the clipboard directly via osascript.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, rmSync } from "node:fs";

export interface ClipImage {
  mediaType: string;
  data: string; // base64
}

let counter = 0;

export function readClipboardImage(): ClipImage | null {
  const tmp = join(tmpdir(), `cd-paste-${process.pid}-${counter++}.png`);
  // AppleScript: write clipboard PNG to a temp file; "ok" on success, "no" if
  // the clipboard holds no image.
  const lines = [
    "try",
    "set d to (the clipboard as «class PNGf»)",
    `set f to (open for access (POSIX file "${tmp}") with write permission)`,
    "write d to f",
    "close access f",
    'return "ok"',
    "on error",
    "try",
    `close access (POSIX file "${tmp}")`,
    "end try",
    'return "no"',
    "end try",
  ];
  const args = ["osascript"];
  for (const l of lines) args.push("-e", l);

  try {
    const r = Bun.spawnSync(args);
    const out = r.stdout.toString().trim();
    if (out !== "ok" || !existsSync(tmp)) return null;
    const buf = readFileSync(tmp);
    rmSync(tmp, { force: true });
    if (!buf.length) return null;
    return { mediaType: "image/png", data: buf.toString("base64") };
  } catch {
    return null;
  }
}
