"""Deterministic OSRM-compatible route fixture for RoadFun CI smoke tests."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

def step(lon, lat, distance, kind, modifier=None, road="Teststraße"):
    maneuver = {"type": kind, "location": [lon, lat]}
    if modifier:
        maneuver["modifier"] = modifier
    return {"distance": distance, "duration": distance / 10, "name": road, "maneuver": maneuver}

routes = [
    {
        "distance": 1450, "duration": 120,
        "geometry": {"type": "LineString", "coordinates": [[13.5, 48.2], [13.505, 48.205], [13.51, 48.21]]},
        "legs": [{"steps": [
            step(13.5, 48.2, 720, "depart"),
            step(13.505, 48.205, 730, "turn", "right", "Prüfstraße"),
            step(13.51, 48.21, 0, "arrive", road="")
        ]}]
    },
    {
        "distance": 1600, "duration": 160,
        "geometry": {"type": "LineString", "coordinates": [[13.5, 48.2], [13.507, 48.2], [13.507, 48.207], [13.51, 48.21]]},
        "legs": [{"steps": [
            step(13.5, 48.2, 700, "depart"),
            step(13.507, 48.207, 900, "turn", "left", "Kurvenweg"),
            step(13.51, 48.21, 0, "arrive", road="")
        ]}]
    }
]

class Handler(BaseHTTPRequestHandler):
    def serve_routes(self):
        payload = json.dumps({"code": "Ok", "routes": routes}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if not self.path.startswith("/route/v1/driving/"):
            self.send_error(404)
            return
        if "48.3" in self.path:
            self.send_error(502, "Simulated OSRM outage")
            return
        self.serve_routes()

    def do_POST(self):
        if self.path != "/route":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        if body.get("format") != "osrm" or body.get("shape_format") != "geojson":
            self.send_error(400, "Valhalla compatibility flags missing")
            return
        self.serve_routes()

    def log_message(self, *_):
        pass

if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 59118
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
