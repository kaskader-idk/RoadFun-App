"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const web = path.resolve(__dirname, "../src/RoadFun.Api/wwwroot");
const html = fs.readFileSync(path.join(web, "index.html"), "utf8");
const js = fs.readFileSync(path.join(web, "terrain3d.js"), "utf8");
const sw = fs.readFileSync(path.join(web, "sw.js"), "utf8");

test("3D building checkbox is declared before use and exists in DOM", () => {
  const declaration = js.indexOf('buildingSwitch=$("layerBuildings")');
  const use = js.indexOf("buildingSwitch.checked");
  assert.ok(declaration >= 0, "3D renderer must declare buildingSwitch");
  assert.ok(use > declaration, "buildingSwitch must be declared before its first use");
  assert.match(html, /id="layerBuildings"/);
  assert.match(html, /id="buildingCount"/);
});

test("PWA HTML and service worker reference the same fresh 3D script", () => {
  const match = html.match(/src="(\/terrain3d\.js\?v=\d+)"/);
  assert.ok(match, "3D script version must be present");
  assert.ok(sw.includes("'" + match[1] + "'"), "service worker must cache the exact 3D asset version");
  assert.match(sw, /roadfun-shell-v9/);
});
