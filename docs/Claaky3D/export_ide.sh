#!/bin/sh
# Exporte la pièce de Claaky depuis Blender vers l'IDE Claake Code (sinew/public/claaky3d/bureau).
# Usage : ./export_ide.sh            → tout (≈ 1 h avec le GPU d'un Mac, 640 px)
#         ./export_ide.sh erreur,cafe → seulement ces clips (le manifeste est complété)
# Variables : BLENDER (chemin de Blender), SIZE (640), SAMPLES (24)
set -e
cd "$(dirname "$0")"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
OUT="$(cd ../.. && pwd)/public/claaky3d"
TMP="${TMPDIR:-/tmp}/claaky3d_export"
mkdir -p "$OUT/bureau" "$TMP"
SEGMENTS=""
[ -n "$1" ] && SEGMENTS="--segments $1"
# Conserve le manifeste existant pour un export partiel.
[ -n "$1" ] && [ -f "$OUT/bureau/clips.json" ] && mkdir -p "$TMP/Claaky_États_animés" && cp "$OUT/bureau/clips.json" "$TMP/Claaky_États_animés/"
"$BLENDER" --background --factory-startup --python claaky_etats.py -- \
  --output "$TMP" --export --gpu --export-size "${SIZE:-640}" --export-samples "${SAMPLES:-24}" $SEGMENTS \
  2>&1 | grep -E "GPU|CLIP|EXPORT|PRÊT|Error|Traceback" || true
cp "$TMP"/Claaky_*/clips.json "$TMP"/Claaky_*/*.png "$OUT/bureau/"
echo "Copié dans $OUT/bureau"
