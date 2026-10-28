#!/usr/bin/env bash
# RoadFun browser map builder — memory-efficient, no osmium-extract step.
# Uses two sequential passes over the Austria PBF and retains ONLY regional nodes.
# The actual A* route search still runs on the user's iPhone/PC.
set -euo pipefail
cd "$(dirname "$0")/.."

BBOX="${ROADFUN_BBOX:-13.2,48.0,13.85,48.5}"
SOURCE="${ROADFUN_OSM_PBF:-$(pwd)/routing-data/austria-latest.osm.pbf}"
OUTPUT="$(pwd)/browser-map-data/region.json"
mkdir -p routing-data "$(dirname "$OUTPUT")"

echo "RoadFun: speichersparender OSM-Kartenimport"
echo "Gebiet (West,Sued,Ost,Nord): $BBOX"
echo "Quelldatei: $SOURCE"
echo "Ausgabe: $OUTPUT"
echo

if [[ ! -s "$SOURCE" ]]; then
  if [[ -e "$SOURCE" ]]; then
    echo "OSM-Quelldatei ist leer: $SOURCE" >&2
    exit 1
  fi
  if [[ "${ROADFUN_OSM_PBF:-}" != "" ]]; then
    echo "Die manuell angegebene OSM-Quelldatei fehlt: $SOURCE" >&2
    exit 1
  fi
  echo "[Download] Lade das OSM-Extrakt fuer Oesterreich (nur einmalig) ..."
  curl --fail --location --retry 3 --continue-at - --progress-bar \
    -o "$SOURCE" https://download.geofabrik.de/europe/austria-latest.osm.pbf
fi

if [[ ! -s "$SOURCE" ]]; then
  echo "OSM-Quelldatei fehlt oder ist leer." >&2
  exit 1
fi
echo "[OSM] Quelldatei: $(du -h "$SOURCE" | cut -f1)"
echo "[OSM] Zwei lesende Durchlaeufe ueber die Quelldatei."
echo "[OSM] Die Meldungen zeigen Knoten/Wege statt eines haengenden 0%-Balkens."
echo

if ! command -v python3 >/dev/null || ! python3 -m venv --help >/dev/null 2>&1; then
  echo "Bitte python3 und python3-venv installieren (apt install python3 python3-venv)." >&2
  exit 2
fi
if [[ ! -x .venv-map/bin/python ]]; then python3 -m venv .venv-map; fi
if ! .venv-map/bin/python -c 'import osmium' >/dev/null 2>&1; then
  echo "[Setup] Installiere PyOsmium nur in der lokalen .venv-map ..."
  .venv-map/bin/python -m pip install --disable-pip-version-check osmium
fi

echo "[Start] Analysiere direkt die OSM-Quelldatei; kein osmium extract notwendig."
echo "[Hinweis] Die vorhandene Region-Karte bleibt bei einem Abbruch erhalten."
time .venv-map/bin/python -u scripts/create-browser-graph.py "$SOURCE" "$OUTPUT" --bbox "$BBOX"

test -s "$OUTPUT"
echo
echo "ERFOLG! Browser-Karte: $(du -h "$OUTPUT" | cut -f1)"
echo "Die Route wird weiterhin direkt auf dem Geraet berechnet."
echo "Bei bereits laufendem Docker-Container wird die Datei sofort per Volume ausgeliefert."
echo "Pruefung auf dem Server:"
echo "  docker exec roadfun ls -lh /app/wwwroot/routing-data/region.json"
echo "Einmal im Browser die RoadFun-Seite neu laden; bei einer alten Karte die PWA schliessen."
