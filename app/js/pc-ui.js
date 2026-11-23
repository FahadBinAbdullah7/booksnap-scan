// Shared PC Remote controls: option switches, the phone's page outline on the
// live view, and the lock-area editor (drag corners + fold on the big screen).
import * as P from "./imgproc.js";
import { editLock, ptsFromGeo, defaultPts } from "./lockedit.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const CONTROL_IDS = ["capture", "undo", "segMode", "segOrient", "segAuto", "lockbtn", "rotbtn", "filter", "torch"];

export function setControlsEnabled(on) {
  for (const id of CONTROL_IDS) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !on;
    el.querySelectorAll("button").forEach((b) => (b.disabled = !on));
  }
}

// wire the switches; `send` sends a command to the phone, `getState` returns the phone's state
export function setupControls(send, getState, getFrame) {
  const pick = (id, fn) => ($(id).onclick = (e) => { const v = e.target.closest("button")?.dataset.v; if (v) fn(v); });
  pick("segMode", (v) => send({ t: "mode", mode: v }));
  pick("segOrient", (v) => send({ t: "orient", v }));
  pick("segAuto", (v) => send({ t: "auto", on: v === "auto" }));
  if ($("rotbtn")) $("rotbtn").onclick = () => send({ t: "rotate" });
  $("lockbtn").onclick = async () => {
    const st = getState();
    let fresh = false;
    if (st.lock) {
      const choice = await chooser("Locked page area", [
        ["edit", "✏️ Adjust the locked area (zoom in for exact corners)"],
        ["new", "🎯 New area — find the page again and lock it"],
        ["unlock", "🔓 Unlock (automatic detection)"]]);
      if (choice === "unlock") return send({ t: "unlock" });
      if (choice !== "edit" && choice !== "new") return;
      fresh = choice === "new";
    }
    const f = await getFrame();
    if (!f || !f.bmp) return alertBox("No camera picture from the phone yet.");
    send({ t: "lock-editing", on: true });              // Auto on the phone waits meanwhile
    let pts = null;
    try {
      let start = !fresh && st.lock ? st.lock.pts : null;
      if (!start && !st.lock) start = ptsFromGeo(f.geo, st.mode);
      if (!start) start = await request(send, { t: "detect-req" }, "detected", 8000).then((r) => r && r.pts).catch(() => null);
      pts = await editLock({
        src: f.bmp, rot: st.rotate || 0, mode: st.mode, pts: start || defaultPts(st.mode),
        title: fresh ? "New area: adjust and lock" : undefined,
        note: "The phone uses exactly this area for every photo until you unlock it. Keys: + / − zoom, Tab next corner, arrows nudge, Enter lock.",
        hiRes: async () => {
          const r = await request(send, { t: "lock-photo-req" }, "lock-photo", 20000);
          if (!r || typeof r.data !== "string" || !r.data.startsWith("data:image/jpeg;base64,")) return null;
          return createImageBitmap(await (await fetch(r.data)).blob());
        },
        detect: async () => (await request(send, { t: "detect-req" }, "detected", 8000))?.pts || null,
        refresh: async () => { const g = await getFrame(); return g && g.bmp ? { src: g.bmp } : null; },
      });
    } finally {
      if (pts) send({ t: "lock", pts, fresh });
      else send({ t: "lock-editing", on: false });
    }
  };
}

// reflect the phone's state on the switches
export function showState(st) {
  const seg = (id, v) => document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  seg("segMode", st.mode);
  seg("segOrient", st.orient || "portrait");
  seg("segAuto", st.auto ? "auto" : "manual");
  $("lockbtn").textContent = st.lock ? "🔒 Locked" : "🔓 Lock area";
  $("lockbtn").classList.toggle("on", !!st.lock);
}


// draw the outline the phone is using (green = automatic, yellow = locked)
export function drawGeo(overlay, vw, vh, geo, rotate, firstPageNo) {
  const ctx = overlay.getContext("2d"), dpr = window.devicePixelRatio || 1, cw = overlay.clientWidth, ch = overlay.clientHeight;
  if (overlay.width !== Math.round(cw * dpr) || overlay.height !== Math.round(ch * dpr)) { overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!geo || !geo.found || !vw) return;
  const s = Math.min(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  const pt = (fx, fy) => { const [ux, uy] = P.unrotPoint([fx, fy], rotate || 0); return [ox + ux * vw * s, oy + uy * vh * s]; };
  ctx.lineWidth = 3;
  ctx.strokeStyle = geo.locked ? "#facc15" : "#22c55e";
  geo.pages.forEach((pg, i) => {
    ctx.fillStyle = geo.locked ? "rgba(250,204,21,0.10)" : "rgba(34,197,94,0.12)";
    ctx.beginPath();
    if (pg.quad) pg.quad.forEach(([x, y], k) => { const [a, b] = pt(x, y); k ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
    else {
      for (let k = 0; k <= 16; k++) { const x = pg.x0 + ((pg.x1 - pg.x0) * k) / 16; const [a, b] = pt(x, P.evalCurve(pg.top, x)); k ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
      for (let k = 16; k >= 0; k--) { const x = pg.x0 + ((pg.x1 - pg.x0) * k) / 16; ctx.lineTo(...pt(x, P.evalCurve(pg.bot, x))); }
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // which page number this will become
    const q = pg.quad || P.pageQuad(pg);
    const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    const [lx, ly] = pt(cx, cy);
    // the live view is turned (rotateLive); keep the number upright
    ctx.save(); ctx.translate(lx, ly); ctx.rotate((-(rotate || 0) * Math.PI) / 180);
    ctx.fillStyle = "rgba(15,23,42,.75)"; ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 18px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(firstPageNo + i), 0, 0);
    ctx.restore();
  });
}

// ---------------------------------------------------------------- small modals
function modal(html) {
  const w = document.createElement("div");
  w.className = "modal-wrap";
  w.innerHTML = `<div class="modal">${html}</div>`;
  document.getElementById("modal-root").appendChild(w);
  return { el: w, close: () => w.remove() };
}
function chooser(title, options) {
  return new Promise((res) => {
    const m = modal(`<h3>${esc(title)}</h3><div class="sheet">${options.map(([v, l]) => `<button class="sheet-btn" data-v="${v}">${l}</button>`).join("")}
      <button class="sheet-btn cancel" data-v="">Cancel</button></div>`);
    m.el.onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b && e.target !== m.el) return; m.close(); res(b ? b.dataset.v : null); };
  });
}
function alertBox(text) {
  const m = modal(`<p>${esc(text)}</p><div class="row end"><button class="btn primary" id="ok">OK</button></div>`);
  m.el.querySelector("#ok").onclick = () => m.close();
}

// The phone's scanner status ("Turning the page…", "Hold still…", "Saved page 12 ✓")
// shown over the live view, with the same countdown ring as on the phone.
export function showPhoneStatus(text, ring) {
  const live = $("live");
  if (!live) return;
  let box = $("phoneStatus");
  if (!box) {
    box = document.createElement("div");
    box.id = "phoneStatus"; box.className = "phone-status hidden";
    box.innerHTML = `<svg viewBox="0 0 36 36" class="ps-ring"><circle cx="18" cy="18" r="15" class="bg"/><circle cx="18" cy="18" r="15" class="fg" id="psRing"/></svg><span id="psText"></span>`;
    live.appendChild(box);
  }
  box.classList.toggle("hidden", !text);
  if (!text) return;
  $("psText").textContent = text;
  box.classList.toggle("warn", /already|same page|not saved|missing|⚠|⛔/i.test(text));
  box.classList.toggle("ok", /✓/.test(text));
  const r = Math.max(0, Math.min(1, +ring || 0));
  $("psRing").style.strokeDashoffset = String(94.25 * (1 - r));
  box.querySelector(".ps-ring").style.display = r > 0 ? "" : "none";
}

// ask the phone for something and wait for its answer ({t: replyType, id})
const pending = new Map();
let reqId = 0;
export function request(send, msg, replyType, timeout = 10000) {
  const id = ++reqId;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve(null); }, timeout);
    pending.set(id, { replyType, done: (m) => { clearTimeout(t); pending.delete(id); resolve(m); } });
    send({ ...msg, id });
  });
}
// answers from the phone (true = it was one)
export function handleReply(m) {
  const p = pending.get(m.id);
  if (!p || p.replyType !== m.t) return false;
  p.done(m);
  return true;
}

// Show the phone's picture the right way up: turn the camera picture and its outline layer
// together by the rotation the phone uses for the pages (portrait or landscape — no tilting
// your head). The outline is drawn in the picture's own coordinates, so it stays on the pages.
let liveRot = 0;
export function rotateLive(rotate) {
  liveRot = ((+rotate || 0) % 360 + 360) % 360;
  const live = $("live");
  if (!live) return;
  const W = live.clientWidth, H = live.clientHeight, side = liveRot === 90 || liveRot === 270;
  for (const el of [$("video"), $("liveimg"), $("overlay")]) {
    if (!el) continue;
    if (!liveRot) { el.style.cssText = el.style.cssText.replace(/(width|height|left|top|right|bottom|inset|transform)\s*:[^;]*;?/g, ""); continue; }
    el.style.inset = "auto";
    el.style.width = (side ? H : W) + "px"; el.style.height = (side ? W : H) + "px";
    el.style.left = (side ? (W - H) / 2 : 0) + "px"; el.style.top = (side ? (H - W) / 2 : 0) + "px";
    el.style.transform = `rotate(${liveRot}deg)`;
  }
}
addEventListener("resize", () => rotateLive(liveRot));
