/* ==========================================================================
   QuakeGuard dashboard
   Reads the ESP32 station from Firebase Realtime Database (REST), or runs a
   demo simulation when config.js has no database URL yet.
   ========================================================================== */
(() => {
"use strict";

const CFG = window.EQ_CONFIG || {};
const I18N = window.EQ_I18N;
const $ = (id) => document.getElementById(id);
const KEY = (k) => { try { return localStorage.getItem("qg_" + k); } catch (e) { return null; } };
const SAVE = (k, v) => { try { localStorage.setItem("qg_" + k, v); } catch (e) { /* storage off */ } };

const FLOORS = (CFG.floors && CFG.floors.length) ? CFG.floors : [{ name: "Floor 1", path: "earthquake" }];
const BASE = String(CFG.firebaseUrl || "").trim().replace(/\/+$/, "");
const params = new URLSearchParams(location.search);
const LIVE = /^https?:\/\//.test(BASE) && !BASE.includes("YOUR-PROJECT") && !params.has("demo");
const DEMO = !LIVE;
const STATION = Object.assign({ lat: 34.35, lon: 62.20, place: "Herat" }, CFG.station || {});
const TOTAL = CFG.peoplePerFloor || 20;
const PIN = String(CFG.managerPin ?? "");

/* ----------------------------------------------------------------- text */
let lang = KEY("lang") === "fa" ? "fa" : "en";
function tt(L, k, v) {
  let s = (I18N[L] && I18N[L][k] != null) ? I18N[L][k] : (I18N.en[k] != null ? I18N.en[k] : k);
  if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]);
  return s;
}
const t = (k, v) => tt(lang, k, v);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fix = (n, d) => (typeof n === "number" && isFinite(n) ? n.toFixed(d) : "—");

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return t("justNow");
  if (s < 60) return t("sAgo", { n: s });
  if (s < 3600) return t("minAgo", { n: Math.round(s / 60) });
  if (s < 86400) return t("hAgo", { n: Math.round(s / 3600) });
  return t("dAgo", { n: Math.round(s / 86400) });
}
function dur(s) {
  s = Math.max(0, Math.floor(s || 0));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}

/* --------------------------------------------------- intensity (MMI) */
// Worden et al. (2012), PGA in cm/s^2
function mmiFromG(g) {
  if (!(g >= 0.005)) return 1;                 // below the MPU6050's reliable range
  const L = Math.log10(g * 980.665);
  const m = L <= 1.57 ? 1.78 + 1.55 * L : -1.60 + 3.70 * L;
  return Math.min(10, Math.max(1, m));
}
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const MMI_COL = ["", "#ffffff", "#bfccff", "#a0e6ff", "#80ffff", "#7aff93", "#ffff00", "#ffc800", "#ff9100", "#ff0000", "#c80000"];
const mmiInt = (g) => Math.round(mmiFromG(g));
const levelOf = (g) => { const m = mmiFromG(g); return m < 4 ? 0 : m < 6 ? 1 : m < 8 ? 2 : 3; };
const AMP = [0, 1.5, 3.5, 6];

/* ======================================================== floor plan */
// Drawn from the physical model: 5 rooms on each side of a long corridor,
// a door from every room into the corridor, windows with red awnings on the
// outer walls, and the emergency exit at the right end of the corridor.
const PX = [20, 181, 304, 428, 559, 690];          // room walls (x)
const TOP = 40, C_TOP = 183, C_BOT = 301, BOT = 440;     // outer wall, corridor walls
const EXIT_Y = 242, EXIT = [690, EXIT_Y], SAFE = [726, 334];
const DOOR_T = [151, 251, 357, 466, 574], DOOR_B = [153, 255, 365, 464, 576], DW = 28;
const SVGNS = "http://www.w3.org/2000/svg";
(function buildPlan() {
  let rooms = "", walls = "", aw = "", doors = "";
  for (let side = 0; side < 2; side++) {
    const y0 = side ? C_BOT : TOP, y1 = side ? BOT : C_TOP, dxs = side ? DOOR_B : DOOR_T;
    for (let i = 0; i < 5; i++) {
      const x0 = PX[i], x1 = PX[i + 1], cx = (x0 + x1) / 2, n = side * 5 + i;
      rooms += `<g class="rm" data-room="${n}"><rect class="room" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}"/>` +
        `<text class="rno" x="${cx}" y="${(y0 + y1) / 2 + 5}" text-anchor="middle">${n + 1}</text></g>`;
      const dx = dxs[i];
      doors += side
        ? `<path class="door" d="M${dx} ${C_BOT}V${C_BOT + DW}A${DW} ${DW} 0 0 0 ${dx + DW} ${C_BOT}"/>`
        : `<path class="door" d="M${dx} ${C_TOP}V${C_TOP - DW}A${DW} ${DW} 0 0 1 ${dx + DW} ${C_TOP}"/>`;
      if (i > 0) {                                   // window + red awning (rooms 2-5)
        const w = (x1 - x0) * 0.42, a0 = cx - w / 2, a1 = cx + w / 2;
        const wy = side ? BOT : TOP;
        walls += `<rect class="win" x="${a0}" y="${wy - 3}" width="${w}" height="6" rx="1"/>`;
        aw += side
          ? `<polygon class="awning" points="${a0 + 4},${BOT + 3} ${a1 + 6},${BOT + 3} ${a1 + 6},${BOT + 22} ${a0 + 4},${BOT + 15}"/>`
          : `<polygon class="awning" points="${a0 + 4},${TOP - 3} ${a1 + 6},${TOP - 3} ${a1 + 6},${TOP - 22} ${a0 + 4},${TOP - 15}"/>`;
      }
    }
    // room dividers
    for (let i = 1; i < 5; i++) walls += `<path class="wall" pathLength="1" d="M${PX[i]} ${y0}V${y1}"/>`;
    // corridor wall with door gaps
    const wy = side ? C_BOT : C_TOP;
    let x = PX[0], d = "";
    dxs.forEach((dx) => { d += `M${x} ${wy}H${dx}`; x = dx + DW; });
    d += `M${x} ${wy}H${PX[5]}`;
    walls += `<path class="wall" pathLength="1" d="${d}"/>`;
  }
  // outer wall with the exit opening on the right
  walls += `<path class="wall outer" pathLength="1" d="M${PX[5]} ${EXIT_Y - 20}V${TOP}H${PX[0]}V${BOT}H${PX[5]}V${EXIT_Y + 20}"/>`;
  $("rooms").innerHTML = rooms;
  $("walls").innerHTML = walls;
  $("awnings").innerHTML = aw;
  $("doors").innerHTML = doors;
})();

// Evacuation routes (one per room) and animated dots
const people = [], WALK = 75;
(function buildRoutes() {
  const routes = [];
  for (let i = 0; i < 5; i++) {
    const c = (PX[i] + PX[i + 1]) / 2, dc = DOOR_T[i] + DW / 2;
    routes.push([[c, 100], [dc, 160], [dc, 226], [672, 226], EXIT, [712, 270], SAFE]);
  }
  for (let i = 0; i < 5; i++) {
    const c = (PX[i] + PX[i + 1]) / 2, dc = DOOR_B[i] + DW / 2;
    routes.push([[c, 384], [dc, 324], [dc, 258], [672, 258], EXIT, [712, 270], SAFE]);
  }
  routes.forEach((pts, i) => {
    const d = [0];
    for (let k = 1; k < pts.length; k++) d.push(d[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const el = document.createElementNS(SVGNS, "circle");
    el.setAttribute("r", 4.5); el.setAttribute("class", "person"); $("people").appendChild(el);
    const p = { pts, d, el, delay: (i % 5) * 420 + (i >= 5 ? 200 : 0) }; people.push(p); place(p, 0);
  });
})();
function place(p, s) {
  const n = p.pts.length, tot = p.d[n - 1];
  if (s >= tot) { p.el.style.opacity = 0; return; }
  let k = 1; while (k < n - 1 && s > p.d[k]) k++;
  const f = (s - p.d[k - 1]) / (p.d[k] - p.d[k - 1]), a = p.pts[k - 1], b = p.pts[k];
  p.el.setAttribute("cx", a[0] + (b[0] - a[0]) * f); p.el.setAttribute("cy", a[1] + (b[1] - a[1]) * f); p.el.style.opacity = 1;
}
let run = false, tStart = 0, raf = 0;
function step(now) {
  const el = (now - tStart) / 1000; let done = true;
  people.forEach((p) => { const s = Math.max(0, el - p.delay / 1000) * WALK; place(p, s); if (s < p.d[p.d.length - 1]) done = false; });
  $("safezone").classList.toggle("filled", el > 3);
  if (run && !done) raf = requestAnimationFrame(step);
}
function evac(alarm, doorOpen) {
  $("scene").classList.toggle("evac", alarm || run);
  if (alarm && !run) { run = true; tStart = performance.now(); raf = requestAnimationFrame(step); }
  if (!alarm && !doorOpen && run) { run = false; cancelAnimationFrame(raf); people.forEach((p) => place(p, 0)); $("safezone").classList.remove("filled"); $("scene").classList.remove("evac"); }
}

// Your room (1 plan unit ≈ 6 cm, so the 670-unit building is about 40 m long)
let mine = KEY("room") === null ? -1 : +KEY("room");
if (mine > 9) mine = -1;
const routeLen = (i) => people[i] ? people[i].d[4] * 0.06 : 0;   // to the exit door
function showRoute() {
  const l = $("myroute"), m = $("me");
  document.querySelectorAll("[data-room]").forEach((g) => g.classList.toggle("mine", +g.dataset.room === mine));
  m.style.display = mine < 0 ? "none" : "";
  if (mine < 0 || !people[mine]) { l.setAttribute("points", ""); $("route").textContent = t("routePrompt"); return; }
  const p = people[mine], len = routeLen(mine);
  l.setAttribute("points", p.pts.slice(0, 5).map((a) => a.join(",")).join(" "));
  m.setAttribute("cx", p.pts[0][0]); m.setAttribute("cy", p.pts[0][1]);
  l.classList.remove("draw"); void l.getBBox(); l.classList.add("draw");
  $("route").textContent = t("routeText", { n: mine + 1, m: Math.round(len), s: Math.round(len / 1.4) });
}
$("scene").addEventListener("click", (e) => {
  const g = e.target.closest && e.target.closest("[data-room]");
  if (g) { mine = +g.dataset.room; SAVE("room", mine); showRoute(); }
});

/* ============================================================ charts */
const TRACE_N = 600, STA_N = 150;
const trace = new Array(TRACE_N).fill(null), traceQ = [];
const staHist = new Array(STA_N).fill(null);
let lastD = null;

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function prepCanvas(c) {
  const r = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w) return null;
  c.width = Math.round(w * r); c.height = Math.round(h * r);
  const x = c.getContext("2d"); x.setTransform(r, 0, 0, r, 0, 0); x.direction = "ltr"; x.textAlign = "left";
  return { x, w, h };
}
function drawChart() {
  const p = prepCanvas($("chart")); if (!p) return;
  const { x, w, h } = p, pad = 46, thr = lastD ? lastD.threshold : 0.03;
  let max = 0; for (const v of trace) if (v != null && v > max) max = v;
  const top = Math.max(thr * 2, max * 1.15, 0.02);
  const y = (v) => h - 18 - Math.min(v / top, 1) * (h - 28);
  const line = css("--line"), mut = css("--muted");
  x.font = "11px system-ui,sans-serif"; x.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = top * i / 4; x.strokeStyle = line; x.beginPath(); x.moveTo(pad, y(v)); x.lineTo(w, y(v)); x.stroke();
    x.fillStyle = mut; x.fillText(v.toFixed(top < 0.1 ? 3 : 2) + " g", 0, y(v) + 4);
  }
  const st = document.body.dataset.state;
  const col = css(st === "fire" ? "--fire" : (st === "quake" || st === "hold") ? "--quake" : "--ok");
  const first = trace.findIndex((v) => v != null);
  if (first >= 0) {
    x.beginPath();
    for (let i = first; i < TRACE_N; i++) { const px = pad + i / (TRACE_N - 1) * (w - pad); i === first ? x.moveTo(px, y(trace[i] || 0)) : x.lineTo(px, y(trace[i] || 0)); }
    x.strokeStyle = col; x.lineWidth = 1.6; x.stroke();
    x.lineTo(w, y(0)); x.lineTo(pad + first / (TRACE_N - 1) * (w - pad), y(0)); x.closePath();
    x.globalAlpha = 0.15; x.fillStyle = col; x.fill(); x.globalAlpha = 1;
  }
  x.setLineDash([6, 5]); x.strokeStyle = css("--fire"); x.lineWidth = 1.4;
  x.beginPath(); x.moveTo(pad, y(thr)); x.lineTo(w, y(thr)); x.stroke(); x.setLineDash([]);
  x.fillStyle = mut;
  ["-60 s", "-45 s", "-30 s", "-15 s", "0"].forEach((s, i) => x.fillText(s, pad + i / 4 * (w - pad) - (i === 4 ? 10 : i ? 14 : 0), h - 3));
}
function drawSta() {
  const p = prepCanvas($("stachart")); if (!p) return;
  const { x, w, h } = p, pad = 34;
  const trig = lastD ? lastD.staTrig : 3, det = lastD ? lastD.staDetrig : 1.5;
  let max = 0; for (const v of staHist) if (v != null && v > max) max = v;
  const top = Math.max(trig * 1.5, max * 1.1);
  const y = (v) => h - 8 - Math.min(v / top, 1) * (h - 16);
  x.font = "11px system-ui,sans-serif"; x.fillStyle = css("--muted"); x.strokeStyle = css("--line"); x.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const v = top * i / 3; x.beginPath(); x.moveTo(pad, y(v)); x.lineTo(w, y(v)); x.stroke(); x.fillText(v.toFixed(1), 0, y(v) + 4); }
  [[trig, "--fire", t("trigLine"), -4], [det, "--quake", t("detrigLine"), 13]].forEach(([v, c, label, dy]) => {
    x.setLineDash([6, 5]); x.strokeStyle = css(c); x.beginPath(); x.moveTo(pad, y(v)); x.lineTo(w, y(v)); x.stroke(); x.setLineDash([]);
    x.fillStyle = css(c); x.fillText(label, w - x.measureText(label).width - 4, Math.min(h - 2, y(v) + dy));
  });
  const first = staHist.findIndex((v) => v != null);
  if (first >= 0) {
    x.beginPath();
    for (let i = first; i < STA_N; i++) { const px = pad + i / (STA_N - 1) * (w - pad); i === first ? x.moveTo(px, y(staHist[i] || 0)) : x.lineTo(px, y(staHist[i] || 0)); }
    x.strokeStyle = css("--ok"); x.lineWidth = 1.8; x.stroke();
  }
}
function drawAll() { drawChart(); drawSta(); }
setInterval(() => {                 // feed queued points at 10 per second
  if (!traceQ.length) return;
  const n = traceQ.length > 25 ? traceQ.length - 10 : 1;
  for (let i = 0; i < n && traceQ.length; i++) { trace.shift(); trace.push(traceQ.shift()); }
  drawChart();
}, 100);
addEventListener("resize", drawAll);

/* ====================================================== static text */
const STEPS = { ok: ["ok1", "ok2", "ok3"], quake: ["q1", "q2", "q3", "q4"], fire: ["f1", "f2", "f3", "f4"], after: ["a1", "a2", "a3", "a4"] };
const STEPS_H = { ok: "stepsReady", quake: "stepsQuake", fire: "stepsFire", after: "stepsAfter" };
let stepsK = "";
function steps(k) {
  if (k === stepsK) return; stepsK = k;
  $("steps").innerHTML = STEPS[k].map((s) => "<li>" + esc(t(s)) + "</li>").join("");
  $("osteps").innerHTML = (k === "ok" || k === "after") ? "" : STEPS[k].slice(0, 3).map((s) => "<li>" + esc(t(s)) + "</li>").join("");
  $("stepsh").textContent = t(STEPS_H[k]);
}
(function buildScale() {
  $("mmiscale").innerHTML = ROMAN.slice(1).map((r, i) => `<span style="background:${MMI_COL[i + 1]}" title="${r}"></span>`).join("");
})();

/* ===================================================== preferences */
const TH = ["auto", "light", "dark"];
let th = KEY("theme") || "dark", big = KEY("big") === "on", voiceOn = KEY("voice") === "on", notifOn = KEY("notif") === "on";
let soundOn = false, ac = null, sirenTimer = 0;
function prefLabels() {
  $("theme").textContent = t("theme", { t: t("theme" + th) });
  $("big").textContent = t("bigText", { s: t(big ? "on" : "off") });
  $("voice").textContent = t(voiceOn ? "voiceOn" : "voiceOff");
  $("snd").textContent = t(soundOn ? "soundOn" : "soundOff");
  $("lang").textContent = t("lang");
  const blocked = "Notification" in window && Notification.permission === "denied";
  $("notif").textContent = blocked ? t("notifBlocked") : t(notifOn ? "notifOn" : "notifOff");
  $("notif").disabled = !("Notification" in window) || blocked;
}
function applyPrefs() {
  document.documentElement.dataset.theme = th;
  document.documentElement.dataset.big = big ? "on" : "off";
  prefLabels();
}
$("theme").onclick = () => { th = TH[(TH.indexOf(th) + 1) % 3]; SAVE("theme", th); applyPrefs(); drawAll(); };
$("big").onclick = () => { big = !big; SAVE("big", big ? "on" : "off"); applyPrefs(); drawAll(); };
$("snd").onclick = () => {
  soundOn = !soundOn; prefLabels();
  if (soundOn) { const A = window.AudioContext || window.webkitAudioContext; if (A) { ac = ac || new A(); ac.resume(); } }
  else siren(false);
};
$("voice").onclick = () => {
  voiceOn = !voiceOn; SAVE("voice", voiceOn ? "on" : "off"); prefLabels();
  if (voiceOn) say("sayVoiceOn"); else if (window.speechSynthesis) speechSynthesis.cancel();
};
$("notif").onclick = async () => {
  if (!("Notification" in window)) return;
  if (!notifOn && Notification.permission !== "granted") await Notification.requestPermission();
  notifOn = !notifOn && Notification.permission === "granted";
  SAVE("notif", notifOn ? "on" : "off"); prefLabels();
};
$("lang").onclick = () => { lang = lang === "fa" ? "en" : "fa"; SAVE("lang", lang); applyLang(); };

function applyLang() {
  const L = I18N[lang];
  document.documentElement.lang = lang === "fa" ? "fa-AF" : "en";
  document.documentElement.dir = L.dir;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $("regiontitle").textContent = t("regionTitle", { place: STATION.place });
  if (DEMO) { $("test").textContent = t("btnSimQuake"); $("firebtn").textContent = t("btnSimFire"); }
  stepsK = ""; evHash = "";
  prefLabels(); showRoute(); renderContacts(); markSafe(); renderTimeline();
  if (lastD) render(lastD);
  if (qData) renderQuakes();
  drawAll();
}

/* ======================================================== sound etc. */
function siren(on) {
  if (on && soundOn && ac) {
    if (!sirenTimer) {
      let hi = false;
      const beep = () => { const o = ac.createOscillator(), g = ac.createGain(); o.type = "square"; o.frequency.value = hi ? 880 : 620; hi = !hi; g.gain.value = 0.06; o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.35); };
      beep(); sirenTimer = setInterval(beep, 400);
    }
  } else if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = 0; }
}
function voiceLang() {
  if (lang !== "fa" || !window.speechSynthesis) return "en";
  return speechSynthesis.getVoices().some((v) => /^fa/i.test(v.lang)) ? "fa" : "en";
}
function say(k, extra) {
  if (!voiceOn || !window.speechSynthesis) return;
  const L = voiceLang();
  const text = typeof k === "function" ? k(L) : tt(L, k) + (extra || "");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = L === "fa" ? "fa-IR" : "en-US"; u.rate = 0.95;
  speechSynthesis.speak(u);
}
const alarmSpeech = (d) => (L) => tt(L, d.fire ? "sayFire" : "sayQuake") + tt(L, "sayMain") + (mine >= 0 ? tt(L, "sayRoom", { m: Math.round(routeLen(mine)) }) : "");
$("speak").onclick = () => { voiceOn = true; SAVE("voice", "on"); prefLabels(); if (lastD) say(alarmSpeech(lastD)); };

function notify(d) {
  if (!notifOn || !("Notification" in window) || Notification.permission !== "granted") return;
  const title = "QuakeGuard: " + t(d.fire ? "headFire" : "headQuake");
  const opts = { body: floorName() + ". " + t("alertText"), tag: "quakeguard", renotify: true, requireInteraction: true, icon: "icons/icon-192.png" };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts)).catch(() => {});
  else try { new Notification(title, opts); } catch (e) { /* not allowed here */ }
}

/* ======================================================== contacts */
const CT = [["ctPolice", "police"], ["ctAmb", "amb"], ["ctFire", "fire"], ["ctMgr", "mgr"]];
const DEF_CT = Object.assign({ police: "119", amb: "102", fire: "112", mgr: "" }, CFG.contacts || {});
const ctVal = (k) => { const v = KEY("ct_" + k); return v === null ? (DEF_CT[k] || "") : v; };
function renderContacts() {
  $("ct").innerHTML = CT.map(([label, k]) => {
    const v = ctVal(k);
    return `<div class="crow"><label>${esc(t(label))}<input id="in_${k}" type="tel" inputmode="tel" value="${esc(v)}" placeholder="${esc(t("enterNumber"))}" dir="ltr"></label><a class="callb" ${v ? `href="tel:${esc(v)}"` : ""}>${esc(t("call"))}</a></div>`;
  }).join("");
  CT.forEach(([, k]) => { $("in_" + k).onchange = (e) => { SAVE("ct_" + k, e.target.value.trim()); renderContacts(); }; });
  smsHref();
}
function smsHref() {
  const d = lastD || {};
  const kind = d.fire ? t("kindFireLower") : d.quake ? t("kindQuakeLower") : t("kindEmergency");
  const body = t("smsBody", { floor: floorName(), kind }) + (mine >= 0 ? t("smsRoom", { n: mine + 1 }) : "");
  const n = ctVal("mgr");
  if (n) $("sms").href = "sms:" + n + "?&body=" + encodeURIComponent(body); else $("sms").removeAttribute("href");
}

/* ============================================================ PIN */
function askPin() {
  return new Promise((res) => {
    if (!PIN) return res(true);
    let s = null; try { s = sessionStorage.getItem("qg_pin"); } catch (e) { /* ignore */ }
    if (s === PIN) return res(true);
    $("pinm").style.display = "flex"; $("pini").value = ""; $("pini").focus();
    const done = (ok) => {
      $("pinm").style.display = "none";
      if (!ok) return res(false);
      const v = $("pini").value;
      if (v !== PIN) { msg(DEMO ? "msgDemoPin" : "msgWrongPin"); return res(false); }
      try { sessionStorage.setItem("qg_pin", v); } catch (e) { /* ignore */ }
      res(true);
    };
    $("pinok").onclick = () => done(true);
    $("pinno").onclick = () => done(false);
    $("pini").onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
  });
}
let msgTimer = 0;
function msg(k, v) { $("msg").textContent = t(k, v); clearTimeout(msgTimer); msgTimer = setTimeout(() => { $("msg").textContent = ""; }, 8000); }

/* ======================================================== floors */
let curFloor = Math.min(+(KEY("floor") || 0), FLOORS.length - 1);
const floorState = FLOORS.map(() => "ok");
const floorName = () => FLOORS[curFloor].name;
let floorsHtml = "";
function floorsUI() {
  const dotCol = (s) => s === "ok" ? "var(--ok)" : s === "quake" || s === "hold" ? "var(--quake)" : s === "fire" ? "var(--fire)" : "var(--muted)";
  const h = FLOORS.map((f, i) => `<button class="fchip ${i === curFloor ? "on" : ""} ${floorState[i] === "quake" || floorState[i] === "fire" ? "alarm" : ""}" data-i="${i}" aria-label="${esc(f.name)}" aria-pressed="${i === curFloor}">${esc(f.name.replace(/^\D+/, "") || f.name)}</button>`).join("") + "|" +
    FLOORS.map((f, i) => `<li><button class="fitem ${i === curFloor ? "on" : ""}" data-i="${i}"><i class="dot" style="background:${dotCol(floorState[i])}"></i>${esc(f.name)}</button></li>`).join("");
  if (h === floorsHtml) return; floorsHtml = h;
  const p = h.split("|"); $("fchips").innerHTML = p[0]; $("flist").innerHTML = p[1];
  document.querySelectorAll("[data-i]").forEach((b) => { b.onclick = () => pickFloor(+b.dataset.i); });
}
function pickFloor(i) {
  if (i === curFloor) return;
  curFloor = i; SAVE("floor", i);
  resetView(); floorsUI();
  if (LIVE) { liveReset(); pollLive(); pollEvents(); pollSafe(); loadConfig(); }
  else { sim = sims[i]; tick(); }
}
function resetView() {
  TL = []; renderTimeline(); prev = {}; first = true; safeMe = false; markSafe(); stepsK = "";
  trace.fill(null); traceQ.length = 0; staHist.fill(null); events = []; evHash = ""; drawAll();
}

/* ======================================================== timeline */
let TL = [], prev = {}, first = true, aStart = 0, peek = false, safeMe = false, wasAlarm = false;
function tl(k) { TL.unshift([Date.now(), k]); TL = TL.slice(0, 14); renderTimeline(); }
function renderTimeline() {
  $("tl").innerHTML = TL.map(([ms, k]) => `<li><i class="dot" style="background:var(--neon)"></i><span>${esc(t(k))}</span><time>${new Date(ms).toLocaleTimeString()}</time></li>`).join("");
}
function markSafe() {
  [$("safe"), $("safe2")].forEach((b) => { b.textContent = t(safeMe ? "markedSafe" : "imSafe"); b.disabled = safeMe; });
}
async function iAmSafe() {
  try { await sendSafe(); safeMe = true; msg("safeThanks"); say("safeThanks"); }
  catch (e) { msg("msgSafeFail"); }
  markSafe();
}
$("safe").onclick = $("safe2").onclick = iAmSafe;
$("peek").onclick = () => { peek = true; document.body.classList.add("peek"); };

/* ============================================================ render */
function render(d) {
  lastD = d;
  const online = d.online !== false;
  const alarm = online && d.state === "ALARM";
  const hold = online && d.state === "HOLD";
  const realAlarm = alarm && !d.test;
  const level = levelOf(d.g);

  // status
  let state = "ok", head = "headOk", sub = d.door ? "subHold" : "subOk";
  if (!online) { state = "off"; head = d.offKind || "headOffline"; sub = { headOffline: "subOffline", headWaiting: "subWaiting", headUnreachable: "subUnreachable" }[head] || "subOffline"; }
  else if (d.state === "CALIBRATING") { head = "headCalib"; sub = "subCalib"; }
  else if (alarm && d.fire) { state = "fire"; head = d.test ? "headTestFire" : "headFire"; sub = d.test ? "subTest" : "subAlarm"; }
  else if (alarm) { state = "quake"; head = d.test ? "headTestQuake" : "headQuake"; sub = d.test ? "subTest" : "subAlarm"; }
  else if (hold) { state = "hold"; head = "headHold"; sub = "subHold"; }
  document.body.dataset.state = state;
  $("head").textContent = t(head);
  $("sub").textContent = t(sub);
  floorState[curFloor] = state === "off" ? "off" : state;
  floorsUI();

  // floor plan
  const s = $("scene");
  s.classList.toggle("neon-on", online && d.light);
  s.classList.toggle("door-open", online && d.door);
  s.classList.toggle("fire", alarm && d.fire);
  s.classList.toggle("nogas", !d.gasEnabled);
  const shaking = online && ((alarm && d.quake) || level > 0);
  s.classList.toggle("shaking", shaking);
  $("plan").style.setProperty("--amp", shaking ? AMP[Math.max(level, alarm && d.quake ? 1 : 0)] : 0);
  $("plantitle").textContent = t("planTitle", { floor: floorName() });

  // intensity
  const mNow = online ? mmiInt(d.g) : 1, mPeak = d.peak > 0 ? mmiInt(d.peak) : 0;
  $("mmir").textContent = online ? ROMAN[mNow] : "–";
  $("mmir").style.background = MMI_COL[mNow];
  $("mmil").textContent = online ? t("mmi" + mNow) : "—";
  $("mmip").textContent = mPeak ? `${ROMAN[mPeak]} · ${t("mmi" + mPeak)} (${fix(d.peak, 3)} g)` : t("noneYet");
  [...$("mmiscale").children].forEach((el, i) => { el.classList.toggle("on", i < mNow); el.classList.toggle("pk", i + 1 === mPeak); });

  // sensor cards
  const lv = alarm && d.quake ? Math.max(level, 1) : level;
  $("vib").textContent = online ? fix(d.g, 3) + " g" : "—";
  bd("bv", lv === 0 ? "ok" : lv === 1 ? "warn" : "bad", t("lvl" + lv));
  bd("bchart", lv === 0 ? "ok" : lv === 1 ? "warn" : "bad", t("lvl" + lv));
  if (!d.gasEnabled) { $("gas").textContent = t("notInstalled"); bd("bg", "mute", t("bNotInstalled")); }
  else if (d.gasWarm) { $("gas").textContent = t("warming"); bd("bg", "mute", t("bWarm")); }
  else {
    $("gas").textContent = `${d.gas} / ${d.gasLimit}`;
    bd("bg", d.fire && alarm ? "bad" : d.gas > d.gasLimit * 0.8 ? "warn" : "ok", t(d.fire && alarm ? "bDanger" : "bNormal"));
  }
  $("neon").textContent = t(d.light ? "bOn" : "bOff"); bd("bn", d.light ? "ok" : "mute", t(d.light ? "bActive" : "bNormal"));
  $("doorv").textContent = t(d.door ? "bOpen" : "bSecure"); bd("bd2", d.door ? "warn" : "ok", t(d.door ? "bOpen" : "bSecure"));
  $("buzz").textContent = t(d.buzzer ? "bSounding" : "bSilent") + ", LED " + t(d.led ? "bOn" : "bOff").toLowerCase();
  bd("bb", d.buzzer ? "bad" : d.led ? "warn" : "mute", t(d.buzzer ? "bSounding" : d.led ? "bOn" : "bSilent"));
  $("tilt").textContent = fix(d.tilt, 2) + "°";
  bd("bt", d.tilt > 2 ? "bad" : d.tilt > 0.7 ? "warn" : "ok", t(d.tilt > 0.7 ? "bShifted" : "bSteadyTilt"));

  // captions
  $("vibcap").textContent = t("vibCap", { g: fix(d.threshold, 3) });
  $("stacap").textContent = t("staCap", { g: fix(d.threshold, 3), d: fix(d.minDur, 1) });

  // people
  $("safen").textContent = t("ofN", { a: d.safe ?? 0, b: TOTAL });

  // aftershock watch
  const w = d.watchLeft > 0;
  $("watch").hidden = !w;
  if (w) $("watcht").textContent = t("watchBanner", { h: Math.max(1, Math.round(d.watchLeft / 3600)), n: d.aftershocks || 0 });

  // controls
  const busy = !online || d.state !== "MONITORING";
  $("reset").disabled = !online || !(alarm || hold);
  $("test").disabled = busy;
  $("firebtn").disabled = busy;
  $("calib").disabled = busy;

  // steps
  steps(alarm && !d.test ? (d.fire ? "fire" : "quake") : hold ? "after" : "ok");

  // timeline
  const neon = online && d.light, door = online && d.door;
  if (alarm && d.quake && !prev.q) tl("tlShaking");
  if (alarm && d.fire && !prev.f) tl("tlGas");
  if (neon && !prev.n) { tl("tlLights"); aStart = first && activeEventStart() ? activeEventStart() : Date.now(); }
  if (door && !prev.d) tl("tlDoorOpen");
  if (!neon && prev.n) tl("tlCleared");
  if (!door && prev.d) { tl("tlDoorClosed"); safeMe = false; markSafe(); }
  if (!first && !online && prev.o) tl("tlOffline");
  if (!first && online && prev.o === false) tl("tlOnline");
  prev = { q: alarm && d.quake, f: alarm && d.fire, n: neon, d: door, o: online };
  first = false;
  const el = Math.max(0, Math.round((Date.now() - aStart) / 1000));
  $("timer").textContent = neon ? t("alarmFor", { t: Math.floor(el / 60) + ":" + String(el % 60).padStart(2, "0") }) : t("noAlarm");

  // full-screen alarm (real alarms only, not tests)
  if (!realAlarm) peek = false;
  document.body.classList.toggle("alarm", realAlarm);
  document.body.classList.toggle("peek", peek);
  $("ah").textContent = t(d.fire ? "alertFire" : "alertQuake");
  $("ap").textContent = (mine >= 0 ? t("routeText", { n: mine + 1, m: Math.round(routeLen(mine)), s: Math.round(routeLen(mine) / 1.4) }) + " " : "") + t("alertText");
  document.title = realAlarm ? t("docAlert", { floor: floorName() }) : t("docTitle");

  // effects
  if (realAlarm && !wasAlarm) { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); notify(d); }
  effects(d, realAlarm);
  wasAlarm = realAlarm;
  siren(realAlarm);
  evac(realAlarm || (alarm && d.test), door);

  health(d);
  stats(d);
  smsHref();
  if (DEMO) $("faultbtn").textContent = t("btnFault");
}
function bd(id, c, txt) { const e = $(id); e.className = "bd " + c + (id === "bchart" ? " push" : ""); e.textContent = txt; const sc = e.closest(".sc"); if (sc) sc.dataset.tone = c; }

let vTimer = 0, bTimer = 0;
function effects(d, on) {
  if (on) {
    if (!vTimer) { say(alarmSpeech(d)); vTimer = setInterval(() => lastD && say(alarmSpeech(lastD)), 15000); }
    if (!bTimer && navigator.vibrate) bTimer = setInterval(() => navigator.vibrate([300, 150, 300, 150, 300]), 3000);
  } else {
    if (vTimer) { clearInterval(vTimer); vTimer = 0; say("sayEnd"); }
    if (bTimer) { clearInterval(bTimer); bTimer = 0; if (navigator.vibrate) navigator.vibrate(0); }
  }
}

function health(d) {
  const online = d.online !== false;
  const gasBad = d.gasEnabled && !d.gasWarm && (d.gas <= 5 || d.gas >= 4090);
  const rssiTxt = d.rssi == null ? t("connected") : d.rssi > -67 ? t("good") : d.rssi > -80 ? t("weak") : t("veryWeak");
  const rows = [
    [t("hGyro"), d.sensorOk !== false, t("working"), t("notResponding")],
    [t("hGas"), !gasBad, !d.gasEnabled ? t("notInstalled") : d.gasWarm ? t("warming") : t("working"), t("looksWrong")],
    [t("hWifi"), d.rssi == null || d.rssi > -80, rssiTxt + (d.rssi != null ? ` (${d.rssi} dBm)` : ""), rssiTxt + ` (${d.rssi} dBm)`]
  ];
  let h = rows.map((r) => `<dt><i class="dot" style="background:${r[1] ? "var(--ok)" : "var(--fire)"}"></i> ${esc(r[0])}</dt><dd>${esc(r[1] ? r[2] : r[3])}</dd>`).join("");
  h += `<dt><i class="dot" style="background:var(--muted)"></i> ${esc(t("hDoor"))}</dt><dd>${esc(t(d.door ? "openCmd" : "closedCmd"))}</dd>`;
  if (d.fw) h += `<dt>${esc(t("hFw"))}</dt><dd>v${esc(d.fw)}</dd>`;
  if (d.heap) h += `<dt>${esc(t("hMem"))}</dt><dd>${Math.round(d.heap / 1024)} KB</dd>`;
  if (d.uptime != null) h += `<dt>${esc(t("hUptime"))}</dt><dd>${esc(dur(d.uptime))}</dd>`;
  $("hl").innerHTML = h;
  const bad = online ? rows.filter((r) => !r[1] && r[0] !== t("hWifi")).map((r) => r[0].toLowerCase()) : [];
  $("fault").hidden = !bad.length;
  $("fault").textContent = bad.length ? t("faultText", { list: bad.join(", ") }) : "";
  $("hs").textContent = bad.length ? t("healthBad") : t("healthOk");
}

/* ============================================================ events */
let events = [], evHash = "", evTime = 0;
const catResults = {};
const activeEventStart = () => { const e = events.find((x) => x.status === "active" && !x.test); return e ? e.start : 0; };
const KIND = { quake: ["kQuake", "var(--quake)"], fire: ["kFire", "var(--fire)"], test: ["kTest", "var(--muted)"] };
function stats(d) {
  const real = events.filter((e) => !e.test);
  const q = real.filter((e) => e.kind === "quake"), f = real.filter((e) => e.kind === "fire");
  $("sq").textContent = Math.max(q.length, d.quakes || 0);
  $("sf").textContent = Math.max(f.length, d.fires || 0);
  const strongest = Math.max(d.peakAll || 0, ...q.map((e) => e.peak || 0));
  $("sp").textContent = strongest > 0 ? `${fix(strongest, 3)} g (${ROMAN[mmiInt(strongest)]})` : t("noneYet");
  $("sl").textContent = real.length && real[0].start ? ago(real[0].start) : t("noneYet");
  const h = JSON.stringify(events) + lang;
  if (h === evHash && Date.now() - evTime < 10000) return;
  evHash = h; evTime = Date.now();
  const l = $("evs");
  if (!events.length) { l.innerHTML = `<li><span></span><span>${esc(t("noEvents"))}</span></li>`; return; }
  l.innerHTML = events.slice(0, 12).map((e) => {
    const k = KIND[e.test ? "test" : e.kind] || KIND.quake;
    const val = e.kind === "fire" ? t("evGas", { v: Math.round(e.gas || 0) }) : e.test ? "" : t("evPeak", { g: fix(e.peak, 3) }) + ` (${ROMAN[mmiInt(e.peak)]})`;
    const len = e.status === "active" ? t("evActive") : (e.dur != null ? fix(e.dur, 0) + " s" : "");
    const txt = [t(k[0]), val, len].filter(Boolean).join(", ");
    const canCheck = !e.test && e.kind === "quake" && e.start;
    return `<li><i class="dot" style="background:${k[1]}"></i><span>${esc(txt)}</span><time>${e.start ? esc(ago(e.start)) : ""}</time>` +
      (canCheck ? `<div class="act"><button data-check="${esc(e.key)}">${esc(t("checkUsgs"))}</button><span id="cat_${esc(e.key)}">${esc(catResults[e.key] || "")}</span></div>` : "") + "</li>";
  }).join("");
  l.querySelectorAll("[data-check]").forEach((b) => { b.onclick = () => catalogCheck(b.dataset.check); });
}

// "Was it a real earthquake?" — look for a USGS event near the time
async function catalogCheck(key) {
  const e = events.find((x) => x.key === key); if (!e) return;
  const out = $("cat_" + key);
  const set = (s) => { catResults[key] = s; if (out) out.textContent = s; };
  set(t("checking"));
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
  const u = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${iso(e.start - 15 * 60000)}&endtime=${iso(e.start + 5 * 60000)}&latitude=${STATION.lat}&longitude=${STATION.lon}&maxradiuskm=1500&minmagnitude=2`;
  try {
    const r = await fetch(u); if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const best = (j.features || []).sort((a, b) => (b.properties.mag || 0) - (a.properties.mag || 0))[0];
    if (!best) return set(t("noMatch"));
    const [lon, lat, z] = best.geometry.coordinates;
    set(t("matched", { m: fix(best.properties.mag, 1), place: best.properties.place || "", d: Math.round(km(STATION.lat, STATION.lon, lat, lon)), z: Math.round(z) }));
  } catch (err) { set(t("catFail")); }
}

/* ========================================================= downloads */
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const csvCell = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
$("dlcsv").onclick = () => {
  const rows = [["id", "type", "test", "floor", "start", "duration_s", "peak_g", "intensity_mmi", "gas", "status"]];
  events.forEach((e) => rows.push([e.key, e.kind, e.test, e.floor || floorName(), e.start ? new Date(e.start).toISOString() : "", e.dur ?? "", e.peak ?? "", e.kind === "quake" && !e.test ? ROMAN[mmiInt(e.peak)] : "", e.gas ?? "", e.status || ""]));
  download(`quakeguard-events-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv");
};
$("dljson").onclick = () => download(`quakeguard-events-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(events, null, 2), "application/json");
$("dltrace").onclick = () => {
  const rows = [["seconds_ago", "vibration_g"]];
  trace.forEach((v, i) => { if (v != null) rows.push([((TRACE_N - 1 - i) / 10).toFixed(1), v.toFixed(4)]); });
  download(`quakeguard-vibration-${Date.now()}.csv`, rows.map((r) => r.join(",")).join("\n"), "text/csv");
};

/* ========================================================= tabs */
document.querySelectorAll("#nav button").forEach((b) => {
  b.onclick = () => {
    document.body.dataset.tab = b.dataset.tab;
    document.querySelectorAll("#nav button").forEach((x) => x.classList.toggle("on", x === b));
    scrollTo(0, 0);
    requestAnimationFrame(drawAll);
    if (b.dataset.tab === "region") initRegion();
    if (b.dataset.tab === "set") { loadConfig(); makeQr(); }
  };
});

/* ====================================================== region map */
let map = null, qLayer = null, ringLayer = null, qData = null, qSrc = "", qAt = 0, qTimer = 0, qMarkers = {};
const fR = $("fradius"), fM = $("fmag"), fD = $("fdays");
const reg = Object.assign({ radiusKm: 1000, minMag: 4, days: 30 }, CFG.region || {});
fR.value = KEY("r_rad") || reg.radiusKm; fM.value = KEY("r_mag") || reg.minMag; fD.value = KEY("r_days") || reg.days;
if (!fR.value) fR.value = "1000"; if (!fM.value) fM.value = "4"; if (!fD.value) fD.value = "30";
[fR, fM, fD].forEach((s) => { s.onchange = () => { SAVE("r_rad", fR.value); SAVE("r_mag", fM.value); SAVE("r_days", fD.value); loadQuakes(); }; });

function km(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const depthCol = (z) => z < 70 ? "#ff5a3c" : z < 300 ? "#ffb020" : "#4fb4ff";
function loadAsset(tag, attrs) {
  return new Promise((res, rej) => { const el = document.createElement(tag); Object.assign(el, attrs); el.onload = res; el.onerror = rej; document.head.appendChild(el); });
}
async function initRegion() {
  try {
    if (!window.L) {
      await loadAsset("link", { rel: "stylesheet", href: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" });
      await loadAsset("script", { src: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" });
    }
  } catch (e) { $("qcount").textContent = t("regionFail"); return; }
  if (!map) {
    map = L.map("qmap", { scrollWheelZoom: false, worldCopyJump: true }).setView([STATION.lat, STATION.lon], 6);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    L.circleMarker([STATION.lat, STATION.lon], { radius: 8, color: "#fff", weight: 2, fillColor: "#1de9b6", fillOpacity: 1 })
      .bindTooltip(() => t("stationLbl") + " · " + STATION.place).addTo(map);
    ringLayer = L.layerGroup().addTo(map);
    qLayer = L.layerGroup().addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 50);
  if (!qData || Date.now() - qAt > 5 * 60000) loadQuakes(); else renderQuakes();
  clearInterval(qTimer);
  qTimer = setInterval(() => { if (document.body.dataset.tab === "region") loadQuakes(); }, 5 * 60000);
}
async function loadQuakes() {
  if (!map) return;
  $("qcount").textContent = t("regionLoading");
  const rad = +fR.value, mag = +fM.value, days = +fD.value;
  const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  let list = null;
  try {
    const u = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${STATION.lat}&longitude=${STATION.lon}&maxradiuskm=${rad}&minmagnitude=${mag}&starttime=${start}&orderby=time&limit=300`;
    const r = await fetch(u); if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    list = j.features.map((f) => ({ id: f.id, mag: f.properties.mag, type: f.properties.magType, place: f.properties.place, time: f.properties.time, url: f.properties.url, felt: f.properties.felt, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], z: f.geometry.coordinates[2] }));
    qSrc = "USGS";
  } catch (e) {
    try {   // second source: EMSC (radius in degrees)
      const u = `https://www.seismicportal.eu/fdsnws/event/1/query?format=json&lat=${STATION.lat}&lon=${STATION.lon}&maxradius=${(rad / 111.2).toFixed(2)}&minmag=${mag}&start=${start}&orderby=time&limit=300&nodata=204`;
      const r = await fetch(u); if (!r.ok) throw new Error(r.status);
      const j = r.status === 204 ? { features: [] } : await r.json();
      list = (j.features || []).map((f) => { const p = f.properties; return { id: p.unid, mag: p.mag, type: p.magtype, place: p.flynn_region, time: Date.parse(p.time), url: `https://www.seismicportal.eu/eventdetails.html?unid=${p.unid}`, felt: null, lon: p.lon, lat: p.lat, z: p.depth }; });
      qSrc = "EMSC";
    } catch (e2) { list = null; }
  }
  if (!list) { $("qcount").textContent = t("regionFail"); $("qlist").innerHTML = ""; return; }
  list.forEach((q) => { q.dist = km(STATION.lat, STATION.lon, q.lat, q.lon); });
  qData = list; qAt = Date.now();
  renderQuakes(true);
}
function renderQuakes(fit) {
  if (!map || !qData) return;
  const rad = +fR.value;
  ringLayer.clearLayers();
  L.circle([STATION.lat, STATION.lon], { radius: rad * 1000, color: "#1de9b6", weight: 1, dashArray: "6 6", fill: false }).addTo(ringLayer);
  if (fit) map.fitBounds(L.latLng(STATION.lat, STATION.lon).toBounds(rad * 2000), { padding: [10, 10] });
  qLayer.clearLayers(); qMarkers = {};
  qData.forEach((q) => {
    const popup = `<b>M${fix(q.mag, 1)} ${esc(q.type || "")}</b><br>${esc(q.place || "")}<br>${esc(new Date(q.time).toLocaleString())}<br>${esc(t("depthLbl", { z: Math.round(q.z) }))}<br>${esc(t("kmFrom", { d: Math.round(q.dist) }))}` +
      (q.felt != null ? `<br>${esc(t("feltLbl", { n: q.felt }))}` : "") + `<br><a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(t("details"))}</a>`;
    qMarkers[q.id] = L.circleMarker([q.lat, q.lon], { radius: 3 + Math.max(0, q.mag) * 2.2, color: "#0a111d", weight: 1, fillColor: depthCol(q.z), fillOpacity: 0.8 }).bindPopup(popup).addTo(qLayer);
  });
  $("qcount").textContent = (qData.length ? qData.length + " · " : "") + t("regionTitle", { place: STATION.place });
  $("regionsrc").textContent = t("regionSource", { src: qSrc, t: new Date(qAt).toLocaleTimeString() });
  $("qlist").innerHTML = qData.length ? qData.slice(0, 60).map((q) =>
    `<li><button data-q="${esc(q.id)}"><span class="qmag" style="background:${depthCol(q.z)}">${fix(q.mag, 1)}</span><span>${esc(q.place || "")}<small>${esc(ago(q.time))} · ${esc(t("kmFrom", { d: Math.round(q.dist) }))} · ${esc(t("depthLbl", { z: Math.round(q.z) }))}</small></span></button></li>`).join("")
    : `<li>${esc(t("regionEmpty"))}</li>`;
  $("qlist").querySelectorAll("[data-q]").forEach((b) => {
    b.onclick = () => { const m = qMarkers[b.dataset.q]; if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 7)); m.openPopup(); $("qmap").scrollIntoView({ block: "nearest", behavior: "smooth" }); } };
  });
}

/* =================================================== share & print */
let qrDone = false;
async function makeQr() {
  if (qrDone) return;
  try {
    if (!window.qrcode) await loadAsset("script", { src: "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js" });
    const q = qrcode(0, "M"); q.addData(location.origin + location.pathname); q.make();
    $("qr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    qrDone = true;
  } catch (e) { $("qr").hidden = true; }
}
$("print").onclick = async () => {
  await makeQr();
  $("ptitle").textContent = t("printTitle", { building: CFG.buildingName || "QuakeGuard" }) + " – " + floorName();
  const clone = $("scene").cloneNode(true);
  clone.removeAttribute("id"); clone.querySelectorAll("[id]").forEach((n) => { if (n.id !== "glow" && n.id !== "sT" && n.id !== "sB") n.removeAttribute("id"); });
  clone.classList.add("neon-on");
  $("pplan").innerHTML = ""; $("pplan").appendChild(clone);
  $("psteps1").textContent = t("stepsQuake"); $("plist1").innerHTML = STEPS.quake.map((s) => `<li>${esc(t(s))}</li>`).join("");
  $("psteps2").textContent = t("stepsAfter"); $("plist2").innerHTML = STEPS.after.map((s) => `<li>${esc(t(s))}</li>`).join("");
  $("pnums").innerHTML = CT.filter(([, k]) => ctVal(k)).map(([l, k]) => `<li><b>${esc(ctVal(k))}</b> ${esc(t(l))}</li>`).join("");
  $("pqr").innerHTML = $("qr").innerHTML;
  print();
};
let installEvt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("install").hidden = false; });
$("install").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("install").hidden = true; };
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* ===================================================== controls */
$("reset").onclick = async () => { if (await askPin()) doReset(); };
$("test").onclick = async () => { if (await askPin()) doTest("quake"); };
$("firebtn").onclick = async () => { if (await askPin()) doTest("fire"); };
$("endwatch").onclick = async () => { if (await askPin()) doEndWatch(); };
$("calib").onclick = async () => { if (await askPin()) doCalibrate(); };
$("detform").onsubmit = async (e) => {
  e.preventDefault();
  if (!(await askPin())) return;
  const f = new FormData(e.target), c = {};
  ["minG", "staTrig", "staDetrig", "minDur", "quiet", "gasLimit"].forEach((k) => { c[k] = +f.get(k); });
  if (c.staDetrig >= c.staTrig) c.staDetrig = +(c.staTrig * 0.6).toFixed(2);
  doSaveConfig(c);
};
function fillConfig(c) {
  if (!c) return;
  const form = $("detform");
  ["minG", "staTrig", "staDetrig", "minDur", "quiet", "gasLimit"].forEach((k) => { if (c[k] != null && document.activeElement !== form[k]) form[k].value = c[k]; });
}

/* ==================================================================
   LIVE MODE: Firebase Realtime Database over REST
   ================================================================== */
let lastUpdated = null, lastChange = 0, lastSeq = null, liveOk = false;
function fbUrl(path, q, floor) {
  const auth = CFG.auth ? "auth=" + encodeURIComponent(CFG.auth) : "";
  const qs = [q, auth].filter(Boolean).join("&");
  return `${BASE}/${FLOORS[floor ?? curFloor].path}${path}.json${qs ? "?" + qs : ""}`;
}
async function fb(method, path, body, q, floor) {
  const r = await fetch(fbUrl(path, q, floor), { method, cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(r.status);
  return r.status === 204 ? null : r.json();
}
function liveReset() { lastUpdated = null; lastChange = 0; lastSeq = null; }
function normalize(raw, online) {
  const r = raw || {};
  return {
    online, state: r.state || "MONITORING", test: !!r.test,
    quake: r.quake != null ? !!r.quake : (r.state === "ALARM" && !r.fire), fire: !!r.fire,
    g: +r.shake || 0, gyro: +r.gyro || 0, sta: +r.sta || 0, ratio: +r.ratio || 0,
    staTrig: +r.staTrig || 3, staDetrig: +r.staDetrig || 1.5, minDur: +r.minDur || 0.8, threshold: +r.threshold || 0.03,
    peak: +r.peak || 0, peakAll: +r.peakAll || 0, tilt: +r.tilt || 0,
    gasEnabled: !!r.gasEnabled, gas: +r.gas || 0, gasLimit: +r.gasLimit || 2200, gasWarm: !!r.gasWarm,
    buzzer: !!r.buzzer, led: !!r.led, light: !!r.light, door: r.door === "open",
    sensorOk: r.sensorOk !== false, quakes: +r.quakes || 0, fires: +r.fires || 0,
    aftershocks: +r.aftershocks || 0, watchLeft: +r.watchLeft || 0,
    uptime: r.uptime, rssi: typeof r.rssi === "number" ? r.rssi : null, heap: r.heap, fw: r.fw,
    safe: safeCount
  };
}
function conn(cls, k, extra) { const c = $("conn"); c.className = cls; c.textContent = t(k) + (extra ? " · " + extra : ""); }
let safeCount = 0;

async function pollLive() {
  const floorAtStart = curFloor;
  try {
    const raw = await fb("GET", "/live");
    if (floorAtStart !== curFloor) return;
    if (!raw) { liveOk = false; conn("off", "connWaiting"); render(Object.assign(normalize(null, false), { offKind: "headWaiting" })); return; }
    if (raw.updated !== lastUpdated) {
      const firstRead = lastUpdated === null;
      lastUpdated = raw.updated;
      // first read: trust the server time if the phone clock is roughly right
      lastChange = firstRead ? (Math.abs(Date.now() - raw.updated) < 30000 ? Date.now() : 0) : Date.now();
      takeTrace(raw);
      staHist.shift(); staHist.push(+raw.ratio || 0);
      drawSta();
    }
    const online = Date.now() - lastChange < 10000;
    liveOk = online;
    conn(online ? "on" : "off", online ? "connOnline" : "connOffline", !online && raw.updated ? t("lastSeen", { t: ago(raw.updated) }) : "");
    render(normalize(raw, online));
  } catch (e) {
    liveOk = false;
    conn("off", "connUnreachable");
    render(Object.assign(normalize(null, false), { offKind: "headUnreachable" }));
  }
}
function takeTrace(raw) {
  if (typeof raw.traceSeq !== "number" || !Array.isArray(raw.trace)) return;
  const pts = raw.trace;
  let fresh = (lastSeq === null || raw.traceSeq < lastSeq) ? pts : pts.slice(Math.max(0, pts.length - (raw.traceSeq - lastSeq)));
  if (raw.traceSeq === lastSeq) fresh = [];
  lastSeq = raw.traceSeq;
  fresh.forEach((v) => traceQ.push(Math.max(0, +v || 0)));
}
async function pollEvents() {
  const floorAtStart = curFloor;
  try {
    const j = await fb("GET", "/events", undefined, 'orderBy=%22%24key%22&limitToLast=50');
    if (floorAtStart !== curFloor) return;
    events = Object.keys(j || {}).sort().reverse().map((k) => {
      const e = j[k];
      return { key: k, kind: e.kind || "quake", test: !!e.test, floor: e.floor, start: typeof e.start === "number" ? e.start : 0, dur: e.duration, peak: +e.peak || 0, gas: e.gas, status: e.status };
    });
    if (lastD) stats(lastD);
  } catch (e) { /* keep the last list */ }
}
async function pollSafe() {
  try { const j = await fb("GET", "/safe", undefined, "shallow=true"); safeCount = j ? Object.keys(j).length : 0; $("safen").textContent = t("ofN", { a: safeCount, b: TOTAL }); }
  catch (e) { /* ignore */ }
}
async function pollFloors() {
  await Promise.all(FLOORS.map(async (f, i) => {
    if (i === curFloor) return;
    try {
      const r = await fb("GET", "/live", undefined, "", i);
      const fresh = r && Math.abs(Date.now() - r.updated) < 30000;
      floorState[i] = !fresh ? "off" : r.state === "ALARM" ? (r.fire ? "fire" : "quake") : r.state === "HOLD" ? "hold" : "ok";
    } catch (e) { floorState[i] = "off"; }
  }));
  floorsHtml = ""; floorsUI();
}
async function loadConfig() {
  if (DEMO) { fillConfig(sim.cfg); return; }
  try { fillConfig(await fb("GET", "/config")); } catch (e) { /* ignore */ }
}
const myId = KEY("id") || Math.random().toString(16).slice(2, 10); SAVE("id", myId);
async function command(c) {
  try { await fb("PUT", "/command", c); return true; } catch (e) { msg("msgCmdFail"); return false; }
}

/* ==================================================================
   DEMO MODE: simulated stations (one per floor)
   ================================================================== */
const mk = () => ({ q: 0, qStart: 0, f: 0, test: null, testUntil: 0, latched: false, pq: false, pf: false, qi: null, fi: null,
  quakes: 0, fires: 0, peak: 0, peakAll: 0, ev: [], fault: false, safeMe: false, aS: 0, sta: 0.003, watchUntil: 0, aftershocks: 0,
  cfg: { minG: 0.03, staTrig: 3, staDetrig: 1.5, minDur: 0.8, quiet: 15, gasLimit: 2200 }, seq: 0, tilt: 0.12 });
const sims = FLOORS.map(mk);
let sim = sims[curFloor];
const T0 = Date.now();

function simFloorState(s, now) { return now < s.f ? "fire" : now < s.q ? "quake" : s.latched ? "hold" : "ok"; }
function tick() {
  const now = Date.now();
  const quake = now < sim.q || (sim.test === "quake" && now < sim.testUntil);
  const fire = now < sim.f || (sim.test === "fire" && now < sim.testUntil);
  const realQuake = now < sim.q, realFire = now < sim.f;
  if (sim.test && now >= sim.testUntil) { const e = sim.ev.find((x) => x.test && x.status === "active"); if (e) { e.status = "ended"; e.dur = 6; } sim.test = null; }
  // vibration: smooth envelope during a simulated quake
  const pts = [];
  for (let i = 0; i < 4; i++) {
    let g = 0.002 + Math.random() * 0.004;
    if (realQuake) { const x = (now + i * 100 - sim.qStart) / (sim.q - sim.qStart); g += Math.sin(Math.PI * Math.min(Math.max(x, 0), 1)) ** 1.4 * (0.12 + Math.random() * 0.18); }
    pts.push(g);
  }
  const g = pts.reduce((a, b) => a + b) / pts.length;
  sim.sta += (g - sim.sta) * 0.35;
  const ratio = sim.sta / 0.004;
  if (realQuake && !sim.pq) {
    if (now < sim.watchUntil) sim.aftershocks++;
    sim.qi = { key: "d" + now, kind: "quake", test: false, start: now, dur: 0, peak: 0, status: "active", floor: floorName() };
    sim.ev.unshift(sim.qi); sim.quakes++; sim.latched = true;
  }
  if (realFire && !sim.pf) { sim.fi = { key: "f" + now, kind: "fire", test: false, start: now, dur: 0, gas: 0, status: "active", floor: floorName() }; sim.ev.unshift(sim.fi); sim.fires++; sim.latched = true; }
  if (realQuake) { sim.qi.peak = Math.max(sim.qi.peak, g); sim.qi.dur = Math.round((now - sim.qi.start) / 1000); sim.peak = sim.qi.peak; sim.peakAll = Math.max(sim.peakAll, sim.peak); }
  if (!realQuake && sim.pq && sim.qi) { sim.qi.status = "ended"; sim.watchUntil = now + 24 * 3600e3; }
  const gas = fire ? 3100 + Math.round(Math.random() * 200) : 900 + Math.round(Math.random() * 60);
  if (realFire) { sim.fi.gas = Math.max(sim.fi.gas, gas); sim.fi.dur = Math.round((now - sim.fi.start) / 1000); }
  if (!realFire && sim.pf && sim.fi) sim.fi.status = "ended";
  if ((realQuake || realFire) && !sim.pq && !sim.pf) sim.aS = now;
  sim.pq = realQuake; sim.pf = realFire;

  sim.seq += 4; pts.forEach((v) => traceQ.push(v));
  staHist.shift(); staHist.push(ratio);
  const alarm = quake || fire;
  const state = alarm ? "ALARM" : sim.latched ? "HOLD" : "MONITORING";
  events = sim.ev;
  safeCount = (sim.safeMe ? 1 : 0) + (sim.aS ? Math.min(TOTAL - 1, Math.floor((now - sim.aS) / 3000)) : 0);
  sims.forEach((s, i) => { if (i !== curFloor) floorState[i] = simFloorState(s, now); });
  render({
    online: true, state, test: !!sim.test && !realQuake && !realFire, quake, fire,
    g, gyro: g * 120, sta: sim.sta, ratio, staTrig: sim.cfg.staTrig, staDetrig: sim.cfg.staDetrig, minDur: sim.cfg.minDur,
    threshold: sim.cfg.minG, peak: sim.peak, peakAll: sim.peakAll, tilt: sim.tilt + (realQuake ? Math.random() * 0.05 : 0),
    gasEnabled: true, gas, gasLimit: sim.cfg.gasLimit, gasWarm: (now - T0) < 4000,
    buzzer: alarm, led: alarm || sim.latched, light: alarm || sim.latched, door: alarm || sim.latched,
    sensorOk: !sim.fault, quakes: sim.quakes, fires: sim.fires, aftershocks: sim.aftershocks,
    watchLeft: now < sim.watchUntil ? Math.round((sim.watchUntil - now) / 1000) : 0,
    uptime: Math.round((now - T0) / 1000) + 3600, rssi: -58, heap: 182000, fw: "2.0 demo", safe: safeCount
  });
}

/* ---------------------------------------------- actions (both modes) */
async function sendSafe() {
  if (DEMO) { sim.safeMe = true; return; }
  await fb("PUT", "/safe/" + myId, { ".sv": "timestamp" });
  pollSafe();
}
async function doReset() {
  if (DEMO) {
    if (Date.now() < Math.max(sim.q, sim.f)) return msg("msgStillActive");
    sim.latched = false; sim.safeMe = false; sim.aS = 0; safeMe = false; markSafe(); msg("msgReset"); return tick();
  }
  if (await command("reset")) msg("msgResetSent");
}
async function doTest(kind) {
  if (DEMO) {   // demo: simulate a real event so every function can be seen
    const now = Date.now();
    if (kind === "fire") sim.f = now + 10000; else { sim.qStart = now; sim.q = now + 12000; }
    return tick();
  }
  if (await command(kind === "fire" ? "testfire" : "test")) msg("msgTestSent");
}
async function doEndWatch() {
  if (DEMO) { sim.watchUntil = 0; sim.aftershocks = 0; msg("msgWatchEnded"); return tick(); }
  if (await command("endwatch")) msg("msgWatchEnded");
}
async function doCalibrate() {
  if (DEMO) { sim.tilt = 0; msg("msgCalib"); return; }
  if (await command("calibrate")) msg("msgCalib");
}
async function doSaveConfig(c) {
  if (DEMO) { Object.assign(sim.cfg, c); msg("msgSaved"); return tick(); }
  try { await fb("PATCH", "/config", c); msg("msgSaved"); } catch (e) { msg("msgCmdFail"); }
}
$("faultbtn").onclick = () => { sim.fault = !sim.fault; msg(sim.fault ? "msgFaultOn" : "msgFaultOff"); tick(); };

/* ============================================================ start */
applyPrefs();
applyLang();
floorsUI();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawAll);

if (DEMO) {
  $("demo").hidden = false;
  $("faultbtn").hidden = false;
  conn("demo", "connDemo");
  tick(); setInterval(tick, 400);
} else {
  conn("", "connConnecting");
  pollLive(); pollEvents(); pollSafe(); pollFloors(); loadConfig();
  setInterval(pollLive, 1000);
  setInterval(pollEvents, 5000);
  setInterval(pollSafe, 3000);
  if (FLOORS.length > 1) setInterval(pollFloors, 5000);
}
})();
