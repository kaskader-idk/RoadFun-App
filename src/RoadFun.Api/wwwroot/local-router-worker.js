/* RoadFun browser-only route worker: keeps A* away from Safari's UI thread. */
"use strict";
importScripts("/local-router-core.js?v=8");
let router=null;
let loading=null;
async function load() {
  if(router)return router;
  if(loading)return loading;
  loading=(async()=>{
    const response=await fetch("/routing-data/region.json",{cache:"force-cache"});
    if(!response.ok||!(response.headers.get("content-type")||"").includes("json"))
      throw Error("Lokale Straßenkarte fehlt. Erstelle die Region mit scripts/build-browser-map.sh und aktualisiere RoadFun.");
    const json=await response.json();
    router=new self.RoadFunLocalRouter.LocalRouter(json);
    return router;
  })();
  try{return await loading;}finally{loading=null;}
}
self.onmessage=async event=>{
  const {id,action,start,end,mode}=event.data;
  try{
    if(action==="status"){
      const data=await load();
      self.postMessage({id,success:true,result:{loaded:true,nodes:data.lat.length,
        region:data.region,bounds:data.bounds}});
      return;
    }
    if(action!=="route")throw Error("Unbekannte Aktion");
    const data=await load();
    const begin=performance.now();
    const result=data.search(start,end,mode);
    result.computeMilliseconds=Math.round(performance.now()-begin);
    self.postMessage({id,success:true,result});
  }catch(error){
    self.postMessage({id,success:false,error:String(error?.message||error)});
  }
};
