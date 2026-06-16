#!/bin/sh
# Claudeplex installer — downloads the standalone binary for your platform from
# the latest GitHub Release. No Bun/Node required.
#
#   curl -fsSL https://raw.githubusercontent.com/iret77/claudeplex/main/install.sh | sh
set -e

REPO="iret77/claudeplex"
BIN="claudeplex"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "claudeplex: unsupported OS '$os'" >&2; exit 1 ;;
esac

case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "claudeplex: unsupported architecture '$arch'" >&2; exit 1 ;;
esac

asset="claudeplex-${os}-${arch}"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

# Prefer a system bin dir if writable, else a per-user one.
if [ -w /usr/local/bin ] 2>/dev/null; then
  dir="/usr/local/bin"
else
  dir="${HOME}/.local/bin"
fi
mkdir -p "$dir"

echo "claudeplex: downloading ${asset}"
curl -fsSL "$url" -o "${dir}/${BIN}"
chmod +x "${dir}/${BIN}"
echo "claudeplex: installed to ${dir}/${BIN}"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "claudeplex: add ${dir} to your PATH to run 'claudeplex'" ;;
esac
