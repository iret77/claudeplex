#!/usr/bin/env bun
/**
 * Build standalone Claudeplex binaries for every supported target into ./dist.
 * Each binary embeds the Bun runtime, so end users need neither Bun nor Node.
 * Bun cross-compiles all targets from a single machine.
 *
 *   bun run build
 */
import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

const assetName = (target: string) => `claudeplex-${target.replace(/^bun-/, "")}`;

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

for (const target of TARGETS) {
  const out = `dist/${assetName(target)}`;
  console.log(`▸ building ${out}`);
  await $`bun build src/index.ts --compile --minify --target=${target} --outfile ${out}`;
}

console.log("✓ binaries written to ./dist");
