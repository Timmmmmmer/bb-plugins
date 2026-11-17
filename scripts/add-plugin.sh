#!/usr/bin/env bash
# Copy a bb plugin into this repository as a local plugin, then commit and push.
# Every running hub installs it at the next shared sync.
#
#   scripts/add-plugin.sh <source> [--name <folder>] [--subdir <path>] [--force] [--no-push]
#
# <source> can be:
#   a local folder         ./my-plugin   ~/code/bb-plugin-weather
#   (git repositories aren't copied: add them as remote plugins with `bb hub plugin add <repo>`)
#   an archive (file/URL)  plugin.zip   plugin.tar.gz   https://example.com/plugin.zip
#
#   --name <folder>   folder name under plugins/ (default: the plugin id)
#   --subdir <path>   the plugin's folder inside the source, when it holds several
#   --force           replace plugins/<folder> if it already exists
#   --no-push         commit locally but don't push
#
# The script only copies files; it never runs code from the source. It leaves
# out node_modules, dist, .git, .claude, and .env files.
set -euo pipefail

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
die() { printf 'add-plugin: %s\n' "$*" >&2; exit 1; }

SOURCE="" NAME="" SUBDIR="" FORCE=0 PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --subdir) SUBDIR="${2:?--subdir needs a value}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --no-push) PUSH=0; shift ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) [ -z "$SOURCE" ] || die "only one source, got '$SOURCE' and '$1'"; SOURCE="$1"; shift ;;
  esac
done
[ -n "$SOURCE" ] || usage 1
command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "node is required (bb's npx install provides it)"

REPO_ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/add-plugin.XXXXXX")
trap 'rm -rf "${WORK:?}"' EXIT

# --- 1. Get the source into a folder -----------------------------------------
case "$SOURCE" in
  *.zip|*.tar.gz|*.tgz|*.tar|*.tar.bz2|*.tar.xz)
    ARCHIVE="$WORK/source.${SOURCE##*/}"
    case "$SOURCE" in
      http://*|https://*) command -v curl >/dev/null || die "curl is required for URLs"
        curl -fsSL "$SOURCE" -o "$ARCHIVE" || die "could not download $SOURCE" ;;
      *) [ -f "$SOURCE" ] || die "no such file: $SOURCE"; cp "$SOURCE" "$ARCHIVE" ;;
    esac
    mkdir -p "$WORK/extract"
    case "$ARCHIVE" in
      *.zip) command -v unzip >/dev/null || die "unzip is required for .zip"; unzip -q "$ARCHIVE" -d "$WORK/extract" ;;
      *) tar -xf "$ARCHIVE" -C "$WORK/extract" ;;
    esac
    BASE="$WORK/extract"
    # Archives often wrap everything in one top-level folder.
    entries=$(find "$BASE" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
    first=$(find "$BASE" -mindepth 1 -maxdepth 1 | head -1)
    if [ "$entries" = 1 ] && [ -d "$first" ]; then BASE="$first"; fi
    DESC="archive ${SOURCE##*/}" ;;
  http://*|https://*|git@*|ssh://*|*.git)
    die "git repositories aren't copied in; they're pointed to as remote plugins. Run: bb hub plugin add $SOURCE (the repository must be public)" ;;
  *)
    [ -d "$SOURCE" ] || die "'$SOURCE' is not a folder, git URL, or archive"
    BASE=$(cd "$SOURCE" && pwd)
    DESC="folder ${BASE##*/}" ;;
esac

# --- 2. Find the plugin folder -------------------------------------------------
is_plugin() { [ -f "$1/package.json" ] && node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]+"/package.json","utf8"));process.exit(p.bb&&typeof p.bb==="object"?0:1)' "$1" 2>/dev/null; }
if [ -n "$SUBDIR" ]; then
  BASE="$BASE/$SUBDIR"
  [ -d "$BASE" ] || die "no folder '$SUBDIR' in the source"
fi
if ! is_plugin "$BASE"; then
  candidates=$(find "$BASE" -maxdepth 4 -name package.json -not -path '*/node_modules/*' -print | while read -r f; do d=$(dirname "$f"); is_plugin "$d" && printf '%s\n' "$d"; done || true)
  count=$(printf '%s' "$candidates" | grep -c . || true)
  [ "$count" -gt 0 ] || die "no bb plugin found (a package.json with a \"bb\" section)"
  if [ "$count" -gt 1 ]; then
    printf 'add-plugin: the source holds several plugins; pick one with --subdir:\n' >&2
    printf '%s\n' "$candidates" | sed "s|^$BASE/|  |" >&2
    exit 1
  fi
  BASE="$candidates"
fi

# --- 3. Check the manifest -----------------------------------------------------
PLUGIN_ID=$(node - "$BASE" <<'NODE'
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
const p = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const problems = [];
if (typeof p.name !== "string" || !p.name) problems.push('"name" is missing');
for (const key of ["name", "description", "server"]) if (!p.bb?.[key]) problems.push(`"bb.${key}" is missing`);
if (p.bb?.server && !fs.existsSync(path.join(dir, p.bb.server))) problems.push(`bb.server file ${p.bb.server} does not exist`);
if (!p.bb?.branding?.icon && !p.bb?.branding?.logo) problems.push('"bb.branding.icon" is missing');
if (problems.length) { console.error("add-plugin: not a valid bb plugin:\n  " + problems.join("\n  ")); process.exit(1); }
// Warn when the plugin asks for a newer bb than the oldest one we support.
const min = String(p.engines?.bb ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
if (min) {
  const [a, b, c] = [min[1], min[2], min[3] ?? 0].map(Number);
  if (a > 0 || b > 47 || (b === 47 && c > 1)) {
    console.error(`add-plugin: note: engines.bb is "${p.engines.bb}"; machines on older bb (e.g. 0.47.1) will refuse it. Lower it if the plugin doesn't need it.`);
  }
}
const last = p.name.slice(p.name.lastIndexOf("/") + 1);
console.log((last.startsWith("bb-plugin-") ? last.slice(10) : last).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
NODE
)
[ -n "$PLUGIN_ID" ] || die "could not work out the plugin id"
NAME=${NAME:-$PLUGIN_ID}
printf '%s' "$NAME" | grep -Eq '^[a-z0-9][a-z0-9._-]*$' || die "folder name '$NAME' must use lowercase letters, digits, '.', '_', '-'"
[ "$NAME" != "hub" ] || die "plugins/hub is the hub itself"
# bb installs one plugin per id, so two folders can't share one.
for other in "$REPO_ROOT"/plugins/*/package.json; do
  [ -f "$other" ] || continue
  other_dir=$(dirname "$other"); other_name=${other_dir##*/}
  [ "$other_name" != "$NAME" ] || continue
  other_id=$(node -e 'const n=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name||"";const l=n.slice(n.lastIndexOf("/")+1);console.log((l.startsWith("bb-plugin-")?l.slice(10):l).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""))' "$other" 2>/dev/null || true)
  [ "$other_id" != "$PLUGIN_ID" ] || die "plugin id '$PLUGIN_ID' is already used by plugins/$other_name (rename the package in package.json, or use --name $other_name --force to replace it)"
done
DEST="$REPO_ROOT/plugins/$NAME"
if [ -e "$DEST" ]; then
  [ "$FORCE" = 1 ] || die "plugins/$NAME already exists (use --force to replace it)"
  rm -rf "${DEST:?}"
fi

# --- 4. Copy it in -------------------------------------------------------------
mkdir -p "$DEST"
(cd "$BASE" && tar -cf - --exclude=node_modules --exclude=dist --exclude=.git --exclude=.claude --exclude='.env' --exclude='.env.*' .) | (cd "$DEST" && tar -xf -)
if [ ! -f "$DEST/.gitignore" ]; then printf 'node_modules/\ndist/\n' > "$DEST/.gitignore"; fi
size_kb=$(du -sk "$DEST" | cut -f1)
[ "$size_kb" -lt 5120 ] || printf 'add-plugin: note: plugins/%s is %s KB; check nothing large slipped in.\n' "$NAME" "$size_kb" >&2

# --- 5. Commit and push ---------------------------------------------------------
cd "$REPO_ROOT"
git add -A "plugins/$NAME"
if git diff --cached --quiet -- "plugins/$NAME"; then
  echo "plugins/$NAME is unchanged; nothing to commit."
  exit 0
fi
git commit --quiet -m "Add plugin $NAME (from $DESC)" -- "plugins/$NAME"
echo "Added plugins/$NAME (plugin id: $PLUGIN_ID) from $DESC."
if [ "$PUSH" = 1 ]; then
  git push --quiet
  echo "Pushed. Every running hub installs it at the next shared sync; run \`bb hub status\` for the exact time."
else
  echo "Committed locally. Run \`git push\` when ready; hubs install it at the next sync after that."
fi
