// Zoom for pictures, shared by the phone app and the PC page.
// - attachZoom(stage, target): pinch, mouse wheel, double-tap / double-click, drag to move
//   while zoomed; returns { zoomIn, zoomOut, reset, scale } (the picture itself is not changed)
// - zoomViewer(src, title): full-screen viewer for a page or a sharp camera photo
//   (src: Blob, ImageBitmap, canvas or image URL)

const MAXZ = 8;

export function attachZoom(stage, target, { onChange = () => {} } = {}) {
  let s = 1, tx = 0, ty = 0;
  const pts = new Map();
  let pinch = null, pan = null, lastTap = 0;
  target.style.transformOrigin = "0 0";
  const clamp = () => {
    s = Math.min(MAXZ, Math.max(1, s));
    if (s === 1) { tx = 0; ty = 0; return; }
    const w = stage.clientWidth, h = stage.clientHeight;
    tx = Math.min(0, Math.max(w - w * s, tx));
    ty = Math.min(0, Math.max(h - h * s, ty));
  };
  const apply = () => {
    clamp();
    target.style.transform = s === 1 ? "" : `translate(${tx}px, ${ty}px) scale(${s})`;
    stage.classList.toggle("zoomed", s > 1);
    onChange(s);
  };
  // zoom by f keeping the stage point (px,py) in place
  const zoomAt = (f, px, py) => {
    const ns = Math.min(MAXZ, Math.max(1, s * f));
    tx = px - ((px - tx) * ns) / s; ty = py - ((py - ty) * ns) / s; s = ns;
    apply();
  };
  const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const centre = () => [stage.clientWidth / 2, stage.clientHeight / 2];

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0025), ...local(e));
  }, { passive: false });
  stage.addEventListener("dblclick", (e) => { if (e.pointerType !== "touch") zoomAt(s > 1 ? 1 / s : 2.5, ...local(e)); });
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, a, input, select")) return;
    pts.set(e.pointerId, local(e));
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], tx, ty };
      pan = null;
    } else if (pts.size === 1) {
      if (e.pointerType === "touch") {
        const now = performance.now();
        if (now - lastTap < 300) { zoomAt(s > 1 ? 1 / s : 2.5, ...local(e)); lastTap = 0; return; }
        lastTap = now;
      }
      if (s > 1) { pan = { x: e.clientX, y: e.clientY, tx, ty }; try { stage.setPointerCapture(e.pointerId); } catch {} }
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ns = Math.min(MAXZ, Math.max(1, (pinch.s * d) / Math.max(1, pinch.d)));
      // the picture point that was under the first midpoint follows the fingers
      tx = mid[0] - ((pinch.mid[0] - pinch.tx) * ns) / pinch.s;
      ty = mid[1] - ((pinch.mid[1] - pinch.ty) * ns) / pinch.s;
      s = ns; apply();
    } else if (pan) {
      tx = pan.tx + e.clientX - pan.x; ty = pan.ty + e.clientY - pan.y; apply();
    }
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) pan = null; };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  addEventListener("resize", apply);

  return {
    zoomIn: () => zoomAt(1.5, ...centre()),
    zoomOut: () => zoomAt(1 / 1.5, ...centre()),
    reset: () => { s = 1; apply(); },
    get scale() { return s; },
  };
}

// small − 100% + ⤢ bar on top of a zoomable stage
export function zoomButtons(stage, z, extra = "") {
  const bar = document.createElement("div");
  bar.className = "zoombar";
  bar.innerHTML = `<button type="button" data-z="out" aria-label="Zoom out">−</button><span class="zv">100%</span>
    <button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="fit" aria-label="Fit">⤢</button>${extra}`;
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-z]");
    if (!b) return;
    e.stopPropagation();
    ({ in: z.zoomIn, out: z.zoomOut, fit: z.reset })[b.dataset.z]?.();
  });
  stage.appendChild(bar);
  return (sc) => { bar.querySelector(".zv").textContent = Math.round(sc * 100) + "%"; };
}

// full-screen viewer; resolves when closed
export function zoomViewer(src, title = "") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "zoomview";
    wrap.innerHTML = `<div class="zv-head"><span class="zv-title"></span><button type="button" class="zv-close" aria-label="Close">✕</button></div>
      <div class="zv-stage"><div class="zv-pic"></div></div>
      <div class="zv-hint">Pinch, scroll or double-tap to zoom · drag to move</div>`;
    wrap.querySelector(".zv-title").textContent = title;
    const stage = wrap.querySelector(".zv-stage"), pic = wrap.querySelector(".zv-pic");
    let url = null;
    if (src instanceof Blob) { url = URL.createObjectURL(src); src = url; }
    if (typeof src === "string") {
      const img = document.createElement("img"); img.src = src; img.alt = ""; pic.appendChild(img);
    } else {
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      c.getContext("2d").drawImage(src, 0, 0);
      pic.appendChild(c);
    }
    document.body.appendChild(wrap);
    let upd = () => {};
    const z = attachZoom(stage, pic, { onChange: (sc) => upd(sc) });
    upd = zoomButtons(stage, z);
    const onKey = (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "+" || e.key === "=") z.zoomIn();
      else if (e.key === "-") z.zoomOut();
      else if (e.key === "0") z.reset();
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    function close() {
      document.removeEventListener("keydown", onKey, true);
      wrap.remove();
      if (url) URL.revokeObjectURL(url);
      resolve();
    }
    wrap.querySelector(".zv-close").onclick = close;
  });
}
