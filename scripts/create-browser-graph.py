#!/usr/bin/env python3
"""Compile a small local driving graph from an OSM PBF extract.

A *preparation* step only. RoadFun's routing executes in the user's own
Web Worker, without an HTTP route request to OSRM or any other provider.

Dependencies: python3 -m pip install osmium  (PyOsmium)
Usage: python3 scripts/create-browser-graph.py INPUT.osm.pbf OUTPUT.json
"""
import argparse
import json
import math
import time
from collections import defaultdict, deque
from pathlib import Path

import osmium

ALLOWED = {
    "motorway": (110, 0), "motorway_link": (45, 1),
    "trunk": (95, 1), "trunk_link": (40, 1),
    "primary": (80, 2), "primary_link": (35, 2),
    "secondary": (70, 3), "secondary_link": (30, 3),
    "tertiary": (60, 4), "tertiary_link": (25, 4),
    "unclassified": (45, 5), "residential": (40, 6),
    "living_street": (15, 7), "service": (20, 7),
}
NO_ACCESS = {"no", "private", "agricultural", "forestry"}
NO_MOTOR = {"no", "private"}
EARTH_RADIUS = 6371000


def meters(a, b):
    lat1, lon1 = a
    lat2, lon2 = b
    phi = math.radians((lat1 + lat2) / 2)
    dx = math.radians(lon2 - lon1) * math.cos(phi) * EARTH_RADIUS
    dy = math.radians(lat2 - lat1) * EARTH_RADIUS
    return max(1, round(math.hypot(dx, dy)))


def speed_kmh(tags, default):
    raw = (tags.get("maxspeed") or "").strip().lower()
    try:
        if raw.endswith("mph"):
            speed = float(raw[:-3].strip()) * 1.609344
        else:
            speed = float(raw.split()[0])
        if 5 <= speed <= 150:
            return min(speed, 130)
    except (ValueError, IndexError):
        pass
    return default


class NodeCollector(osmium.SimpleHandler):
    """Stream the source PBF once, retaining only coordinates near the chosen box.

    This intentionally avoids osmium extract's potentially huge max-node-ID
    bitsets, and avoids storing all of Austria's locations in RAM.
    """

    def __init__(self, bbox, padding=0.02):
        super().__init__()
        west, south, east, north = bbox
        self.west = max(-180, west - padding)
        self.east = min(180, east + padding)
        self.south = max(-90, south - padding)
        self.north = min(90, north + padding)
        self.nodes = {}
        self.scanned = 0
        self.started = time.monotonic()

    def node(self, node):
        self.scanned += 1
        if self.scanned % 1000000 == 0:
            print(f"  [1/2] OSM-Knoten gelesen: {self.scanned:,}; "
                  f"im Ausschnitt: {len(self.nodes):,}; "
                  f"Laufzeit: {time.monotonic() - self.started:.0f}s", flush=True)
        if not node.location.valid():
            return
        lat = node.location.lat
        lon = node.location.lon
        if self.west <= lon <= self.east and self.south <= lat <= self.north:
            self.nodes[int(node.id)] = (float(lat), float(lon))


class Reader(osmium.SimpleHandler):
    def __init__(self, node_positions=None):
        super().__init__()
        self.node_positions = node_positions
        self.nodes = {}
        self.edges = []
        self.rejected = 0
        self.ways = 0
        self.scanned = 0
        self.started = time.monotonic()

    def way(self, w):
        self.scanned += 1
        if self.scanned % 250000 == 0:
            print(f"  [2/2] OSM-Wege geprüft: {self.scanned:,}; "
                  f"befahrbare Wege im Ausschnitt: {self.ways:,}; "
                  f"Laufzeit: {time.monotonic() - self.started:.0f}s", flush=True)
        tags = w.tags
        highway = tags.get("highway", "")
        if highway not in ALLOWED:
            return
        if (tags.get("area") == "yes" or
            tags.get("access", "") in NO_ACCESS or
            tags.get("motor_vehicle", "") in NO_MOTOR or
            tags.get("motorcar", "") in NO_MOTOR or
            tags.get("vehicle", "") in NO_MOTOR):
            return
        speed, category = ALLOWED[highway]
        speed = speed_kmh(tags, speed)
        direction = tags.get("oneway", "")
        if tags.get("junction") == "roundabout" and not direction:
            direction = "yes"
        if highway in {"motorway", "motorway_link"} and not direction:
            direction = "yes"
        forward = direction not in {"-1", "reverse"}
        reverse = direction not in {"yes", "1", "true"} 
        coords = []
        for node in w.nodes:
            ident = int(node.ref)
            if self.node_positions is not None:
                position = self.node_positions.get(ident)
                # A node outside the region is not needed. Skip only the
                # crossing segment, never discard the whole road/way.
                coords.append((ident, position) if position is not None else None)
            else:
                if not node.location.valid():
                    self.rejected += 1
                    coords.append(None)
                else:
                    coords.append((ident, (float(node.location.lat), float(node.location.lon))))
        for pair_a, pair_b in zip(coords, coords[1:]):
            if pair_a is None or pair_b is None:
                continue
            start, startpos = pair_a
            end, endpos = pair_b
            if start == end:
                continue
            self.nodes[start] = startpos
            self.nodes[end] = endpos
            dist = meters(startpos, endpos)
            seconds = max(1, math.ceil(dist / (speed / 3.6)))
            if forward:
                self.edges.append((start, end, dist, seconds, category))
            if reverse:
                self.edges.append((end, start, dist, seconds, category))
        self.ways += 1


def make_graph(input_path, output_path, bbox=None):
    if not input_path.is_file():
        raise SystemExit(f"OSM file not found: {input_path}")
    if bbox is None:
        # Backward-compatible mode for already prepared, reference-complete PBF.
        reader = Reader()
        reader.apply_file(str(input_path), locations=True, idx="flex_mem")
    else:
        print("[1/2] Scanning OSM nodes in a padded bounding box ...", flush=True)
        locations = NodeCollector(bbox)
        locations.apply_file(str(input_path))
        print(f"[1/2] Done: {locations.scanned:,} nodes scanned, "
              f"{len(locations.nodes):,} retained in region.", flush=True)
        if len(locations.nodes) < 2:
            raise SystemExit("No map nodes found in the bounding box. Check ROADFUN_BBOX.")
        print("[2/2] Reading drivable roads and constructing edges ...", flush=True)
        reader = Reader(locations.nodes)
        reader.apply_file(str(input_path))
        print(f"[2/2] Done: {reader.scanned:,} ways scanned, "
              f"{reader.ways:,} matching drivable ways.", flush=True)
        locations.nodes.clear()
    if not reader.edges:
        raise SystemExit("No drivable ways in OSM extract.")
    # Drop tiny isolated components (undirected, conservative) to prevent
    # snapping into disconnected driveways and minor mapping fragments.
    adjacency = defaultdict(list)
    for a, b, *_ in reader.edges:
        adjacency[a].append(b)
        adjacency[b].append(a)
    visited = set()
    biggest = set()
    for node in adjacency:
        if node in visited:
            continue
        queue = deque([node])
        visited.add(node)
        group = set([node])
        while queue:
            here = queue.popleft()
            for n in adjacency[here]:
                if n not in visited:
                    visited.add(n)
                    group.add(n)
                    queue.append(n)
        if len(group) > len(biggest):
            biggest = group
    indices = {ident: i for i, ident in enumerate(sorted(biggest))}
    points = [reader.nodes[ident] for ident in sorted(biggest)]
    grouped = [[] for _ in points]
    for start, end, dist, secs, roadtype in reader.edges:
        a = indices.get(start)
        b = indices.get(end)
        if a is not None and b is not None:
            grouped[a].append((b, dist, secs, roadtype))
    offsets = [0]
    targets, metres, seconds, types = [], [], [], []
    for edges in grouped:
        # CSR adjacency: compact arrays and sequential memory for fast A*.
        for dest, dist, secs, category in edges:
            targets.append(dest)
            metres.append(dist)
            seconds.append(secs)
            types.append(category)
        offsets.append(len(targets))
    bounds = {
        "south": min(p[0] for p in points),
        "north": max(p[0] for p in points),
        "west": min(p[1] for p in points),
        "east": max(p[1] for p in points)
    }
    payload = {
        "version": 1,
        "region": input_path.stem,
        "bounds": bounds,
        "notice": "OpenStreetMap contributors (ODbL), road graph without turn restrictions",
        "lat": [round(p[0], 6) for p in points],
        "lon": [round(p[1], 6) for p in points],
        "offsets": offsets,
        "to": targets,
        "meters": metres,
        "seconds": seconds,
        "type": types
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = output_path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as out:
        json.dump(payload, out, separators=(",", ":"))
    tmp.replace(output_path)
    print(f"Local graph created at {output_path}: {len(points):,} nodes, "
          f"{len(targets):,} directed edges, {output_path.stat().st_size / 1048576:.1f} MiB")
    print(f"Bounds: {bounds}. Only roads INSIDE this graph can be routed.")
    print("WARNING: Simplified road model; no turn restrictions or lane guidance.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="small region .osm.pbf extract")
    parser.add_argument("output", type=Path)
    parser.add_argument("--bbox", metavar="W,S,E,N",
                        help="Stream directly from large PBF: bounding box as west,south,east,north")
    args = parser.parse_args()
    bbox = None
    if args.bbox is not None:
        try:
            values = [float(v.strip()) for v in args.bbox.split(",")]
        except ValueError as exc:
            parser.error(f"Invalid --bbox: {exc}")
        if (len(values) != 4 or any(not math.isfinite(v) for v in values) or
                not (-180 <= values[0] < values[2] <= 180) or
                not (-90 <= values[1] < values[3] <= 90)):
            parser.error("--bbox must be west,south,east,north; valid coordinates required")
        bbox = values
    make_graph(args.source, args.output, bbox=bbox)
