#!/bin/sh
# Codesign + notarize the macOS Claudeplex binaries. RUN THIS ON A MAC — the
# Developer ID certificate lives in your login keychain, not on the build host.
#
# Why this exists: binaries installed via `curl … | sh` are NOT quarantined, so
# Gatekeeper never prompts for them. Signing + notarization only matters for
# browser downloads / double-clicked binaries. Do it if you want that path clean.
#
# Order matters: we sign BEFORE recomputing checksums, because signing rewrites
# the Mach-O (so SHA256SUMS and the Homebrew formula sha256 must come AFTER).
# A bare executable can't be stapled; notarization is verified online on first run.
#
# Usage (from the repo root, after `bun run build`):
#   SIGN_IDENTITY="Developer ID Application: High5 Ventures GmbH (TEAMID)" \
#   NOTARY_PROFILE="high5" \
#   sh scripts/sign-macos.sh
#
# One-time notary credential setup (stores an App Store Connect key in keychain):
#   xcrun notarytool store-credentials high5 \
#     --key AuthKey_XXXX.p8 --key-id <KEY_ID> --issuer <ISSUER_UUID>
set -e

case "$(uname -s)" in
  Darwin) ;;
  *) echo "sign-macos: must run on macOS (codesign/notarytool are Apple-only)" >&2; exit 1 ;;
esac

DIST="${DIST:-dist}"
TARGETS="claudeplex-darwin-arm64 claudeplex-darwin-x64"

if [ -z "${SIGN_IDENTITY:-}" ]; then
  echo "sign-macos: set SIGN_IDENTITY to your Developer ID Application identity." >&2
  echo "  Available signing identities on this Mac:" >&2
  security find-identity -v -p codesigning >&2 || true
  exit 1
fi

for bin in $TARGETS; do
  path="$DIST/$bin"
  [ -f "$path" ] || { echo "sign-macos: missing $path (run 'bun run build' first)" >&2; exit 1; }
  echo "▸ signing $bin"
  # --options runtime = hardened runtime (required for notarization); --timestamp = secure timestamp
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$path"
  codesign --verify --strict --verbose=2 "$path"
done

if [ -n "${NOTARY_PROFILE:-}" ]; then
  for bin in $TARGETS; do
    path="$DIST/$bin"
    zip="$DIST/$bin.zip"
    echo "▸ notarizing $bin"
    ditto -c -k --keepParent "$path" "$zip"            # notarytool wants an archive
    xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
    rm -f "$zip"
    echo "  notarized (bare executables can't be stapled; Gatekeeper checks online)"
  done
else
  echo "sign-macos: NOTARY_PROFILE unset — signed but NOT notarized."
  echo "  (curl|sh installs are fine unsigned; notarize for browser/double-click downloads.)"
fi

echo "▸ recomputing checksums (signing changed the bytes)"
( cd "$DIST" && shasum -a 256 claudeplex-* > SHA256SUMS.txt && cat SHA256SUMS.txt )

echo "✓ done. Re-upload the signed darwin binaries + SHA256SUMS.txt to the release,"
echo "  then regenerate the Homebrew formula from the new sums:"
echo "    bun run scripts/formula.ts <version> $DIST/SHA256SUMS.txt"
