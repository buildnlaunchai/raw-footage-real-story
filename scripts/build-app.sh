#!/usr/bin/env bash
# Build the macOS app, and clear what stops it building.
#
# `tauri build` makes its DMG by attaching a scratch image, laying the app out
# inside it, and detaching. If a previous run was interrupted — or the DMG step
# failed for any other reason — that scratch volume stays mounted, and the next
# build dies in `bundle_dmg.sh` with a message that names neither the volume nor
# the cause:
#
#     failed to bundle project: error running bundle_dmg.sh
#
# The app itself has already been built and signed by then; only the DMG fails.
# So this detaches anything left over first, which is safe: these volumes are
# named `dmg.XXXXXX` and are the builder's own scratch space, never a disk
# somebody mounted on purpose.
#
#   ./scripts/build-app.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname)" == "Darwin" ]]; then
  # Scratch images the builder left behind, found by the image it was making
  # rather than by the mount point, so a volume that merely looks similar is
  # left alone.
  stale="$(hdiutil info | awk '
    /^image-path/ { path = $0 }
    /^\/dev\/disk[0-9]+[[:space:]]/ { if (path ~ /rw\..*\.dmg/) print $1 }
  ' || true)"
  for disk in $stale; do
    echo "→ detaching a scratch volume left by an earlier build: $disk"
    hdiutil detach "$disk" -force >/dev/null 2>&1 || true
  done
  rm -f src-tauri/target/release/bundle/macos/rw.*.dmg
fi

npm run tauri build "$@"
