(() => {
  "use strict";

  // ------------------------------------------------------------------ setup
  const cfg = window.EQ_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const baseUrl = String(cfg.firebaseUrl || "").trim().replace(/\/+$/, "");
  const configured = baseUrl.startsWith("https://") && !baseUrl.includes("YOUR-PROJECT");
  const demo = params.has("demo");

  const $ = (id) => document.getElementById(id);
  const body = document.body;

  if (cfg.stationName) $("station-name").textContent = cfg.stationName;
  if (cfg.location) $("station-location").textContent = cfg.location;

  const TRACE_POINTS = 600;            // 60 s at 10 points per second
  const OFFLINE_AFTER_MS = 8000;
  const trace = new Array(TRACE_POINTS).fill(null);
  const traceQueue = [];
  let threshold = 0.06;
  let lastSeq = null;
  let lastUpdatedValue = null;
  let lastChangeAt = 0;
  let lastData = null;
  let currentState = "connecting";

  const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

  // -------------------------------------------------------------- helpers
  function fbUrl(path, query = "") {
    const auth = cfg.auth ? `auth=${encodeURIComponent(cfg.auth)}` : "";
    const q = [query, auth].filter(Boolean).join("&");
    return `${baseUrl}${path}.json${q ? "?" + q : ""}`;
  }

  // Modified Mercalli intensity from peak ground acceleration (Wald et al., 1999)
  function intensity(g) {
    if (!(g > 0)) return null;
    const pct = g * 100;
    const table = [
      [0.17, "I", "Not felt"], [1.4, "II–III", "Weak"], [3.9, "IV", "Light"],
      [9.2, "V", "Moderate"], [18, "VI", "Strong"], [34, "VII", "Very strong"],
      [65, "VIII", "Severe"], [124, "IX", "Violent"], [Infinity, "X+", "Extreme"]
    ];
    for (const [limit, roman, label] of table) if (pct < limit) return `${roman} (${label})`;
    return null;
  }

  const fixed = (n, d) => (typeof n === "number" && isFinite(n) ? n.toFixed(d) : "—");

  function duration(seconds) {
    if (!(seconds >= 0)) return "—";
    const s = Math.floor(seconds);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d} d ${h} h`;
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min ${s % 60} s`;
    return `${s} s`;
  }

  function signal(rssi) {
    if (typeof rssi !== "number") return "—";
    const q = rssi >= -60 ? "Strong" : rssi >= -70 ? "Good" : rssi >= -80 ? "Weak" : "Very weak";
    return `${q} (${rssi} dBm)`;
  }

  // ---------------------------------------------------------- seismograph
  const canvas = $("seismograph");
  const ctx = canvas.getContext("2d");
  let cssW = 0, cssH = 0;

  function resizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cssW = r.width; cssH = r.height;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    if (!cssW) return;
    const W = cssW, H = cssH, mid = H / 2;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--ink").trim();
    const grid = css.getPropertyValue("--grid").trim();
    const alert = css.getPropertyValue("--alert").trim();
    const muted = css.getPropertyValue("--muted").trim();

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);

    // recorder-paper grid: every 1 s light, every 15 s darker
    for (let s = 0; s <= 60; s++) {
      const x = Math.round((s / 60) * W) + 0.5;
      ctx.strokeStyle = s % 15 === 0 ? "#CBD4DD" : grid;
      ctx.lineWidth = 1;
      if (s % 5 !== 0 && W < 700) continue;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      const y = Math.round((i / 8) * H) + 0.5;
      ctx.strokeStyle = i === 4 ? "#B8C3CF" : grid;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // vertical scale
    let max = 0;
    for (const v of trace) if (v !== null && v > max) max = v;
    const scale = Math.max(threshold * 2, max * 1.15, 0.05);
    const yOf = (v) => (v / scale) * (mid - 6);

    // threshold lines
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = alert;
    ctx.lineWidth = 1.5;
    for (const sign of [-1, 1]) {
      const y = Math.round(mid - sign * yOf(threshold)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // envelope
    const step = W / (TRACE_POINTS - 1);
    const first = trace.findIndex((v) => v !== null);
    if (first !== -1) {
      ctx.beginPath();
      for (let i = first; i < TRACE_POINTS; i++) ctx.lineTo(i * step, mid - yOf(trace[i] ?? 0));
      for (let i = TRACE_POINTS - 1; i >= first; i--) ctx.lineTo(i * step, mid + yOf(trace[i] ?? 0));
      ctx.closePath();
      ctx.fillStyle = "rgba(20, 36, 59, 0.14)";
      ctx.fill();

      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      for (const sign of [1, -1]) {
        ctx.beginPath();
        for (let i = first; i < TRACE_POINTS; i++) {
          const v = trace[i] ?? 0;
          ctx.strokeStyle = ink;
          ctx.lineTo(i * step, mid - sign * yOf(v));
        }
        ctx.stroke();
      }

      // red where the threshold was crossed
      ctx.strokeStyle = alert;
      ctx.lineWidth = 2.2;
      for (const sign of [1, -1]) {
        ctx.beginPath();
        let drawing = false;
        for (let i = first; i < TRACE_POINTS; i++) {
          const v = trace[i] ?? 0;
          const y = mid - sign * yOf(v);
          if (v > threshold) { drawing ? ctx.lineTo(i * step, y) : ctx.moveTo(i * step, y); drawing = true; }
          else drawing = false;
        }
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = muted;
      ctx.font = "500 14px 'Public Sans', system-ui, sans-serif";
      ctx.fillText("Waiting for sensor data", 16, mid - 10);
    }

    // scale label
    ctx.fillStyle = muted;
    ctx.font = "500 12px 'Public Sans', system-ui, sans-serif";
    ctx.fillText(`±${scale.toFixed(scale < 0.1 ? 3 : 2)} g`, 10, 18);
  }

  // feed queued points at 10 per second so the trace scrolls smoothly
  setInterval(() => {
    if (!traceQueue.length) return;
    const n = traceQueue.length > 25 ? traceQueue.length - 10 : 1;
    for (let i = 0; i < n && traceQueue.length; i++) {
      trace.shift();
      trace.push(traceQueue.shift());
    }
    draw();
  }, 100);

  function takeTrace(data) {
    if (typeof data.traceSeq !== "number" || !Array.isArray(data.trace)) return;
    const pts = data.trace;
    let fresh;
    if (lastSeq === null || data.traceSeq < lastSeq) fresh = pts;
    else fresh = pts.slice(Math.max(0, pts.length - (data.traceSeq - lastSeq)));
    if (data.traceSeq === lastSeq) fresh = [];
    lastSeq = data.traceSeq;
    for (const v of fresh) traceQueue.push(Math.max(0, Number(v) || 0));
  }

  // --------------------------------------------------------------- render
  const STATUS = {
    monitor: ["No shaking detected", "The sensor is measuring ground motion continuously. Every response is on standby."],
    alarm: ["Earthquake detected", "Shaking is in progress. The alarm is sounding, the exit door is open and the emergency light is on. Move to a safe place."],
    hold: ["Shaking has stopped", "The buzzers are off. The exit door stays open and the emergency light stays on until the system is reset."],
    test: ["Test in progress", "Every response is switched on for 5 seconds, then the system returns to monitoring."],
    calibrating: ["Calibrating the sensor", "Keep the station still for a few seconds while the sensor measures its resting position."],
    offline: ["Station offline", "No update has arrived from the ESP32. Check that it has power and is connected to Wi-Fi."],
    waiting: ["Waiting for the station", "The database has no readings yet. Switch on the ESP32 and it will appear here within a few seconds."],
    unreachable: ["Database not reachable", "This page could not read from Firebase. Check the URL in config.js and the database rules."],
    setup: ["Not connected yet", "Add your Firebase database URL to config.js to show live readings from the station."]
  };

  function setStatus(key) {
    const [title, detail] = STATUS[key];
    $("status-title").textContent = title;
    $("status-detail").textContent = detail;
    const visual = key === "test" ? "hold" : (key === "monitor" || key === "alarm" || key === "hold" || key === "offline") ? key : "connecting";
    body.dataset.state = visual;
    currentState = key;
  }

  function setLink(kind, text) {
    body.dataset.link = kind;
    $("link-text").textContent = text;
  }

  function setResp(id, on, onText, offText) {
    const el = $(id);
    el.classList.toggle("is-on", !!on);
    el.querySelector(".resp-state").textContent = on === null ? "Unknown" : on ? onText : offText;
  }

  function render(data, online) {
    lastData = data;
    if (!online) {
      setStatus("offline");
    } else {
      const st = String(data.state || "").toUpperCase();
      if (st === "ALARM") setStatus(data.test ? "test" : "alarm");
      else if (st === "HOLD") setStatus("hold");
      else if (st === "CALIBRATING") setStatus("calibrating");
      else setStatus("monitor");
    }

    if (typeof data.threshold === "number") threshold = data.threshold;
    $("threshold-value").textContent = `(${fixed(threshold, 3)} g)`;

    $("fig-shake").textContent = online ? fixed(data.shake, 3) : "—";
    $("fig-gyro").textContent = online ? fixed(data.gyro, 1) : "—";
    $("fig-peak").textContent = data.peak > 0 ? fixed(data.peak, 3) : "—";

    const known = null;
    setResp("resp-buzzer", online ? data.buzzer : known, "Sounding", "Silent");
    setResp("resp-led", online ? data.led : known, "On", "Off");
    setResp("resp-door", online ? data.door === "open" : known, "Open", "Closed");
    setResp("resp-light", online ? data.light : known, "On", "Off");

    $("r-intensity").textContent = intensity(data.peak) || "No event yet";
    $("r-threshold").textContent = `${fixed(threshold, 3)} g`;
    $("r-events").textContent = typeof data.events === "number" ? String(data.events) : "—";
    $("r-sensor").textContent = data.sensorOk === false ? "Not found, check wiring" : "Working";
    $("r-rssi").textContent = signal(data.rssi);
    $("r-uptime").textContent = duration(data.uptime);
    updateAge();

    const st = String(data.state || "").toUpperCase();
    $("btn-reset").disabled = !online || !(st === "ALARM" || st === "HOLD") || data.test;
    $("btn-test").disabled = !online || st !== "MONITORING";

    handleSound(online && st === "ALARM" && !data.test);
  }

  function updateAge() {
    if (!lastChangeAt) { $("r-updated").textContent = "—"; return; }
    const s = Math.round((Date.now() - lastChangeAt) / 1000);
    $("r-updated").textContent = s <= 1 ? "Just now" : `${duration(s)} ago`;
  }
  setInterval(updateAge, 1000);

  function renderEvents(events) {
    const tbody = $("log-body");
    const rows = Object.entries(events || {}).reverse();
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty"><td colspan="6">No events recorded yet. Events appear here as soon as the sensor detects shaking.</td></tr>';
      return;
    }
    tbody.textContent = "";
    for (const [, ev] of rows) {
      const tr = document.createElement("tr");
      const active = ev.status === "active";
      const cells = [
        typeof ev.start === "number" ? timeFmt.format(new Date(ev.start)) : "—",
        ev.test ? "Test" : "Earthquake",
        active ? "In progress" : (typeof ev.duration === "number" ? `${ev.duration.toFixed(1)} s` : "—"),
        ev.test ? "—" : `${fixed(ev.peak, 3)} g`,
        ev.test ? "—" : (intensity(ev.peak) || "—")
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (i === 3) td.className = "num";
        tr.appendChild(td);
      });
      const td = document.createElement("td");
      const tag = document.createElement("span");
      tag.className = `tag ${ev.test ? "tag-test" : active ? "tag-active" : "tag-ended"}`;
      tag.textContent = active ? "Active" : ev.test ? "Completed" : "Ended";
      td.appendChild(tag);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  // ---------------------------------------------------------------- sound
  let audioCtx = null, sirenTimer = null;
  const soundToggle = $("sound-toggle");
  try { soundToggle.checked = localStorage.getItem("eq-sound") === "1"; } catch (e) { /* storage unavailable */ }
  soundToggle.addEventListener("change", () => {
    try { localStorage.setItem("eq-sound", soundToggle.checked ? "1" : "0"); } catch (e) { /* ignore */ }
    if (soundToggle.checked && !audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    if (!soundToggle.checked) handleSound(false);
  });

  function tone(freq, start, len) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "square"; o.frequency.value = freq;
    g.gain.setValueAtTime(0.08, start);
    g.gain.setValueAtTime(0, start + len);
    o.connect(g).connect(audioCtx.destination);
    o.start(start); o.stop(start + len + 0.02);
  }

  function handleSound(on) {
    if (on && soundToggle.checked && audioCtx && !sirenTimer) {
      const beep = () => { const t = audioCtx.currentTime; tone(960, t, 0.25); tone(720, t + 0.3, 0.25); };
      beep();
      sirenTimer = setInterval(beep, 700);
    } else if (!on && sirenTimer) {
      clearInterval(sirenTimer);
      sirenTimer = null;
    }
  }

  // ------------------------------------------------------------- commands
  const feedback = $("cmd-feedback");
  function say(text, isError) {
    feedback.textContent = text;
    feedback.classList.toggle("is-error", !!isError);
  }

  async function sendCommand(cmd) {
    if (demo) { demoCommand(cmd); return true; }
    const res = await fetch(fbUrl("/earthquake/command"), { method: "PUT", body: JSON.stringify(cmd) });
    if (!res.ok) throw new Error(res.status);
    return true;
  }

  $("btn-reset").addEventListener("click", async () => {
    if (!confirm("Reset the system only when the building is safe. The door will close and the emergency light will turn off. Reset now?")) return;
    try { await sendCommand("reset"); say("Reset sent. The station applies it within 2 seconds."); }
    catch (e) { say("Could not send the reset. Check that the database rules allow writing.", true); }
  });

  $("btn-test").addEventListener("click", async () => {
    try { await sendCommand("test"); say("Test sent. Every response turns on for 5 seconds."); }
    catch (e) { say("Could not send the test. Check that the database rules allow writing.", true); }
  });

  // ------------------------------------------------------------ live mode
  async function pollLive() {
    try {
      const res = await fetch(fbUrl("/earthquake/live"), { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      if (!data) {
        setStatus("waiting");
        setLink("offline", "No data yet");
        return;
      }
      if (data.updated !== lastUpdatedValue) {
        lastUpdatedValue = data.updated;
        lastChangeAt = Date.now();
        takeTrace(data);
      }
      const online = Date.now() - lastChangeAt < OFFLINE_AFTER_MS;
      setLink(online ? "online" : "offline", online ? "Station online" : "Station offline");
      render(data, online);
    } catch (e) {
      setStatus("unreachable");
      setLink("offline", "Database not reachable");
    }
  }

  async function pollEvents() {
    try {
      const res = await fetch(fbUrl("/earthquake/events", 'orderBy=%22%24key%22&limitToLast=25'), { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const events = await res.json();
      // keep chronological key order, since JSON object order follows the keys
      const sorted = {};
      Object.keys(events || {}).sort().forEach((k) => { sorted[k] = events[k]; });
      renderEvents(sorted);
    } catch (e) { /* keep the last table */ }
  }

  // ------------------------------------------------------------ demo mode
  const sim = { t: 0, state: "MONITORING", quakeAt: 8, quakeLen: 12, holdUntil: 0, peak: 0, events: 0, seq: 0, test: false, testUntil: 0, log: {} };

  function demoCommand(cmd) {
    if (cmd === "reset" && (sim.state === "ALARM" || sim.state === "HOLD")) {
      closeDemoEvent();
      sim.state = "MONITORING"; sim.test = false; sim.quakeAt = sim.t + 30;
    }
    if (cmd === "test" && sim.state === "MONITORING") {
      sim.state = "ALARM"; sim.test = true; sim.testUntil = sim.t + 5;
      sim.key = "e" + String(Date.now()); sim.log[sim.key] = { start: Date.now(), status: "active", test: true, peak: 0 };
      sim.evStart = sim.t;
    }
  }

  function closeDemoEvent() {
    const ev = sim.log[sim.key];
    if (ev && ev.status === "active") { ev.status = "ended"; ev.duration = sim.t - sim.evStart; ev.peak = sim.test ? 0 : sim.peak; }
  }

  function demoTick() {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const tt = sim.t + i / 10;
      let v = 0.004 + Math.random() * 0.008;
      const into = tt - sim.quakeAt;
      if (into >= 0 && into < sim.quakeLen) {
        const env = Math.sin(Math.PI * into / sim.quakeLen) ** 1.5;
        v += env * (0.16 + Math.random() * 0.12);
      }
      pts.push(+v.toFixed(4));
    }
    sim.seq += 10;
    const level = pts.reduce((a, b) => a + b, 0) / pts.length;

    if (sim.state === "MONITORING" && level > threshold) {
      sim.state = "ALARM"; sim.test = false; sim.peak = level; sim.events++;
      sim.key = "e" + String(Date.now()); sim.evStart = sim.t;
      sim.log[sim.key] = { start: Date.now(), status: "active", test: false, peak: level };
    }
    if (sim.state === "ALARM" && !sim.test) {
      sim.peak = Math.max(sim.peak, level);
      sim.log[sim.key].peak = sim.peak;
      if (sim.t > sim.quakeAt + sim.quakeLen + 4) { closeDemoEvent(); sim.state = "HOLD"; sim.holdUntil = sim.t + 10; }
    }
    if (sim.state === "ALARM" && sim.test && sim.t >= sim.testUntil) { closeDemoEvent(); sim.state = "MONITORING"; sim.test = false; }
    if (sim.state === "HOLD" && sim.t >= sim.holdUntil) { sim.state = "MONITORING"; sim.quakeAt = sim.t + 25; }

    const alarm = sim.state === "ALARM", hold = sim.state === "HOLD";
    const data = {
      state: sim.state, test: sim.test, shake: level, gyro: level * 140, peak: sim.peak, threshold,
      buzzer: alarm, led: alarm || hold, light: alarm || hold, door: alarm || hold ? "open" : "closed",
      sensorOk: true, events: sim.events, uptime: 3600 + sim.t, rssi: -61,
      traceSeq: sim.seq, trace: pts, updated: Date.now()
    };
    sim.t += 1;
    lastChangeAt = Date.now();
    takeTrace(data);
    render(data, true);
    renderEvents(sim.log);
  }

  // ---------------------------------------------------------------- start
  window.addEventListener("resize", resizeCanvas);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
  resizeCanvas();

  if (demo) {
    setLink("demo", "Sample data");
    $("station-location").textContent = "Preview with sample data, not a live station";
    demoTick();
    setInterval(demoTick, 1000);
  } else if (!configured) {
    setStatus("setup");
    setLink("offline", "Not connected");
    $("setup").hidden = false;
    $("btn-reset").disabled = true;
    $("btn-test").disabled = true;
  } else {
    pollLive(); pollEvents();
    setInterval(pollLive, 1000);
    setInterval(pollEvents, 5000);
  }
})();
