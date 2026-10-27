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


class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.nodes = {}
        self.edges = []
        self.rejected = 0
        self.ways = 0

    def way(self, w):
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
            if not node.location.valid():
                self.rejected += 1
                return
            coords.append((int(node.ref), (float(node.location.lat), float(node.location.lon))))
        for (start, startpos), (end, endpos) in zip(coords, coords[1:]):
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


def make_graph(input_path, output_path):
    reader = Reader()
    reader.apply_file(str(input_path), locations=True, idx="flex_mem")
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
    args = parser.parse_args()
    make_graph(args.source, args.output)
