// PC Remote: look through the received pages like a PDF — previous / next, a strip of all
// pages, zoom, and ✕ on the page to remove it (on the phone too).
import { attachZoom, zoomButtons } from "./zoomview.js";

// opts.list(): [{ order, blob, blurry }] sorted by order · opts.remove(order): Promise<boolean>
// returns { refresh() } — call it when pages arrive or are renumbered
export function pageViewer(startOrder, { list, remove, onClose = () => {} }) {
  let pages = list();
  let i = Math.max(0, pages.findIndex((p) => p.order === startOrder));
  let url = null, removing = false;
  const stripUrls = new Map();               // blob -> object URL for the strip

  const w = document.createElement("div");
  w.className = "zoomview pageview";
  w.innerHTML = `
    <div class="zv-head">
      <span class="zv-title" id="pvTitle"></span>
      <button type="button" class="pv-hbtn" id="pvDel" title="Remove this page (on the phone too) — key Delete">🗑 Remove page</button>
      <button type="button" class="zv-close" aria-label="Close">✕</button>
    </div>
    <div class="zv-stage" id="pvStage">
      <div class="zv-pic"><div class="pv-page"><img alt="" id="pvImg"><button type="button" class="pv-x" id="pvX" title="Remove this page" aria-label="Remove this page">✕</button></div></div>
      <button type="button" class="pv-nav prev" id="pvPrev" aria-label="Previous page">‹</button>
      <button type="button" class="pv-nav next" id="pvNext" aria-label="Next page">›</button>
    </div>
    <div class="pv-strip" id="pvStrip"></div>
    <div class="zv-hint">← → or PageUp / PageDown: other pages · scroll or double-click: zoom · Delete: remove page · Esc: close</div>`;
  document.body.appendChild(w);
  const $ = (id) => w.querySelector("#" + id);
  const stage = $("pvStage"), pic = w.querySelector(".zv-pic"), img = $("pvImg"), strip = $("pvStrip");
  let upd = () => {};
  const z = attachZoom(stage, pic, { onChange: (sc) => upd(sc) });
  upd = zoomButtons(stage, z);

  // fit the page into the free area (whole page always visible at 100%)
  const fit = () => {
    if (!img.naturalWidth) return;
    const sw = stage.clientWidth - 24, sh = stage.clientHeight - 24;
    const s = Math.min(sw / img.naturalWidth, sh / img.naturalHeight);
    img.style.width = Math.round(img.naturalWidth * s) + "px";
    img.style.height = Math.round(img.naturalHeight * s) + "px";
  };
  img.onload = fit;
  addEventListener("resize", fit);

  function drawStrip() {
    const keep = new Set(pages.map((p) => p.blob));
    for (const [b, u] of stripUrls) if (!keep.has(b)) { URL.revokeObjectURL(u); stripUrls.delete(b); }
    strip.innerHTML = "";
    pages.forEach((p, k) => {
      let u = stripUrls.get(p.blob);
      if (!u) { u = URL.createObjectURL(p.blob); stripUrls.set(p.blob, u); }
      const b = document.createElement("button");
      b.type = "button"; b.className = "pv-th" + (k === i ? " on" : "") + (p.blurry ? " blurry" : "") + (p.retaken ? " retaken" : "");
      b.innerHTML = `<img alt="" loading="lazy" decoding="async"><span>${Math.round(p.order)}</span>`;
      b.querySelector("img").src = u;
      b.onclick = () => show(k);
      strip.appendChild(b);
    });
    strip.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function show(k) {
    if (!pages.length) { $("pvTitle").textContent = "No pages"; img.removeAttribute("src"); strip.innerHTML = ""; return; }
    i = Math.max(0, Math.min(pages.length - 1, k));
    const p = pages[i];
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(p.blob);
    z.reset();
    img.src = url;
    $("pvTitle").textContent = `Page ${Math.round(p.order)} of ${pages.length}` + (p.retaken ? "  ·  ↻ Retaken" : "") + (p.blurry ? "  ·  ⚠ looks blurry" : "");
    $("pvPrev").disabled = i === 0;
    $("pvNext").disabled = i === pages.length - 1;
    strip.querySelectorAll(".pv-th").forEach((b, n) => b.classList.toggle("on", n === i));
    strip.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  async function del() {
    if (removing || !pages[i]) return;
    removing = true;
    const order = pages[i].order;
    try { await remove(order); } finally { removing = false; }
  }

  $("pvPrev").onclick = (e) => { e.stopPropagation(); show(i - 1); };
  $("pvNext").onclick = (e) => { e.stopPropagation(); show(i + 1); };
  $("pvDel").onclick = del;
  $("pvX").onclick = (e) => { e.stopPropagation(); del(); };

  const onKey = (e) => {
    if (document.querySelector(".modal-wrap")) return;            // a question box is open
    const k = e.key;
    if (k === "Escape") close();
    else if (k === "ArrowRight" || k === "PageDown" || k === "ArrowDown") show(i + 1);
    else if (k === "ArrowLeft" || k === "PageUp" || k === "ArrowUp") show(i - 1);
    else if (k === "Home") show(0);
    else if (k === "End") show(pages.length - 1);
    else if (k === "Delete" || k === "Backspace") del();
    else if (k === "+" || k === "=") z.zoomIn();
    else if (k === "-") z.zoomOut();
    else if (k === "0") z.reset();
    else if (k === " ") { /* never take a photo from here */ }
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  document.addEventListener("keydown", onKey, true);

  function close() {
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", fit);
    w.remove();
    if (url) URL.revokeObjectURL(url);
    for (const u of stripUrls.values()) URL.revokeObjectURL(u);
    onClose();
  }
  w.querySelector(".zv-close").onclick = close;

  drawStrip(); show(i);
  return {
    // pages changed (arrived, removed, renumbered): stay on the same page number if it exists
    refresh() {
      if (!w.isConnected) return;
      const cur = pages[i] && pages[i].order;
      pages = list();
      drawStrip();
      const k = pages.findIndex((p) => p.order === cur);
      show(k >= 0 ? k : Math.min(i, pages.length - 1));
    },
    close,
  };
}
