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
  'sk-ant-[A-Za-z0-9_-]{16,}'             # Anthropic keys
  'ghp_[A-Za-z0-9]{20,}'                  # GitHub tokens
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'  # JWTs
  'AKIA[0-9A-Z]{16}'                      # AWS access key ids
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'    # private keys
  '(service_role|SERVICE_ROLE)[[:space:]]*[:=][[:space:]]*['"'"'"][^'"'"'"]{20,}'
)
for pattern in "${SECRET_PATTERNS[@]}"; do
  if hits=$(grep -rInE "${EXCLUDES[@]}" "$pattern" "${SCAN_DIRS[@]}" 2>/dev/null); then
    bad "  secret-shaped string found:"
    printf '%s\n' "$hits" | sed 's/^/    /'
  fi
done
[ "$fail" -eq 0 ] && ok "  clean"

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
  missing=""
  for var in $used; do
    printf '%s\n' "$documented" | grep -qx "$var" || missing="$missing $var"
  done
  if [ -n "$missing" ]; then
    bad "  read by the code but absent from .env.example:$missing"
  else
    ok "  complete"
  fi
fi

say ""
if [ "$fail" -ne 0 ]; then
  printf '%spreflight FAILED%s\n' "$RED" "$OFF"
  exit 1
fi
printf '%spreflight passed%s\n' "$GREEN" "$OFF"
printf '%snote: v1 is offline-only and holds no secrets; this guard exists so that stays true.%s\n' "$YELLOW" "$OFF"
