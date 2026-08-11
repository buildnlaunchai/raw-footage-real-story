#!/usr/bin/env bash
#
# Fetch the Kokoro ONNX model.
#
# The model is 82MB and was in Git LFS, which put it on the wrong side of
# GitHub's free 1GB/month bandwidth allowance: every CI checkout on every
# platform pulled it, so a couple of releases a month exhausted the quota and a
# throttled LFS repo stops serving *everyone*. Fetching it from its actual
# source instead costs nothing and shrinks a clone from 114MB to about 5MB.
#
# The voice packs stay in LFS. They are 28MB and, unlike the model, are not
# published as a single addressable file anywhere convenient.
#
# Pinned by revision *and* checked by hash. The revision alone is not enough:
# the sibling repo `onnx-community/Kokoro-82M-ONNX` publishes a different file
# under the same name and nearly the same size, so a copy-paste error would
# produce a model that loads, speaks, and is not the one this was tuned against.
#
#   ./scripts/fetch-model.sh          fetch if missing or wrong
#   ./scripts/fetch-model.sh --force  fetch even if present and correct
#
set -euo pipefail

REPO="onnx-community/Kokoro-82M-v1.0-ONNX"
REVISION="1939ad2a8e416c0acfeecc08a694d14ef25f2231"
REMOTE_PATH="onnx/model_q8f16.onnx"
SHA256="04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0"
BYTES=86033585

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$here/src-tauri/resources/kokoro/model_q8f16.onnx"
url="https://huggingface.co/$REPO/resolve/$REVISION/$REMOTE_PATH"

digest() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1
  fi
}

if [ "${1:-}" != "--force" ] && [ -f "$dest" ]; then
  if [ "$(digest "$dest")" = "$SHA256" ]; then
    echo "model already present and verified"
    exit 0
  fi
  echo "model present but does not match the pinned hash; refetching"
fi

mkdir -p "$(dirname "$dest")"
echo "fetching $REPO @ ${REVISION:0:7}"

# To a temporary file first: a half-downloaded model at the real path would
# pass an "exists" check and fail much later, inside ONNX, as something that
# reads like a corrupt model rather than a truncated download.
tmp="$dest.partial"
trap 'rm -f "$tmp"' EXIT
curl --fail --location --show-error --silent --retry 3 --retry-delay 2 \
  --output "$tmp" "$url"

actual_bytes=$(wc -c < "$tmp" | tr -d ' ')
if [ "$actual_bytes" != "$BYTES" ]; then
  echo "FAIL  expected $BYTES bytes, got $actual_bytes" >&2
  exit 1
fi

actual_sha=$(digest "$tmp")
if [ "$actual_sha" != "$SHA256" ]; then
  echo "FAIL  checksum mismatch" >&2
  echo "  expected $SHA256" >&2
  echo "  got      $actual_sha" >&2
  exit 1
fi

mv "$tmp" "$dest"
trap - EXIT
echo "ok  $dest ($actual_bytes bytes, sha256 verified)"
