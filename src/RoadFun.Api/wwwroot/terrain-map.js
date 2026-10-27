/* RoadFun 3D geographic tiles; no build tooling required; pure helpers work in Node tests.
 * Satellite: Esri World Imagery; elevation: Mapzen/Terrarium AWS Open Data.
 * Browser fetches only a bounded number of 256x256 tiles around each route.
 */
(function (global) {
  "use strict";
  const rad = Math.PI / 180;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const tileCount = z => Math.pow(2, z);
  function tileXY(lon, lat, z) {
    const count = tileCount(z), phi = clamp(lat, -85.051128, 85.051128) * rad;
    return {
      x: clamp((lon + 180) / 360 * count, 0, count - 1e-8),
      y: clamp((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * count, 0, count - 1e-8)
    };
  }
  function tileLatLon(x, y, z) {
    const n = tileCount(z);
    return {
      lon: x / n * 360 - 180,
      lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / rad
    };
  }
  function tileBound(z, x, y) {
    const nw = tileLatLon(x, y, z), se = tileLatLon(x + 1, y + 1, z);
    return { north:nw.lat, west:nw.lon, south:se.lat, east:se.lon };
  }
  function bbox(coords) {
    const lon = coords.map(p=>p[0]),lat=coords.map(p=>p[1]);
    return { west:Math.min(...lon), east:Math.max(...lon), south:Math.min(...lat), north:Math.max(...lat) };
  }
  function tileRange(b, z) {
    const p = tileXY(b.west, b.north, z), q = tileXY(b.east, b.south, z);
    return { minX:Math.floor(p.x),maxX:Math.floor(q.x),minY:Math.floor(p.y),maxY:Math.floor(q.y) };
  }
  function tileList(b, z) {
    const range = tileRange(b, z), tiles=[];
    for(let y=range.minY;y<=range.maxY;y++)for(let x=range.minX;x<=range.maxX;x++)
      tiles.push({z,x,y,key:`${z}/${x}/${y}`,bounds:tileBound(z,x,y)});
    return tiles;
  }
  function coverage(raw, maxTiles = 16) {
    const pts=global.RoadFunGeometry?.coordinates(raw) || raw;
    const base=bbox(pts);
    const dLon=base.east-base.west, dLat=base.north-base.south;
    const padLon=Math.max(.0018,dLon*.055), padLat=Math.max(.0018,dLat*.055);
    const b={
      west:clamp(base.west-padLon,-179.99,179.99),east:clamp(base.east+padLon,-179.99,179.99),
      south:clamp(base.south-padLat,-85,85),north:clamp(base.north+padLat,-85,85)
    };
    let zoom=15;
    while(zoom>5 && tileList(b,zoom).length>maxTiles) zoom--;
    const imagery=tileList(b,zoom);
    const demZoom=Math.min(13,zoom);
    const imageryBounds={
      west:Math.min(...imagery.map(t=>t.bounds.west)),
      east:Math.max(...imagery.map(t=>t.bounds.east)),
      north:Math.max(...imagery.map(t=>t.bounds.north)),
      south:Math.min(...imagery.map(t=>t.bounds.south))
    };
    const dem=tileList({
      west:imageryBounds.west+1e-8,east:imageryBounds.east-1e-8,
      south:imageryBounds.south+1e-8,north:imageryBounds.north-1e-8
    },demZoom);
    // Geospatially accurate tile envelopes (OSM's common XYZ/WebMercator scheme).
    return {bbox:b,routeBBox:base,zoom,demZoom,imagery,dem};
  }
  function projectFactory(raw) {
    const b=bbox(raw), cLat=(b.north+b.south)/2,cLon=(b.east+b.west)/2;
    const xFactor=111195*Math.cos(cLat*rad), zFactor=111195;
    const maxMetres=Math.max(200,(b.east-b.west)*xFactor,(b.north-b.south)*zFactor);
    const unitsPerMetre=80/maxMetres;
    return {
      unitsPerMetre, centerLat:cLat, centerLon:cLon,
      project(lon,lat) {return { x:(lon-cLon)*xFactor*unitsPerMetre,z:-(lat-cLat)*zFactor*unitsPerMetre };},
      unproject(x,z) {return {lon:cLon + x/(xFactor*unitsPerMetre),lat:cLat-z/(zFactor*unitsPerMetre)};}
    };
  }
  function heightTerrarium(r,g,b) { return r*256 + g + b/256 - 32768; }
  function bilinear(data,width,height,fx,fy) {
    const x=clamp(fx,0,width-1),y=clamp(fy,0,height-1),
      x0=Math.floor(x),x1=Math.min(width-1,x0+1), y0=Math.floor(y),y1=Math.min(height-1,y0+1),
      a=x-x0,b=y-y0;
    function sample(px,py) {
      const i=(py*width+px)*4;
      return heightTerrarium(data[i],data[i+1],data[i+2]);
    }
    return sample(x0,y0)*(1-a)*(1-b)+sample(x1,y0)*a*(1-b)+
      sample(x0,y1)*(1-a)*b+sample(x1,y1)*a*b;
  }
  const terrainUrl=t=>`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${t.z}/${t.x}/${t.y}.png`;
  const satelliteUrl=t=>`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${t.z}/${t.y}/${t.x}`;

  function loadImage(url, signal) {
    return new Promise((resolve,reject)=>{
      if (signal?.aborted) {reject(new Error("Abgebrochen"));return;}
      const img=new Image();
      img.crossOrigin="anonymous";
      const abort=()=>{img.src="";reject(new Error("Abgebrochen"));};
      const cleanup=()=>signal?.removeEventListener("abort",abort);
      img.onload=()=>{cleanup();resolve(img);};
      img.onerror=()=>{cleanup();reject(new Error("Bilddaten nicht verfügbar: "+new URL(url).hostname));};
      signal?.addEventListener("abort",abort,{once:true});
      img.src=url;
    });
  }
  async function demSampler(coverage, signal, onProgress=()=>{}) {
    const elevation=new Map(),tiles=coverage.dem;
    // Sequential requests cap peak memory and don't overload the public AWS dataset.
    for(let i=0;i<tiles.length;i++) {
      const tile=tiles[i];
      const img=await loadImage(terrainUrl(tile),signal);
      const canvas=document.createElement("canvas");
      canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
      const ctx=canvas.getContext("2d",{willReadFrequently:true});
      ctx.drawImage(img,0,0);
      const image=ctx.getImageData(0,0,canvas.width,canvas.height);
      elevation.set(tile.key,{width:image.width,height:image.height,data:image.data});
      onProgress(i+1,tiles.length);
    }
    function sample(lon,lat) {
      const px=tileXY(lon,lat,coverage.demZoom),x=Math.floor(px.x),y=Math.floor(px.y);
      let rx=x,ry=y,raster=elevation.get(`${coverage.demZoom}/${x}/${y}`);
      if (!raster) {
        // Geometries include both sides of an XYZ tile; coordinate exactly on
        // the eastern/southern border can address a non-fetched neighboring tile.
        outer: for (const dx of [0,-1,1])for(const dy of [0,-1,1]){
          const candidate=elevation.get(`${coverage.demZoom}/${x+dx}/${y+dy}`);
          if(candidate && Math.abs(px.x-(x+dx))<=1.00001 &&
            Math.abs(px.y-(y+dy))<=1.00001) {
            rx=x+dx;ry=y+dy;raster=candidate;break outer;
          }
        }
      }
      if(!raster)return NaN;
      return bilinear(raster.data,raster.width,raster.height,
        (px.x-rx)*(raster.width-1),(px.y-ry)*(raster.height-1));
    }
    return {sample,elevation,tiles};
  }
  function pointInside(lon,lat,polygon) {
    let inside=false;
    for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
      const a=polygon[i],b=polygon[j];
      if((a.lat>lat)!==(b.lat>lat) && lon<(b.lon-a.lon)*(lat-a.lat)/(b.lat-a.lat)+a.lon)
        inside=!inside;
    }
    return inside;
  }
  function vegetationFromOverpass(elements, region, limit=500) {
    const nodes=[],forests=[];
    for(const item of Array.isArray(elements)?elements:[]) {
      if(item.type==="node"&&item.tags?.natural==="tree"&&Number.isFinite(item.lat)&&Number.isFinite(item.lon))
        nodes.push({lon:item.lon,lat:item.lat,id:item.id});
      if(item.type==="way" && item.geometry?.length>=4 &&
        (item.tags?.natural==="wood" || item.tags?.landuse==="forest")) {
        const poly=item.geometry.filter(p=>Number.isFinite(p.lon)&&Number.isFinite(p.lat));
        if(poly.length>=4) forests.push({id:item.id,geometry:poly});
      }
    }
    const treePositions=[];
    const take = p=> {
      if(treePositions.length>=limit)return;
      if(p.lon<region.west||p.lon>region.east||p.lat<region.south||p.lat>region.north)return;
      treePositions.push(p);
    };
    // Exact OSM-tagged individual tree locations are always preferred.
    for(const tree of nodes)take({...tree,source:"surveyed"});
    for(const f of forests) {
      if(treePositions.length>=limit)break;
      const bb={west:Math.min(...f.geometry.map(p=>p.lon)),east:Math.max(...f.geometry.map(p=>p.lon)),
        south:Math.min(...f.geometry.map(p=>p.lat)),north:Math.max(...f.geometry.map(p=>p.lat))};
      const widthMetres=(bb.east-bb.west)*111195*Math.cos((bb.north+bb.south)/2*rad);
      const heightMetres=(bb.north-bb.south)*111195;
      const attempts=Math.min(150,Math.max(12,Math.round(widthMetres*heightMetres/13000)));
      let seed=(Number(f.id)||7531)>>>0;
      const rnd=()=> {seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
      for(let i=0;i<attempts&&treePositions.length<limit;i++) {
        const lon=bb.west+rnd()*(bb.east-bb.west),lat=bb.south+rnd()*(bb.north-bb.south);
        if(pointInside(lon,lat,f.geometry))take({lon,lat,source:"approximate"});
      }
    }
    return treePositions;
  }
  function featureBounds(region, maxSpan=.025) {
    const centerLat=(region.north+region.south)/2,centerLon=(region.east+region.west)/2;
    const latSpan=Math.min(maxSpan,region.north-region.south);
    const lonSpan=Math.min(maxSpan/Math.max(.5,Math.cos(centerLat*rad)),region.east-region.west);
    return {south:centerLat-latSpan/2,north:centerLat+latSpan/2,
      west:centerLon-lonSpan/2,east:centerLon+lonSpan/2};
  }
  function buildingsFromOverpass(elements, region, limit=180) {
    const result=[];
    for (const item of Array.isArray(elements)?elements:[]) {
      if(result.length>=limit)break;
      if(item.type!=="way"||!item.tags?.building||!Array.isArray(item.geometry))continue;
      const pts=item.geometry.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));
      if(pts.length<4||pts.length>120)continue;
      const poly=pts.slice(0,-1);
      if(poly.length<3)continue;
      const center={lat:poly.reduce((a,p)=>a+p.lat,0)/poly.length,
        lon:poly.reduce((a,p)=>a+p.lon,0)/poly.length};
      if(center.lat<region.south||center.lat>region.north||
        center.lon<region.west||center.lon>region.east)continue;
      const meters=Number.parseFloat(String(item.tags.height||""));
      const levels=Number.parseFloat(String(item.tags["building:levels"]||""));
      const heightMeters=Number.isFinite(meters)&&meters>0?meters:
        Number.isFinite(levels)&&levels>0?levels*3:9;
      result.push({id:item.id,polygon:poly,center,heightMeters:clamp(heightMeters,2,90),
        roof:item.tags["roof:shape"]||null,kind:item.tags.building});
    }
    return result;
  }
  const api={tileXY,tileLatLon,tileBound,tileList,coverage,bbox,projectFactory,heightTerrarium,bilinear,
    terrainUrl,satelliteUrl,loadImage,demSampler,pointInside,vegetationFromOverpass,buildingsFromOverpass,featureBounds};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  global.RoadFunTerrain=api;
})(typeof window!=="undefined"?window:globalThis);
