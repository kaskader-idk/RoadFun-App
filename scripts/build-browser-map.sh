#!/usr/bin/env bash
# Builds a SMALL regional OSM road graph that is delivered to users' devices.
# All shortest-path calculations happen locally in the browser Web Worker.
# Example: ROADFUN_BBOX="13.2,48.0,13.85,48.5" bash scripts/build-browser-map.sh
set -euo pipefail
cd "$(dirname "$0")/.."
BBOX="${ROADFUN_BBOX:-13.2,48.0,13.85,48.5}" # wider Ried im Innkreis area
SOURCE="${ROADFUN_OSM_PBF:-$(pwd)/routing-data/austria-latest.osm.pbf}"
REGION="$(pwd)/routing-data/region.osm.pbf"
OUTPUT="$(pwd)/browser-map-data/region.json"
mkdir -p routing-data "$(dirname "$OUTPUT")"
if ! command -v osmium >/dev/null; then
  echo "Missing osmium CLI. On Debian: apt update && apt install -y osmium-tool python3-venv curl"
  exit 2
fi
if [[ ! -f "$SOURCE" ]]; then
  echo "Downloading Austrian OSM data (only needed for preprocessing)"
  curl --fail --location --retry 3 --continue-at - \
    -o "$SOURCE" https://download.geofabrik.de/europe/austria-latest.osm.pbf
fi
if [[ ! -x .venv-map/bin/python ]]; then
  python3 -m venv .venv-map
fi
if ! .venv-map/bin/python -c 'import osmium' >/dev/null 2>&1; then
  .venv-map/bin/python -m pip install --disable-pip-version-check osmium
fi
echo "Extracting bbox $BBOX (longitude_min,latitude_min,longitude_max,latitude_max)"
rm -f "$REGION"
osmium extract --strategy=complete_ways -b "$BBOX" "$SOURCE" -o "$REGION"
.venv-map/bin/python scripts/create-browser-graph.py "$REGION" "$OUTPUT"
echo
echo "IMPORTANT: Browser map generated. Docker bind-mounts this directory into the API:"
echo "  docker compose up -d roadfun"
echo "The app will download the graph; route search then runs 100% on each user's device."
echo "To cover more roads, rebuild using a wider ROADFUN_BBOX (increases file size and memory)."
