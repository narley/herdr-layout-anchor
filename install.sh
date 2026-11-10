#!/bin/bash
# Copies this layout into Herdr Desktop's home, saving whatever it replaces first.
set -euo pipefail
cd "$(dirname "$0")"
app=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
scripts=$HOME/.config/herdr
[[ -d "$app" ]] || { echo "No Herdr Desktop home at $app (set HERDR_APP_HOME)." >&2; exit 1; }
backup="$app/backups/$(basename "$PWD")-$(date +%Y%m%d%H%M%S)"
for dir in layouts themes mods; do
  [[ -d "$dir" ]] || continue
  for item in "$dir"/*; do
    if [[ -e "$app/$item" ]]; then
      mkdir -p "$backup/$dir"
      cp -R "$app/$item" "$backup/$dir/"
    fi
  done
  mkdir -p "$app/$dir"
  cp -R "$dir"/. "$app/$dir/"
done
mkdir -p "$scripts"
for file in scripts/*; do
  name=$(basename "$file")
  if [[ -e "$scripts/$name" ]]; then
    mkdir -p "$backup/scripts"
    cp "$scripts/$name" "$backup/scripts/"
  fi
  cp "$file" "$scripts/$name"
done
chmod +x "$scripts/claude-desktop.sh"
# Menu entries go into any programs.json already there, keeping its others.
if [[ -e "$app/programs.json" ]]; then
  python3 - "$app/programs.json" programs.json "$backup" <<'PY'
import json, os, shutil, sys
path, mine, backup = sys.argv[1:]
have = json.load(open(path))
merged = {**have, "programs": {**have.get("programs", {}), **json.load(open(mine))["programs"]}}
if merged != have:
    os.makedirs(backup, exist_ok=True)
    shutil.copy(path, backup)
    json.dump(merged, open(path, "w"), indent=2)
PY
else
  cp programs.json "$app/programs.json"
fi
echo "Installed into $app"
if [[ -d "$backup" ]]; then echo "Replaced files saved in $backup"; fi
