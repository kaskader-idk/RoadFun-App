/* Client wrapper around the offline route Web Worker. */
(function(root){
  "use strict";
  let worker=null,serial=0;
  const pending=new Map();
  function getWorker(){
    if(worker)return worker;
    if(!root.Worker)throw Error("Dieser Browser unterstützt keine Hintergrundberechnung");
    worker=new Worker("/local-router-worker.js?v=8");
    worker.onmessage=e=>{
      const p=pending.get(e.data.id);
      if(!p)return;
      pending.delete(e.data.id);
      if(e.data.success)p.resolve(e.data.result);
      else p.reject(new Error(e.data.error||"Lokale Routenberechnung fehlgeschlagen"));
    };
    worker.onerror=()=>{
      const err=new Error("Lokaler Routing-Worker konnte nicht geladen werden");
      for(const p of pending.values())p.reject(err);
      pending.clear();worker.terminate();worker=null;
    };
    return worker;
  }
  function send(action,data={}){
    const w=getWorker(),id=++serial;
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      w.postMessage({id,action,...data});
    });
  }
  root.RoadFunOffline={
    status:()=>send("status"),
    route:(start,end,mode)=>send("route",{start,end,mode})
  };
})(window);
