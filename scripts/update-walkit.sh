#!/bin/sh
# Refreshes packages/walkit-web, the walkit engine webamp draws its skins with, from a walkit
# checkout (WALKIT_DIR, else ../walkit next to this repository). Needs Rust with the wasm32
# target; building webamp afterwards does not.
set -eu
cd "$(dirname "$0")/.."
walkit=${WALKIT_DIR:-../walkit}
[ -x "$walkit/tools/web-pack.sh" ] || { echo "no walkit checkout at $walkit" >&2; exit 2; }
rm -rf packages/walkit-web
"$walkit/tools/web-pack.sh" "$PWD/packages/walkit-web"
echo "$(git -C "$walkit" rev-parse HEAD)" > packages/walkit-web/WALKIT_COMMIT
