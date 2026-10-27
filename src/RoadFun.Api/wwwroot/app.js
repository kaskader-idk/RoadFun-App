/* RoadFun PWA – client-only state and interactive map. Server owns persistent data. */
"use strict";
const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const nice = n => Number(n || 0).toFixed(1);
const stamp = n => new Date(Number(n) * 1000).toLocaleString("de-AT");
const coords = p => p ? nice(p.lat) + ", " + nice(p.lon) : "Kein Punkt gewählt";
const form = (id, field) => $(id).elements[field].value;
const state = {
  token: localStorage.getItem("roadfun-token") || "", me: null, pos: null, watchId: null,
  map: null, marker: null, overlays: null, routeLine: null, route: null, tab: "map",
  mode: "fast", routeStart: null, routeEnd: null, reportPoint: null, meetPoint: null,
  trackStart: null, trackEnd: null, picker: null, friendCode: null, activeTrack: null,
  timer: null, three: null, lastSend: 0, refreshHandle: null, authRegister: false
};
function toast(message, error = false) {
  const t = $("toast"); t.textContent = message; t.style.borderColor = error ? "#ff626e" : "#304764";
  t.style.display = "block"; clearTimeout(t._hide); t._hide = setTimeout(() => t.style.display = "none", 4500);
}
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  let response;
  try { response = await fetch("/api" + path, { ...options, headers, cache:"no-store" }); }
  catch { throw Error("Server nicht erreichbar"); }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth")) logout(false);
    throw Error(data?.error || "Fehler " + response.status);
  }
  return data;
}
const json = (method, body) => ({ method, body: JSON.stringify(body) });
function point(lat, lon) { return { lat: Number(lat), lon: Number(lon) }; }
function km(a,b) {
  const rad=Math.PI/180, dLat=(b.lat-a.lat)*rad, dLon=(b.lon-a.lon)*rad;
  const v=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLon/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(v)));
}
function formatDuration(seconds) {
  const s=Math.max(0,Math.floor(seconds)); return String(Math.floor(s/3600)).padStart(2,"0")+":"+
    String(Math.floor(s%3600/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
}
function showAuth() { $("auth").hidden = false; $("auth").style.display = "grid"; }
function hideAuth() { $("auth").hidden = true; $("auth").style.display = "none"; }
function logout(message = true) {
  state.token = ""; state.me = null; localStorage.removeItem("roadfun-token");
  stopLocation(); clearInterval(state.refreshHandle); state.refreshHandle = null;
  state.overlays?.clearLayers(); state.marker?.remove(); state.marker = null;
  state.activeTrack = null; state.timer = null; showAuth();
  if (message) toast("Abgemeldet");
}
function initMap() {
  state.map = L.map("map", { zoomControl: false }).setView([47.7,13.6], 7);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(state.map);
  L.control.zoom({ position:"bottomright" }).addTo(state.map);
  state.overlays = L.layerGroup().addTo(state.map);
  state.map.on("click", event => {
    if (!state.picker) return;
    const p = point(event.latlng.lat, event.latlng.lng), done = state.picker;
    state.picker = null; $("mapHint").hidden = true; done(p);
    setTab(state.tab); toast("Punkt gespeichert");
  });
  $("centerGps").onclick = () => {
    if (state.pos) state.map.setView([state.pos.lat,state.pos.lon],16);
    else toast("GPS-Standort noch nicht verfügbar", true);
  };
  $("refreshMap").onclick = refreshMarkers;
}
function dotClass(kind) { return kind === "meet" ? "map-meet" : kind === "friend" ? "map-friend" : "map-report"; }
function dot(p, kind, text, layer = state.overlays) {
  return L.marker([p.lat,p.lon], { icon: L.divIcon({
    className:"", html:'<div class="'+dotClass(kind)+'"></div>', iconSize:[22,22],iconAnchor:[11,11]
  }) }).addTo(layer).bindPopup(text);
}
function pick(label, setter) {
  state.picker = setter; $("mapHint").textContent = label + " – tippe auf die Karte";
  $("mapHint").hidden = false; $("panel").hidden = true;
  toast("Tippe jetzt auf die gewünschte Stelle");
}
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("panel").hidden = tab === "map";
  if (tab === "map") { setTimeout(() => state.map.invalidateSize(), 100); return; }
  const names = { route:"Route planen", report:"Meldung erstellen", tracks:"Strecken & GPS", meets:"Car Meets",
    friends:"Freunde & Chat", profile:"Mein Profil", admin:"Administration" };
  $("panelTitle").textContent = names[tab] || "RoadFun";
  $("panelContent").innerHTML = '<p class="help">Lade …</p>';
  ({ route:renderRoute, report:renderReport, tracks:renderTracks, meets:renderMeets,
    friends:renderFriends, profile:renderProfile, admin:renderAdmin })[tab]?.();
  setTimeout(() => state.map.invalidateSize(), 80);
}
async function boot() {
  if (!state.token) { showAuth(); return; }
  try {
    state.me = await api("/me"); hideAuth();
    $("openProfile").textContent = state.me.username.slice(0,1).toUpperCase();
    $("adminNav").hidden = !state.me.isAdmin;
    startLocation();
    await refreshMarkers();
    if (!state.refreshHandle) state.refreshHandle = setInterval(refreshMarkers, 20000);
    setTab("map");
  } catch (e) { toast(e.message,true); logout(false); }
}
$("authSwitch").onclick = () => {
  state.authRegister = !state.authRegister; $("inviteField").hidden = !state.authRegister;
  $("authSubmit").textContent = state.authRegister ? "Registrieren" : "Anmelden";
  $("authSwitch").textContent = state.authRegister ? "Schon einen Account? Anmelden" : "Noch keinen Account? Registrieren";
};
$("authForm").onsubmit = async event => {
  event.preventDefault();
  const f = event.currentTarget;
  const data = { username:f.elements.username.value.trim(), password:f.elements.password.value,
    inviteCode:f.elements.inviteCode.value };
  try {
    const result = await api(state.authRegister ? "/auth/register" : "/auth/login", json("POST", data));
    state.token = result.token; localStorage.setItem("roadfun-token", state.token); await boot();
  } catch (e) { toast(e.message,true); }
};
$("openProfile").onclick = () => setTab("profile");
$("closePanel").onclick = () => setTab("map");
document.querySelectorAll("#nav button").forEach(b => b.onclick = () => setTab(b.dataset.tab));

function startLocation() {
  if (!navigator.geolocation) { toast("GPS wird nicht unterstützt",true); return; }
  if (!window.isSecureContext) { toast("Für GPS ist HTTPS nötig",true); return; }
  if (state.watchId !== null) return;
  state.watchId = navigator.geolocation.watchPosition(updateLocation, err => {
    $("gpsStatus").textContent = "GPS: " + err.message;
  }, { enableHighAccuracy:true, maximumAge:1000, timeout:20000 });
}
function stopLocation() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  $("gpsStatus").textContent = "GPS aus";
}
async function updateLocation(update) {
  const c=update.coords, pos=point(c.latitude,c.longitude);
  pos.accuracy=c.accuracy; pos.speed=c.speed == null ? null : c.speed;
  pos.time=update.timestamp;
  state.pos=pos; $("gpsStatus").textContent = "GPS ±"+Math.round(c.accuracy)+" m";
  if (!state.marker) {
    state.marker=dot(pos,"friend","Deine Position",state.map);
    state.map.setView([pos.lat,pos.lon], 14);
  } else state.marker.setLatLng([pos.lat,pos.lon]);
  state.marker.setIcon(L.divIcon({ className:"", html:'<div class="map-user"></div>', iconSize:[22,22],iconAnchor:[11,11] }));
  timerUpdate(pos);
  if (state.me?.shareLocation && Date.now()-state.lastSend > 10000) {
    state.lastSend=Date.now();
    api("/location", json("POST",{ lat:pos.lat, lon:pos.lon, accuracy:pos.accuracy })).catch(()=>{});
  }
}
async function refreshMarkers() {
  if (!state.token) return;
  try {
    const [reports, meets, people] = await Promise.all([api("/reports"),api("/meets"),api("/map/people")]);
    state.overlays.clearLayers();
    for (const r of reports) {
      const label = {police:"Polizei",speedcam_mobile:"Mobiler Blitzer",speedcam_fixed:"Stationärer Blitzer",traffic:"Stau",hazard:"Gefahr"}[r.kind] || r.kind;
      dot(point(r.lat,r.lon),"report",'<b>'+esc(label)+'</b><br>'+esc(r.note || "")+
        (r.heading == null ? "" : '<br>Richtung: '+esc(r.heading)+'°')+'<br><small>'+esc(stamp(r.created_at))+'</small>');
      L.circle([r.lat,r.lon],{ radius:65,fillColor:"#ff4967",color:"#ff4967",fillOpacity:.12,weight:1 }).addTo(state.overlays);
    }
    for (const m of meets) dot(point(m.lat,m.lon),"meet",'<b>'+esc(m.title)+'</b><br>'+esc(stamp(m.starts_at))+'<br>Teilnehmer: '+Number(m.participants || 0));
    for (const p of people) dot(point(p.lat,p.lon),"friend",'<b>'+esc(p.username)+'</b><br>'+esc(p.car||"Fahrer"));
  } catch(e) { if (state.token) console.warn("Map refresh:",e.message); }
}

function section(title, body) { return '<div class="item"><h3>'+esc(title)+'</h3>'+body+'</div>'; }
function empty(msg) { return '<p class="help">'+esc(msg)+'</p>'; }
function attach(id, fn) { const e=$(id); if(e) e.onclick=fn; }
function renderRoute() {
  $("panelContent").innerHTML =
    '<p class="help">Karte mit Live-Position und alternativen Straßenrouten. Geschätzte ETA ohne Staus in Echtzeit.</p>'+
    '<button class="select-point" id="routeStartBtn">Start: '+esc(state.routeStart ? coords(state.routeStart) : "Meine GPS-Position")+'</button>'+
    '<button class="select-point" id="routeEndBtn">Ziel: '+esc(coords(state.routeEnd))+'</button>'+
    '<label>Routenmodus<select id="routeMode"><option value="fast">Schnellste</option><option value="short">Kürzeste</option><option value="eco">Eco (Heuristik)</option><option value="fun">Fun (Kurven-Heuristik)</option></select></label>'+
    '<div class="button-row"><button class="primary" id="routeGo">Route berechnen</button><button class="secondary" id="route3d">3D-Höhe</button></div>'+
    '<p class="help">Fun/Eco nutzen vorhandene Routing-Alternativen. Bei nur einer Route sind alle Modi identisch.</p>';
  $("routeMode").value = state.mode;
  attach("routeStartBtn",()=>pick("Startpunkt wählen",p=>state.routeStart=p));
  attach("routeEndBtn",()=>pick("Zielpunkt wählen",p=>state.routeEnd=p));
  attach("routeGo",routeGo);
  attach("route3d",show3D);
}
async function routeGo() {
  const a=state.routeStart || state.pos,b=state.routeEnd;
  if (!a || !b) return toast("GPS oder Start und Ziel auswählen",true);
  state.mode=$("routeMode").value;
  try {
    const q=new URLSearchParams({fromLat:a.lat,fromLon:a.lon,toLat:b.lat,toLon:b.lon,mode:state.mode});
    const result=await api("/route?"+q);
    state.route=result; state.route.geometry=result.geometry;
    if(state.routeLine) state.routeLine.remove();
    state.routeLine=L.polyline(result.geometry.map(p=>[p[1],p[0]]),{color:"#299bff",weight:6,opacity:.9}).addTo(state.map);
    state.map.fitBounds(state.routeLine.getBounds(),{padding:[55,55]});
    const arrival=new Date(Date.now()+result.durationMin*60000).toLocaleTimeString("de-AT",{hour:"2-digit",minute:"2-digit"});
    $("routeSummary").hidden=false;
    $("routeSummary").innerHTML='<b>↗ Route · '+esc(state.mode.toUpperCase())+'</b><div class="metrics"><span><strong>'+
      nice(result.distanceKm)+' km</strong><br>Entfernung</span><span><strong>'+Math.ceil(result.durationMin)+
      ' min</strong><br>Fahrtzeit</span><span><strong>'+arrival+'</strong><br>Ankunft</span></div>'+
      '<span class="muted tiny">'+result.alternatives+' Alternative(n) · Kein Live-Verkehr</span>';
    setTab("map"); toast("Route berechnet");
  } catch(e){toast(e.message,true)}
}
function renderReport() {
  $("panelContent").innerHTML='<p class="help">Melde Beobachtungen, nicht während du selbst fährst.</p>'+
    '<button class="select-point" id="reportPick">Meldepunkt: '+esc(state.reportPoint?coords(state.reportPoint):"Auf Karte wählen")+'</button>'+
    '<button class="secondary wide" id="reportHere">Meine aktuelle Position</button><div class="divider"></div>'+
    '<form id="reportForm"><label>Art<select name="kind">'+
    '<option value="police">Polizeisichtung</option><option value="speedcam_mobile">Mobiler Blitzer</option>'+
    '<option value="speedcam_fixed">Stationärer Blitzer</option><option value="traffic">Stau</option><option value="hazard">Gefahr</option></select></label>'+
    '<label>Blickrichtung in Grad (optional, 0°=Nord)<input name="heading" type="number" min="0" max="359" placeholder="z. B. 90"></label>'+
    '<label>Hinweis<input name="note" maxlength="240" placeholder="Kurze Beschreibung"></label>'+
    '<button class="primary wide">Meldung veröffentlichen</button></form>';
  attach("reportPick",()=>pick("Meldeort wählen",p=>state.reportPoint=p));
  attach("reportHere",()=>{if(!state.pos)return toast("GPS fehlt",true);state.reportPoint=point(state.pos.lat,state.pos.lon);renderReport()});
  $("reportForm").onsubmit=async e=>{
    e.preventDefault(); if(!state.reportPoint)return toast("Ort auswählen",true);
    const f=e.currentTarget;
    try{
      await api("/reports",json("POST",{...state.reportPoint,kind:f.elements.kind.value,note:f.elements.note.value,
        heading:f.elements.heading.value===""?null:Number(f.elements.heading.value)}));
      state.reportPoint=null;await refreshMarkers();setTab("map");toast("Meldung gespeichert");
    }catch(err){toast(err.message,true)}
  };
}
function renderTracks() {
  $("panelContent").innerHTML =
    '<p class="help">GPS-Zeitmessung nur auf freigegebenen, abgesperrten Strecken. iOS: Bildschirm aktiv lassen. Ungenaues GPS kann Zeiten verfälschen.</p>'+
    '<div id="liveTimer"></div><h3>Neue Strecke</h3>'+
    '<button id="trackStartBtn" class="select-point">Start: '+esc(coords(state.trackStart))+'</button>'+
    '<button id="trackEndBtn" class="select-point">Ziel: '+esc(coords(state.trackEnd))+'</button>'+
    '<form id="trackForm"><label>Name<input name="title" maxlength="100" required placeholder="Meine Teststrecke"></label>'+
    '<label>Sichtbarkeit<select name="visibility"><option value="private">Privat</option><option value="friends">Freunde</option></select></label>'+
    '<button class="primary wide">Strecke speichern</button></form><div class="divider"></div>'+
    '<h3>Meine und freigegebene Strecken</h3><div id="trackList">'+empty("Lade Strecken …")+'</div>'+
    '<div class="divider"></div><h3>Meine Messungen</h3><div id="runsList">'+empty("Lade Messungen …")+'</div>';
  attach("trackStartBtn",()=>pick("Start der Strecke wählen",p=>state.trackStart=p));
  attach("trackEndBtn",()=>pick("Ende der Strecke wählen",p=>state.trackEnd=p));
  $("trackForm").onsubmit=async e=>{
    e.preventDefault();
    if(!state.trackStart||!state.trackEnd)return toast("Start und Ziel auswählen",true);
    try{
      await api("/tracks",json("POST",{title:form("trackForm","title"),startLat:state.trackStart.lat,
      startLon:state.trackStart.lon,endLat:state.trackEnd.lat,endLon:state.trackEnd.lon,visibility:form("trackForm","visibility")}));
      state.trackStart=state.trackEnd=null;renderTracks();toast("Strecke gespeichert");
    }catch(err){toast(err.message,true)}
  };
  updateTimerDisplay();
  Promise.all([api("/tracks"),api("/runs")]).then(([tracks,runs])=>{
    if(state.tab!=="tracks")return;
    $("trackList").innerHTML=tracks.length?tracks.map(t=>section(t.title,
      '<p>von '+esc(t.owner)+' · '+(t.visibility==="private"?"Privat":"Freunde")+'</p>'+
      '<div class="button-row"><button class="secondary arm" data-id="'+esc(t.id)+'">GPS-Messung aktivieren</button>'+
      (t.owner===state.me.username?'<button class="danger deltrack" data-id="'+esc(t.id)+'">Löschen</button>':"")+'</div>')).join(""):empty("Noch keine Strecken.");
    $("runsList").innerHTML=runs.length?runs.map(r=>section(r.title,
      '<p>'+esc(stamp(r.created_at))+' · nicht verifiziert</p><div class="mini-stats">'+
      '<div class="stat"><b>'+formatDuration(r.duration_seconds)+'</b><span>Zeit</span></div>'+
      '<div class="stat"><b>'+nice(r.max_kmh)+'</b><span>Max km/h</span></div>'+
      '<div class="stat"><b>'+nice(r.avg_kmh)+'</b><span>Ø km/h</span></div>'+
      '<div class="stat"><b>'+nice(r.max_g)+' g</b><span>Max. Längs-g (GPS)</span></div></div>')).join(""):empty("Noch keine Zeitmessungen.");
    document.querySelectorAll(".arm").forEach(b=>b.onclick=()=>armTrack(tracks.find(t=>t.id===b.dataset.id)));
    document.querySelectorAll(".deltrack").forEach(b=>b.onclick=async()=>{
      if(!confirm("Strecke wirklich löschen?"))return;
      try{await api("/tracks/"+encodeURIComponent(b.dataset.id),{method:"DELETE"});renderTracks()}catch(e){toast(e.message,true)}
    });
  }).catch(e=>toast(e.message,true));
}
function armTrack(track) {
  if(!track)return;
  state.activeTrack=track;
  state.timer={status:"armed",outside:false,previous:null,start:0,last:null,distance:0,maxKmh:0,maxG:0};
  if(state.routeLine)state.routeLine.remove();
  state.routeLine=L.polyline([[track.start_lat,track.start_lon],[track.end_lat,track.end_lon]],
    {color:"#00d6a5",weight:3,dashArray:"9 6"}).addTo(state.map);
  state.map.fitBounds(state.routeLine.getBounds(),{padding:[45,45]});
  updateTimerDisplay();toast("Messung scharf: erst >65 m vom Start entfernen, dann auf <35 m zurückkehren");
}
function updateTimerDisplay(){
  if(!state.timer||!state.activeTrack)return;
  const t=state.timer;
  const txt=t.status==="armed"?"Bereit · Startzone erst verlassen, dann durchfahren":
    t.status==="running"?"Läuft · "+formatDuration((Date.now()-t.start)/1000):"Beendet";
  if($("liveTimer"))$("liveTimer").innerHTML=
    section("GPS-Zeitmessung",'<p class="timer-running">'+esc(txt)+'</p><div class="mini-stats">'+
    '<div class="stat"><b>'+nice(t.maxKmh)+'</b><span>Max. km/h</span></div>'+
    '<div class="stat"><b>'+nice(t.distance)+'</b><span>Gefahrene km</span></div></div>'+
    '<button id="stopTimer" class="danger wide">Messung abbrechen</button>');
  attach("stopTimer",()=>{state.timer=null;state.activeTrack=null;renderTracks();toast("Messung abgebrochen")});
  if(t.status==="running"){
    $("routeSummary").hidden=false;
    $("routeSummary").innerHTML='<b class="timer-running">⏱ GPS-Messung aktiv</b><div class="metrics"><strong>'+formatDuration((Date.now()-t.start)/1000)+'</strong><strong>'+nice(t.maxKmh)+' km/h</strong></div>';
  }
}
function timerUpdate(pos){
  const t=state.timer,track=state.activeTrack;
  if(!t||!track||pos.accuracy>35)return;
  const d0=km(pos,point(track.start_lat,track.start_lon))*1000;
  const d1=km(pos,point(track.end_lat,track.end_lon))*1000;
  if(t.status==="armed"){
    if(d0>65)t.outside=true;
    if(t.outside&&d0<35){t.status="running";t.start=Date.now();t.last=pos;t.previous=null;toast("Zeitmessung gestartet");}
  }else if(t.status==="running"){
    if(t.last){
      const seconds=(pos.time-t.last.time)/1000, dist=km(pos,t.last);
      if(seconds>0&&seconds<30&&dist<.5){
        t.distance+=dist;
        const mps=pos.speed!=null&&pos.speed>=0?pos.speed:dist*1000/seconds;
        const kmh=mps*3.6;
        t.maxKmh=Math.max(t.maxKmh,kmh);
        if(t.previous!=null)t.maxG=Math.max(t.maxG,Math.abs(mps-t.previous)/(seconds*9.80665));
        t.previous=mps;
      }
    }
    t.last=pos;
    if(d1<35&&Date.now()-t.start>5000){finishTimer();return}
  }
  if(state.tab==="tracks")updateTimerDisplay();
}
async function finishTimer(){
  const t=state.timer,track=state.activeTrack;
  if(!t||t.status!=="running")return;
  t.status="finished";
  const duration=(Date.now()-t.start)/1000;
  const result={trackId:track.id,durationSeconds:duration,distanceKm:t.distance,
    maxKmh:t.maxKmh,avgKmh:duration>0?t.distance/duration*3600:0,maxG:t.maxG};
  state.timer=null;state.activeTrack=null;$("routeSummary").hidden=true;
  try{await api("/runs",json("POST",result));toast("Messung gespeichert: "+formatDuration(duration));}
  catch(e){toast("Messung konnte nicht gespeichert werden: "+e.message,true)}
  if(state.tab==="tracks")renderTracks();
}
function renderMeets(){
  $("panelContent").innerHTML='<p class="help">Plane Treffen und navigiere zur Location. Bitte keine gefährlichen Fahrmanöver bei öffentlichen Treffen.</p>'+
    '<button id="meetPick" class="select-point">Treffpunkt: '+esc(coords(state.meetPoint))+'</button>'+
    '<form id="meetForm"><label>Name<input name="title" maxlength="100" required placeholder="RoadFun Treffen"></label>'+
    '<label>Datum/Uhrzeit<input name="startsAt" type="datetime-local" required></label>'+
    '<label>Beschreibung<textarea name="description" rows="3" maxlength="1000"></textarea></label>'+
    '<button class="primary wide">Treffen erstellen</button></form><div class="divider"></div>'+
    '<h3>Anstehende Treffen</h3><div id="meetList">'+empty("Lade …")+'</div>';
  attach("meetPick",()=>pick("Treffpunkt wählen",p=>state.meetPoint=p));
  $("meetForm").onsubmit=async e=>{
    e.preventDefault();if(!state.meetPoint)return toast("Treffpunkt auswählen",true);
    const f=e.currentTarget;
    try{
      await api("/meets",json("POST",{title:f.elements.title.value,description:f.elements.description.value,
        ...state.meetPoint,startsAt:new Date(f.elements.startsAt.value).toISOString()}));
      state.meetPoint=null;renderMeets();refreshMarkers();toast("Treffen erstellt");
    }catch(err){toast(err.message,true)}
  };
  api("/meets").then(rows=>{
    if(state.tab!=="meets")return;
    $("meetList").innerHTML=rows.length?rows.map(m=>section(m.title,'<p>'+esc(stamp(m.starts_at))+
      ' · '+esc(m.organizer)+' · '+m.participants+' Zusagen<br>'+esc(m.description||"")+'</p>'+
      '<div class="button-row"><button class="secondary joinMeet" data-id="'+esc(m.id)+'">Teilnehmen</button>'+
      '<button class="secondary navigateMeet" data-id="'+esc(m.id)+'">Route</button>'+
      (m.organizer===state.me.username?'<button class="danger removeMeet" data-id="'+esc(m.id)+'">Löschen</button>':"")+'</div>')).join(""):empty("Noch keine Treffen.");
    document.querySelectorAll(".joinMeet").forEach(b=>b.onclick=async()=>{try{
      await api("/meets/"+encodeURIComponent(b.dataset.id)+"/join",{method:"POST"});toast("Teilnahme gespeichert");renderMeets()
    }catch(e){toast(e.message,true)}});
    document.querySelectorAll(".navigateMeet").forEach(b=>b.onclick=()=>{
      const m=rows.find(x=>x.id===b.dataset.id);state.routeEnd=point(m.lat,m.lon);setTab("route");
    });
    document.querySelectorAll(".removeMeet").forEach(b=>b.onclick=async()=>{
      if(!confirm("Treffen löschen?"))return;
      try{await api("/meets/"+encodeURIComponent(b.dataset.id),{method:"DELETE"});renderMeets();refreshMarkers()}
      catch(e){toast(e.message,true)}
    });
  }).catch(e=>toast(e.message,true));
}
function renderFriends(){
  $("panelContent").innerHTML=
    '<p class="help">Dein Freundescode: <b>'+esc(state.me.code)+'</b> <button id="copyCode" class="secondary">Kopieren</button></p>'+
    '<form id="friendForm"><label>Freundescode eingeben<input name="code" maxlength="12" placeholder="Beispiel: ABCD123456" required></label>'+
    '<button class="primary wide">Freundschaft anfragen</button></form><div class="divider"></div>'+
    '<h3>Freunde & Anfragen</h3><div id="friendList">'+empty("Lade …")+'</div>'+
    '<div class="divider"></div><div id="chatPanel"></div>';
  attach("copyCode",()=>navigator.clipboard.writeText(state.me.code).then(()=>toast("Code kopiert")).catch(()=>toast("Kopieren nicht möglich",true)));
  $("friendForm").onsubmit=async e=>{e.preventDefault();try{
    await api("/friends/request",json("POST",{code:form("friendForm","code").trim()}));renderFriends();toast("Anfrage geschickt")
  }catch(err){toast(err.message,true)}};
  api("/friends").then(list=>{
    if(state.tab!=="friends")return;
    $("friendList").innerHTML=list.length?list.map(f=>section(f.username,
      '<p>'+esc(f.car||"")+' · '+esc(f.code)+' · '+(f.status==="accepted"?"Befreundet":f.incoming?"Anfrage erhalten":"Anfrage gesendet")+'</p>'+
      '<div class="button-row">'+(f.status==="accepted"?'<button class="secondary chatFriend" data-code="'+esc(f.code)+'">Chat öffnen</button>':
      f.incoming?'<button class="primary acceptFriend" data-id="'+esc(f.requestId)+'">Annehmen</button>':"")+
      '<button class="danger removeFriend" data-id="'+esc(f.requestId)+'">Entfernen</button></div>')).join(""):empty("Noch keine Freunde.");
    document.querySelectorAll(".chatFriend").forEach(b=>b.onclick=()=>{state.friendCode=b.dataset.code;renderChat()});
    document.querySelectorAll(".acceptFriend").forEach(b=>b.onclick=async()=>{try{
      await api("/friends/"+encodeURIComponent(b.dataset.id)+"/accept",{method:"POST"});renderFriends()
    }catch(e){toast(e.message,true)}});
    document.querySelectorAll(".removeFriend").forEach(b=>b.onclick=async()=>{try{
      await api("/friends/"+encodeURIComponent(b.dataset.id),{method:"DELETE"});renderFriends()
    }catch(e){toast(e.message,true)}});
    if(state.friendCode&&list.some(f=>f.code===state.friendCode&&f.status==="accepted"))renderChat();
  }).catch(e=>toast(e.message,true));
}
async function renderChat(){
  const code=state.friendCode;
  if(!code||state.tab!=="friends")return;
  const root=$("chatPanel");if(!root)return;
  try {
    const messages=await api("/messages/"+encodeURIComponent(code));
    if(state.tab!=="friends"||code!==state.friendCode)return;
    root.innerHTML='<h3>Chat · '+esc(code)+'</h3><div class="stack">'+messages.map(m=>
      '<div class="item"><span class="tiny muted">'+esc(m.sender)+' · '+esc(stamp(m.created_at))+
      '</span><p style="color:white;white-space:pre-wrap">'+esc(m.body)+'</p></div>').join("")+'</div>'+
      '<form id="chatForm"><label>Nachricht<textarea name="body" maxlength="1000" required rows="2"></textarea></label>'+
      '<button class="primary wide">Senden</button></form>';
    $("chatForm").onsubmit=async e=>{
      e.preventDefault();
      try{await api("/messages/"+encodeURIComponent(code),json("POST",{body:form("chatForm","body")}));renderChat()}
      catch(err){toast(err.message,true)}
    };
  }catch(e){toast(e.message,true)}
}
function renderProfile(){
  const me=state.me;
  $("panelContent").innerHTML='<div class="item"><h3>'+esc(me.username)+(me.isAdmin?' · Admin':'')+'</h3>'+
    '<p>Freundescode: <b>'+esc(me.code)+'</b></p>'+
    (me.avatar?'<img alt="Profilbild" src="'+esc(me.avatar)+'" width="76" height="76" style="object-fit:cover;border-radius:100%">':"")+'</div>'+
    '<form id="profileForm"><label>Alter<input name="age" type="number" min="16" max="110" value="'+esc(me.age||"")+'"></label>'+
    '<label>Auto<input name="car" maxlength="80" value="'+esc(me.car||"")+'" placeholder="z. B. BMW 320d"></label>'+
    '<label>Über mich<textarea name="bio" maxlength="500" rows="3">'+esc(me.bio||"")+'</textarea></label>'+
    '<label class="checkbox-row"><input name="share" type="checkbox" '+(me.shareLocation?"checked":"")+'> Live-Standort mit Freunden teilen (Admin kann ebenfalls sehen)</label>'+
    '<p class="help">Die Freigabe ist freiwillig und jederzeit abschaltbar. Positionsdaten verfallen für die Kartenanzeige nach 3 Minuten.</p>'+
    '<button class="primary wide">Profil speichern</button></form><div class="divider"></div>'+
    '<label>Profilbild (JPEG/PNG/WebP, max. 2 MB)<input id="avatarFile" type="file" accept="image/png,image/jpeg,image/webp"></label>'+
    '<button id="uploadAvatar" class="secondary wide">Profilbild hochladen</button><div class="divider"></div>'+
    '<button id="logout" class="danger wide">Abmelden</button>';
  $("profileForm").onsubmit=async e=>{
    e.preventDefault();const f=e.currentTarget;
    const share=f.elements.share.checked;
    try{state.me=await api("/me",json("PATCH",{car:f.elements.car.value,bio:f.elements.bio.value,
      age:f.elements.age.value?Number(f.elements.age.value):null,shareLocation:share}));
      renderProfile();toast("Profil gespeichert");
    }catch(err){toast(err.message,true)}
  };
  attach("uploadAvatar",async()=>{
    const file=$("avatarFile").files?.[0];
    if(!file)return toast("Datei auswählen",true);
    const fd=new FormData();fd.append("avatar",file);
    try{await api("/me/avatar",{method:"POST",body:fd});state.me=await api("/me");renderProfile();toast("Bild gespeichert")}
    catch(e){toast(e.message,true)}
  });
  attach("logout",async()=>{try{await api("/auth/logout",{method:"POST"})}catch{}logout()});
}
function renderAdmin(){
  if(!state.me?.isAdmin){setTab("map");return}
  $("panelContent").innerHTML='<p class="help">Nur Accounts mit aktivierter Freigabe erscheinen live auf der Karte. Keine heimliche Ortung.</p>'+
  '<h3>Registrierte Benutzer</h3><div id="adminList">'+empty("Lade …")+'</div>';
  api("/admin/users").then(rows=>{
    if(state.tab!=="admin")return;
    $("adminList").innerHTML=rows.map(r=>section(r.username,
      '<p>Code: '+esc(r.code)+'<br>Auto: '+esc(r.car||"—")+'<br>Freigabe: '+(r.share_location?"Aktiv":"Aus")+
      '<br>Letzte Position: '+(r.updated_at?esc(stamp(r.updated_at)):"—")+'</p>')).join("");
  }).catch(e=>toast(e.message,true));
}

/* Lightweight orbitable 3D elevation line. No synthetic elevation if provider is unavailable. */
async function show3D(){
  if(!state.route?.geometry?.length)return toast("Bitte zuerst eine Route berechnen",true);
  if(!window.THREE||!window.THREE.OrbitControls)return toast("3D-Bibliothek nicht geladen",true);
  $("modal").hidden=false;
  const root=$("terrain");root.innerHTML='<p style="padding:20px">Lade echte Höhendaten …</p>';
  const coordinates=state.route.geometry;
  const sample=Array.from({length:Math.min(30,coordinates.length)},(_,i)=>
    coordinates[Math.round(i*(coordinates.length-1)/(Math.min(30,coordinates.length)-1))]);
  let heights;
  try{
    const r=await api("/elevation?points="+encodeURIComponent(sample.map(p=>p[1]+","+p[0]).join("|")));
    heights=r.elevations;
    if(heights.some(v=>v==null))throw Error("Höhenpunkte fehlen");
  }catch(e){root.textContent="Keine Höhendaten verfügbar: "+e.message;return}
  root.innerHTML="";
  if(state.three){cancelAnimationFrame(state.three.anim);state.three.renderer.dispose();state.three=null}
  const width=root.clientWidth,height=root.clientHeight;
  const scene=new THREE.Scene();scene.background=new THREE.Color(0x0b1728);
  const camera=new THREE.PerspectiveCamera(48,width/height,.1,5000);
  const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(width,height);
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));root.appendChild(renderer.domElement);
  const controls=new THREE.OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
  const minLon=Math.min(...sample.map(p=>p[0])),maxLon=Math.max(...sample.map(p=>p[0]));
  const minLat=Math.min(...sample.map(p=>p[1])),maxLat=Math.max(...sample.map(p=>p[1]));
  const centerLon=(minLon+maxLon)/2,centerLat=(minLat+maxLat)/2;
  const scale=80/Math.max((maxLon-minLon)*Math.cos(centerLat*Math.PI/180),(maxLat-minLat),.0001);
  const bottom=Math.min(...heights);
  const vectors=sample.map((p,i)=>new THREE.Vector3(
    (p[0]-centerLon)*Math.cos(centerLat*Math.PI/180)*scale,
    (heights[i]-bottom)*.055+2,(p[1]-centerLat)*scale));
  const geo=new THREE.BufferGeometry().setFromPoints(vectors);
  const line=new THREE.Line(geo,new THREE.LineBasicMaterial({color:0x37a7ff}));
  scene.add(line);
  vectors.forEach(v=>{const g=new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(v.x,0,v.z),v]);
    scene.add(new THREE.Line(g,new THREE.LineBasicMaterial({color:0x215776,transparent:true,opacity:.6})))});
  const grid=new THREE.GridHelper(110,22,0x386185,0x28415b);scene.add(grid);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(110,110),
    new THREE.MeshBasicMaterial({color:0x19364a,transparent:true,opacity:.2,side:THREE.DoubleSide}));
  floor.rotation.x=-Math.PI/2;floor.position.y=-.05;scene.add(floor);
  const bbox=new THREE.Box3().setFromPoints(vectors);const center=bbox.getCenter(new THREE.Vector3());
  const extent=Math.max(bbox.getSize(new THREE.Vector3()).length(),50);
  camera.position.set(center.x+extent*.8,center.y+extent*.65,center.z+extent*.8);
  controls.target.copy(center);controls.update();
  $("showSurroundings").checked=true;$("showSurroundings").onchange=e=>{grid.visible=floor.visible=e.target.checked};
  const view={renderer,anim:null};state.three=view;
  const tick=()=>{if(state.three!==view)return;view.anim=requestAnimationFrame(tick);controls.update();renderer.render(scene,camera)};
  tick();
}
$("closeModal").onclick=()=>{
  $("modal").hidden=true;
  if(state.three){cancelAnimationFrame(state.three.anim);state.three.renderer.dispose();state.three=null}
  $("terrain").innerHTML="";
};
setInterval(()=>{if(state.timer?.status==="running")updateTimerDisplay();},1000);
setInterval(()=>{if(state.tab==="friends"&&state.friendCode&&$("chatPanel")&&!$("chatForm textarea:focus"))renderChat();},10000);
if("serviceWorker" in navigator&&window.isSecureContext)navigator.serviceWorker.register("/sw.js").catch(()=>{});
initMap();
boot();
