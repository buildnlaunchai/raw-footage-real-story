#!/usr/bin/env bash
#
# Fetch the fonts that captions are drawn in.
#
# Bundled rather than borrowed from the machine, because the machine's fonts do
# not work. Two things were learned the hard way:
#
#   1. libass — what ffmpeg's `subtitles` filter uses — does no complex shaping
#      in the builds people actually have. Bengali vowel signs land after their
#      consonant (ভেতরের renders ভতেররে), Arabic letters do not join, Devanagari
#      does not reorder. Every font produced the same wrong output, so the text
#      is drawn with `drawtext` instead, which shapes correctly.
#
#   2. `drawtext` shapes correctly only from a plain `.ttf`. Handed one of
#      macOS's `.ttc` collections — which is what every Bengali font on a Mac
#      is — it loses the shaping tables and produces the same mess. Kalpurush,
#      a standalone `.ttf`, worked; Bangla Sangam MN and Bangla MN did not.
#
# So: a `.ttf` per script, shipped with the app. Noto because it is under the
# SIL Open Font License, which permits redistribution — Apple's system fonts do
# not, whatever they render like.
#
# Pinned by size and SHA-256. A font that silently changes changes every
# caption in every video anybody renders.
#
#   ./scripts/fetch-fonts.sh          fetch what is missing or wrong
#   ./scripts/fetch-fonts.sh --force  fetch everything again
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$here/src-tauri/resources/fonts"
base="https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts"

# name|bytes|sha256
FONTS=(
  "NotoSans|621572|478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823"
  "NotoSansBengali|143072|b55c62ee531e3214da6c0701daecea89a52ba42db7d8206b92e6b51f397a3193"
  "NotoSansDevanagari|244284|306b53ecfb182a504dd8a7446093c316387d2fd8dc350d0792ed1753fe0996cd"
  "NotoSansArabic|234892|bdff3e5659d67e67def05b33f749683b9376ae819d65d3dd62ac4640b3aaef48"
  "NotoSansThai|37780|61cf814eec46b294d6ea4401ac295d0cecd5207bd2331dcc5a15e7301d30ee44"
)

digest() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

mkdir -p "$dest"
force="${1:-}"

for entry in "${FONTS[@]}"; do
  IFS='|' read -r name bytes sha <<<"$entry"
  file="$dest/$name-Regular.ttf"

  if [ "$force" != "--force" ] && [ -f "$file" ]; then
    if [ "$(wc -c <"$file" | tr -d ' ')" = "$bytes" ] && [ "$(digest "$file")" = "$sha" ]; then
      echo "  ok       $name"
      continue
    fi
    echo "  stale    $name — refetching"
  fi

  echo "  fetching $name"
  curl -fsSL --retry 3 -o "$file.tmp" "$base/$name/hinted/ttf/$name-Regular.ttf"

  got_bytes="$(wc -c <"$file.tmp" | tr -d ' ')"
  got_sha="$(digest "$file.tmp")"
  if [ "$got_bytes" != "$bytes" ] || [ "$got_sha" != "$sha" ]; then
    rm -f "$file.tmp"
    echo "  MISMATCH $name: expected $bytes/$sha, got $got_bytes/$got_sha" >&2
    exit 1
  fi
  mv "$file.tmp" "$file"
done

# The licence travels with the fonts. OFL requires it.
cat >"$dest/LICENSE.md" <<'EOF'
# Fonts

The `Noto Sans` families here are Copyright the Noto Project Authors
(https://github.com/notofonts), licensed under the SIL Open Font License,
Version 1.1: https://openfontlicense.org

They are redistributed unmodified. They are used only to draw subtitles into
rendered video; no font file is embedded in the output.

Fetched by `scripts/fetch-fonts.sh`, which pins each file by size and SHA-256.
EOF

echo "fonts ready in resources/fonts"
