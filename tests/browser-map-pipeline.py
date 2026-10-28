"""End-to-end regression test for low-memory regional graph creation.

This tests the same code path as build-browser-map.sh, using a very small
local OSM XML fixture instead of downloading the whole Austria map.
"""
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


def test_pipeline():
    with TemporaryDirectory(prefix="roadfun-osm-test-") as temp:
        path = Path(temp)
        osm = path / "fixture.osm"
        graph = path / "region.json"
        osm.write_text(
            """<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="RoadFun test">
 <node id="1" lat="48.20000" lon="13.50000" version="1"/>
 <node id="2" lat="48.20000" lon="13.50100" version="1"/>
 <node id="3" lat="48.20100" lon="13.50100" version="1"/>
 <node id="4" lat="48.35000" lon="14.20000" version="1"/>
 <way id="101" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/>
  <tag k="highway" v="residential"/><tag k="maxspeed" v="30"/></way>
 <way id="102" version="1"><nd ref="3"/><nd ref="4"/>
  <tag k="highway" v="residential"/></way>
 <way id="103" version="1"><nd ref="1"/><nd ref="2"/>
  <tag k="highway" v="footway"/></way>
</osm>
""",
            encoding="utf-8"
        )
        script = Path(__file__).resolve().parents[1] / "scripts" / "create-browser-graph.py"
        command = [
            sys.executable, str(script), str(osm), str(graph),
            "--bbox", "13.49,48.19,13.52,48.22"
        ]
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        assert graph.is_file(), result.stdout
        payload = json.loads(graph.read_text(encoding="utf-8"))
        assert payload["version"] == 1
        assert len(payload["lat"]) == 3, payload
        assert len(payload["to"]) == 4, payload
        assert payload["bounds"]["west"] >= 13.5
        assert max(payload["lon"]) <= 13.501
        assert "OSM-Knoten gelesen" in result.stdout or "[1/2] Done" in result.stdout
        # JSON graph must remain intact on invalid input.
        invalid = subprocess.run(
            [sys.executable, str(script), str(osm), str(graph), "--bbox", "wrong"],
            capture_output=True, text=True
        )
        assert invalid.returncode != 0
        assert json.loads(graph.read_text())["version"] == 1
        print("Streaming OSM graph test passed")


if __name__ == "__main__":
    test_pipeline()
