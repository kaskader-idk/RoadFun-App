/* RoadFun curved 3D route: a continuous flat road ribbon over sampled elevations.
 * North = -Z, east = +X; the initial camera looks north from the south.
 * This is a 3D elevation visualization, NOT a real-world road-width or 3D terrain model.
 */
(function (root) {
  "use strict";
  let active = null, requestId = 0;

  function stop() {
    requestId++;
    const view = active;
    active = null;
    if (!view) return;
    cancelAnimationFrame(view.frame);
    view.observer?.disconnect();
    view.controls?.dispose();
    view.scene.traverse(object => {
      object.geometry?.dispose();
      if (object.material) {
        (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => m.dispose());
      }
    });
    view.renderer.dispose();
    view.renderer.domElement.remove();
  }
  function close() {
    stop();
    document.getElementById("modal").hidden = true;
    document.getElementById("terrain").replaceChildren();
  }

  // Each pair of samples gets 2 vertices on a smooth, constant-width horizontal road.
  // Index winding is double-sided so steep hills don't cause triangles to disappear.
  function roadRibbon(points, width, THREE) {
    const positions = [], indices = [], left = [], right = [];
    let previousNormalX = 0, previousNormalZ = 1;
    const halfWidth = width / 2;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)];
      let dx = after.x - before.x, dz = after.z - before.z;
      const length = Math.hypot(dx, dz);
      if (length > 1e-7) {
        previousNormalX = -dz / length;
        previousNormalZ = dx / length;
      }
      const y = p.y + 0.025;
      const l = new THREE.Vector3(p.x + previousNormalX * halfWidth, y, p.z + previousNormalZ * halfWidth);
      const r = new THREE.Vector3(p.x - previousNormalX * halfWidth, y, p.z - previousNormalZ * halfWidth);
      left.push(l); right.push(r);
      positions.push(l.x, l.y, l.z, r.x, r.y, r.z);
      if (i !== points.length - 1) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return { geometry, left, right };
  }

  function endMarker(scene, THREE, p, color, radius) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 18, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    marker.position.copy(p);
    marker.position.y += 0.2;
    scene.add(marker);
  }

  async function open(rawGeometry, api, toast) {
    if (!root.THREE || !root.THREE.OrbitControls || !root.RoadFunGeometry)
      return toast("3D-Ansicht konnte nicht geladen werden. Bitte aktualisieren.", true);
    if (!rawGeometry || rawGeometry.length < 2)
      return toast("Bitte zuerst eine Route berechnen", true);

    const modal = document.getElementById("modal");
    const rootElement = document.getElementById("terrain");
    modal.hidden = false;
    stop();
    const id = requestId;
    rootElement.innerHTML = '<p class="terrain-loading">Berechne Straßenverlauf und lade Höhendaten …</p>';

    let data, samples;
    try {
      samples = RoadFunGeometry.elevationLocations(rawGeometry, 30);
      const query = samples.map(p => p[1].toFixed(6) + "," + p[0].toFixed(6)).join("|");
      const response = await api("/elevation?points=" + encodeURIComponent(query));
      if (id !== requestId || modal.hidden) return;
      data = RoadFunGeometry.routeSceneData(rawGeometry, response.elevations, samples.length);
    } catch (error) {
      if (id === requestId && !modal.hidden)
        rootElement.textContent = "3D-Höhenansicht nicht verfügbar: " + error.message;
      return;
    }

    const THREE = root.THREE;
    let renderer;
    try {
      const width = rootElement.clientWidth, height = rootElement.clientHeight;
      if (!width || !height) throw Error("3D-Fenster hat keine gültige Größe");
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b1728);
      const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 6000);
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
      renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.outputEncoding = THREE.sRGBEncoding;

      rootElement.replaceChildren(renderer.domElement);
      const controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI * 0.88; // avoid flipping the view beneath the ground

      // Each original route point, including its real bends, is used as an anchor.
      // Catmull-Rom adds smooth intermediate geometry instead of straight, 30-point links.
      const rawPoints = data.vertices.map(v => new THREE.Vector3(v.x, v.y, v.z));
      const roadCurve = new THREE.CatmullRomCurve3(rawPoints, false, "centripetal");
      const subdivisions = Math.min(3400, Math.max(220, rawPoints.length * 3));
      const points = roadCurve.getPoints(subdivisions);

      const ribbon = roadRibbon(points, data.sceneWidth, THREE);
      scene.add(new THREE.Mesh(ribbon.geometry, new THREE.MeshBasicMaterial({
        color: 0x299bff, side: THREE.DoubleSide
      })));
      // White edges make the width and the curve visible at every zoom level.
      for (const edge of [ribbon.left, ribbon.right]) {
        scene.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(edge),
          new THREE.LineBasicMaterial({ color: 0xb3e1ff, opacity: 0.9, transparent: true })
        ));
      }
      endMarker(scene, THREE, points[0], 0x32d7a3, data.sceneWidth * 0.8);
      endMarker(scene, THREE, points[points.length - 1], 0xff7b7b, data.sceneWidth * 0.8);

      const bounds = new THREE.Box3().setFromPoints(points);
      const center = bounds.getCenter(new THREE.Vector3());
      const sizes = bounds.getSize(new THREE.Vector3());
      const extent = Math.max(28, sizes.x, sizes.z, sizes.y * 2);
      const grid = new THREE.GridHelper(Math.max(110, extent * 1.5), 22, 0x386185, 0x28415b);
      grid.position.y = 0;
      scene.add(grid);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(110, extent * 1.5), Math.max(110, extent * 1.5)),
        new THREE.MeshBasicMaterial({ color: 0x19364a, transparent: true, opacity: 0.24, side: THREE.DoubleSide }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.15;
      scene.add(floor);
      const northArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(data.bounds.minX - 8, 0.25, data.bounds.maxZ + 6),
        Math.max(8, extent * 0.14), 0xffffff, Math.max(2, extent * 0.04), Math.max(1.1, extent * 0.025)
      );
      scene.add(northArrow);

      const initialCamera = new THREE.Vector3(center.x, center.y + extent * 1.1, center.z + extent * 0.85);
      function resetCamera() {
        camera.up.set(0, 1, 0);
        camera.position.copy(initialCamera);
        controls.target.copy(center);
        controls.update();
      }
      resetCamera();
      controls.minDistance = 3;
      controls.maxDistance = Math.max(250, extent * 12);

      const checkbox = document.getElementById("showSurroundings");
      checkbox.checked = true;
      checkbox.onchange = () => {
        grid.visible = floor.visible = northArrow.visible = checkbox.checked;
      };
      const resetButton = document.getElementById("reset3dView");
      if (resetButton) resetButton.onclick = resetCamera;
      const information = document.getElementById("terrainStats");
      if (information) information.textContent =
        "Start ● grün · Ziel ● rot · Norden: weißer Pfeil · " +
        (data.totalMeters / 1000).toFixed(1) + " km · " +
        Math.round(data.minElevation) + "–" + Math.round(data.maxElevation) + " m Seehöhe";

      const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
        const w = rootElement.clientWidth, h = rootElement.clientHeight;
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }) : null;
      observer?.observe(rootElement);
      const view = { renderer, controls, observer, scene, frame: 0 };
      active = view;
      const render = () => {
        if (active !== view) return;
        view.frame = requestAnimationFrame(render);
        controls.update();
        renderer.render(scene, camera);
      };
      render();
    } catch (error) {
      renderer?.dispose();
      rootElement.textContent = "3D-Darstellung fehlgeschlagen: " + error.message;
      toast("3D-Ansicht konnte nicht gerendert werden", true);
    }
  }

  root.RoadFun3D = { open, close };
})(window);
