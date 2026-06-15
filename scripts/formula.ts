#!/usr/bin/env bun
/**
 * Render the Homebrew formula for a release from its SHA256SUMS file.
 *   bun run scripts/formula.ts <version> <path/to/SHA256SUMS.txt>
 * Emits Formula/claudeplex.rb on stdout. Used by the release workflow to bump
 * the byte5ai/homebrew-tap formula automatically.
 */
const [version, sumsPath] = process.argv.slice(2);
if (!version || !sumsPath) {
  console.error("usage: formula.ts <version> <SHA256SUMS path>");
  process.exit(1);
}

const sums = new Map<string, string>();
for (const line of (await Bun.file(sumsPath).text()).trim().split("\n")) {
  const [sha, name] = line.trim().split(/\s+/);
  if (sha && name) sums.set(name, sha);
}

const sha = (target: string): string => {
  const s = sums.get(`claudeplex-${target}`);
  if (!s) throw new Error(`missing sha256 for claudeplex-${target}`);
  return s;
};
const url = (target: string): string =>
  `https://github.com/byte5ai/claudeplex/releases/download/v${version}/claudeplex-${target}`;

process.stdout.write(`class Claudeplex < Formula
  desc "Terminal multiplexer and cockpit for Claude Code"
  homepage "https://github.com/byte5ai/claudeplex"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${url("darwin-arm64")}"
      sha256 "${sha("darwin-arm64")}"
    end
    on_intel do
      url "${url("darwin-x64")}"
      sha256 "${sha("darwin-x64")}"
    end
  end

  on_linux do
    on_arm do
      url "${url("linux-arm64")}"
      sha256 "${sha("linux-arm64")}"
    end
    on_intel do
      url "${url("linux-x64")}"
      sha256 "${sha("linux-x64")}"
    end
  end

  def install
    bin.install Dir["claudeplex-*"].first => "claudeplex"
  end

  test do
    system bin/"claudeplex", "--json"
  end
end
`);
