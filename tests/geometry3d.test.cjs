"use strict";
const assert = require("node:assert/strict");
const geom = require("../src/RoadFun.Api/wwwroot/roadfun-geometry.js");

function approx(value, expected, eps=1e-5) {
  assert.ok(Math.abs(value-expected)<eps, `${value} is not within ${eps} of ${expected}`);
}

// OSRM coordinates are [longitude, latitude]. A northbound road must go -Z.
{
  const route = [[13.5,48.2],[13.5,48.21]];
  const g = geom.routeSceneData(route,[420,440],2);
  assert.equal(g.orientation,"north=-Z, east=+X");
  approx(g.vertices[0].x,g.vertices[1].x);
  assert.ok(g.vertices[1].z<g.vertices[0].z,"north must render upwards in map-aligned 3D");
  assert.equal(g.vertices.length,2);
  assert.ok(g.vertices[1].y>g.vertices[0].y,"higher point must be above lower point");
}
// Eastbound roads go +X, with no false north/south movement.
{
  const g = geom.routeSceneData([[13.5,48.2],[13.51,48.2]],[400,400],2);
  assert.ok(g.vertices[1].x>g.vertices[0].x);
  approx(g.vertices[1].z,g.vertices[0].z);
  assert.ok(g.sceneWidth>0);
}
// Heights must be interpolated by distance driven, NOT by array index.
{
  const route = [[13.5,48.2],[13.501,48.2],[13.51,48.2]];
  const s = geom.elevationLocations(route,3);
  approx(s[1][0],13.505,.000001);
  const g = geom.routeSceneData(route,[400,500,600],3);
  assert.ok(g.vertices[1].elevation>409 && g.vertices[1].elevation<412,
    `elevation at 10% distance should be near 410, received ${g.vertices[1].elevation}`);
}
// All bends in the actual OSRM geometry are retained as mesh anchors.
{
  const route = [[13.5,48.2],[13.505,48.2],[13.505,48.205],[13.51,48.205]];
  const g = geom.routeSceneData(route,[400,410,420,430],4);
  assert.equal(g.vertices.length,4);
  assert.ok(g.vertices[1].x>g.vertices[0].x);
  assert.ok(g.vertices[2].z<g.vertices[1].z);
  approx(g.vertices[2].x,g.vertices[1].x);
  assert.ok(g.totalMeters>500);
}
// Repeated/invalid points should not produce invalid surfaces.
{
  const g = geom.routeSceneData([[13.5,48.2],[13.5,48.2],[13.51,48.2]],[0,0],2);
  assert.equal(g.vertices.length,2);
  assert.throws(()=>geom.routeSceneData([[13.5,48.2],[13.5,48.2]],[0,0],2));
  assert.throws(()=>geom.routeSceneData([[500,48.2],[13.5,48.2]],[0,0],2));
  assert.throws(()=>geom.routeSceneData([[13.5,48.2],[13.51,48.2]],[null,300],2));
}
console.log("3D geometry orientation, distance sampling and shape tests passed");
