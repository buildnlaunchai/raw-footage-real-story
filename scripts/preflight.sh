#!/usr/bin/env bash
# preflight — TEMPLATE.md law 1 enforcement.
#
# Fails if a secret-shaped string is in the source, or if the code reads an env
# var that .env.example does not document. Run before any commit that ships.
#
#   ./scripts/preflight.sh
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
fail=0

SCAN_DIRS=(src src-tauri/src scripts)
EXCLUDES=(--exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist --exclude-dir=gen)

say()  { printf '%s\n' "$*"; }
bad()  { printf '%s%s%s\n' "$RED" "$*" "$OFF"; fail=1; }
ok()   { printf '%s%s%s\n' "$GREEN" "$*" "$OFF"; }

# --- 1. secret-shaped strings ----------------------------------------------
say "→ scanning for hardcoded secrets"
SECRET_PATTERNS=(
  'sk-[A-Za-z0-9_-]{16,}'                 # OpenAI-style keys
  'sk-proj-[A-Za-z0-9_-]{16,}'            # OpenAI project keys
  'sk-ant-[A-Za-z0-9_-]{16,}'             # Anthropic keys
  'ghp_[A-Za-z0-9]{20,}'                  # GitHub tokens
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'  # JWTs
  'AKIA[0-9A-Z]{16}'                      # AWS access key ids
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'    # private keys
  '(service_role|SERVICE_ROLE)[[:space:]]*[:=][[:space:]]*['"'"'"][^'"'"'"]{20,}'
  'xi-api-key[[:space:]]*[:=][[:space:]]*['"'"'"][^'"'"'"]{8,}'   # ElevenLabs, inline
  'sk_[a-f0-9]{32,}'                                              # ElevenLabs key shape
)
# Not every secret-shaped string is a secret. A Supabase *publishable* key is a
# JWT, is printed in every web page the platform serves, and has to be in the
# binary for a downloaded copy to sign anyone in; the RS256 tokens the licence
# tests verify against are signed by a throwaway key that was destroyed after
# generating them.
#
# Those are allowed by the SHA-256 of the exact string, one per line in
# `preflight-allowed.txt`, so that a *different* secret-shaped string still
# fails. Nothing is allowed by file, by line number, or by pattern — the only
# way past this is to have written the value down here on purpose.
ALLOWED="$(dirname "$0")/preflight-allowed.txt"
sha() { if command -v shasum >/dev/null; then shasum -a 256 | cut -d' ' -f1; else sha256sum | cut -d' ' -f1; fi; }
allowed() { [ -f "$ALLOWED" ] && grep -qx "$1" "$ALLOWED"; }

for pattern in "${SECRET_PATTERNS[@]}"; do
  # -o so the hash is of the secret itself and not of whatever line it sits on,
  # which would let a rename or a reindent quietly re-admit it.
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    where=${hit%%:*}; rest=${hit#*:}; line=${rest%%:*}; match=${rest#*:}
    digest=$(printf '%s' "$match" | sha)
    if allowed "$digest"; then continue; fi
    bad "  secret-shaped string found:"
    # The first few characters and the hash, never the value: enough to
    # recognise it, and enough to allow it deliberately if it turns out to be
    # publishable. The whole string is not printed into a CI log.
    printf '    %s:%s  starts %s…  sha256 %s\n' "$where" "$line" "${match:0:12}" "$digest"
  done <<< "$(grep -rInoE "${EXCLUDES[@]}" "$pattern" "${SCAN_DIRS[@]}" 2>/dev/null || true)"
done
[ "$fail" -eq 0 ] && ok "  clean — $(grep -cvE '^\s*(#|$)' "$ALLOWED" 2>/dev/null || echo 0) string(s) allowed by hash"

# --- 2. .env.local is not tracked ------------------------------------------
say "→ checking .env.local is not tracked by git"
if git ls-files --error-unmatch .env.local >/dev/null 2>&1; then
  bad "  .env.local is tracked by git — remove it from the index immediately"
else
  ok "  not tracked"
fi

# --- 3. every env var the code reads is documented -------------------------
say "→ checking .env.example covers every env var the code reads"
if [ ! -f .env.example ]; then
  bad "  .env.example is missing"
else
  used=$(grep -rhoE "${EXCLUDES[@]}" \
      -e 'import\.meta\.env\.[A-Z0-9_]+' \
      -e 'process\.env\.[A-Z0-9_]+' \
      -e 'env!?\("[A-Z0-9_]+"\)' \
      -e 'env::var\("[A-Z0-9_]+"\)' \
      "${SCAN_DIRS[@]}" 2>/dev/null \
    | grep -oE '[A-Z][A-Z0-9_]{2,}' | sort -u || true)
  documented=$(grep -oE '^[A-Z][A-Z0-9_]*(?==)' -P .env.example 2>/dev/null \
    || grep -oE '^[A-Z][A-Z0-9_]*=' .env.example | tr -d '=')
  # Supplied by the toolchain, the bundler, or the OS. None of these are app
  # configuration, so none belong in .env.example.
  BUILTINS="CARGO_MANIFEST_DIR CARGO_PKG_VERSION CARGO_PKG_NAME CARGO_BIN_NAME OUT_DIR TARGET PROFILE"   # cargo
  BUILTINS="$BUILTINS DEV PROD MODE SSR BASE_URL"                                                        # vite
  BUILTINS="$BUILTINS PATH HOME TMPDIR APPDATA PROGRAMFILES"                                             # os
  missing=""
  for var in $used; do
    case " $BUILTINS " in *" $var "*) continue ;; esac
    printf '%s\n' "$documented" | grep -qx "$var" || missing="$missing $var"
  done
  if [ -n "$missing" ]; then
    bad "  read by the code but absent from .env.example:$missing"
  else
    ok "  complete"
  fi
fi

# --- 4. no GPL phonemiser in the dependency graph --------------------------
# Kokoro's usual G2P backend is espeak-ng, which is GPL. Linking it would put
# GPL obligations on the whole distributed bundle, so the app phonemises from
# permissively-licensed lexicons instead (see src-tauri/src/g2p.rs). This guard
# exists because the dependency is easy to reintroduce by accident: several
# Kokoro crates pull espeak-ng in as a *default* cargo feature.
say "→ checking espeak-ng has not entered the dependency graph"
espeak_hits=0
if [ -f src-tauri/Cargo.lock ]; then
  if grep -inE 'espeak|phonemizer' src-tauri/Cargo.lock >/dev/null 2>&1; then
    bad "  espeak-ng appears in src-tauri/Cargo.lock:"
    grep -inE 'espeak|phonemizer' src-tauri/Cargo.lock | sed 's/^/    /'
    espeak_hits=1
  fi
fi
# Only application code — this script names espeak in its own comments, and
# g2p.rs explains at length why it is absent. Actual linkage would show up as a
# use/extern/dependency line, which is what this pattern looks for.
if grep -rInE "${EXCLUDES[@]}" \
     -e '^[[:space:]]*(use|extern crate)[[:space:]]+espeak' \
     -e '^[[:space:]]*espeak[a-z_-]*[[:space:]]*=' \
     -e 'espeak[a-z_-]*::' \
     src src-tauri/src 2>/dev/null; then
  bad "  application code links espeak (see above)"
  espeak_hits=1
fi
if grep -rInE '^[[:space:]]*espeak' src-tauri/Cargo.toml 2>/dev/null; then
  bad "  espeak is declared in Cargo.toml (see above)"
  espeak_hits=1
fi
[ "$espeak_hits" -eq 0 ] && ok "  clean — no GPL phonemiser"

# --- 5. no API key ever reaches a project file -----------------------------
# The ElevenLabs key is a live billing credential. It lives in the OS keychain,
# never in a project, and never in an exported bundle. The schema has nowhere to
# put one, but a schema is a promise and this is the check.
say "→ checking no API key has leaked into a project file"
key_leak=0
PROJECT_DIR="$HOME/Library/Application Support/com.buildnlaunchai.raw-footage-real-story/projects"
if [ -d "$PROJECT_DIR" ]; then
  if grep -rlE 'xi-api-key|sk_[a-f0-9]{32,}|apiKey' "$PROJECT_DIR" --include='project.json' 2>/dev/null; then
    bad "  a project file contains something key-shaped (listed above)"
    key_leak=1
  fi
fi
# And the schema itself must have no field for one.
if grep -rInE 'api_key|apiKey' src-tauri/src/project.rs 2>/dev/null; then
  bad "  the project schema has an api key field; it must not"
  key_leak=1
fi
[ "$key_leak" -eq 0 ] && ok "  clean — no key material in projects"

# --- 6. the app never invents a provider-key link ---------------------------
#
# Every provider slot the platform sends carries exactly one link — manage_url
# when the key works, consent_url when it does not — and the app opens what it
# was given. It composes nothing, and this is the check that it stays that way.
#
# The regression this catches is quiet and nasty. A composed link looks correct
# and opens cleanly; it just lands somewhere that cannot help. `consent_required`
# is the case that proves it — that page has no provider in its address at all,
# so anything built from a provider slug sends the person somewhere plausible
# and useless, with nothing to suggest the app was wrong.
#
# Test modules are exempt: they have to name the addresses they assert on. So is
# LoginGate, whose /account and /pricing links belong to the licence gate and
# have nothing to do with provider keys.
say "→ checking no provider-key dashboard link is composed in the app"
dash_hits="$(
  grep -rn "buildnlaunchai\.com/dashboard" src src-tauri/src 2>/dev/null \
    | grep -v "src-tauri/src/provider_keys.rs" \
    | grep -v "src-tauri/src/openai.rs" \
    || true
)"
# Those two files carry the address only inside `#[cfg(test)]`; confirm that.
for f in src-tauri/src/provider_keys.rs src-tauri/src/openai.rs; do
  [ -f "$f" ] || continue
  test_start="$(grep -n '#\[cfg(test)\]' "$f" | head -1 | cut -d: -f1)"
  if [ -n "$test_start" ]; then
    working="$(head -n "$((test_start - 1))" "$f" | grep -n "buildnlaunchai\.com" || true)"
  else
    working="$(grep -n "buildnlaunchai\.com" "$f" || true)"
  fi
  [ -n "$working" ] && dash_hits="$dash_hits
$f (outside tests): $working"
done
if [ -n "$(printf '%s' "$dash_hits" | tr -d '[:space:]')" ]; then
  printf '%s\n' "$dash_hits"
  bad "  a dashboard link is written into the app; it must come from the response"
else
  ok "  clean — every provider-key link comes from the platform"
fi

# --- duplicated resource files ---------------------------------------------
#
# This machine has twice produced "name 2.ext" copies of files under sync
# pressure: once emptying seven voice packs of their contents, once filling a
# freshly installed node_modules with them mid-build. `resources/**/*` is
# bundled wholesale, so a duplicate that survives to build time ships inside
# the app — 62 voice packs where there should be 55, seven of them junk. Cheap
# to check here; expensive to find out from a user.
say "→ checking for duplicated resource files"
dupes="$(find src-tauri/resources \( -name '* [0-9]' -o -name '* [0-9].*' \) 2>/dev/null || true)"
if [ -n "$dupes" ]; then
  bad "  duplicated files under resources — these would be bundled into the app:"
  printf '%s\n' "$dupes" | sed 's/^/    /'
else
  ok "  clean — no duplicated resources"
fi

# --- captions are shaped correctly -----------------------------------------
#
# The Bengali subtitles were declared fixed three times and were wrong three
# times, because a wrong vowel sign and a right one look alike at the size they
# render. This measures instead, in every engine that draws a caption, and
# checks that its own measurement can still catch a renderer known to be wrong.
# Skipped where the tools are missing rather than failing the run — a Linux CI
# box has no CoreText and no Chrome at that path.
say "→ checking captions are shaped correctly"
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  if caption_out="$(node scripts/check-captions.mjs 2>&1)"; then
    ok "  correct in every engine, and the broken renderer was caught"
  else
    bad "  captions are not shaped correctly:"
    printf '%s\n' "$caption_out" | sed 's/^/    /'
  fi
else
  printf '%s  skipped — no Chrome to measure against%s\n' "$YELLOW" "$OFF"
fi

say ""
if [ "$fail" -ne 0 ]; then
  printf '%spreflight FAILED%s\n' "$RED" "$OFF"
  exit 1
fi
printf '%spreflight passed%s\n' "$GREEN" "$OFF"
printf '%snote: v1 is offline-only and holds no secrets; this guard exists so that stays true.%s\n' "$YELLOW" "$OFF"
