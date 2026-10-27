/* Pure coordinate and height sampling helpers for the 3D route.
 * OSRM: [longitude, latitude]. Three.js: +X east, -Z north, +Y up.
 * These functions also run under Node to allow deterministic geometry tests.
 */
(function (root) {
  "use strict";
  const rad = Math.PI / 180;
  function coordinates(geometry) {
    if (!Array.isArray(geometry) || geometry.length < 2) throw Error("Keine vollständige Route vorhanden");
    const good = geometry.map(pair => {
      if (!Array.isArray(pair) || pair.length < 2) throw Error("Ungültige Route");
      const lon = Number(pair[0]), lat = Number(pair[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
        throw Error("Ungültige Routenkoordinaten");
      return [lon, lat];
    }).filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
    if (good.length < 2) throw Error("Route enthält zu wenige verschiedene Punkte");
    return good;
  }
  function segmentMeters(a, b) {
    const dLat = (b[1] - a[1]) * rad;
    const dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function cumulative(pts) {
    const distances = [0];
    for (let i = 1; i < pts.length; i++)
      distances.push(distances[i - 1] + segmentMeters(pts[i - 1], pts[i]));
    return distances;
  }
  function interpolatePoint(pts, distances, target) {
    let lo = 0, hi = distances.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (distances[mid] < target) lo = mid + 1; else hi = mid;
    }
    const next = Math.max(1, lo), prev = next - 1;
    const span = distances[next] - distances[prev];
    const t = span > 0 ? Math.max(0, Math.min(1, (target - distances[prev]) / span)) : 0;
    return [pts[prev][0] + t * (pts[next][0] - pts[prev][0]),
      pts[prev][1] + t * (pts[next][1] - pts[prev][1])];
  }
  function elevationLocations(raw, count = 30) {
    const pts = coordinates(raw), distances = cumulative(pts);
    const total = distances[distances.length - 1];
    if (total < 0.01) throw Error("Strecke ist zu kurz");
    const size = Math.max(2, Math.min(30, Math.round(count)));
    return Array.from({ length: size }, (_, i) =>
      interpolatePoint(pts, distances, total * i / (size - 1)));
  }
  function routeSceneData(raw, sampledElevations, elevationCount = 30) {
    const pts = coordinates(raw), distances = cumulative(pts);
    const total = distances[distances.length - 1];
    if (total < 0.01) throw Error("Strecke ist zu kurz");
    if (!Array.isArray(sampledElevations) || sampledElevations.length !== Math.max(2, Math.min(30, Math.round(elevationCount))) ||
      !sampledElevations.every(Number.isFinite)) throw Error("Höhendaten sind unvollständig");
    const minElevation = Math.min(...sampledElevations);
    const minLon = Math.min(...pts.map(p => p[0])), maxLon = Math.max(...pts.map(p => p[0]));
    const minLat = Math.min(...pts.map(p => p[1])), maxLat = Math.max(...pts.map(p => p[1]));
    const centerLon = (minLon + maxLon) / 2, centerLat = (minLat + maxLat) / 2;
    const eastWeight = Math.max(0.01, Math.cos(centerLat * rad));
    const scale = 80 / Math.max((maxLon - minLon) * eastWeight, maxLat - minLat, 0.000001);
    const low = 0, heightExaggeration = 0.045;
    let vertices = pts.map((p, i) => {
      const scaled = (distances[i] / total) * (sampledElevations.length - 1);
      const j = Math.min(sampledElevations.length - 2, Math.floor(scaled));
      const fraction = Math.max(0, Math.min(1, scaled - j));
      const elevation = sampledElevations[j] * (1 - fraction) + sampledElevations[j + 1] * fraction;
      return {
        x: (p[0] - centerLon) * eastWeight * scale,
        y: (elevation - minElevation) * heightExaggeration + 2,
        z: -(p[1] - centerLat) * scale, // NORTH IS NEGATIVE Z
        distance: distances[i], elevation
      };
    });
    // Preserve overall shape while bounding browser/GPU work for very large routes.
    const maxAnchors = 1800;
    if (vertices.length > maxAnchors) {
      const downsampled = [];
      for (let i = 0; i < maxAnchors; i++) {
        const target = total * i / (maxAnchors - 1);
        let lo = 0, hi = distances.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (distances[mid] < target) lo = mid + 1; else hi = mid;
        }
        const k = Math.max(1, lo), j = k - 1, d = distances[k] - distances[j];
        const t = d > 0 ? (target - distances[j]) / d : 0;
        downsampled.push({
          x: vertices[j].x + (vertices[k].x - vertices[j].x) * t,
          y: vertices[j].y + (vertices[k].y - vertices[j].y) * t,
          z: vertices[j].z + (vertices[k].z - vertices[j].z) * t,
          distance: target,
          elevation: vertices[j].elevation + (vertices[k].elevation - vertices[j].elevation) * t
        });
      }
      vertices = downsampled;
    }
    const minX = Math.min(...vertices.map(p => p.x)), maxX = Math.max(...vertices.map(p => p.x));
    const minZ = Math.min(...vertices.map(p => p.z)), maxZ = Math.max(...vertices.map(p => p.z));
    // Stylized road width: visible from above, not a claim about real-world lane width.
    const visibleWidth = Math.max(0.75, Math.min(1.8, Math.hypot(maxX - minX, maxZ - minZ) * 0.012));
    return {
      vertices, totalMeters: total, sceneWidth: visibleWidth,
      minElevation, maxElevation: Math.max(...sampledElevations),
      bounds: { minX, maxX, minZ, maxZ },
      orientation: "north=-Z, east=+X"
    };
  }
  const geometry = { coordinates, segmentMeters, cumulative, interpolatePoint, elevationLocations, routeSceneData };
  if (typeof module !== "undefined" && module.exports) module.exports = geometry;
  root.RoadFunGeometry = geometry;
})(typeof window !== "undefined" ? window : globalThis);
