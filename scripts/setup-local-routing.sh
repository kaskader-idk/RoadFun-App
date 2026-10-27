#!/usr/bin/env bash
# Prepare offline Austrian OSRM routing using Contraction Hierarchies.
# Run on the Docker host, not inside the roadfun container.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p routing-data
DIR="$(pwd)/routing-data"
IMAGE="ghcr.io/project-osrm/osrm-backend:v5.27.1"
PBF="${ROADFUN_PBF_FILE:-$DIR/austria-latest.osm.pbf}"
if [[ ! "$PBF" = /* ]]; then echo "ROADFUN_PBF_FILE must be an absolute path"; exit 2; fi
if [[ ! -f "$PBF" ]]; then
  if [[ "$PBF" != "$DIR/austria-latest.osm.pbf" ]]; then
    echo "Custom PBF missing: $PBF"; exit 2
  fi
  echo "Downloading Austria (~800 MB) from Geofabrik; this step requires Internet."
  curl --fail --location --retry 3 --continue-at - \
    --output "$PBF" https://download.geofabrik.de/europe/austria-latest.osm.pbf
fi
if [[ "$PBF" != "$DIR/austria-latest.osm.pbf" ]]; then
  echo "Using custom region extract from $PBF"
  cp -- "$PBF" "$DIR/austria-latest.osm.pbf"
fi
if [[ ! -s "$DIR/austria-latest.osm.pbf" ]]; then echo "OSM file empty"; exit 1; fi
FREE=$(df -Pk "$DIR" | awk 'NR==2{print $4}')
if (( FREE < 8 * 1024 * 1024 )); then
  echo "WARNING: less than 8 GiB free disk space. OSRM preprocessing may fail."
fi
echo "Preparing Austrian road graph for very fast on-server routing."
echo "Large extracts can need >8GB RAM during preprocessing; use a smaller custom PBF if necessary."
echo "Do not shut down the existing RoadFun service while preparing."
docker pull "$IMAGE"
docker run --rm -t -v "$DIR:/data" "$IMAGE" \
  osrm-extract -p /opt/car.lua /data/austria-latest.osm.pbf
docker run --rm -t -v "$DIR:/data" "$IMAGE" \
  osrm-contract /data/austria-latest.osrm
test -s "$DIR/austria-latest.osrm"
echo
echo "Preparation complete. In your .env, set:"
echo "  ROADFUN_ROUTING_URL=http://osrm:5000"
echo "Then start:"
echo "  docker compose --profile local-routing up -d --build"
echo "The OSRM container is internal to the Docker network (not public)."
