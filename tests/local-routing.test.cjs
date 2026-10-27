"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {LocalRouter,greatCircle}=require("../src/RoadFun.Api/wwwroot/local-router-core.js");
function graph(){
  // Coordinates: A -> B -> C is FAST; A -> D -> C is slower.
  // A -> C direct edge is shortest, but slowest. No reverse edges.
  const lat=[48.2,48.2,48.201,48.201],lon=[13.5,13.501,13.501,13.5];
  return {version:1,region:"offline-unit-test",bounds:{south:48.2,north:48.201,west:13.5,east:13.501},
    lat,lon,offsets:[0,3,4,4,5],to:[1,3,2,2,2],
    meters:[75,111,146,111,75],seconds:[3,10,24,3,10],type:[3,6,2,3,6]};
}
test("A* is computed locally and returns navigation-shaped response",()=>{
  const router=new LocalRouter(graph());
  const result=router.search({lat:48.2,lon:13.5},{lat:48.201,lon:13.501},"fast");
  assert.equal(result.provider,"Lokal · A* auf diesem Gerät");
  assert.deepEqual(result.geometry,[[13.5,48.2],[13.501,48.2],[13.501,48.201]]);
  assert.equal(result.distanceKm,.186);
  assert.equal(result.steps[0].type,"depart");
  assert.equal(result.steps[result.steps.length-1].type,"arrive");
  assert.ok(Number.isFinite(result.visitedNodes));
});
test("shortest route differs from fastest route",()=>{
  const router=new LocalRouter(graph());
  const shortest=router.search({lat:48.2,lon:13.5},{lat:48.201,lon:13.501},"short");
  assert.deepEqual(shortest.geometry,[[13.5,48.2],[13.501,48.201]]);
  assert.equal(shortest.distanceKm,.146);
});
test("one-way restrictions and graph bounds are honored",()=>{
  const router=new LocalRouter(graph());
  assert.throws(()=>router.search({lat:48.201,lon:13.501},{lat:48.2,lon:13.5},"fast"),
    /Keine Verbindung/);
  assert.throws(()=>router.search({lat:49.5,lon:13.5},{lat:48.2,lon:13.5},"short"),
    /außerhalb/);
});
test("malformed graph is rejected, distances are sensible",()=>{
  assert.throws(()=>new LocalRouter({version:1,lat:[],offsets:[]}),/Ungültige/);
  assert.ok(greatCircle(48.2,13.5,48.2,13.501)>65);
});
