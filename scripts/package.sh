#!/usr/bin/env bash
#
# Build a Chrome Web Store-ready .zip of the extension.
#
# Usage:
#   ./scripts/package.sh              -> writes dist/tab-triage-ai-<version>.zip
#   ./scripts/package.sh --check      -> prints which files would be included, no zip
#
# The script:
#   1. Reads the version from manifest.json so the filename matches what
#      reviewers see at submission time.
#   2. Includes only the runtime files the extension actually needs.
#      Dev-only artifacts (the build_icons.py source, this scripts/ dir,
#      docs/, .git/, *.zip files, __pycache__, .DS_Store) are excluded.
#   3. Sanity-checks the manifest after packaging by validating the JSON
#      and confirming every icon path it references exists in the zip.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "package.sh needs python3 (for JSON parsing)." >&2
  exit 1
fi
if ! command -v zip >/dev/null 2>&1; then
  echo "package.sh needs the 'zip' command. Install it (e.g. apt-get install zip)." >&2
  exit 1
fi

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
NAME="tab-triage-ai-${VERSION}"
DIST="${ROOT}/dist"
ZIP="${DIST}/${NAME}.zip"

# Whitelist of paths to include. Listed explicitly so a stray file in the
# repo root doesn't accidentally get bundled.
INCLUDE=(
  "manifest.json"
  "background"
  "popup"
  "options"
  "newtab"
  "lib"
  "icons/icon16.png"
  "icons/icon32.png"
  "icons/icon48.png"
  "icons/icon128.png"
)

# Files inside the included dirs that should still be skipped.
EXCLUDE_GLOBS=(
  "*/__pycache__/*"
  "*.pyc"
  "*.DS_Store"
  "icons/build_icons.py"
  "icons/*.py"
)

# Sanity-check every path exists before we touch the zip.
missing=0
for p in "${INCLUDE[@]}"; do
  if [[ ! -e "$p" ]]; then
    echo "Missing required path: $p" >&2
    missing=1
  fi
done
if (( missing )); then
  echo "Aborting — fix the missing paths and re-run." >&2
  exit 1
fi

if [[ "${1:-}" == "--check" ]]; then
  echo "Files that would be packaged (size shown in bytes):"
  for p in "${INCLUDE[@]}"; do
    if [[ -f "$p" ]]; then
      printf "  %-80s %s\n" "$p" "$(stat -c %s "$p" 2>/dev/null || stat -f %z "$p")"
    else
      find "$p" -type f \
        -not -path "*/__pycache__/*" \
        -not -name "*.pyc" \
        -not -name "*.DS_Store" \
        -not -name "build_icons.py" \
        | sort \
        | while read -r f; do
          printf "  %-80s %s\n" "$f" "$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")"
        done
    fi
  done
  exit 0
fi

mkdir -p "$DIST"
rm -f "$ZIP"

# Build the exclude flags for zip.
EXCLUDE_FLAGS=()
for g in "${EXCLUDE_GLOBS[@]}"; do
  EXCLUDE_FLAGS+=("-x" "$g")
done

zip -r "$ZIP" "${INCLUDE[@]}" "${EXCLUDE_FLAGS[@]}" >/dev/null

# Validate the package.
echo "Validating manifest in $ZIP …"
python3 - <<PY "$ZIP"
import json, sys, zipfile
zpath = sys.argv[1]
with zipfile.ZipFile(zpath) as z:
    names = set(z.namelist())
    if "manifest.json" not in names:
        sys.exit("manifest.json missing from zip")
    with z.open("manifest.json") as f:
        m = json.load(f)

issues = []
for size, path in (m.get("icons") or {}).items():
    if path not in names:
        issues.append(f"icon {size}px ({path}) not in zip")
for ws in [m.get("background", {}).get("service_worker")]:
    if ws and ws not in names:
        issues.append(f"service_worker ({ws}) not in zip")
for cs in m.get("content_scripts", []):
    for j in cs.get("js", []):
        if j not in names:
            issues.append(f"content_script ({j}) not in zip")
options_page = m.get("options_page")
if options_page and options_page not in names:
    issues.append(f"options_page ({options_page}) not in zip")
overrides = (m.get("chrome_url_overrides") or {})
for k, v in overrides.items():
    if v not in names:
        issues.append(f"chrome_url_overrides.{k} ({v}) not in zip")

if issues:
    for i in issues:
        print(f"  ! {i}", file=sys.stderr)
    sys.exit("Package is missing referenced files. Aborting.")
print(f"  ok: manifest references all resolve. {len(names)} files, {round(__import__('os').path.getsize(zpath)/1024, 1)} KB.")
PY

echo
echo "Built: $ZIP"
echo "Upload that file at https://chrome.google.com/webstore/devconsole/"
