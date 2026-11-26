// PDF tools on the home screen: ✍️ E-sign PDF and 💧 Watermark PDF.
// They work on any PDF file, or on a scan made in this app.
//  - pages are shown with pdf.js (Mozilla), the new PDF is written with pdf-lib, so the
//    original pages (text, vectors) stay exactly as they were — only the signature /
//    watermark is added on top.
//  - signatures, dates and watermark text are drawn as pictures, so any language works
//    (Bangla too), not only the few letters built into PDF fonts.
import * as DB from "./db.js";
import { buildPdf } from "./pdf.js";

let libs = null;
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("could not load " + src));
    document.head.appendChild(s);
  });
}
async function loadLibs() {
  if (!libs) libs = (async () => {
    const v = (f) => new URL("../vendor/" + f, import.meta.url).href;
    await Promise.all([window.PDFLib ? 0 : loadScript(v("pdf-lib.min.js")), window.pdfjsLib ? 0 : loadScript(v("pdfjs.min.js"))]);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = v("pdfjs.worker.min.js");
    return { PDFLib: window.PDFLib, pdfjs: window.pdfjsLib };
  })().catch((e) => { libs = null; throw e; });
  return libs;
}

const baseName = (n) => String(n || "Document").replace(/\.pdf$/i, "");

// ---------------------------------------------------------------- choose a PDF
// { kind: "file", bytes, name } or { kind: "scan", book, pages, name }
function pickSource(ui, title) {
  return new Promise(async (resolve) => {
    const books = await DB.listBooks();
    const withPages = [];
    for (const b of books) {
      const n = (await DB.listPages(b.id)).filter((p) => p.status === "done").length;
      if (n) withPages.push({ b, n });
    }
    const m = ui.modal(`<h3>${ui.esc(title)}</h3>
      <label class="btn primary big pick-file">📂 Open a PDF file<input type="file" accept="application/pdf,.pdf" hidden></label>
      <p class="muted small" style="margin:14px 2px 6px">Or one of your scans:</p>
      <div class="pick-list">${withPages.length ? withPages.map(({ b, n }, i) => `<button class="pick-row" data-i="${i}"><b>${ui.esc(b.name)}</b><span class="muted small">${n} page${n > 1 ? "s" : ""}</span></button>`).join("")
        : '<p class="muted small">No scans yet.</p>'}</div>
      <div class="row end"><button class="btn" id="c">Cancel</button></div>`, "pick-modal");
    m.el.querySelector("#c").onclick = () => { m.close(); resolve(null); };
    m.el.querySelector("input[type=file]").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      m.close();
      resolve({ kind: "file", bytes: new Uint8Array(await f.arrayBuffer()), name: baseName(f.name) });
    };
    m.el.querySelectorAll(".pick-row").forEach((r) => (r.onclick = async () => {
      const { b } = withPages[+r.dataset.i];
      m.close();
      const pages = (await DB.listPages(b.id)).filter((p) => p.status === "done");
      resolve({ kind: "scan", book: b, pages, name: b.name });
    }));
  });
}

// a scan as PDF bytes (for signing and showing)
async function scanToBytes(src, onProgress) {
  const blobs = [];
  for (let i = 0; i < src.pages.length; i++) {
    const b = await DB.getBlob("full:" + src.pages[i].id);
    if (b) blobs.push(b);
    onProgress && onProgress((i + 1) / src.pages.length);
  }
  const pdf = await buildPdf(blobs, { title: src.name });
  return new Uint8Array(await pdf.arrayBuffer());
}

function progressModal(ui, title) {
  const m = ui.modal(`<h3 id="ph">${ui.esc(title)}</h3><div class="progress"><div id="bar"></div></div><p class="muted small" id="pt"></p>`);
  return {
    set(f, text = "") { m.el.querySelector("#bar").style.width = Math.round(100 * f) + "%"; m.el.querySelector("#pt").textContent = text; },
    close: () => m.close(),
  };
}

// a text as a transparent picture (any script); returns a canvas
function textPicture(text, { px = 160, color = "#000", bold = true } = {}) {
  const c = document.createElement("canvas"), g = c.getContext("2d");
  const font = `${bold ? "700 " : ""}${px}px system-ui, "Noto Sans Bengali", "Noto Sans", sans-serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + px * 0.4, h = Math.ceil(px * 1.45);
  c.width = w; c.height = h;
  g.font = font; g.fillStyle = color; g.textBaseline = "middle"; g.textAlign = "center";
  g.fillText(text, w / 2, h / 2);
  return c;
}
const canvasPng = (c) => new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), "image/png"));

// ================================================================ ✍️ E-SIGN
const SIGN_KEY = "booksnap.signature";
const loadSign = () => { try { return localStorage.getItem(SIGN_KEY); } catch { return null; } };
const saveSign = (d) => { try { localStorage.setItem(SIGN_KEY, d); } catch {} };

// draw (or load a photo of) the signature; returns a PNG data URL with a clear background
function signaturePad(ui) {
  return new Promise((resolve) => {
    const m = ui.modal(`<h3>✍️ Your signature</h3>
      <div class="sigpad-wrap"><canvas class="sigpad" id="pad"></canvas><span class="sigpad-hint" id="hint">Sign here with your finger or mouse</span></div>
      <div class="row sig-opts">
        <div class="seg light" id="ink"><button data-c="#111827" class="active">⚫ Black</button><button data-c="#1d4ed8">🔵 Blue</button></div>
        <button class="btn small" id="clr">Clear</button>
      </div>
      <label class="btn small" style="margin-top:8px">🖼 Use a photo of my signature<input type="file" accept="image/*" hidden id="photo"></label>
      <div class="row end"><button class="btn" id="c">Cancel</button><button class="btn primary" id="o">Use signature</button></div>`, "sig-modal");
    const pad = m.el.querySelector("#pad"), g = pad.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const size = () => { const r = pad.getBoundingClientRect(); pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr); g.scale(dpr, dpr); g.lineCap = g.lineJoin = "round"; };
    requestAnimationFrame(size);
    let ink = "#111827", drawn = false, last = null, photo = null;
    m.el.querySelector("#ink").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; ink = b.dataset.c; m.el.querySelectorAll("#ink button").forEach((x) => x.classList.toggle("active", x === b)); };
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, e.pressure || 0.5]; };
    pad.onpointerdown = (e) => { pad.setPointerCapture(e.pointerId); last = pos(e); photo = null; m.el.querySelector("#hint").style.display = "none"; };
    pad.onpointermove = (e) => {
      if (!last) return;
      const p = pos(e);
      g.strokeStyle = ink; g.lineWidth = 2.2 + 1.6 * (e.pointerType === "pen" ? p[2] : 0.6);
      g.beginPath(); g.moveTo(last[0], last[1]); g.quadraticCurveTo(last[0], last[1], (last[0] + p[0]) / 2, (last[1] + p[1]) / 2); g.lineTo(p[0], p[1]); g.stroke();
      last = p; drawn = true;
    };
    pad.onpointerup = pad.onpointercancel = () => { last = null; };
    m.el.querySelector("#clr").onclick = () => { g.clearRect(0, 0, pad.width, pad.height); drawn = false; photo = null; m.el.querySelector("#hint").style.display = ""; };
    // photo of a signature on paper: keep the dark ink, make the paper clear
    m.el.querySelector("#photo").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const cg = c.getContext("2d"); cg.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
      const im = cg.getImageData(0, 0, c.width, c.height), d = im.data;
      let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      const paper = sum / (d.length / 4) / 3, cut = paper * 0.72;
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        d[i + 3] = v >= cut ? 0 : Math.min(255, Math.round(255 * (cut - v) / (cut * 0.35)));
      }
      cg.putImageData(im, 0, 0);
      photo = c;
      g.clearRect(0, 0, pad.width, pad.height);
      const r = pad.getBoundingClientRect(), s = Math.min(r.width / c.width, r.height / c.height) * 0.9;
      g.drawImage(c, (r.width - c.width * s) / 2, (r.height - c.height * s) / 2, c.width * s, c.height * s);
      m.el.querySelector("#hint").style.display = "none";
      drawn = true;
    };
    m.el.querySelector("#c").onclick = () => { m.close(); resolve(null); };
    m.el.querySelector("#o").onclick = () => {
      if (!drawn) return ui.toast("Sign first, or use a photo of your signature");
      const src = photo || pad;
      const t = trimCanvas(src);
      if (!t) return ui.toast("Sign first");
      const d = t.toDataURL("image/png");
      saveSign(d); m.close(); resolve(d);
    };
  });
}
// cut a canvas to its drawn part (plus a small margin)
function trimCanvas(c) {
  const g = c.getContext("2d"), { width: w, height: h } = c, d = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const m = Math.round(Math.max(w, h) * 0.01);
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  const o = document.createElement("canvas"); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext("2d").drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}

// show the pages one under the other; returns { pdf, wraps[] } — each wrap holds the page picture
async function showPages(ui, holder, pdf, scaleTo) {
  const wraps = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const w = document.createElement("div");
    w.className = "pdfpage"; w.dataset.i = i - 1;
    w.style.aspectRatio = `${vp.width} / ${vp.height}`;
    w.innerHTML = `<canvas></canvas><span class="pgno">${i} / ${pdf.numPages}</span>`;
    holder.appendChild(w);
    wraps.push({ w, page, vp, drawn: false });
  }
  const draw = async (o) => {
    if (o.drawn) return; o.drawn = true;
    const cssW = o.w.clientWidth || scaleTo, dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = o.page.getViewport({ scale: (cssW * dpr) / o.vp.width });
    const c = o.w.querySelector("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await o.page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  };
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) draw(wraps[+e.target.dataset.i]); }), { rootMargin: "600px 0px" });
  wraps.forEach((o) => io.observe(o.w));
  return { wraps, stop: () => io.disconnect() };
}

export async function viewEsign(ui) {
  const { app } = ui;
  app.innerHTML = `
    <header class="bar"><a class="icon" href="#/" aria-label="Back">‹</a><div class="title">✍️ E-sign PDF</div></header>
    <main class="tool">
      <div class="tool-intro">
        <div class="big-emoji">✍️</div>
        <p><b>Sign any PDF.</b> Open a PDF (or one of your scans), tap where your signature goes, move or resize it, then make the signed PDF.</p>
        <button class="btn primary big" id="open">📂 Choose a PDF</button>
      </div>
    </main>`;
  let stop = () => {};
  app.querySelector("#open").onclick = async () => {
    const src = await pickSource(ui, "Which PDF do you want to sign?");
    if (!src) return;
    let bytes = src.bytes;
    try {
      if (src.kind === "scan") {
        const pm = progressModal(ui, "Preparing the PDF…");
        bytes = await scanToBytes(src, (f) => pm.set(f));
        pm.close();
      }
      stop = await signEditor(ui, bytes, src.name);
    } catch (e) { console.error(e); ui.toast("Could not open this PDF: " + (e.message || e), 6000); }
  };
  return () => stop();
}

// text to place on the page
function textDialog(ui) {
  return new Promise((resolve) => {
    const m = ui.modal(`<h3>📝 Add text</h3>
      <input class="input" id="t" maxlength="120" placeholder="e.g. your name, Approved, a note">
      <div class="row sig-opts">
        <div class="seg light" id="ink"><button data-c="#111827" class="active">⚫ Black</button><button data-c="#1d4ed8">🔵 Blue</button><button data-c="#b91c1c">🔴 Red</button></div>
        <label class="check"><input type="checkbox" id="b"> Bold</label>
      </div>
      <div class="row end"><button class="btn" id="c">Cancel</button><button class="btn primary" id="o">Add</button></div>`);
    let color = "#111827";
    const inp = m.el.querySelector("#t"); setTimeout(() => inp.focus(), 50);
    m.el.querySelector("#ink").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; color = b.dataset.c; m.el.querySelectorAll("#ink button").forEach((x) => x.classList.toggle("active", x === b)); };
    const ok = () => { const t = inp.value.trim(); if (!t) return ui.toast("Type the text first"); m.close(); resolve({ text: t, color, bold: m.el.querySelector("#b").checked }); };
    m.el.querySelector("#o").onclick = ok;
    inp.onkeydown = (e) => { if (e.key === "Enter") ok(); };
    m.el.querySelector("#c").onclick = () => { m.close(); resolve(null); };
  });
}

async function signEditor(ui, bytes, name) {
  const { app } = ui;
  const { PDFLib, pdfjs } = await loadLibs();
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  app.innerHTML = `
    <header class="bar"><a class="icon" href="#/esign" aria-label="Back" id="back">‹</a><div class="title">✍️ ${ui.esc(name)}</div></header>
    <div class="tool-bar">
      <button class="btn small primary" id="addsig">＋ Add signature</button>
      <button class="btn small" id="addtext">📝 Add text</button>
      <button class="btn small" id="adddate">📅 Date</button>
      <button class="btn small" id="mysig">✍️ Change signature</button>
      <span class="muted small" id="tip">Tap a page to place your signature</span>
    </div>
    <main class="tool pages" id="pages"></main>
    <div class="tool-foot"><button class="btn primary big" id="make" disabled>✓ Make signed PDF</button></div>`;
  app.querySelector("#back").onclick = (e) => { e.preventDefault(); ui.go("#/"); };
  const holder = app.querySelector("#pages");
  const view = await showPages(ui, holder, pdf, holder.clientWidth);
  let sig = loadSign();
  const marks = [];          // { page, fx, fy, fw, fh, src (dataURL), el }
  const updateMake = () => { app.querySelector("#make").disabled = !marks.length; app.querySelector("#tip").textContent = marks.length ? `${marks.length} placed · drag to move, ◢ to resize, ✕ to remove` : "Tap a page (or ＋ Add signature) to place your signature"; };
  updateMake();

  async function ensureSig() { if (!sig) sig = await signaturePad(ui); updateMake(); return sig; }
  app.querySelector("#mysig").onclick = async () => { const d = await signaturePad(ui); if (d) { sig = d; ui.toast("Signature saved on this device ✓"); } updateMake(); };

  // add a mark (signature or date picture) on a page at the given place (fractions of the page)
  function addMark(pageIdx, src, fx, fy, fwWanted) {
    const o = view.wraps[pageIdx];
    const img = new Image();
    img.onload = () => {
      const pw = o.w.clientWidth, ph = o.w.clientHeight;
      const fw = Math.min(fwWanted, 0.9), fh = (fw * pw * img.naturalHeight) / img.naturalWidth / ph;
      const mk = { page: pageIdx, fx: Math.max(0, Math.min(1 - fw, fx - fw / 2)), fy: Math.max(0, Math.min(1 - fh, fy - fh / 2)), fw, fh, src, ratio: img.naturalWidth / img.naturalHeight };
      const el = document.createElement("div");
      el.className = "mark";
      el.innerHTML = `<img alt="" src="${src}"><button class="mk-x" aria-label="Remove">✕</button><span class="mk-rs" aria-label="Resize">◢</span>`;
      o.w.appendChild(el);
      mk.el = el; marks.push(mk); place(mk); updateMake();
      el.querySelector(".mk-x").onclick = (e) => { e.stopPropagation(); el.remove(); marks.splice(marks.indexOf(mk), 1); updateMake(); };
      dragMark(mk, o);
    };
    img.src = src;
  }
  function place(mk) { Object.assign(mk.el.style, { left: mk.fx * 100 + "%", top: mk.fy * 100 + "%", width: mk.fw * 100 + "%", height: mk.fh * 100 + "%" }); }
  function dragMark(mk, o) {
    let st = null;
    mk.el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".mk-x")) return;
      e.stopPropagation(); e.preventDefault();
      mk.el.setPointerCapture(e.pointerId);
      st = { x: e.clientX, y: e.clientY, fx: mk.fx, fy: mk.fy, fw: mk.fw, resize: !!e.target.closest(".mk-rs") };
    });
    mk.el.addEventListener("pointermove", (e) => {
      if (!st) return;
      const pw = o.w.clientWidth, ph = o.w.clientHeight;
      const dx = (e.clientX - st.x) / pw, dy = (e.clientY - st.y) / ph;
      if (st.resize) {
        mk.fw = Math.max(0.05, Math.min(1 - mk.fx, st.fw + dx));
        mk.fh = (mk.fw * pw) / mk.ratio / ph;
        if (mk.fy + mk.fh > 1) { mk.fh = 1 - mk.fy; mk.fw = (mk.fh * ph * mk.ratio) / pw; }
      } else {
        mk.fx = Math.max(0, Math.min(1 - mk.fw, st.fx + dx));
        mk.fy = Math.max(0, Math.min(1 - mk.fh, st.fy + dy));
      }
      place(mk);
    });
    const end = () => { st = null; };
    mk.el.addEventListener("pointerup", end); mk.el.addEventListener("pointercancel", end);
  }
  // tap a page: put the signature there
  holder.addEventListener("click", async (e) => {
    if (e.target.closest(".mark")) return;
    const w = e.target.closest(".pdfpage"); if (!w) return;
    const s = await ensureSig(); if (!s) return;
    const r = w.getBoundingClientRect();
    addMark(+w.dataset.i, s, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, 0.3);
  });
  // the page most in view (signature / text / date buttons put things there)
  const pageInView = () => {
    const mid = innerHeight / 2;
    let best = 0, bd = 1e9;
    view.wraps.forEach((o, i) => { const r = o.w.getBoundingClientRect(); const dd = Math.abs((r.top + r.bottom) / 2 - mid); if (dd < bd) { bd = dd; best = i; } });
    return best;
  };
  app.querySelector("#addsig").onclick = async () => {
    const s = await ensureSig(); if (!s) return;
    addMark(pageInView(), s, 0.5, 0.75, 0.3);
    ui.toast("Signature added — drag it to its place, ◢ to resize");
  };
  // 📝 any text (name, title, "Approved", …) in black or blue
  app.querySelector("#addtext").onclick = async () => {
    const r = await textDialog(ui);
    if (!r) return;
    const c = textPicture(r.text, { px: 90, color: r.color, bold: r.bold });
    addMark(pageInView(), c.toDataURL("image/png"), 0.5, 0.5, Math.min(0.8, 0.04 + r.text.length * 0.022));
    ui.toast("Text added — drag it to its place, ◢ to resize");
  };
  // 📅 today's date
  app.querySelector("#adddate").onclick = () => {
    const d = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    const c = textPicture(d, { px: 90, color: "#111827", bold: false });
    addMark(pageInView(), c.toDataURL("image/png"), 0.5, 0.5, 0.25);
    ui.toast("Date added — drag it where it belongs");
  };

  app.querySelector("#make").onclick = async () => {
    const btn = app.querySelector("#make"); btn.disabled = true; btn.textContent = "Making PDF…";
    try {
      const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const cache = new Map();
      for (const mk of marks) {
        if (!cache.has(mk.src)) cache.set(mk.src, await doc.embedPng(mk.src));
        const im = cache.get(mk.src);
        const page = doc.getPage(mk.page), pj = view.wraps[mk.page];
        const vp = pj.page.getViewport({ scale: 1 });
        const rot = ((pj.page.rotate || 0) % 360 + 360) % 360;
        // corner of the mark at its bottom-left on screen -> PDF point (handles rotated pages and offsets)
        const [ax, ay] = vp.convertToPdfPoint(mk.fx * vp.width, (mk.fy + mk.fh) * vp.height);
        page.drawImage(im, { x: ax, y: ay, width: mk.fw * vp.width, height: mk.fh * vp.height, rotate: PDFLib.degrees(rot) });
      }
      const out = await doc.save();
      await ui.deliver({ name }, `${name} (signed).pdf`, new Blob([out], { type: "application/pdf" }), "Signed");
    } catch (e) { console.error(e); ui.toast("Could not sign: " + (e.message || e), 6000); }
    btn.disabled = false; btn.textContent = "✓ Make signed PDF";
  };
  return () => { view.stop(); pdf.destroy(); };
}

// ================================================================ 💧 WATERMARK
const WM_OPACITY = 0.10;
export async function viewWatermark(ui) {
  const { app } = ui;
  let src = null, pdfDoc = null, prevUrl = null;
  app.innerHTML = `
    <header class="bar"><a class="icon" href="#/" aria-label="Back">‹</a><div class="title">💧 Watermark PDF</div></header>
    <main class="tool wm">
      <button class="btn big" id="open">📂 Choose a PDF</button>
      <p class="muted small" id="srcname"></p>
      <label class="wm-label">Watermark text</label>
      <input class="input" id="text" maxlength="80" placeholder="e.g. CONFIDENTIAL or your name">
      <div class="row wm-opts">
        <div class="seg light" id="dir"><button data-v="diag" class="active">⟋ Diagonal</button><button data-v="flat">— Straight</button></div>
        <span class="muted small">Middle of every page · ${Math.round(WM_OPACITY * 100)}% opacity</span>
      </div>
      <button class="btn primary big" id="make" disabled>💧 Make watermarked PDF</button>
      <p class="muted small" id="pnote">Choose a PDF to see a preview</p>
      <div class="wm-pages" id="wmpages"></div>
    </main>`;
  const $ = (q) => app.querySelector(q);
  let dir = "diag";
  $("#dir").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; dir = b.dataset.v; app.querySelectorAll("#dir button").forEach((x) => x.classList.toggle("active", x === b)); preview(); };
  const ready = () => { $("#make").disabled = !(src && $("#text").value.trim()); };
  $("#text").oninput = () => { ready(); preview(); };

  // every page with the watermark on it, drawn as it scrolls into view
  let io = null, items = [];
  async function pageBase(i, width) {
    if (src.kind === "scan") {
      const b = await DB.getBlob("full:" + src.pages[i].id);
      return b ? await createImageBitmap(b, { resizeWidth: width }) : null;
    }
    const page = await pdfDoc.getPage(i + 1), vp = page.getViewport({ scale: 1 });
    const vp2 = page.getViewport({ scale: width / vp.width });
    const c = document.createElement("canvas"); c.width = Math.round(vp2.width); c.height = Math.round(vp2.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp2 }).promise;
    return c;
  }
  async function drawItem(it) {
    const my = (it.ver = (it.ver || 0) + 1);
    const base = await pageBase(it.i, 640).catch(() => null);
    if (!base || my !== it.ver) { base && base.close && base.close(); return; }
    const c = it.c; c.width = base.width; c.height = base.height;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(base, 0, 0);
    if (base.close) base.close();
    const text = $("#text").value.trim();
    if (text) stampCanvas(g, c.width, c.height, text, dir);
    it.drawn = true;
  }
  async function buildPreview() {
    if (io) io.disconnect();
    const holder = $("#wmpages"); holder.innerHTML = ""; items = [];
    if (!src) return;
    if (src.kind !== "scan" && !pdfDoc) { const { pdfjs } = await loadLibs(); pdfDoc = await pdfjs.getDocument({ data: src.bytes.slice() }).promise; }
    const n = src.kind === "scan" ? src.pages.length : pdfDoc.numPages;
    io = new IntersectionObserver((es) => es.forEach((e) => { const it = items[+e.target.dataset.i]; it.visible = e.isIntersecting; if (e.isIntersecting && !it.drawn) drawItem(it); }), { rootMargin: "500px 0px" });
    for (let i = 0; i < n; i++) {
      const w = document.createElement("div"); w.className = "wm-page"; w.dataset.i = i;
      w.innerHTML = `<canvas></canvas><span class="pgno">${i + 1} / ${n}</span>`;
      holder.appendChild(w);
      items.push({ i, w, c: w.querySelector("canvas") });
      io.observe(w);
    }
    $("#pnote").textContent = `Preview of all ${n} page${n > 1 ? "s" : ""} — scroll down`;
  }
  // text / direction changed: redraw the pages in view now, the others when they come into view
  let pvTimer = null;
  function preview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(() => items.forEach((it) => { it.drawn = false; if (it.visible) drawItem(it); }), 200);
  }
  $("#open").onclick = async () => {
    const s = await pickSource(ui, "Which PDF gets the watermark?");
    if (!s) return;
    src = s; if (pdfDoc) { pdfDoc.destroy(); pdfDoc = null; }
    $("#srcname").textContent = `📄 ${s.name}` + (s.kind === "scan" ? ` · ${s.pages.length} pages (your scan)` : "");
    $("#open").textContent = "📂 Choose another PDF";
    ready();
    try { await buildPreview(); } catch (e) { ui.toast("Could not open this PDF: " + (e.message || e), 6000); src = null; ready(); }
  };
  $("#make").onclick = async () => {
    const text = $("#text").value.trim();
    if (!src || !text) return;
    const pm = progressModal(ui, "Adding the watermark…");
    try {
      let blob;
      if (src.kind === "scan") {
        // your scan: each page picture gets the watermark, then a new PDF (works for big books too)
        const out = [];
        for (let i = 0; i < src.pages.length; i++) {
          const b = await DB.getBlob("full:" + src.pages[i].id);
          if (!b) continue;
          const bmp = await createImageBitmap(b);
          const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
          const g = c.getContext("2d"); g.drawImage(bmp, 0, 0); bmp.close();
          stampCanvas(g, c.width, c.height, text, dir);
          out.push(await new Promise((r) => c.toBlob(r, "image/jpeg", 0.88)));
          pm.set((i + 1) / src.pages.length, `${i + 1} / ${src.pages.length}`);
        }
        blob = await buildPdf(out, { title: src.name });
      } else {
        // any PDF: the pages stay exactly as they are, the watermark is laid on top
        const { PDFLib } = await loadLibs();
        const doc = await PDFLib.PDFDocument.load(src.bytes, { ignoreEncryption: true });
        const pic = await doc.embedPng(await canvasPng(textPicture(text, { px: 220, color: "#000" })));
        const pages = doc.getPages();
        pages.forEach((page, i) => {
          const { x: bx, y: by, width: W, height: H } = page.getCropBox();
          const rot = ((page.getRotation().angle || 0) % 360 + 360) % 360;
          // on-screen size of the page (a 90°/270° page is shown sideways)
          const sw = rot % 180 ? H : W, sh = rot % 180 ? W : H;
          const ang = dir === "diag" ? Math.atan2(sh, sw) : 0;           // along the diagonal, as seen
          const span = dir === "diag" ? Math.hypot(sw, sh) * 0.72 : sw * 0.8;
          const w = span, h = (span * pic.height) / pic.width;
          const t = ang + (rot * Math.PI) / 180;                            // the viewer turns the page by rot
          const cx = bx + W / 2, cy = by + H / 2;
          // rotate about the picture's corner: put its centre on the page centre
          const x = cx - (w / 2) * Math.cos(t) + (h / 2) * Math.sin(t);
          const y = cy - (w / 2) * Math.sin(t) - (h / 2) * Math.cos(t);
          page.drawImage(pic, { x, y, width: w, height: h, rotate: PDFLib.radians(t), opacity: WM_OPACITY });
          pm.set((i + 1) / pages.length, `${i + 1} / ${pages.length}`);
        });
        blob = new Blob([await doc.save()], { type: "application/pdf" });
      }
      pm.close();
      await ui.deliver({ name: src.name }, `${src.name} (watermark).pdf`, blob, "Watermarked");
    } catch (e) { pm.close(); console.error(e); ui.toast("Could not add the watermark: " + (e.message || e), 6000); }
  };
  return () => { if (io) io.disconnect(); if (pdfDoc) pdfDoc.destroy(); if (prevUrl) URL.revokeObjectURL(prevUrl); };
}

// watermark on a page picture: middle of the page, 10 % opacity
function stampCanvas(g, W, H, text, dir) {
  const pic = textPicture(text, { px: 220, color: "#000" });
  const ang = dir === "diag" ? -Math.atan2(H, W) : 0;
  const span = dir === "diag" ? Math.hypot(W, H) * 0.72 : W * 0.8;
  const w = span, h = (span * pic.height) / pic.width;
  g.save(); g.globalAlpha = WM_OPACITY; g.translate(W / 2, H / 2); g.rotate(ang);
  g.drawImage(pic, -w / 2, -h / 2, w, h); g.restore();
}
