/* RoadFun 3D relief viewer v5.
 * Elevations: Mapzen Terrain Tiles (Terrarium), satellite imagery: Esri World Imagery,
 * individual tagged trees / forest polygons: OpenStreetMap via bounded backend Overpass query.
 * Forest trees are approximations, satellite imagery is not a real 3D model.
 */
(function (root) {
  "use strict";
  let active = null, generation = 0;
  const $ = id => document.getElementById(id);
  const T = () => root.RoadFunTerrain;

  function stop() {
    generation++;
    const view = active;
    active = null;
    if (!view) return;
    view.abort.abort();
    cancelAnimationFrame(view.frame);
    view.observer?.disconnect();
    view.controls?.dispose();
    const doneTextures = new Set(), doneGeometries = new Set(), doneMaterials = new Set();
    view.scene.traverse(object => {
      if (object.geometry && !doneGeometries.has(object.geometry)) {
        doneGeometries.add(object.geometry);object.geometry.dispose();
      }
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (!material || doneMaterials.has(material)) continue;
        doneMaterials.add(material);
        if(material.map && !doneTextures.has(material.map)){doneTextures.add(material.map);material.map.dispose();}
        material.dispose();
      }
    });
    view.extraTextures.forEach(t=>{if(!doneTextures.has(t))t.dispose();});
    view.renderer.dispose();
    view.renderer.domElement.remove();
  }
  function close() {
    stop();
    $("modal").hidden = true;
    $("terrain").replaceChildren();
  }
  function roadRibbon(points, width, THREE) {
    const positions=[],indices=[],left=[],right=[];
    let nx=0,nz=1;
    for(let i=0;i<points.length;i++) {
      const p=points[i],prev=points[Math.max(0,i-1)],next=points[Math.min(points.length-1,i+1)];
      const dx=next.x-prev.x,dz=next.z-prev.z,length=Math.hypot(dx,dz);
      if(length>1e-7){nx=-dz/length;nz=dx/length;}
      const a=new THREE.Vector3(p.x+nx*width/2,p.y,p.z+nz*width/2);
      const b=new THREE.Vector3(p.x-nx*width/2,p.y,p.z-nz*width/2);
      left.push(a);right.push(b);positions.push(a.x,a.y,a.z,b.x,b.y,b.z);
      if(i<points.length-1){const j=i*2;indices.push(j,j+1,j+2,j+1,j+3,j+2);}
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
    geo.setIndex(indices);geo.computeVertexNormals();
    return {geometry:geo,left,right};
  }
  function marker(THREE,group,position,color,radius){
    const m=new THREE.Mesh(new THREE.SphereGeometry(radius,12,10),
      new THREE.MeshBasicMaterial({color}));
    m.position.copy(position);m.position.y+=radius*0.9;group.add(m);
  }
  function groundTile(THREE, tile, project, heightY, elev, segments=30) {
    const positions=[],normals=[],uvs=[],indices=[],b=tile.bounds;
    for(let v=0;v<=segments;v++)for(let u=0;u<=segments;u++){
      const fracU=u/segments,fracV=v/segments;
      // Web Mercator tile pixels, not linear latitudes (otherwise aerial photos slip).
      const p=T().tileLatLon(tile.x+fracU,tile.y+fracV,tile.z);
      const scene=project.project(p.lon,p.lat);
      let h=elev.sample(p.lon,p.lat);
      if(!Number.isFinite(h))h=heightY.base;
      positions.push(scene.x,heightY.at(h),scene.z);
      uvs.push(fracU,1-fracV);normals.push(0,1,0);
      if(u<segments&&v<segments){
        const a=v*(segments+1)+u,bb=a+1,c=a+segments+1,d=c+1;
        indices.push(a,c,bb,bb,c,d);
      }
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));
    geometry.setIndex(indices);geometry.computeVertexNormals();
    const mat=new THREE.MeshBasicMaterial({color:0x3b6553,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(geometry,mat);mesh.userData.tile=tile;
    return mesh;
  }

  function createForest(THREE,positions,proj,elev,heightY,road,roadWidth) {
    const group=new THREE.Group();
    const valid=[];
    const sampleRoad=road.filter((_,i)=>i%Math.max(1,Math.floor(road.length/220))===0);
    const nearRoad=(x,z)=>sampleRoad.some(v=>Math.hypot(v.x-x,v.z-z)<roadWidth*2.1);
    for(const p of positions) {
      const m=proj.project(p.lon,p.lat),h=elev.sample(p.lon,p.lat);
      if(!Number.isFinite(h)||nearRoad(m.x,m.z))continue;
      valid.push({x:m.x,z:m.z,h,source:p.source});
    }
    if(!valid.length)return {group,count:0,exact:0};
    const canopyGeo=new THREE.ConeGeometry(1,1,5),trunkGeo=new THREE.CylinderGeometry(.17,.2,1,5);
    const canopy=new THREE.InstancedMesh(canopyGeo,new THREE.MeshLambertMaterial({color:0xffffff}),valid.length);
    const trunk=new THREE.InstancedMesh(trunkGeo,new THREE.MeshLambertMaterial({color:0x60462a}),valid.length);
    const dummy=new THREE.Object3D(),color=new THREE.Color();
    valid.forEach((p,i)=>{
      const treeMetres=(p.source==="surveyed"?12:9)+(i%7)*.8;
      const tall=Math.max(.7,treeMetres*proj.unitsPerMetre);
      const base=heightY.at(p.h);
      dummy.position.set(p.x,base+tall*.24,p.z);
      dummy.scale.set(tall*.12,tall*.48,tall*.12);dummy.updateMatrix();
      trunk.setMatrixAt(i,dummy.matrix);
      dummy.position.set(p.x,base+tall*.69,p.z);
      dummy.scale.set(tall*.34,tall*.68,tall*.34);dummy.updateMatrix();
      canopy.setMatrixAt(i,dummy.matrix);
      color.setHSL(.30+(i%7)*.012,.39+(i%3)*.05,.29+(i%5)*.025);
      canopy.setColorAt(i,color);
    });
    canopy.instanceMatrix.needsUpdate=true;
    trunk.instanceMatrix.needsUpdate=true;
    if(canopy.instanceColor)canopy.instanceColor.needsUpdate=true;
    canopy.frustumCulled=false;trunk.frustumCulled=false;
    group.add(trunk,canopy);
    return {group,count:valid.length,exact:positions.filter(x=>x.source==="surveyed").length};
  }

  async function open(rawGeometry, api, toast) {
    if(!root.THREE||!root.THREE.OrbitControls||!root.RoadFunGeometry||!T())
      return toast("3D-Module fehlen. Bitte die Web-App aktualisieren.",true);
    if(!rawGeometry?.length||rawGeometry.length<2)return toast("Bitte zuerst Route berechnen",true);
    $("modal").hidden=false;
    stop();
    const id=generation, abort=new AbortController();
    const uiStatus=$("terrainStatus"),terrainRoot=$("terrain");
    const status=(s)=>{if(id===generation && !$("modal").hidden)uiStatus.textContent=s;};
    terrainRoot.innerHTML='<p class="terrain-loading">Lade Geländedaten und berechne Relief …</p>';
    status("Lade Höhenkacheln …");

    const THREE=root.THREE, proj=T().projectFactory(rawGeometry),cov=T().coverage(rawGeometry,16);
    let elev=null, fallbackData=null;
    try {
      elev=await T().demSampler(cov,abort.signal,(n,total)=>status("Höhenkacheln: "+n+"/"+total));
    } catch(error) {
      if(id!==generation || $("modal").hidden)return;
      console.warn("Mapzen relief:",error);
      status("Höhenraster nicht verfügbar – benutze einfache Höhenlinie (ohne Satellitengelände).");
      try {
        const samples=RoadFunGeometry.elevationLocations(rawGeometry,30);
        const res=await api("/elevation?points="+encodeURIComponent(samples.map(p=>p[1]+","+p[0]).join("|")));
        fallbackData=RoadFunGeometry.routeSceneData(rawGeometry,res.elevations,samples.length);
      }catch(inner) {
        if(id===generation)terrainRoot.textContent="3D-Höhendaten derzeit nicht erreichbar: "+inner.message;
        return;
      }
    }
    if(id!==generation||$("modal").hidden)return;

    let renderer=null;
    try{
      const width=terrainRoot.clientWidth,height=terrainRoot.clientHeight;
      if(width<10||height<10)throw Error("3D-Ansicht zu klein");
      const scene=new THREE.Scene();scene.background=new THREE.Color(0x0b1728);
      const camera=new THREE.PerspectiveCamera(48,width/height,.1,10000);
      renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:"low-power"});
      renderer.setPixelRatio(Math.min(root.devicePixelRatio||1,1.7));
      renderer.setSize(width,height);
      renderer.outputEncoding=THREE.sRGBEncoding;
      terrainRoot.replaceChildren(renderer.domElement);
      scene.add(new THREE.HemisphereLight(0xffffff,0x293d35,1.1));
      const sunlight=new THREE.DirectionalLight(0xffffff,.65);sunlight.position.set(30,110,-40);scene.add(sunlight);
      const controls=new THREE.OrbitControls(camera,renderer.domElement);
      controls.enableDamping=true;
      controls.maxPolarAngle=Math.PI*.86;
      const terrainGroup=new THREE.Group(),roadGroup=new THREE.Group(),treeGroup=new THREE.Group();
      const scaled=new THREE.Group();
      scaled.add(terrainGroup,roadGroup,treeGroup);scene.add(scaled);

      const route=RoadFunGeometry.coordinates(rawGeometry);
      const base=elev ? Math.min(...RoadFunGeometry.elevationLocations(route,30).map(p=>elev.sample(p[0],p[1])).filter(Number.isFinite)) :
        fallbackData.minElevation;
      const heightY={base,at:(h)=>Math.max(-1500,Math.min(9000,h-base))*proj.unitsPerMetre*1.5};
      // Approximate 6m road width with a minimum on-screen visibility.
      const roadWidth=Math.max(.34,Math.min(1.45,proj.unitsPerMetre*6));
      const roadPts=[];
      if(elev) {
        // Keep every turn for normal routes; sub-sample huge routes for iPhone performance.
        const step=Math.max(1,Math.ceil(route.length/1400));
        for(let i=0;i<route.length;i+=step) {
          const p=route[i],xy=proj.project(p[0],p[1]),h=elev.sample(p[0],p[1]);
          roadPts.push(new THREE.Vector3(xy.x,heightY.at(Number.isFinite(h)?h:base)+.16,xy.z));
        }
        const last=route[route.length-1],xy=proj.project(last[0],last[1]);
        if((route.length-1)%step!==0)
          roadPts.push(new THREE.Vector3(xy.x,heightY.at(elev.sample(last[0],last[1]))+.16,xy.z));
      } else {
        fallbackData.vertices.forEach(v=>roadPts.push(new THREE.Vector3(v.x,v.y,v.z)));
      }
      const curved=new THREE.CatmullRomCurve3(roadPts,false,"centripetal");
      const rough=curved.getPoints(Math.min(2700,Math.max(200,roadPts.length*2)));
      // Re-sample Y AFTER horizontal smoothing, so bends never float over the raster relief.
      const curvePoints=elev ? rough.map(p=>{
        const coord=proj.unproject(p.x,p.z),h=elev.sample(coord.lon,coord.lat);
        return new THREE.Vector3(p.x,heightY.at(Number.isFinite(h)?h:base)+.18,p.z);
      }):rough;

      const ribbon=roadRibbon(curvePoints,roadWidth,THREE);
      const roadMesh=new THREE.Mesh(ribbon.geometry,new THREE.MeshBasicMaterial({color:0x299bff,side:THREE.DoubleSide}));
      roadGroup.add(roadMesh);
      for(const side of [ribbon.left,ribbon.right])
        roadGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(side),
          new THREE.LineBasicMaterial({color:0xd4edff})));
      marker(THREE,roadGroup,curvePoints[0],0x27d69e,roadWidth*.8);
      marker(THREE,roadGroup,curvePoints[curvePoints.length-1],0xff7474,roadWidth*.8);

      const tileMeshes=[];
      if(elev){
        for(const tile of cov.imagery) {
          const mesh=groundTile(THREE,tile,proj,heightY,elev,cov.zoom>=13?32:24);
          terrainGroup.add(mesh);tileMeshes.push(mesh);
        }
      } else {
        // Graceful fallback: existing route still works even when the DEM tile source is down.
        const plane=new THREE.Mesh(new THREE.PlaneGeometry(115,115),new THREE.MeshBasicMaterial({
          color:0x284a3b,transparent:true,opacity:.35,side:THREE.DoubleSide
        }));
        plane.rotation.x=-Math.PI/2;plane.position.y=-.3;terrainGroup.add(plane);
      }

      const bounds=new THREE.Box3().setFromPoints(curvePoints),center=bounds.getCenter(new THREE.Vector3());
      const dim=bounds.getSize(new THREE.Vector3());
      const extent=Math.max(42,dim.x,dim.z,dim.y*2);
      const grid=new THREE.GridHelper(Math.max(110,extent*1.5),22,0x386185,0x28415b);
      grid.position.y=-.04;scene.add(grid);
      const north=new THREE.ArrowHelper(new THREE.Vector3(0,0,-1),
        new THREE.Vector3(center.x-extent*.55,0.3,center.z+extent*.56),
        extent*.15,0xffffff,extent*.04,extent*.025);
      scene.add(north);
      const initialCamera=new THREE.Vector3(center.x,center.y+extent*.98,center.z+extent*.79);
      function resetCamera(){
        camera.up.set(0,1,0);camera.position.copy(initialCamera);
        controls.target.copy(center);controls.update();
      }
      resetCamera();
      controls.minDistance=1;
      controls.maxDistance=Math.max(250,extent*15);
      const extraTextures=[];
      const view={renderer,controls,scene,observer:null,abort,frame:0,extraTextures};active=view;

      const terrainSwitch=$("layerTerrain"),satSwitch=$("layerSatellite"),
        roadSwitch=$("layerRoad"),treeSwitch=$("layerTrees"),
        gridSwitch=$("showSurroundings"),relief=$("terrainRelief");
      const treeLabel=$("treeCount");
      terrainSwitch.checked=true;satSwitch.checked=!!elev;roadSwitch.checked=true;
      treeSwitch.checked=!!elev;gridSwitch.checked=false;relief.value="1.5";
      treeLabel.textContent=elev?"Baumdaten werden geladen …":"Ohne DEM keine Baummodelle";
      satSwitch.disabled=!elev;treeSwitch.disabled=!elev;
      function updateLayers(){
        terrainGroup.visible=terrainSwitch.checked;
        roadGroup.visible=roadSwitch.checked;
        treeGroup.visible=treeSwitch.checked;
        grid.visible=north.visible=gridSwitch.checked;
        scaled.scale.y=Number(relief.value)/1.5;
        $("terrainReliefLabel").textContent=Number(relief.value).toFixed(1)+"×";
        for(const mesh of tileMeshes){
          mesh.material.map=satSwitch.checked ? (mesh.userData.satellite||null) : null;
          mesh.material.color.set(satSwitch.checked&&mesh.userData.satellite?0xffffff:0x3b6553);
          mesh.material.needsUpdate=true;
        }
      }
      for(const control of [terrainSwitch,satSwitch,roadSwitch,treeSwitch,gridSwitch,relief])
        control.oninput=updateLayers;
      updateLayers();
      $("reset3dView").onclick=resetCamera;

      const information=$("terrainStats");
      information.textContent="Start ● grün · Ziel ● rot · "+(RoadFunGeometry.cumulative(route).at(-1)/1000).toFixed(1)+
        " km · "+(elev?"DEM z"+cov.demZoom+" · Satelliten z"+cov.zoom+" · "+cov.imagery.length+" Bildkacheln":"Höhenraster derzeit nicht erreichbar");

      const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(()=>{
        const w=terrainRoot.clientWidth,h=terrainRoot.clientHeight;
        if(w>0&&h>0){camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h);}
      }):null;
      observer?.observe(terrainRoot);view.observer=observer;
      const render=()=>{
        if(active!==view)return;
        view.frame=requestAnimationFrame(render);
        controls.update();renderer.render(scene,camera);
      };
      render();

      if(elev){
        // Imagery is loaded asynchronously and only for this bounded region. Tile
        // failure never removes the underlying terrain or the road.
        const loader=new THREE.TextureLoader();
        loader.setCrossOrigin("anonymous");
        let completed=0,failed=0;
        for(const mesh of tileMeshes){
          if(active!==view)break;
          const tex=loader.load(T().satelliteUrl(mesh.userData.tile),
            ()=>{
              if(active!==view)return;
              tex.encoding=THREE.sRGBEncoding;
              tex.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());
              mesh.userData.satellite=tex;updateLayers();
              completed++;status("Satellitenbilder: "+completed+"/"+tileMeshes.length+
                (failed?" ("+failed+" fehlen)":""));
            },undefined,()=>{
              failed++;completed++;
              status("Satellitenbilder teilweise nicht erreichbar ("+failed+" fehlen)");
            });
          extraTextures.push(tex);
        }

        // Overpass request only for reasonably small geographical regions.
        const b=cov.bbox;
        if(b.north-b.south<=.12 && b.east-b.west<=.12) {
          const query=new URLSearchParams({south:b.south,west:b.west,north:b.north,east:b.east});
          api("/terrain/vegetation?"+query,{signal:abort.signal}).then(payload=>{
            if(active!==view)return;
            const trees=T().vegetationFromOverpass(payload.elements,b,500);
            const visual=createForest(THREE,trees,proj,elev,heightY,curvePoints,roadWidth);
            treeGroup.add(visual.group);updateLayers();
            treeLabel.textContent=visual.count+" Baum-Modelle (davon "+
              Math.min(visual.exact,visual.count)+" aus einzeln kartierten Standorten)";
          }).catch(err=>{
            if(active!==view)return;
            treeLabel.textContent="OSM-Baumdaten nicht verfügbar";
            console.warn("RoadFun vegetation:",err.message);
          });
        }else{
          treeLabel.textContent="Baum-Modelle für lange Routen deaktiviert (Ausschnitt zu groß)";
        }
      }
    }catch(error){
      console.error("RoadFun terrain viewer:",error);
      renderer?.dispose();
      if(id===generation)terrainRoot.textContent="3D-Szene konnte nicht angezeigt werden: "+error.message;
      toast("Fehler in der 3D-Ansicht",true);
    }
  }
  root.RoadFun3D={open,close};
})(window);
