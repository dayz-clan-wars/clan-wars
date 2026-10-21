#!/usr/bin/env bash
# Pulls what the item cards need out of the DayZ game install: every config.bin, derapified
# to text, and the English stringtable. Runs ON the Ubuntu PC that has DayZ installed
# (rraygun@192.168.1.103); scripts/build-item-cards.ts copies the result back and builds
# the cards. Nothing here comes from iZurvive or any other site.
#
# ⚠️ Read-only against the Steam install. Everything is written under $OUT
# (~/clan-wars-item-cards/out) and the tool lives in ~/.local/bin: no sudo, no system
# packages, never a write next to Steam's files.
#
# What worked (spike, 2026-10-21, DayZ Steam buildid 25956772):
#   - HEMTT 1.22.0's Linux binary (github.com/BrettMayson/HEMTT, release asset linux-x64.zip)
#     reads DayZ's PBOs as they ship: `hemtt utils pbo inspect` lists them, `pbo extract`
#     pulls one file out, `config derapify` turns config.bin into config.cpp text. No other
#     tool was needed. Encrypted .ebo files (worlds_nasdara.ebo) are skipped; they hold no
#     item configs.
#   - The item configs are spread over 258 config.bin files across Addons/*.pbo (118), plus
#     dta/*.pbo (7) and the Nasdara map's own nasdara/addons/*.pbo (24, its extra gear).
#   - The English names are in dta/languagecore.pbo:stringtable.csv. Its keys are lower
#     case ("str_cfgweapons_m4a10"); configs write them as "$STR_cfgWeapons_M4A10".
#   - Item pictures: DayZ draws inventory items as live 3D models, so it ships NO preview
#     or icon image for them. Across all 149 PBOs there is no *_preview*.paa, no *_icon*.paa
#     for an item, and no editorPreview in any item config. The preview step below still
#     runs, so a future build that adds them is picked up without a code change.
#
# Usage (on the PC): bash extract.sh        then locally: pnpm --filter @factions/web map:cards
set -euo pipefail

HEMTT="${HEMTT:-$HOME/.local/bin/hemtt}"
STEAM="${STEAM:-$HOME/snap/steam/common/.local/share/Steam/steamapps}"
DAYZ="$STEAM/common/DayZ"
OUT="$HOME/clan-wars-item-cards/out"

[ -x "$HEMTT" ] || { echo "hemtt not found at $HEMTT (install the Linux release to ~/.local/bin)" >&2; exit 1; }
[ -d "$DAYZ/Addons" ] || { echo "no DayZ install at $DAYZ" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/configs" "$OUT/previews"

# The files we want from one PBO, from the table `pbo inspect` prints (column 2 is the path):
# every config.bin, the stringtable, and any preview or icon texture (matched on the file's
# own name, not its folders: church_icons\data\alfa_ca.paa is a wall texture).
wanted_files() {
  "$HEMTT" utils pbo inspect "$1" 2>/dev/null | awk -F'│' '
    NF > 2 {
      gsub(/^ +| +$/, "", $2); f = $2; base = tolower(f); sub(/.*\\/, "", base)
      if (base == "config.bin" || base == "stringtable.csv" || base ~ /(_preview|_icon)[^.]*\.paa$/) print f
    }'
}

# ⚠️ `hemtt utils pbo extract` REFUSES to overwrite its output file and still exits 0, so
# reusing one temp path silently writes the first config into every file. Every extract
# goes to a fresh path.
TMP="$OUT/tmp"
n=0
for pbo in "$DAYZ"/Addons/*.pbo "$DAYZ"/dta/*.pbo "$DAYZ"/nasdara/addons/*.pbo; do
  name="$(basename "$pbo" .pbo)"
  while IFS= read -r f; do
    rm -rf "$TMP"; mkdir -p "$TMP"
    base="$(basename "${f//\\//}")"
    "$HEMTT" utils pbo extract "$pbo" "$f" "$TMP/$base" >/dev/null 2>&1
    [ -s "$TMP/$base" ] || { echo "could not extract $name:$f" >&2; exit 1; }
    case "$base" in
      config.bin)
        # One file per config: pbo name + its folder inside, separators flattened.
        dest="$OUT/configs/${name}__$(printf '%s' "$f" | tr '\\/' '__' | sed 's/\.bin$//').cpp"
        "$HEMTT" utils config derapify "$TMP/$base" "$dest" >/dev/null 2>&1
        [ -s "$dest" ] || { echo "could not derapify $name:$f" >&2; exit 1; }
        n=$((n + 1))
        ;;
      stringtable.csv) cp "$TMP/$base" "$OUT/stringtable-$name.csv" ;;
      *) "$HEMTT" utils paa convert "$TMP/$base" "$OUT/previews/${base%.*}.png" >/dev/null 2>&1 || echo "could not convert $name:$f" >&2 ;;
    esac
  done < <(wanted_files "$pbo")
done
rm -rf "$TMP"

# The game build, for the cards file's `source`: Steam's build id and the Addons mtime.
buildid="$(awk -F'"' '/"buildid"/ { print $4; exit }' "$STEAM/appmanifest_221100.acf" 2>/dev/null || true)"
addons="$(date -u -r "$DAYZ/Addons/dz.pbo" +%Y-%m-%dT%H:%M:%SZ)"
printf '{"steamBuildId":"%s","addonsModified":"%s","hemtt":"%s"}\n' "$buildid" "$addons" "$("$HEMTT" --version 2>&1 | awk '{print $2}')" > "$OUT/build.json"

echo "configs: $n, previews: $(ls "$OUT/previews" | wc -l), build: $(cat "$OUT/build.json")"
