#!/usr/bin/env bash
# Install the pinned surfpool release binary into .tools/surfpool/<version>/ (gitignored).
# CI and local runs use this same script, so both test against the same binary. No brew, no sudo:
# it downloads the official release asset and checks its sha256 before unpacking.
#
#   scripts/install-surfpool.sh            # prints the binary's path
#   FORKIT_SURFPOOL_BIN="$(scripts/install-surfpool.sh)" bun run test:svm
#
# To move the pin: change VERSION and the four sha256 sums below to the `digest` values GitHub
# lists for that release (gh release view <tag> -R solana-foundation/surfpool --json assets).
set -euo pipefail

VERSION="v1.6.1"
REPO="solana-foundation/surfpool"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET="surfpool-darwin-arm64.tar.gz"
    SHA256="fca0a1c75eca7cc848b8ff70f141c6fc6d39c11a781764d4840e001ea90172cc" ;;
  Darwin-x86_64) ASSET="surfpool-darwin-x64.tar.gz"
    SHA256="96cf61c8ac430f1dcd8eeff1fc74cf7a9d85752358d4316abf7636d8527fddcc" ;;
  Linux-x86_64) ASSET="surfpool-linux-x64.tar.gz"
    SHA256="64cff3fd6bb00bb0d5c7edef2915a491338d14eb19b7130abf9c81ee5357d165" ;;
  *) echo "install-surfpool: no ${VERSION} release asset for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${FORKIT_TOOLS_DIR:-$ROOT/.tools}/surfpool/${VERSION}"
BIN="$DIR/surfpool"

if [ -x "$BIN" ]; then
  echo "$BIN"
  exit 0
fi

mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
echo "install-surfpool: downloading ${URL}" >&2
curl -fsSL --retry 3 -o "$TMP/$ASSET" "$URL"

ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
if [ "$ACTUAL" != "$SHA256" ]; then
  echo "install-surfpool: sha256 mismatch for ${ASSET}: expected ${SHA256}, got ${ACTUAL}" >&2
  exit 1
fi

tar -xzf "$TMP/$ASSET" -C "$TMP"
FOUND="$(find "$TMP" -type f -name surfpool -perm -u+x | head -n 1)"
if [ -z "$FOUND" ]; then
  echo "install-surfpool: ${ASSET} has no surfpool binary" >&2
  exit 1
fi
mv "$FOUND" "$BIN"
chmod +x "$BIN"
echo "$BIN"
