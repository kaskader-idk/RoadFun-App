/* Offline, browser-side A* routing for RoadFun regional OSM road graphs.
 * Source OSM PBF is preprocessed ONCE into a static CSR graph; every route is
 * computed here on the user's device. No OSRM or route HTTP request.
 */
(function(root) {
  "use strict";
  const R=6371000;
  const rad=Math.PI/180;
  function greatCircle(a,b,c,d) {
    const p1=a*rad,p2=c*rad,dp=p2-p1,dl=(d-b)*rad;
    const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
  }
  class Heap {
    constructor(){this.data=[];}
    push(node,priority){
      const a=this.data;let i=a.length;a.push([node,priority]);
      while(i){const p=(i-1)>>1;if(a[p][1]<=priority)break;a[i]=a[p];i=p;}
      a[i]=[node,priority];
    }
    pop(){
      const a=this.data;if(!a.length)return null;
      const first=a[0],last=a.pop();
      if(!a.length)return first;
      let i=0;
      while((i*2+1)<a.length){
        let child=i*2+1;
        if(child+1<a.length&&a[child+1][1]<a[child][1])child++;
        if(a[child][1]>=last[1])break;
        a[i]=a[child];i=child;
      }
      a[i]=last;return first;
    }
    get size(){return this.data.length;}
  }
  function wrapDegrees(deg){return (deg+540)%360-180;}
  function heading(from,to){
    const y=Math.sin((to[0]-from[0])*rad)*Math.cos(to[1]*rad);
    const x=Math.cos(from[1]*rad)*Math.sin(to[1]*rad)-
      Math.sin(from[1]*rad)*Math.cos(to[1]*rad)*Math.cos((to[0]-from[0])*rad);
    return (Math.atan2(y,x)/rad+360)%360;
  }
  function maneuvers(points) {
    const steps=[{lat:points[0][1],lon:points[0][0],type:"depart",modifier:"straight",road:"",
      distanceMeters:0}];
    let since=0;
    for(let i=1;i<points.length-1;i++){
      const prev=points[i-1],here=points[i],next=points[i+1];
      since+=greatCircle(prev[1],prev[0],here[1],here[0]);
      if(since<30)continue;
      const delta=wrapDegrees(heading(here,next)-heading(prev,here));
      if(Math.abs(delta)<42)continue;
      const modifier=delta>0?(delta>130?"sharp right":delta>70?"right":"slight right"):
        (delta< -130?"sharp left":delta< -70?"left":"slight left");
      steps.push({lat:here[1],lon:here[0],type:"turn",modifier,road:"",
        distanceMeters:Math.round(since)});
      since=0;
    }
    const end=points[points.length-1];
    steps.push({lat:end[1],lon:end[0],type:"arrive",modifier:"straight",road:"",
      distanceMeters:Math.round(since)});
    return steps;
  }
  class LocalRouter {
    constructor(graph) {
      if(!graph||graph.version!==1||!Array.isArray(graph.lat)||
        !Array.isArray(graph.offsets)||graph.offsets.length!==graph.lat.length+1)
        throw Error("Ungültige lokale Kartendatei");
      this.lat=Float64Array.from(graph.lat);
      this.lon=Float64Array.from(graph.lon);
      this.offset=Uint32Array.from(graph.offsets);
      this.to=Uint32Array.from(graph.to);
      this.metres=Uint32Array.from(graph.meters);
      this.seconds=Float32Array.from(graph.seconds);
      this.type=Uint8Array.from(graph.type);
      this.bounds=graph.bounds;
      this.region=graph.region||"Regional";
      const n=this.lat.length;
      if(n<2||this.lon.length!==n||this.to.length!==this.seconds.length||
        this.to.length!==this.metres.length||this.type.length!==this.to.length||
        this.offset[n]!==this.to.length)throw Error("Unvollständige lokale Straßenkarte");
      this.index=new Map();
      for(let i=0;i<n;i++){
        const key=Math.floor(this.lat[i]*100)+":"+Math.floor(this.lon[i]*100);
        let bucket=this.index.get(key);
        if(!bucket){bucket=[];this.index.set(key,bucket);}
        bucket.push(i);
      }
    }
    nearest(lat,lon){
      if(!Number.isFinite(lat)||!Number.isFinite(lon))throw Error("GPS-Koordinaten fehlen");
      const b=this.bounds;
      if(lat<b.south-.025||lat>b.north+.025||lon<b.west-.035||lon>b.east+.035)
        throw Error("Punkt außerhalb der heruntergeladenen Region");
      const cy=Math.floor(lat*100),cx=Math.floor(lon*100);
      let closest=-1,best=Infinity;
      for(let radius=0;radius<=4;radius++){
        for(let y=cy-radius;y<=cy+radius;y++)for(let x=cx-radius;x<=cx+radius;x++){
          if(radius&&Math.abs(y-cy)!==radius&&Math.abs(x-cx)!==radius)continue;
          const bucket=this.index.get(y+":"+x);
          if(!bucket)continue;
          for(const id of bucket){
            const d=greatCircle(lat,lon,this.lat[id],this.lon[id]);
            if(d<best){best=d;closest=id;}
          }
        }
        if(best<radius*700)break;
      }
      if(closest<0||best>3000)
        throw Error("Kein befahrbarer Straßenknoten in der Nähe (max. 3 km)");
      return {node:closest,metres:best};
    }
    search(start,end,mode="fast"){
      const allowed=["fast","short","eco","fun"];
      if(!allowed.includes(mode))throw Error("Unbekannter Routenmodus");
      const from=this.nearest(start.lat,start.lon);
      const to=this.nearest(end.lat,end.lon);
      const n=this.lat.length,prev=new Int32Array(n).fill(-1);
      const prevEdge=new Int32Array(n).fill(-1);
      const distance=new Float64Array(n);distance.fill(Infinity);
      const queue=new Heap();
      const target=to.node;
      const rate=mode==="short"?1:mode==="eco"?0.3/36.1111+0.7/18:1/36.1111;
      const heuristic=i=>greatCircle(this.lat[i],this.lon[i],this.lat[target],this.lon[target])*rate;
      distance[from.node]=0;queue.push(from.node,heuristic(from.node));
      let reached=false;
      let popped=0;
      while(queue.size){
        const [node,estimated]=queue.pop();
        if(estimated>distance[node]+heuristic(node)+1e-6)continue;
        if(node===target){reached=true;break;}
        if(++popped>n*5)break;
        for(let j=this.offset[node];j<this.offset[node+1];j++){
          const neighbor=this.to[j];
          let weight=this.seconds[j];
          if(mode==="short")weight=this.metres[j];
          else if(mode==="eco")weight=0.3*this.seconds[j]+0.7*this.metres[j]/18;
          else if(mode==="fun")
            weight=this.seconds[j]*(this.type[j]<=2?1.7:this.type[j]<=3?1.18:1);
          const next=distance[node]+weight;
          if(next<distance[neighbor]){
            distance[neighbor]=next;prev[neighbor]=node;prevEdge[neighbor]=j;
            queue.push(neighbor,next+heuristic(neighbor));
          }
        }
      }
      if(!reached)throw Error("Keine Verbindung im lokalen Straßennetz gefunden");
      const sequence=[];
      for(let at=target;at!==-1;at=prev[at]){
        sequence.push(at);
        if(sequence.length>n)throw Error("Routenrekonstruktion fehlgeschlagen");
      }
      sequence.reverse();
      if(sequence.length<2)throw Error("Start und Ziel liegen auf demselben Straßenknoten");
      let totalMetres=0,totalSeconds=0;
      const coords=sequence.map((id,index)=>{
        if(index){const edge=prevEdge[id];totalMetres+=this.metres[edge];
          totalSeconds+=this.seconds[edge];}
        return [this.lon[id],this.lat[id]];
      });
      return {
        provider:"Lokal · A* auf diesem Gerät",
        selectedMode:mode,alternatives:1,
        distanceKm:totalMetres/1000,durationMin:totalSeconds/60,
        geometry:coords,steps:maneuvers(coords),
        snappedStartMeters:Math.round(from.metres),snappedEndMeters:Math.round(to.metres),
        visitedNodes:popped,
        note:"Offline im Browser berechnet. Vereinfachtes OSM-Straßennetz: keine Abbiegeverbote, Spurführung oder Live-Staus."
      };
    }
  }
  root.RoadFunLocalRouter={LocalRouter,greatCircle,maneuvers};
  if(typeof module!=="undefined"&&module.exports)
    module.exports=root.RoadFunLocalRouter;
})(typeof self!=="undefined"?self:globalThis);
