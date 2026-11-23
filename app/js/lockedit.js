// Lock-area editor shared by the phone and the PC page.
// - zoom: pinch, mouse wheel, double-tap / double-click, + / − buttons
// - pan: drag empty space (or two fingers)
// - drag a corner (or the red fold point) — a magnifier shows exactly where it is
// - drag inside the area to move the whole area
// - "New area" re-detects the page on the current picture, "Whole picture" resets
// - a sharper picture can be loaded in the background (hiRes) for precise zooming
// Points are fractions (0..1) of the picture as it is shown (after rotation).

import { pageQuad } from "./imgproc.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function defaultPts(mode) {
  return mode === "spread"
    ? [[0.05, 0.05], [0.5, 0.05], [0.95, 0.05], [0.95, 0.95], [0.5, 0.95], [0.05, 0.95]]
    : [[0.08, 0.05], [0.92, 0.05], [0.92, 0.95], [0.08, 0.95]];
}

// corner points from a detected page outline (null if nothing was found)
export function ptsFromGeo(g, mode) {
  if (!g || !g.found || !g.pages || !g.pages.length) return null;
  const q = (pg) => (pg.quad || pageQuad(pg)).map((p) => [...p]);
  if (mode === "spread" && g.pages.length === 2) { const l = q(g.pages[0]), r = q(g.pages[1]); return [l[0], l[1], r[1], r[2], l[2], l[3]]; }
  if (mode !== "spread") return q(g.pages[0]);
  return null;
}

// draw `src` (ImageBitmap / video / canvas) turned by `rot` degrees into a canvas, at most maxSide px
function rotated(src, rot, maxSide = 2400) {
  const w0 = src.videoWidth || src.width, h0 = src.videoHeight || src.height;
  if (!w0 || !h0) return null;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = document.createElement("canvas");
  c.width = rot % 180 ? h : w; c.height = rot % 180 ? w : h;
  const g = c.getContext("2d");
  if (rot === 90) { g.translate(c.width, 0); g.rotate(Math.PI / 2); }
  else if (rot === 180) { g.translate(c.width, c.height); g.rotate(Math.PI); }
  else if (rot === 270) { g.translate(0, c.height); g.rotate(-Math.PI / 2); }
  g.drawImage(src, 0, 0, w, h);
  return c;
}

/**
 * @param {object} o
 *  src     picture to start with           rot   rotation (0/90/180/270)
 *  mode    "single" | "spread"             pts   starting points (or null)
 *  title   heading                          note  small text under the picture
 *  hiRes   async () => sharper picture (ImageBitmap/canvas) or null, same view as src
 *  refresh async () => { src, pts? } a new live picture (book moved)
 *  detect  async (src) => points found on the picture, or null
 *  unlock  true: show an "Unlock" button (resolves with the string "unlock")
 * @returns Promise<points | "unlock" | null>
 */
export function editLock(o) {
  return new Promise((resolve) => {
    const mode = o.mode, rot = o.rot || 0;
    let base = rotated(o.src, rot);
    if (!base) { resolve(null); return; }
    let pts = (o.pts && o.pts.length === (mode === "spread" ? 6 : 4) ? o.pts : defaultPts(mode)).map((p) => [...p]);
    const polys = mode === "spread" ? [[0, 1, 4, 5], [1, 2, 3, 4]] : [[0, 1, 2, 3]];
    const isFold = (i) => mode === "spread" && (i === 1 || i === 4);
    // edges with a handle in the middle (drag = move the whole edge); spread: the fold [1,4] too
    const edges = mode === "spread" ? [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 4]] : [[0, 1], [1, 2], [2, 3], [3, 0]];
    const mid = (e) => [(pts[e[0]][0] + pts[e[1]][0]) / 2, (pts[e[0]][1] + pts[e[1]][1]) / 2];
    const centre = () => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];

    const wrap = document.createElement("div");
    wrap.className = "lockedit";
    wrap.innerHTML = `
      <div class="le-head">
        <button class="btn" data-a="cancel">Cancel</button>
        <span class="le-title">${esc(o.title || (mode === "spread" ? "Drag corners, edges or the fold (red)" : "Drag the corners or edges"))}</span>
        <button class="btn primary" data-a="ok">🔒 Lock</button>
      </div>
      <div class="le-stage"><canvas></canvas><canvas class="le-loupe"></canvas><div class="le-badge hidden"></div></div>
      <div class="le-tools">
        <button class="btn" data-a="out" title="Zoom out (−)">−</button>
        <span class="le-zoom">100%</span>
        <button class="btn" data-a="in" title="Zoom in (+)">+</button>
        <button class="btn" data-a="fit" title="Show the whole picture (0)">⤢ Fit</button>
        ${o.detect ? `<button class="btn" data-a="detect" title="Find the page again on this picture">🎯 New area</button>` : ""}
        <button class="btn" data-a="whole" title="Start from a simple rectangle">⬚ Reset</button>
        ${o.unlock ? `<button class="btn" data-a="unlock" title="Stop using a fixed area (pages are found automatically)">🔓 Unlock</button>` : ""}
        ${o.refresh ? `<button class="btn" data-a="refresh" title="Take a new picture from the camera (if the book moved)">📷 New picture</button>` : ""}
      </div>
      <div class="le-hint">Pinch or scroll to zoom · drag a corner ● or the middle of an edge ▬ · ✥ moves the whole area · drag outside to move the picture${o.note ? "<br>" + esc(o.note) : ""}</div>`;
    document.body.appendChild(wrap);
    const stage = wrap.querySelector(".le-stage"), cv = stage.querySelector("canvas"), loupe = wrap.querySelector(".le-loupe");
    const badge = wrap.querySelector(".le-badge"), zoomEl = wrap.querySelector(".le-zoom");
    const ctx = cv.getContext("2d"), lctx = loupe.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    let cw = 0, ch = 0;
    // view: zoom (1 = whole picture fits) and the picture point in the middle of the screen
    let zoom = 1, cx = 0.5, cy = 0.5, sel = -1;
    const MAXZ = 8;
    const fit = () => Math.min(cw / base.width, ch / base.height) * 0.94;
    const sc = () => fit() * zoom;
    const toScreen = ([x, y]) => [cw / 2 + (x - cx) * base.width * sc(), ch / 2 + (y - cy) * base.height * sc()];
    const toPic = (sx, sy) => [cx + (sx - cw / 2) / (base.width * sc()), cy + (sy - ch / 2) / (base.height * sc())];
    const clampView = () => {
      zoom = Math.min(MAXZ, Math.max(1, zoom));
      const hx = cw / (2 * base.width * sc()), hy = ch / (2 * base.height * sc());   // half the view, in picture fractions
      cx = hx >= 0.5 ? 0.5 : Math.min(1 - hx, Math.max(hx, cx));
      cy = hy >= 0.5 ? 0.5 : Math.min(1 - hy, Math.max(hy, cy));
    };
    const zoomAt = (f, sx, sy) => {            // zoom keeping the picture point under (sx,sy) in place
      const [px, py] = toPic(sx, sy);
      zoom *= f; clampView();
      const [nx, ny] = toPic(sx, sy);
      cx += px - nx; cy += py - ny; clampView(); draw();
    };

    function resize() {
      const r = stage.getBoundingClientRect();
      cw = Math.max(50, r.width); ch = Math.max(50, r.height);
      cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
      cv.style.width = cw + "px"; cv.style.height = ch + "px";
      clampView(); draw();
    }

    function draw() {
      if (!cw) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
      const s = sc(), [ox, oy] = toScreen([0, 0]);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = zoom < 3;
      ctx.drawImage(base, ox, oy, base.width * s, base.height * s);
      const Q = pts.map(toScreen);
      ctx.lineWidth = 2.5;
      for (const poly of polys) {
        ctx.beginPath(); poly.forEach((i, k) => (k ? ctx.lineTo(...Q[i]) : ctx.moveTo(...Q[i]))); ctx.closePath();
        ctx.fillStyle = "rgba(250,204,21,0.12)"; ctx.fill(); ctx.strokeStyle = "#facc15"; ctx.stroke();
      }
      if (mode === "spread") { ctx.setLineDash([8, 6]); ctx.strokeStyle = "#ef4444"; ctx.beginPath(); ctx.moveTo(...Q[1]); ctx.lineTo(...Q[4]); ctx.stroke(); ctx.setLineDash([]); }
      // middle-of-edge handles: a pill along the edge
      edges.forEach((e, k) => {
        const a = Q[e[0]], b = Q[e[1]], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 70) return;              // too short to fit one
        const on = act && act.kind === "edge" && act.k === k;
        ctx.save(); ctx.translate(m[0], m[1]); ctx.rotate(ang);
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-16, -6, 32, 12, 6) : ctx.rect(-16, -6, 32, 12);
        ctx.fillStyle = e[0] === 1 && e[1] === 4 ? "rgba(239,68,68,0.85)" : "rgba(250,204,21,0.85)";
        ctx.fill(); ctx.strokeStyle = on ? "#22d3ee" : "#fff"; ctx.lineWidth = on ? 3 : 2; ctx.stroke();
        ctx.restore();
      });
      // centre handle: move the whole area
      { const c = toScreen(centre());
        ctx.beginPath(); ctx.arc(c[0], c[1], 17, 0, Math.PI * 2); ctx.fillStyle = "rgba(15,23,42,0.6)"; ctx.fill();
        ctx.strokeStyle = act && act.kind === "move" ? "#22d3ee" : "#fff"; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.font = "bold 18px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("✥", c[0], c[1] + 1); }
      Q.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p[0], p[1], i === sel ? 15 : 12, 0, Math.PI * 2);
        ctx.fillStyle = isFold(i) ? "rgba(239,68,68,0.65)" : "rgba(250,204,21,0.55)";
        ctx.fill(); ctx.strokeStyle = i === sel ? "#22d3ee" : "#fff"; ctx.lineWidth = i === sel ? 3 : 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(p[0], p[1], 1.8, 0, Math.PI * 2); ctx.fillStyle = "#000"; ctx.fill();
      });
      zoomEl.textContent = Math.round(zoom * 100) + "%";
    }

    // magnifier: 3x around the point being dragged, shown in the corner away from the finger
    function drawLoupe(i) {
      if (i === -1 || i == null) { loupe.style.display = "none"; return; }
      const P0 = Array.isArray(i) ? i : pts[i];
      const L = 150, z = Math.max(3, zoom * 2.5) * fit();   // picture px -> loupe px
      loupe.width = L * dpr; loupe.height = L * dpr; loupe.style.width = loupe.style.height = L + "px";
      const [sx] = toScreen(P0);
      loupe.style.display = "block";
      loupe.style.left = sx < cw / 2 ? "" : "10px"; loupe.style.right = sx < cw / 2 ? "10px" : "";
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.fillStyle = "#000"; lctx.fillRect(0, 0, L, L);
      const px = P0[0] * base.width, py = P0[1] * base.height;
      lctx.imageSmoothingEnabled = false;
      lctx.drawImage(base, L / 2 - px * z, L / 2 - py * z, base.width * z, base.height * z);
      const map = (p) => [L / 2 + (p[0] * base.width - px) * z, L / 2 + (p[1] * base.height - py) * z];
      lctx.strokeStyle = "#facc15"; lctx.lineWidth = 2;
      for (const poly of polys) { lctx.beginPath(); poly.forEach((k, j) => (j ? lctx.lineTo(...map(pts[k])) : lctx.moveTo(...map(pts[k])))); lctx.closePath(); lctx.stroke(); }
      lctx.strokeStyle = "#22d3ee"; lctx.lineWidth = 1.5;
      lctx.beginPath(); lctx.moveTo(L / 2 - 14, L / 2); lctx.lineTo(L / 2 + 14, L / 2); lctx.moveTo(L / 2, L / 2 - 14); lctx.lineTo(L / 2, L / 2 + 14); lctx.stroke();
    }

    const inside = (p, poly) => {              // point in polygon (picture fractions)
      let c = false;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xa, ya] = pts[poly[a]], [xb, yb] = pts[poly[b]];
        if (ya > p[1] !== yb > p[1] && p[0] < ((xb - xa) * (p[1] - ya)) / (yb - ya) + xa) c = !c;
      }
      return c;
    };
    const clamp01 = (v) => Math.min(1, Math.max(0, v));

    // ---- pointers: 1 finger = drag corner / move area / pan, 2 fingers = pinch zoom + pan
    const ptrs = new Map();
    let act = null, lastTap = 0;
    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, local(e));
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        act = { kind: "pinch", d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        drawLoupe(-1); return;
      }
      if (ptrs.size > 2) return;
      const [sx, sy] = local(e), p = toPic(sx, sy);
      const hit = e.pointerType === "touch" ? 44 : 26;
      let best = -1, bd = Infinity;
      pts.forEach((q, i) => { const [qx, qy] = toScreen(q); const d = Math.hypot(qx - sx, qy - sy); if (d < bd) { bd = d; best = i; } });
      const now = performance.now();
      // middle-of-edge handles and the centre handle
      let be = -1, bed = Infinity;
      edges.forEach((e, k) => {
        const a = toScreen(pts[e[0]]), b = toScreen(pts[e[1]]);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 70) return;
        const [mx, my] = toScreen(mid(e)), d = Math.hypot(mx - sx, my - sy);
        if (d < bed) { bed = d; be = k; }
      });
      const [ccx, ccy] = toScreen(centre()), cd = Math.hypot(ccx - sx, ccy - sy);
      if (bd < hit && bd <= bed) { sel = best; act = { kind: "corner", i: best, off: [pts[best][0] - p[0], pts[best][1] - p[1]] }; drawLoupe(best); }
      else if (bed < hit) { sel = -1; act = { kind: "edge", k: be, start: p, orig: pts.map((q) => [...q]) }; drawLoupe(mid(edges[be])); }
      else if (cd < hit) act = { kind: "move", start: p, orig: pts.map((q) => [...q]) };
      else if (now - lastTap < 320) { act = null; zoomAt(zoom >= MAXZ * 0.7 ? 1 / zoom : 2.5, sx, sy); }
      else if (polys.some((poly) => inside(p, poly))) act = { kind: "move", start: p, orig: pts.map((q) => [...q]) };
      else act = { kind: "pan", start: [sx, sy], c: [cx, cy] };
      lastTap = bd < hit || bed < hit || cd < hit ? 0 : now;
      draw();
    });
    cv.addEventListener("pointermove", (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, local(e));
      if (!act) return;
      if (act.kind === "pinch" && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        // pan with the fingers' middle, zoom with their distance
        cx -= (m[0] - act.m[0]) / (base.width * sc()); cy -= (m[1] - act.m[1]) / (base.height * sc());
        act.m = m; clampView();
        if (act.d > 10) zoomAt(d / act.d, m[0], m[1]);
        act.d = d; draw(); return;
      }
      const [sx, sy] = local(e), p = toPic(sx, sy);
      if (act.kind === "corner") {
        pts[act.i] = [clamp01(p[0] + act.off[0]), clamp01(p[1] + act.off[1])];
        // corner close to the screen edge while zoomed: scroll the picture along
        const edge = 30, step = 0.012 / zoom;
        if (zoom > 1) { if (sx < edge) cx -= step; if (sx > cw - edge) cx += step; if (sy < edge) cy -= step; if (sy > ch - edge) cy += step; clampView(); }
        draw(); drawLoupe(act.i);
      } else if (act.kind === "edge") {
        // move both ends of the edge together (kept inside the picture)
        const e = edges[act.k], A = act.orig[e[0]], B = act.orig[e[1]];
        let dx = p[0] - act.start[0], dy = p[1] - act.start[1];
        dx = Math.min(1 - Math.max(A[0], B[0]), Math.max(-Math.min(A[0], B[0]), dx));
        dy = Math.min(1 - Math.max(A[1], B[1]), Math.max(-Math.min(A[1], B[1]), dy));
        pts = act.orig.map((q) => [...q]);
        pts[e[0]] = [A[0] + dx, A[1] + dy]; pts[e[1]] = [B[0] + dx, B[1] + dy];
        draw(); drawLoupe(mid(e));
      } else if (act.kind === "move") {
        let dx = p[0] - act.start[0], dy = p[1] - act.start[1];
        const xs = act.orig.map((q) => q[0]), ys = act.orig.map((q) => q[1]);
        dx = Math.min(1 - Math.max(...xs), Math.max(-Math.min(...xs), dx));
        dy = Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), dy));
        pts = act.orig.map(([x, y]) => [x + dx, y + dy]); draw();
      } else if (act.kind === "pan") {
        cx = act.c[0] - (sx - act.start[0]) / (base.width * sc());
        cy = act.c[1] - (sy - act.start[1]) / (base.height * sc());
        clampView(); draw();
      }
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (act && act.kind === "pinch" && ptrs.size === 1) { const [q] = [...ptrs.values()]; act = { kind: "pan", start: q, c: [cx, cy] }; return; }
      if (!ptrs.size) { act = null; drawLoupe(-1); draw(); }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), sx, sy);
    }, { passive: false });

    // keyboard (PC): arrows nudge the selected corner, Tab picks the next one
    const onKey = (e) => {
      if (e.target.closest && e.target.closest("input, select, textarea")) return;
      e.stopPropagation();                     // the page's own shortcuts (Space = capture…) wait
      if (e.key === "Escape") { e.preventDefault(); done(null); return; }
      if (e.key === "Enter") { e.preventDefault(); done(pts); return; }
      if (e.key === "+" || e.key === "=") { zoomAt(1.4, cw / 2, ch / 2); e.preventDefault(); return; }
      if (e.key === "-") { zoomAt(1 / 1.4, cw / 2, ch / 2); e.preventDefault(); return; }
      if (e.key === "0") { zoom = 1; clampView(); draw(); return; }
      if (e.key === "Tab") { e.preventDefault(); sel = (sel + (e.shiftKey ? pts.length - 1 : 1)) % pts.length; draw(); return; }
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (dir && sel >= 0) {
        e.preventDefault(); e.stopPropagation();
        const px = (e.shiftKey ? 10 : 1) / sc();
        pts[sel] = [clamp01(pts[sel][0] + (dir[0] * px) / base.width), clamp01(pts[sel][1] + (dir[1] * px) / base.height)];
        draw();
      }
    };
    document.addEventListener("keydown", onKey, true);

    const flash = (t, ms = 2200) => { badge.textContent = t; badge.classList.remove("hidden"); clearTimeout(flash.t); flash.t = setTimeout(() => badge.classList.add("hidden"), ms); };
    const setBase = (src) => { const b = rotated(src, rot); if (b) { base = b; clampView(); draw(); } };

    wrap.querySelector(".le-tools").addEventListener("click", async (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "in") zoomAt(1.5, cw / 2, ch / 2);
      else if (a === "out") zoomAt(1 / 1.5, cw / 2, ch / 2);
      else if (a === "fit") { zoom = 1; clampView(); draw(); }
      else if (a === "whole") { pts = defaultPts(mode); draw(); }
      else if (a === "detect") {
        flash("Finding the page…", 8000);
        const p = await o.detect().catch(() => null);
        if (p) { pts = p.map((q) => [...q]); zoom = 1; clampView(); draw(); flash("New area found — adjust it if needed"); }
        else flash("No page found — drag the corners yourself");
      } else if (a === "refresh") {
        flash("Getting a new picture…", 8000);
        const r = await o.refresh().catch(() => null);
        if (r && r.src) { setBase(r.src); if (r.pts) pts = r.pts.map((q) => [...q]); draw(); flash("New picture"); loadHiRes(); }
        else flash("No new picture from the camera");
      }
    });
    wrap.querySelector('[data-a="cancel"]').onclick = () => done(null);
    wrap.querySelector('[data-a="ok"]').onclick = () => done(pts);
    const ub = wrap.querySelector('[data-a="unlock"]');
    if (ub) ub.onclick = () => done("unlock");

    let closed = false, hiResGen = 0;
    async function loadHiRes() {
      if (!o.hiRes) return;
      const gen = ++hiResGen;
      flash("Loading a sharper picture for zooming…", 15000);
      const b = await o.hiRes().catch(() => null);
      if (closed || gen !== hiResGen) return;
      if (b) { setBase(b); flash("Sharp picture ready — zoom in for precise corners"); }
      else badge.classList.add("hidden");
    }

    function done(v) {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      removeEventListener("resize", resize);
      wrap.remove();
      resolve(v === "unlock" ? v : v ? v.map(([x, y]) => [+clamp01(x).toFixed(4), +clamp01(y).toFixed(4)]) : null);
    }
    addEventListener("resize", resize);
    requestAnimationFrame(() => { resize(); loadHiRes(); });
  });
}
