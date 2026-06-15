# Homebrew formula for Claudeplex.
#
# This lives in the tap repo, not here — copy it to:
#   byte5ai/homebrew-tap → Formula/claudeplex.rb
# Then `brew install byte5ai/tap/claudeplex` works.
#
# On each release, bump `version`, the per-arch URLs, and the sha256 values
# (from the release's SHA256SUMS.txt). This file is a template; the
# REPLACE_WITH_* placeholders are filled by the release tooling.
class Claudeplex < Formula
  desc "Terminal multiplexer & cockpit for Claude Code — monitor & orchestrate Claude accounts"
  homepage "https://github.com/byte5ai/claudeplex"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/byte5ai/claudeplex/releases/download/v#{version}/claudeplex-darwin-arm64"
      sha256 "REPLACE_WITH_DARWIN_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/byte5ai/claudeplex/releases/download/v#{version}/claudeplex-darwin-x64"
      sha256 "REPLACE_WITH_DARWIN_X64_SHA256"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/byte5ai/claudeplex/releases/download/v#{version}/claudeplex-linux-arm64"
      sha256 "REPLACE_WITH_LINUX_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/byte5ai/claudeplex/releases/download/v#{version}/claudeplex-linux-x64"
      sha256 "REPLACE_WITH_LINUX_X64_SHA256"
    end
  end

  def install
    bin.install Dir["claudeplex-*"].first => "claudeplex"
  end

  test do
    # --json works headless and exits 0 even with no accounts configured.
    system "#{bin}/claudeplex", "--json"
  end
end
