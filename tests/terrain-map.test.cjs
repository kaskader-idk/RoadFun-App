"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
globalThis.RoadFunGeometry=require("../src/RoadFun.Api/wwwroot/roadfun-geometry.js");
const t=require("../src/RoadFun.Api/wwwroot/terrain-map.js");
const approx=(a,b,eps=1e-6)=>assert.ok(Math.abs(a-b)<eps,`${a} ~= ${b}`);
test("Web Mercator tile conversions round-trip WGS84 coordinates",()=>{
  for(const [lon,lat] of [[13.495,48.203],[9.99,47.11],[-122.45,37.79]]) {
    const loc=t.tileXY(lon,lat,13),p=t.tileLatLon(loc.x,loc.y,13);
    approx(p.lon,lon);approx(p.lat,lat);
  }
});
test("draped imagery and DEM always stay inside bounded tile budget",()=>{
  const route=[[13.45,48.2],[13.50,48.22],[13.55,48.24]];
  const c=t.coverage(route,16);
  assert.ok(c.imagery.length<=16 && c.imagery.length>0);
  assert.ok(c.dem.length>0 && c.dem.length<=16);
  assert.ok(c.zoom<=15 && c.zoom>=6);
  for(const img of c.imagery) {
    for(const corner of [
      [img.bounds.west+1e-7,img.bounds.north-1e-7],
      [img.bounds.east-1e-7,img.bounds.south+1e-7]
    ]) {
      const point=t.tileXY(corner[0],corner[1],c.demZoom);
      assert.ok(c.dem.some(d=>d.x===Math.floor(point.x)&&d.y===Math.floor(point.y)),
        `DEM should cover satellite pixel at ${corner}`);
    }
  }
});
test("tile-to-scene projection maps east to +X and north to -Z",()=>{
  const p=t.projectFactory([[13.49,48.2],[13.51,48.21]]);
  const west=p.project(13.49,48.2),east=p.project(13.51,48.2);
  const north=p.project(13.49,48.21);
  assert.ok(east.x>west.x && north.z<west.z);
  const n=p.unproject(north.x,north.z);
  approx(n.lon,13.49);approx(n.lat,48.21);
});
test("Mapzen Terrarium height encoding and bilinear sampling",()=>{
  approx(t.heightTerrarium(128,0,0),0);
  approx(t.heightTerrarium(129,44,0),300);
  approx(t.heightTerrarium(127,255,0),-1);
  const data=new Uint8ClampedArray([128,0,0,255,129,0,0,255,128,100,0,255,129,100,0,255]);
  approx(t.bilinear(data,2,2,0,0),0);
  approx(t.bilinear(data,2,2,.5,.5),178);
});
test("OSM single tree locations are exact; forest trees are labelled approximate",()=>{
  const region={west:13.49,east:13.51,south:48.19,north:48.21};
  const elements=[
    {type:"node",id:4,lat:48.2,lon:13.5,tags:{natural:"tree"}},
    {type:"way",id:20,tags:{landuse:"forest"},geometry:[
      {lat:48.201,lon:13.501},{lat:48.201,lon:13.506},
      {lat:48.206,lon:13.506},{lat:48.206,lon:13.501},
      {lat:48.201,lon:13.501}]}
  ];
  const trees=t.vegetationFromOverpass(elements,region,75);
  assert.ok(trees.length>1&&trees.length<=75);
  assert.equal(trees[0].source,"surveyed");
  assert.equal(trees[0].lat,48.2);
  assert.ok(trees.some(p=>p.source==="approximate"));
  assert.ok(trees.every(p=>p.lon>=region.west&&p.lon<=region.east));
});
