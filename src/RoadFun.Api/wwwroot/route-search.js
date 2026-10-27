/* RoadFun Google-Maps-like map-side address and coordinate picker.
 * Uses authenticated Photon autocomplete via API, with exact lat,lon input.
 */
(function(root){
"use strict";
const pointText=p=>p?Number(p.lat).toFixed(5)+", "+Number(p.lon).toFixed(5):"";
function parseCoords(value){
  const match=String(value).trim().match(/^(-?[0-9]+(?:\.[0-9]+)?)\s*[,; ]\s*(-?[0-9]+(?:\.[0-9]+)?)$/);
  if(!match)return null;
  const lat=Number(match[1]),lon=Number(match[2]);
  return Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;
}
function render(){
  const rootElement=document.getElementById("routePlannerBody");
  rootElement.replaceChildren();
  const info=document.createElement("p");
  info.className="route-planner-tip";
  info.textContent="Adresse eingeben, Koordinaten (Breite, Länge) oder Punkt auf der Karte wählen.";
  rootElement.append(info);
  const inputs={};
  for(const side of ["start","end"]){
    const starting=side==="start";
    const wrapper=document.createElement("div");
    wrapper.className="route-address-wrap";
    const label=document.createElement("label");
    label.htmlFor="route-"+side;
    label.textContent=starting?"Start":"Ziel";
    const line=document.createElement("div");
    line.className="route-address-row";
    const input=document.createElement("input");
    input.id="route-"+side;input.type="search";input.autocomplete="off";
    input.placeholder=starting?"Mein Standort oder Adresse":"Adresse oder GPS-Koordinaten";
    const coord=state[starting?"routeStart":"routeEnd"];
    input.value=state[starting?"routeStartLabel":"routeEndLabel"]||pointText(coord);
    inputs[side]=input;
    const picker=document.createElement("button");
    picker.type="button";picker.className="route-pin";picker.textContent="⌖";
    picker.title=(starting?"Start":"Ziel")+" auf Karte wählen";
    const options=document.createElement("div");
    options.className="route-suggestions";options.hidden=true;
    line.append(input,picker);wrapper.append(label,line,options);
    rootElement.append(wrapper);
    const stateKey=starting?"routeStart":"routeEnd";
    const labelKey=starting?"routeStartLabel":"routeEndLabel";
    const choose=(p,name)=>{
      state[stateKey]=p;state[labelKey]=name||pointText(p);
      input.value=state[labelKey];options.replaceChildren();options.hidden=true;
      state.map.panTo([p.lat,p.lon]);
    };
    picker.addEventListener("click",()=>{
      pick((starting?"Startpunkt":"Zielpunkt")+" auf Karte wählen",p=>{
        state[stateKey]=p;state[labelKey]=pointText(p);
      });
    });
    let seq=0,timer=null;
    input.addEventListener("input",()=>{
      seq++;clearTimeout(timer);
      state[stateKey]=null;state[labelKey]="";
      const query=input.value.trim(),thisSeq=seq;
      options.hidden=true;options.replaceChildren();
      const exact=parseCoords(query);
      if(exact){choose(exact,pointText(exact));return;}
      if(query.length<3)return;
      timer=setTimeout(async()=>{
        try{
          const params=new URLSearchParams({q:query});
          if(state.pos){params.set("lat",String(state.pos.lat));params.set("lon",String(state.pos.lon));}
          const response=await api("/geocode?"+params.toString());
          if(seq!==thisSeq||state.tab!=="route")return;
          options.hidden=false;
          const results=(response.results||[]).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));
          if(!results.length){options.textContent="Keine Adresse gefunden – alternativ Karte anklicken";return;}
          for(const result of results){
            const btn=document.createElement("button");btn.className="route-result";btn.type="button";
            btn.textContent=result.label||pointText(result);
            btn.addEventListener("click",()=>choose({lat:result.lat,lon:result.lon},btn.textContent));
            options.append(btn);
          }
        }catch(error){if(thisSeq===seq){options.hidden=false;options.textContent=error.message;}}
      },500);
    });
    input.addEventListener("keydown",event=>{
      if(event.key!=="Enter")return;
      const exact=parseCoords(input.value);
      if(exact){event.preventDefault();choose(exact,pointText(exact));}
      else {
        const result=options.querySelector("button");
        if(result){event.preventDefault();result.click();}
      }
    });
  }
  const label=document.createElement("label");label.htmlFor="routeMode";label.textContent="Routenart";
  const select=document.createElement("select");select.id="routeMode";
  for(const [value,text] of [["fast","Schnellste"],["short","Kürzeste"],["eco","Eco"],["fun","Landstraße (Heuristik)"]]){
    const option=document.createElement("option");option.value=value;option.textContent=text;
    select.append(option);
  }
  select.value=state.mode;
  rootElement.append(label,select);
  const actions=document.createElement("div");actions.className="route-actions";
  const calc=document.createElement("button");calc.className="primary";calc.textContent="Route berechnen";
  calc.type="button";calc.onclick=routeGo;
  const terrain=document.createElement("button");terrain.className="secondary";terrain.textContent="3D-Gelände";
  terrain.type="button";terrain.onclick=show3D;
  actions.append(calc,terrain);rootElement.append(actions);
  const note=document.createElement("p");note.className="route-planner-tip";
  note.id="routeOfflineStatus";
  note.textContent="Prüfe lokale Straßenkarte auf diesem Gerät …";
  rootElement.append(note);
  if(root.RoadFunOffline)root.RoadFunOffline.status().then(result=>{
    if(note.isConnected)
      note.textContent="Offline-Karte geladen: "+result.nodes.toLocaleString("de-AT")+
        " Straßenknoten · Region "+result.region+" · Routen werden auf diesem Gerät berechnet.";
  }).catch(error=>{
    if(note.isConnected)note.textContent=error.message;
  });
  document.getElementById("closeRoutePlanner").onclick=()=>setTab("map");
}
root.RoadFunRoutePlanner={render,parseCoords};
})(window);
