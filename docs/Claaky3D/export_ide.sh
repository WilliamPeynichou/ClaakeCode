#!/bin/bash
# Full export: ./export_ide.sh ; partial: ./export_ide.sh erreur,cafe
# BLENDER, SIZE=640, SAMPLES=24, EXPORT_TMP can be overridden.
set -euo pipefail
cd "$(dirname "$0")"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
OUT="$(cd ../.. && pwd)/public/claaky3d/bureau"
TMP="${EXPORT_TMP:-${TMPDIR:-/tmp}/claaky3d_export}"
DEST="$TMP/Claaky_États_animés"
mkdir -p "$OUT" "$DEST"
ARGS=()
if [ -n "${1:-}" ]; then
  ARGS=(--segments "$1")
  [ ! -f "$OUT/clips.json" ] || cp "$OUT/clips.json" "$DEST/"
fi
# Do not hide Blender failures behind grep/`|| true`, nor copy stale renders on error.
"$BLENDER" --background --factory-startup --python claaky_etats.py -- \
  --output "$TMP" --export --gpu --export-size "${SIZE:-640}" --export-samples "${SAMPLES:-24}" ${ARGS[@]+"${ARGS[@]}"}
FILES="$(python3 - "$DEST" <<'PY'
import json, pathlib, struct, sys
folder = pathlib.Path(sys.argv[1])
data = json.loads((folder / 'clips.json').read_text())
files = [data['decor'], *(c['planche'] for c in data['clips'].values())]
if data.get('machine', {}).get('decor'):
    files.append(data['machine']['decor'])
for name in files:
    raw = (folder / name).read_bytes()
    assert raw[:8] == b'\x89PNG\r\n\x1a\n', name
    w, h = struct.unpack('>II', raw[16:24])
    assert w > 0 and h > 0, name
print(' '.join(sorted(set(files))))
PY
)"
echo "VALIDÉ : $FILES"
# Copy only what the manifest uses (the temp folder may hold sheets of removed clips).
for f in $FILES; do cp "$DEST/$f" "$OUT/"; done
# Full export: drop sheets no longer in the manifest.
if [ -z "${1:-}" ]; then
  for f in "$OUT"/*.png; do
    case " $FILES " in *" $(basename "$f") "*) ;; *) rm -f "$f"; echo "Supprimé : $(basename "$f")" ;; esac
  done
fi
# Publish manifest last, only after all assets exist.
cp "$DEST/clips.json" "$OUT/clips.json"
echo "Copié dans $OUT"
