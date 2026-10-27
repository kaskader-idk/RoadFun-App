/* RoadFun experimental foreground GPS navigation.
 * OSRM maneuver coordinates are approximate; this is NOT a safety-critical navigation system.
 * All directions use current GPS; no off-route re-routing or background GPS on iOS.
 */
"use strict";
const navSession = { active:false, index:1, spoken:new Set(), voice:false, wake:null, lastCenter:0, steps:[] };

function maneuverText(step) {
  if (!step) return "Route folgen";
  const modifier = {
    "right":"rechts", "slight right":"leicht rechts", "sharp right":"scharf rechts",
    "left":"links", "slight left":"leicht links", "sharp left":"scharf links",
    "straight":"geradeaus", "uturn":"wenden"
  }[step.modifier] || "geradeaus";
  let text;
  switch (step.type) {
    case "arrive": text="Ziel erreicht"; break;
    case "depart": text="Route starten"; break;
    case "roundabout": case "rotary":
      text="Im Kreisverkehr die "+(step.exit ? step.exit+". " : "")+"Ausfahrt nehmen"; break;
    case "turn": case "end of road": case "fork": text=modifier==="geradeaus"?"Geradeaus fahren":"Nach "+modifier+" abbiegen";break;
    case "on ramp": text="Auf die Auffahrt "+modifier+" fahren";break;
    case "off ramp": text="Ausfahrt "+modifier+" nehmen";break;
    case "merge": text="Auf die Fahrbahn "+modifier+" einfädeln";break;
    case "new name": text="Der Straße weiter folgen"; break;
    default: text=modifier==="geradeaus"?"Dem Straßenverlauf folgen":"Weiter "+modifier+" halten";
  }
  if (step.road && step.type!=="arrive" && step.type!=="depart") text+=" · "+step.road;
  return text;
}
function voiceSay(text) {
  if (!navSession.voice || !("speechSynthesis" in window) || document.hidden) return;
  const u=new SpeechSynthesisUtterance(text);
  u.lang="de-AT"; u.rate=.95; u.volume=1;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
async function startNavigation() {
  if (!state.route?.steps?.length || state.route.steps.length < 2)
    return toast("Route erst neu berechnen, damit Abbiegungen geladen werden.",true);
  if (!state.pos) return toast("Aktuelle GPS-Position fehlt. Standort erlauben.",true);
  stopNavigation();
  navSession.active=true;
  navSession.index=1;
  navSession.steps=state.route.steps;
  navSession.spoken.clear();
  navSession.voice=false;
  navSession.lastCenter=0;
  $("navCard").hidden=false;
  $("routeSummary").hidden=true;
  setTab("map");
  $("navVoice").checked=false;
  navigationLocationUpdate(state.pos);
  if (navigator.wakeLock?.request) {
    try { navSession.wake=await navigator.wakeLock.request("screen"); }
    catch { /* some browsers do not support keeping the screen awake */ }
  }
  toast("Navigation gestartet. Hinweise sind experimentell.");
}
function stopNavigation() {
  navSession.active=false;
  navSession.steps=[];
  navSession.spoken.clear();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (navSession.wake) { navSession.wake.release().catch(()=>{}); navSession.wake=null; }
  const card=$("navCard");
  if(card)card.hidden=true;
  if (state?.route?.geometry && $("routeSummary")) $("routeSummary").hidden=false;
}
function navigationLocationUpdate(pos) {
  if (!navSession.active || !navSession.steps.length) return;
  const steps=navSession.steps;
  if (!Number.isFinite(pos.accuracy) || pos.accuracy > 60) {
    $("navInstruction").textContent="GPS zu ungenau – Positionssignal verbessern";
    $("navDistance").textContent="±"+Math.round(pos.accuracy || 0)+" m";
    return;
  }
  let step=steps[navSession.index];
  if (!step) { stopNavigation(); return; }
  let meters=km(pos,point(step.lat,step.lon))*1000;
  const threshold=Math.max(25,Math.min(50,(pos.accuracy || 10)*1.5));
  if (meters < threshold) {
    if (step.type==="arrive" || navSession.index===steps.length-1) {
      $("navInstruction").textContent="Ziel erreicht";
      voiceSay("Ziel erreicht");
      stopNavigation();
      toast("Ziel erreicht");
      return;
    }
    navSession.index++;
    step=steps[navSession.index];
    meters=km(pos,point(step.lat,step.lon))*1000;
  }
  const guidance=maneuverText(step);
  $("navInstruction").textContent=guidance;
  $("navDistance").textContent=meters >= 1000 ? (meters/1000).toFixed(1)+" km" : Math.round(meters)+" m";
  $("navRoad").textContent="Luftlinie zum nächsten Manöver · GPS ±"+Math.round(pos.accuracy)+" m";
  // Speak once before each upcoming maneuver. Approximate air distance, not exact road distance.
  if (meters<=350 && meters>120 && !navSession.spoken.has(navSession.index+":350")) {
    navSession.spoken.add(navSession.index+":350");
    voiceSay("In ungefähr "+Math.round(meters/50)*50+" Metern: "+guidance);
  }
  if (meters<=120 && !navSession.spoken.has(navSession.index+":120")) {
    navSession.spoken.add(navSession.index+":120");
    voiceSay("Gleich: "+guidance);
  }
  if (Date.now()-navSession.lastCenter>1700) {
    state.map.setView([pos.lat,pos.lon],Math.max(state.map.getZoom(),15),{animate:true});
    navSession.lastCenter=Date.now();
  }
}
window.startNavigation=startNavigation;
window.stopNavigation=stopNavigation;
window.navigationLocationUpdate=navigationLocationUpdate;
$("stopNavigation").addEventListener("click",()=>{stopNavigation();toast("Navigation beendet")});
$("navVoice").addEventListener("change",e=>{
  navSession.voice=e.target.checked;
  if (navSession.voice && !("speechSynthesis" in window)) {
    navSession.voice=false;e.target.checked=false;toast("Sprachausgabe in diesem Browser nicht verfügbar",true);
  } else if(navSession.voice) voiceSay("Sprachanweisungen aktiviert");
});
document.addEventListener("visibilitychange",()=>{
  if(document.hidden) {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  } else if(navSession.active && state.pos) navigationLocationUpdate(state.pos);
});
