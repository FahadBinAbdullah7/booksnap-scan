// BookSnap — app shell: library, book grid, scanner, page editor, crop, PDF export.
import * as DB from "./db.js";
import * as P from "./imgproc.js";
import { buildPdf } from "./pdf.js";
import { Camera, NativeCamera } from "./camera.js";
import * as R from "./remote.js";
import * as N from "./native.js";
import * as PN from "./pagenum.js";
import * as Dev from "./device.js";
import * as PS from "./pagesig.js";
import * as Upd from "./updater.js";
import { editLock, ptsFromGeo, defaultPts } from "./lockedit.js";

const app = document.getElementById("app");
const modalRoot = document.getElementById("modal-root");

// ---------------------------------------------------------------- settings (per device)
const settings = (() => {
  const def = { auto: false, delay: 2, rotate: 0, sound: true };
  try { return { ...def, ...JSON.parse(localStorage.getItem("booksnap.settings") || "{}") }; } catch { return def; }
})();
const saveSettings = () => { try { localStorage.setItem("booksnap.settings", JSON.stringify(settings)); } catch {} };

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? (b / 1e6).toFixed(0) + " MB" : Math.round(b / 1e3) + " KB");
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const go = (h) => { location.hash = h; };
const FILTER_NAMES = { magic: "Magic Color", original: "Original", gray: "Grayscale", bw: "B&W" };

const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
function on(type, fn) { const h = (e) => fn(e.detail); bus.addEventListener(type, h); return () => bus.removeEventListener(type, h); }

function toast(msg, ms = 2200) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 400);
}

function modal(html, cls = "") {
  const wrap = document.createElement("div");
  wrap.className = "modal-wrap";
  wrap.innerHTML = `<div class="modal ${cls}">${html}</div>`;
  modalRoot.appendChild(wrap);
  return { el: wrap, close: () => wrap.remove() };
}

function ask(title, value = "", ok = "Save") {
  return new Promise((res) => {
    const m = modal(`<h3>${esc(title)}</h3><input class="input" id="v" value="${esc(value)}" maxlength="120">
      <div class="row end"><button class="btn" id="c">Cancel</button><button class="btn primary" id="o">${esc(ok)}</button></div>`);
    const inp = m.el.querySelector("#v");
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const done = (v) => { m.close(); res(v); };
    m.el.querySelector("#c").onclick = () => done(null);
    m.el.querySelector("#o").onclick = () => done(inp.value.trim() || null);
    inp.onkeydown = (e) => { if (e.key === "Enter") done(inp.value.trim() || null); };
  });
}

function confirmBox(text, ok = "Delete", danger = true) {
  return new Promise((res) => {
    const m = modal(`<p>${text}</p><div class="row end"><button class="btn" id="c">Cancel</button>
      <button class="btn ${danger ? "danger" : "primary"}" id="o">${esc(ok)}</button></div>`);
    m.el.querySelector("#c").onclick = () => { m.close(); res(false); };
    m.el.querySelector("#o").onclick = () => { m.close(); res(true); };
  });
}

function sheet(title, options) {
  return new Promise((res) => {
    const m = modal(`<h3>${esc(title)}</h3><div class="sheet">${options.map((o, i) =>
      `<button class="sheet-btn ${o.danger ? "danger" : ""} ${o.active ? "active" : ""}" data-i="${i}">${o.label}</button>`).join("")}
      <button class="sheet-btn cancel" data-i="-1">Cancel</button></div>`, "bottom");
    m.el.onclick = (e) => {
      const b = e.target.closest("[data-i]");
      if (!b && e.target !== m.el) return;
      m.close();
      const i = b ? +b.dataset.i : -1;
      res(i >= 0 ? options[i].value : null);
    };
  });
}

// ---------------------------------------------------------------- worker + processing queue
// The worker can crash (out of memory on a low-end phone) or hang. Every job has a
// time limit; on a crash/timeout the worker is restarted and the page is retried
// at a lower resolution, so one bad photo never blocks the rest of the book.
let worker = null, seq = 0;
const calls = new Map();
function startWorker() {
  try { worker && worker.terminate(); } catch {}
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const c = calls.get(id);
    if (!c) return;
    calls.delete(id); clearTimeout(c.timer);
    ok ? c.res(result) : c.rej(new Error(error));
  };
  worker.onerror = (e) => {
    console.error("worker crashed", e);
    for (const [id, c] of calls) { clearTimeout(c.timer); c.rej(new Error("processing crashed")); calls.delete(id); }
    startWorker();
  };
}
startWorker();
const rpc = (msg, timeoutMs = 150000) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    if (!calls.has(id)) return;
    calls.delete(id);
    rej(new Error("processing took too long"));
    startWorker();                                   // a hung worker is replaced
  }, timeoutMs);
  calls.set(id, { res, rej, timer });
  worker.postMessage({ id, ...msg });
});
let devProfile = { maxPixels: 16e6, maxSide: 3400 };
Dev.profile().then((p) => { devProfile = p; }).catch(() => {});

let qRunning = false;
async function kickQueue() {
  if (qRunning) return;
  qRunning = true;
  emit("queue", { running: true });
  try {
    for (;;) {
      const first = await DB.nextPending();
      if (!first) break;
      const cap = await DB.get("captures", first.captureId);
      const sibs = (await DB.pagesOfCapture(first.captureId)).filter((p) => p.status === "pending");
      if (!cap || !cap.blob) {
        for (const s of sibs) { const np = { ...s, status: "error", error: "original photo missing" }; await DB.putPage(np); emit("page", np); }
        continue;
      }
      let out = null, lastErr = null;
      // try at the normal size; if that fails (memory), once more at half the pixels
      for (const scale of [1, 0.5]) {
        try {
          out = await rpc({
            type: "process", key: cap.id + ":" + scale, blob: cap.blob, rotate: cap.rotate || 0, mode: cap.mode, lock: cap.lock || null,
            maxPixels: Math.round(devProfile.maxPixels * scale), maxSide: Math.round(devProfile.maxSide * (scale < 1 ? 0.8 : 1)),
            sides: sibs.map((s) => ({ side: s.side, filter: s.filter, crop: s.crop || null, rot: s.rot || 0 })),
          });
          break;
        } catch (err) { lastErr = err; console.warn("page processing failed", scale, err); }
      }
      try {
        if (!out) throw lastErr || new Error("processing failed");
        if (out.original) await DB.put("captures", { ...cap, blob: out.original });
        for (let i = 0; i < sibs.length; i++) {
          const r = out.pages[i];
          const np = await DB.finishPage(sibs[i].id, sibs[i].rev, r.full, r.thumb, {
            w: r.w, h: r.h, autoQuad: r.autoQuad, found: out.found,
            sharp: r.sharp ? r.sharp.score : null, blurry: !!(r.sharp && r.sharp.blurry), skew: r.skew,
          });
          if (np) emit("page", np);
        }
      } catch (err) {
        console.error(err);
        for (const s of sibs) {
          const np = { ...s, status: "error", error: String((err && err.message) || err) };
          await DB.putPage(np);
          emit("page", np);
        }
      }
      emit("queue", { running: true });
    }
  } catch (e) {
    console.error("queue stopped", e);
  } finally {
    qRunning = false;
    rpc({ type: "release" }, 10000).catch(() => {});
    emit("queue", { running: false });
  }
}

// ---------------------------------------------------------------- router
let cleanup = null;
async function route() {
  try { cleanup?.(); } catch {}
  cleanup = null;
  modalRoot.innerHTML = "";
  const [, a, id, extra] = (location.hash.slice(1) || "/").split("/");
  window.scrollTo(0, 0);
  if (a === "book" && id) return viewBook(id);
  if (a === "scan" && id) return viewScan(id, extra ? decodeURIComponent(extra) : null);
  if (a === "link" && id) return viewLink(id);
  if (a === "page" && id) return viewPage(id);
  return viewLibrary();
}
window.addEventListener("hashchange", route);

// ================================================================ LIBRARY
async function viewLibrary() {
  const books = await DB.listBooks();
  const counts = await Promise.all(books.map((b) => DB.countPages(b.id)));
  const st = await DB.storageInfo();
  // two tabs: books (book scan) and regular scans
  const tab = settings.homeTab === "doc" ? "doc" : "book";
  const all = books.map((b, i) => ({ b, n: counts[i] }));
  const shown = all.filter(({ b }) => (b.kind === "doc") === (tab === "doc"));
  const nDoc = all.filter(({ b }) => b.kind === "doc").length, nBook = all.length - nDoc;
  app.innerHTML = `
    <header class="bar"><div class="brand"><span class="logo">📚</span> BookSnap</div><div style="flex:1"></div>
      <button class="icon" id="help" aria-label="How to use">?</button></header>
    <main class="lib">
      <div class="tabs" role="tablist">
        <button class="tab${tab === "book" ? " active" : ""}" data-tab="book" role="tab">📖 Book scan <span class="tabn">${nBook}</span></button>
        <button class="tab${tab === "doc" ? " active" : ""}" data-tab="doc" role="tab">📄 Regular scan <span class="tabn">${nDoc}</span></button>
      </div>
      ${tab === "book"
        ? `<button class="btn primary big" id="new">＋ New book</button>`
        : `<button class="btn primary big" id="newdoc">＋ New scan</button>
           <p class="muted small newhint">Plain photos, no page detection — crop, rotate and filter each page afterwards.</p>`}
      ${shown.length ? `<div class="books">${shown.map(({ b, n }) => `
        <a class="book" href="#/book/${b.id}">
          <div class="cover" data-cover="${b.id}"></div>
          <div class="info"><div class="name">${esc(b.name)}</div>
          <div class="meta">${n} pages · ${fmtDate(b.updated)}</div></div>
          <span class="chev">›</span>
        </a>`).join("")}</div>`
      : tab === "book"
        ? `<div class="empty"><div class="big-emoji">📖</div><p>No books yet.</p><p class="muted">Tap <b>New book</b>, put your book under the phone and start scanning.</p></div>`
        : `<div class="empty"><div class="big-emoji">📄</div><p>No regular scans yet.</p><p class="muted">Tap <b>New scan</b> to photograph documents, receipts or single sheets.</p></div>`}
      <p class="storage">${st.quota ? `Stored on this device: ${fmtBytes(st.usage)} of ${fmtBytes(st.quota)} available` : ""}
      ${st.persisted ? " · protected ✓" : ""}</p>
      ${N.isAndroid() ? `<p class="storage"><span id="appver"></span> · <a href="#" id="chkupd">Check for updates</a></p>` : ""}
    </main>`;
  app.querySelectorAll(".tab").forEach((t) => (t.onclick = () => { settings.homeTab = t.dataset.tab; saveSettings(); viewLibrary(); }));
  if (app.querySelector("#new")) app.querySelector("#new").onclick = async () => {
    const name = await ask("Book name", "Book " + new Date().toLocaleDateString(), "Create");
    if (!name) return;
    DB.askPersist();
    const b = await DB.createBook(name);
    go("#/scan/" + b.id);
  };
  if (app.querySelector("#newdoc")) app.querySelector("#newdoc").onclick = async () => {
    const name = await ask("Scan name", "Scan " + new Date().toLocaleString(), "Create");
    if (!name) return;
    DB.askPersist();
    const b = await DB.createBook(name, "doc");
    go("#/scan/" + b.id);
  };
  app.querySelector("#help").onclick = showHelp;
  if (!settings.seenHelp) { settings.seenHelp = true; saveSettings(); showHelp(); }
  // Android app: offer new versions from GitHub
  if (N.isAndroid()) {
    const lib = app.querySelector("main.lib");
    Upd.installedVersion().then((v) => {
      const e = app.querySelector("#appver"); if (e && v) e.textContent = "BookSnap " + v;
      // first start after an update: say so
      let last = null; try { last = localStorage.getItem("booksnap.lastVersion"); localStorage.setItem("booksnap.lastVersion", v || ""); } catch {}
      if (v && last && last !== v) toast(`✓ Updated to BookSnap ${v}`, 4000);
    });
    Upd.banner(lib).catch(() => {});
    app.querySelector("#chkupd").onclick = (e) => { e.preventDefault(); toast("Checking…"); Upd.banner(lib, { force: true, toast }).catch(() => {}); };
  }
  const urls = [];
  for (const { b } of shown) {
    const ps = await DB.listPages(b.id);
    const first = ps.find((p) => p.status === "done");
    if (!first) continue;
    const blob = await DB.getBlob("thumb:" + first.id);
    const el = app.querySelector(`[data-cover="${b.id}"]`);
    if (blob && el) { const u = URL.createObjectURL(blob); urls.push(u); el.style.backgroundImage = `url(${u})`; }
  }
  cleanup = () => urls.forEach((u) => URL.revokeObjectURL(u));
}

function showHelp() {
  const m = modal(`<h3>How to scan a book</h3>
    <ol class="help">
      <li><b>Set up:</b> book on a dark cloth, phone above it (a stand is best). For <b>2 pages</b> per photo hold the phone <b>sideways</b>.</li>
      <li><b>New book → Scan.</b> Take a photo with the round button, a <b>volume button</b>, or a <b>Bluetooth shutter remote</b>. Left page = page 1, right page = page 2.</li>
      <li><b>From the computer (optional):</b> on the Mac double-click <b>Start BookSnap PC</b>, then in the scanner tap <b>💻 PC</b> and scan its QR code. Press <b>Space</b> on the computer to shoot; pages are saved on the computer too. Next time it reconnects by itself.</li>
      <li><b>Check:</b> pages marked <b>⚠ blurry</b> → tap <b>↶ Retake</b>. Tap a page to change filter, crop or rotate; use <b>☑</b> to edit many pages at once.</li>
      <li><b>Export:</b> <b>⬇ PDF</b> or <b>⋯ → Save page images</b>. Files go to <b>Documents/BookSnap</b> on the phone.</li>
    </ol>
    <div class="row end"><button class="btn primary" id="ok">Got it</button></div>`);
  m.el.querySelector("#ok").onclick = () => m.close();
}

// ================================================================ BOOK
async function viewBook(bookId) {
  kickQueue();                       // make sure nothing is left waiting
  let book = await DB.get("books", bookId);
  if (!book) return go("#/");
  let pages = await DB.listPages(bookId);
  let selecting = false;
  const selected = new Set();
  const urls = new Map();

  app.innerHTML = `
    <header class="bar">
      <a class="icon" href="#/" aria-label="Back">‹</a>
      <button class="title" id="title">${esc(book.name)}</button>
      <button class="icon" id="selbtn" aria-label="Select pages" title="Select pages">☑</button>
      <button class="icon" id="menu" aria-label="Menu">⋯</button>
    </header>
    <div class="sub" id="sub"></div>
    <div class="selhead hidden" id="selhead"><span id="selcount">0 selected</span>
      <button class="btn small" id="selall">All</button><button class="btn small" id="selrange">Range…</button></div>
    <main class="grid" id="grid"></main>
    <footer class="actions" id="actions">
      <button class="act" id="scan"><span>📷</span>Scan</button>
      <label class="act"><span>🖼</span>Import<input type="file" id="imp" accept="image/*" multiple hidden></label>
      <button class="act" id="pdf"><span>⬇</span>PDF</button>
    </footer>
    <footer class="actions sel hidden" id="selbar">
      <button class="act" id="bfilter"><span>🎨</span>Filter</button>
      <button class="act" id="brot"><span>⟳</span>Rotate</button>
      <button class="act" id="bcrop"><span>✂</span>Crop</button>
      <button class="act danger" id="seldel"><span>🗑</span>Delete</button>
      <button class="act" id="selcancel"><span>✓</span>Done</button>
    </footer>`;
  const grid = app.querySelector("#grid");

  const io = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) { loadThumb(e.target); io.unobserve(e.target); }
  }, { rootMargin: "600px" });

  async function loadThumb(cell) {
    const id = cell.dataset.id;
    const b = await DB.getBlob("thumb:" + id);
    if (!b) return;
    const u = URL.createObjectURL(b);
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    urls.set(id, u);
    cell.querySelector("img").src = u;
  }

  const cellHTML = (p, i) => `<a class="cell ${p.status}${selected.has(p.id) ? " selected" : ""}" data-id="${p.id}" href="#/page/${p.id}">
      <img alt="">${p.status === "pending" ? '<span class="spin"></span>' : ""}${p.status === "error" ? '<span class="err">!</span>' : ""}${p.blurry && p.status === "done" ? '<span class="blur-badge" title="Looks blurry">⚠ blurry</span>' : ""}
      <span class="num">${i + 1}</span><span class="tick">✓</span></a>`;

  function renderGrid() {
    grid.innerHTML = pages.length ? pages.map(cellHTML).join("")
      : `<div class="empty"><p>No pages yet.</p><p class="muted">Tap <b>Scan</b> to start.</p></div>`;
    grid.querySelectorAll(".cell").forEach((c) => io.observe(c));
    renderSub();
  }
  function renderSub() {
    const pend = pages.filter((p) => p.status === "pending").length;
    const err = pages.filter((p) => p.status === "error").length;
    const blur = pages.filter((p) => p.blurry && p.status === "done").length;
    app.querySelector("#sub").innerHTML = `${pages.length} pages · ${FILTER_NAMES[book.filter || "magic"]}` +
      (pend ? ` · <span class="proc">processing ${pend}…</span>` : "") + (err ? ` · <span class="bad">${err} failed</span>` : "") +
      (blur ? ` · <button class="linkbtn bad" id="showblur">⚠ ${blur} blurry</button>` : "");
    const sb = app.querySelector("#showblur");
    if (sb) sb.onclick = () => { if (!selecting) setSelecting(true); pages.forEach((p) => p.blurry && selected.add(p.id)); updateSel(); toast("Blurry pages selected — open one to check, or delete and rescan"); };
  }
  renderGrid();

  grid.onclick = (e) => {
    const cell = e.target.closest(".cell");
    if (!cell || !selecting) return;
    e.preventDefault();
    const id = cell.dataset.id;
    selected.has(id) ? selected.delete(id) : selected.add(id);
    cell.classList.toggle("selected");
    updateSel();
  };
  function updateSel() {
    app.querySelector("#selcount").textContent = `${selected.size} selected`;
    app.querySelector("#selall").textContent = selected.size && selected.size === pages.length ? "None" : "All";
    grid.querySelectorAll(".cell").forEach((c) => c.classList.toggle("selected", selected.has(c.dataset.id)));
  }
  const setSelecting = (v) => {
    selecting = v; selected.clear();
    grid.classList.toggle("selecting", v);
    app.querySelector("#actions").classList.toggle("hidden", v);
    app.querySelector("#selbar").classList.toggle("hidden", !v);
    app.querySelector("#selhead").classList.toggle("hidden", !v);
    updateSel();
  };
  const selIds = () => pages.filter((p) => selected.has(p.id)).map((p) => p.id);   // in page order
  const needSel = () => { if (!selected.size) { toast("Select some pages first"); return false; } return true; };
  const refresh = async () => { pages = await DB.listPages(bookId); renderGrid(); updateSel(); kickQueue(); };
  async function batchEdit(fn, label) {
    let ids = selIds();
    const keep = [];
    for (const id of ids) { const p = pages.find((x) => x.id === id); const cap = p && await DB.get("captures", p.captureId); if (cap && cap.blob) keep.push(id); }
    if (keep.length < ids.length) toast(`${ids.length - keep.length} page(s) skipped: original photo was removed to save space`, 4000);
    ids = keep;
    if (!ids.length) return;
    const m = modal(`<h3>${esc(label)}…</h3><div class="progress"><div id="bar"></div></div>`);
    for (let i = 0; i < ids.length; i++) {
      const p = pages.find((x) => x.id === ids[i]);
      await DB.editPage(ids[i], fn(p));
      if (i % 20 === 0) m.el.querySelector("#bar").style.width = (100 * (i + 1)) / ids.length + "%";
    }
    m.close();
    await refresh();
    toast(`${label}: ${ids.length} page(s) — processing`);
  }
  app.querySelector("#selbtn").onclick = () => setSelecting(!selecting);
  app.querySelector("#selcancel").onclick = () => setSelecting(false);
  app.querySelector("#selall").onclick = () => {
    if (selected.size === pages.length) selected.clear(); else pages.forEach((p) => selected.add(p.id));
    updateSel();
  };
  app.querySelector("#selrange").onclick = async () => {
    const r = await rangeBox(pages.length);
    if (!r) return;
    for (let i = r[0] - 1; i < r[1]; i++) selected.add(pages[i].id);
    updateSel();
  };
  app.querySelector("#bfilter").onclick = async () => {
    if (!needSel()) return;
    const f = await sheet(`Filter for ${selected.size} page(s)`, P.FILTERS.map((k) => ({ label: FILTER_NAMES[k], value: k })));
    if (f) await batchEdit(() => ({ filter: f }), "Filter " + FILTER_NAMES[f]);
  };
  app.querySelector("#brot").onclick = async () => {
    if (!needSel()) return;
    const d = await sheet(`Rotate ${selected.size} page(s)`, [
      { label: "⟳ 90° right", value: 90 }, { label: "⟲ 90° left", value: 270 }, { label: "↻ 180°", value: 180 },
    ]);
    if (d) await batchEdit((p) => ({ rot: ((p.rot || 0) + d) % 360 }), "Rotate");
  };
  app.querySelector("#bcrop").onclick = async () => {
    if (!needSel()) return;
    const v = await sheet(`Crop ${selected.size} page(s)`, [
      { label: "✂ One crop for ALL selected pages", value: "all" },
      { label: "✂ Adjust crop page by page", value: "each" },
      { label: "↺ Reset to automatic page detection", value: "auto" },
    ]);
    if (v === "auto") await batchEdit(() => ({ crop: null }), "Auto crop");
    if (v === "each") { await batchCrop(selIds(), pages); await refresh(); }
    if (v === "all") { await batchCropAll(selIds(), pages); await refresh(); }
  };
  app.querySelector("#seldel").onclick = async () => {
    if (!needSel()) return;
    if (!(await confirmBox(`Delete ${selected.size} page(s)? This can't be undone.`))) return;
    await DB.deletePages([...selected]);
    pages = await DB.listPages(bookId);
    setSelecting(false);
    renderGrid();
  };

  const rename = async () => {
    const n = await ask("Rename book", book.name);
    if (!n) return;
    book = { ...book, name: n };
    await DB.saveBook(book);
    app.querySelector("#title").textContent = n;
  };
  app.querySelector("#title").onclick = rename;
  app.querySelector("#menu").onclick = async () => {
    const v = await sheet(book.name, [
      { label: "💻 Connect to PC (scan its QR code)", value: "pc" },
      { label: "✓ Select pages", value: "select" },
      { label: "🎨 Filter for all pages", value: "filter" },
      { label: "🖼 Save page images (0001.jpg …)", value: "images" },
      { label: "↻ Retry failed pages", value: "retry" },
      { label: "🧹 Free up space (remove original photos)", value: "free" },
      { label: "✏️ Rename", value: "rename" },
      { label: "🗑 Delete book", value: "delete", danger: true },
    ]);
    if (v === "select") setSelecting(true);
    if (v === "pc") go(`#/scan/${bookId}/qr`);
    if (v === "images") exportImages(book);
    if (v === "retry") {
      const failed = pages.filter((p) => p.status === "error");
      if (!failed.length) return toast("No failed pages 👍");
      for (const p of failed) await DB.editPage(p.id, {});
      pages = await DB.listPages(bookId); renderGrid(); kickQueue();
      toast(`Retrying ${failed.length} page(s)…`);
    }
    if (v === "free") {
      const st = await DB.originalsInfo(bookId);
      if (!st.count) return toast("No original photos to remove");
      const ok = await confirmBox(`Remove ${st.count} original photo(s) and free about <b>${fmtBytes(st.bytes)}</b>?<br><br>Your finished pages stay. You won't be able to re-crop or change the filter of those pages any more. Export a PDF first if unsure.`, "Free up space", true);
      if (!ok) return;
      const freed = await DB.dropOriginals(bookId);
      toast(`Freed ${fmtBytes(freed)}`);
    }
    if (v === "rename") rename();
    if (v === "filter") {
      const f = await sheet("Filter for all pages", P.FILTERS.map((k) => ({ label: FILTER_NAMES[k], value: k, active: k === book.filter })));
      if (!f) return;
      book = { ...book, filter: f };
      await DB.saveBook(book);
      for (const p of pages) if (p.filter !== f) await DB.editPage(p.id, { filter: f });
      pages = await DB.listPages(bookId);
      renderGrid();
      kickQueue();
    }
    if (v === "delete") {
      if (!(await confirmBox(`Delete “${esc(book.name)}” and all ${pages.length} pages? This can't be undone.`))) return;
      await DB.deleteBook(bookId);
      go("#/");
    }
  };

  app.querySelector("#scan").onclick = () => go("#/scan/" + bookId);
  app.querySelector("#imp").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    const mode = await sheet("Each photo shows…", [
      { label: "📖 Two pages (split left / right)", value: "spread", active: book.mode === "spread" },
      { label: "📄 One page", value: "single", active: book.mode === "single" },
    ]);
    if (!mode) return;
    DB.askPersist();
    for (const f of files) await DB.addCapture(bookId, f, { mode, filter: book.filter || "magic" });
    pages = await DB.listPages(bookId);
    renderGrid();
    kickQueue();
    toast(`${files.length} photo(s) added`);
  };
  app.querySelector("#pdf").onclick = () => exportPdf(book);

  const off1 = on("page", (p) => {
    if (p.bookId !== bookId) return;
    const i = pages.findIndex((x) => x.id === p.id);
    if (i < 0) return;
    pages[i] = p;
    const cell = grid.querySelector(`[data-id="${p.id}"]`);
    if (cell) {
      const t = document.createElement("template");
      t.innerHTML = cellHTML(p, i).trim();
      const nc = t.content.firstChild;
      cell.replaceWith(nc);
      loadThumb(nc);
    }
    renderSub();
  });
  cleanup = () => { off1(); io.disconnect(); urls.forEach((u) => URL.revokeObjectURL(u)); };
}

// ---------------------------------------------------------------- PDF export
async function exportPdf(book) {
  const pages = await DB.listPages(book.id);
  const done = pages.filter((p) => p.status === "done");
  if (!done.length) return toast("No finished pages yet");
  if (done.length < pages.length) {
    const ok = await confirmBox(`${pages.length - done.length} page(s) are still processing or failed. Export the ${done.length} ready pages now?`, "Export", false);
    if (!ok) return;
  }
  const n = done.length, PART = 300;
  const choice = await sheet(`PDF · ${n} pages`, [
    { label: `📄 Whole book — one PDF`, value: "whole" },
    ...(n > PART ? [{ label: `📚 In parts of ${PART} pages (${Math.ceil(n / PART)} PDFs)`, value: "parts" }] : []),
    { label: "📉 Smaller file for sharing (WhatsApp, email)", value: "small" },
  ]);
  if (!choice) return;
  const small = choice === "small";
  const groups = [];
  if (choice === "parts") for (let i = 0; i < n; i += PART) groups.push(done.slice(i, i + PART));
  else groups.push(done);

  const base = N.safeName(book.name);
  const m = modal(`<h3 id="ph">Making PDF…</h3><div class="progress"><div id="bar"></div></div><p class="muted" id="ptxt"></p>
    <p class="muted small">Keep the app open. Large books can take a few minutes.</p>`);
  const setP = (title, f, text) => { m.el.querySelector("#ph").textContent = title; m.el.querySelector("#bar").style.width = 100 * f + "%"; m.el.querySelector("#ptxt").textContent = text; };
  const results = [];
  try {
    let pageNo = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi], first = pageNo + 1, last = pageNo + g.length;
      pageNo = last;
      const partTxt = groups.length > 1 ? ` (part ${gi + 1} of ${groups.length})` : "";
      const blobs = [];
      for (let i = 0; i < g.length; i++) {
        let b = await DB.getBlob("full:" + g[i].id);
        if (!b) continue;
        if (small) b = await rpc({ type: "shrink", blob: b, maxSide: 1700, quality: 0.72 }, 60000).catch(() => b);
        blobs.push(b);
        if (i % 10 === 0) setP(`Preparing pages${partTxt}…`, (i + 1) / g.length, `${i + 1} / ${g.length}`);
      }
      const pdf = await buildPdf(blobs, { title: book.name, onProgress: (i, k) => setP(`Making PDF${partTxt}…`, i / k, `${i} / ${k}`) });
      const name = base + (groups.length > 1 ? ` - pages ${first}-${last}` : "") + (small ? " (small)" : "") + ".pdf";
      if (N.isNative()) {
        const path = `BookSnap/${base}/${name}`;
        const uri = await N.saveBlob(path, pdf, (f) => setP(`Saving to phone${partTxt}…`, f, Math.round(100 * f) + "%"));
        results.push({ name, size: pdf.size, pages: blobs.length, uri, path });
      } else {
        results.push({ name, size: pdf.size, pages: blobs.length, url: URL.createObjectURL(pdf), file: new File([pdf], name, { type: "application/pdf" }) });
      }
    }
  } catch (e) {
    m.close();
    console.error(e);
    return toast("PDF failed: " + e.message, 6000);
  }
  m.close();
  const list = results.map((r) => `<li>${esc(r.name)} <span class="muted">· ${r.pages} pages · ${fmtBytes(r.size)}</span>${r.url ? ` <a href="${r.url}" download="${esc(r.name)}">⬇ Save</a>` : ""}</li>`).join("");
  const r = modal(`<h3>PDF ready ✓</h3><ul class="pdf-list">${list}</ul>
    ${N.isAndroid() ? `<p class="muted small">Saved in <b>Documents/BookSnap/${esc(base)}/</b> — open the Files app → Documents → BookSnap.</p>` : N.isIOS() ? `<p class="muted small">Saved in the <b>Files</b> app → <b>On My iPhone → BookSnap → BookSnap/${esc(base)}</b>.</p>` : ""}
    <div class="col">${N.isNative() || (navigator.canShare && navigator.canShare({ files: [results[0].file] })) ? '<button class="btn primary" id="sh">↗ Share / Save to Drive</button>' : ""}
    <button class="btn" id="cl">Close</button></div>`);
  r.el.querySelector("#cl").onclick = () => { r.close(); results.forEach((x) => x.url && setTimeout(() => URL.revokeObjectURL(x.url), 60000)); };
  const sh = r.el.querySelector("#sh");
  if (sh) sh.onclick = async () => {
    try {
      if (N.isNative()) await N.shareFiles(results.map((x) => x.uri), book.name);
      else await navigator.share({ files: results.map((x) => x.file), title: book.name });
    } catch (e) { if (!/cancel|abort/i.test(e.message || "")) toast("Share failed: " + e.message); }
  };
}

// ---------------------------------------------------------------- save page images (0001.jpg …)
async function exportImages(book) {
  const pages = (await DB.listPages(book.id)).filter((p) => p.status === "done");
  if (!pages.length) return toast("No finished pages yet");
  const folder = N.safeName(book.name);
  let write;
  if (N.isNative()) {
    write = (name, blob) => N.saveBlob(`BookSnap/${folder}/pages/${name}`, blob);
  } else if (window.showDirectoryPicker) {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: "booksnap-pages", mode: "readwrite" }); } catch { return; }
    dir = await dir.getDirectoryHandle(folder, { create: true });
    write = async (name, blob) => { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close(); };
  } else {
    return toast("Saving separate images needs the BookSnap Android app (or Chrome/Edge on a computer). Use PDF instead.", 5000);
  }
  const m = modal(`<h3>Saving ${pages.length} images…</h3><div class="progress"><div id="bar"></div></div><p class="muted" id="ptxt"></p>`);
  try {
    for (let i = 0; i < pages.length; i++) {
      const b = await DB.getBlob("full:" + pages[i].id);
      if (b) await write(String(i + 1).padStart(4, "0") + ".jpg", b);
      m.el.querySelector("#bar").style.width = (100 * (i + 1)) / pages.length + "%";
      m.el.querySelector("#ptxt").textContent = `${i + 1} / ${pages.length}`;
    }
    m.close();
    toast(N.isNative() ? `Saved in Documents/BookSnap/${folder}/pages` : "Images saved", 5000);
  } catch (e) { m.close(); toast("Saving failed: " + e.message, 5000); }
}

// ================================================================ SCANNER
let audioCtx = null;
function beep() {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
    o.frequency.value = 1320;
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.16);
  } catch {}
}

function grayOf(f) {
  const n = f.w * f.h, g = new Uint8Array(n), d = f.d;
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}
// Did the page change? Compare 8x8-block brightness at 320 px (brightness-normalised),
// sensitive enough to tell two pages of the same book apart.
function blockSig(f) {
  if (!f) return null;
  const g = grayOf(f), w = f.w, bs = 8, bw = Math.floor(f.w / bs), bh = Math.floor(f.h / bs), m = new Float32Array(bw * bh);
  let tot = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let s = 0;
    for (let y = by * bs; y < by * bs + bs; y++) for (let x = bx * bs; x < bx * bs + bs; x++) s += g[y * w + x];
    m[by * bw + bx] = s / (bs * bs); tot += m[by * bw + bx];
  }
  const mean = tot / m.length;
  for (let i = 0; i < m.length; i++) m[i] -= mean;
  return m;
}
function pageChanged(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  let c = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 6) c++;
  return c / a.length > 0.02;
}

// average brightness change between two small frames (0-255)
function meanDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function diffFrac(a, b, thr = 20) {
  if (!a || !b || a.length !== b.length) return 1;
  let c = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > thr) c++;
  return c / a.length;
}

async function viewScan(bookId, pcCode = null) {
  let book = await DB.get("books", bookId);
  if (!book) return go("#/");
  const isDoc = book.kind === "doc";                       // regular scan: plain camera, no detection
  let mode = isDoc ? "single" : book.mode || "spread";
  let count = await DB.countPages(bookId);

  app.innerHTML = `
    <div class="scan">
      <div class="stage"><video class="cam" playsinline muted></video><canvas class="overlay"></canvas><div class="flash"></div></div>
      <div class="scan-top">
        <button class="chip" id="close" aria-label="Close">✕</button>
        <button class="chip" id="pc">💻 PC</button>
        <button class="chip" id="lockbtn">🔓 Lock area</button>
        <button class="chip" id="delay"></button>
        <button class="chip" id="rot" title="Fix sideways photos"></button>
        <button class="chip hidden" id="torch">🔦</button>
        <button class="chip hidden" id="undo">↶ Retake</button>
      </div>
      <div class="scan-opts">
        <div class="seg" id="segMode"><button data-v="single">📄 1 page</button><button data-v="spread">📖 2 pages</button></div>
        <div class="seg" id="segOrient"><button data-v="portrait">▯ Portrait</button><button data-v="landscape">▭ Landscape</button></div>
        <div class="seg" id="segAuto"><button data-v="manual">✋ Manual</button><button data-v="auto" id="auto">🤖 Auto</button></div>
      </div>
      <div class="scan-status"><div class="ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="bg"/><circle cx="18" cy="18" r="15" class="fg" id="ringfg"/></svg></div><span id="status">Starting camera…</span></div>
      <div class="scan-bottom">
        <button class="last" id="last"><img id="lastimg" alt=""><span id="count">${count}</span></button>
        <button class="shutter" id="shutter" aria-label="Take photo"><span></span></button>
        <button class="chip done" id="done">Done</button>
      </div>
    </div>`;
  document.body.classList.add("dark");
  const $ = (s) => app.querySelector(s);
  const video = $(".cam"), overlay = $(".overlay"), statusEl = $("#status"), ringFg = $("#ringfg");
  if (isDoc) {
    for (const sel of ["#lockbtn", "#delay", "#pc", ".scan-opts"]) $(sel)?.classList.add("hidden");
    $(".scan").classList.add("docscan");
  }
  const cam = N.isAndroid() ? new NativeCamera() : new Camera(video);
  const prof = await Dev.profile().catch(() => ({}));
  cam.profile = prof;
  if (cam.native) video.classList.add("hidden");

  // tap the picture to focus there (real camera)
  $(".stage").addEventListener("click", (e) => {
    if (!cam.focus) return;
    const r = $(".stage").getBoundingClientRect();
    cam.focus((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    const ring = document.createElement("div");
    ring.className = "focus-ring"; ring.style.left = e.clientX - r.left + "px"; ring.style.top = e.clientY - r.top + "px";
    $(".stage").appendChild(ring);
    setTimeout(() => ring.remove(), 900);
  });

  const MOVE = 0.03, STILL = 0.015;
  let running = true, busy = false, wake = null;
  let state = "idle", stillSince = 0, prevG = null, lastShotSig = null, lastStatus = "";
  let lastMotion = 0, lastDetect = 0, geo = null, savedAt = 0, lastFrameId = -1;
  let link = null, pcOriginals = false, pcCodeLast = null, userUnlinked = false, reconnecting = false;
  const shots = [];               // captures taken in this session (for retake)
  const remote = () => !!(link && link.open);
  const autoOn = () => !!settings.auto && !isDoc;
  // Portrait / Landscape (per book). Landscape is the natural choice for 2 pages per photo.
  let orient = book.orient || "portrait";
  // locked page area (set once, reused for every photo until unlocked)
  // regular scan: the whole photo, every time (a fixed full-frame area, marked "plain")
  const FULL = { mode: "single", pts: [[0, 0], [1, 0], [1, 1], [0, 1]], plain: true };
  let lock = isDoc ? FULL : book.lock && book.lock.mode === mode ? book.lock : null;
  // web version: a sideways video in landscape mode is turned upright here; the app turns the screen instead
  const effRotate = () => ((cam.native ? 0 : orient === "landscape" && cam.size.h > cam.size.w ? 90 : 0) + settings.rotate) % 360;
  // auto mode: page-number check
  let lastNum = book.lastPageNo ?? null;   // last printed page number seen
  let numGuess = null;                     // a printed number not yet confirmed by the next photo
  let paused = false, checking = false;
  let turnSeen = false;           // Auto: a page turn was seen since the last saved page
  const noiseHist = [];
  // Duplicate guard in Auto: every page saved in this session is remembered.
  //  - fp: detailed page fingerprint (tile-aligned, survives a moved book / other light / a thumb)
  //        kept for the last FP_KEEP photos (≈130 KB each)
  //  - sig: tiny block picture kept for all photos (older ones are checked with it)
  const seenPages = [], FP_KEEP = 60;
  let turnFrames = 0;             // consecutive frames with movement (a real page turn lasts several)

  // the status line + countdown ring are mirrored on the PC's live view when it is connected
  let ringVal = 0, mirrorTimer = null, mirrorSent = { text: null, ring: -1 }, mirrorAt = 0;
  const mirror = () => {
    if (!remote() || mirrorTimer) return;
    const go = () => {
      mirrorTimer = null;
      if (!remote()) return;
      const ring = Math.round(ringVal * 20) / 20;
      if (lastStatus === mirrorSent.text && ring === mirrorSent.ring) return;
      mirrorSent = { text: lastStatus, ring }; mirrorAt = performance.now();
      link.send({ t: "status", text: lastStatus, ring });
    };
    const wait = 200 - (performance.now() - mirrorAt);
    if (wait <= 0) go(); else mirrorTimer = setTimeout(go, wait);
  };
  const setStatus = (s) => { if (s !== lastStatus) { statusEl.textContent = s; lastStatus = s; mirror(); } };
  // a message that stays visible for `ms` before the normal status returns
  const note = (msg, ms = 3000) => { setStatus(msg); savedAt = performance.now() + ms - 2500; };
  const setRing = (f) => {
    f = Math.max(0, Math.min(1, f));
    if (f === ringVal) return;
    ringVal = f; ringFg.style.strokeDashoffset = String(94.25 * (1 - f)); mirror();
  };
  const seg = (id, v) => app.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  const labels = () => {
    seg("segMode", mode);
    $("#lockbtn").textContent = lock ? "🔒 Locked" : "🔓 Lock area";
    $("#lockbtn").classList.toggle("on", !!lock);
    seg("segOrient", orient);
    seg("segAuto", settings.auto ? "auto" : "manual");
    $("#auto").textContent = settings.auto && paused ? "⏸ Paused – tap" : "🤖 Auto";
    $("#auto").classList.toggle("warn", settings.auto && paused);

    $("#delay").classList.toggle("hidden", isDoc || remote() || !settings.auto);
    $("#delay").textContent = `⏱ ${settings.delay}s`;
    $("#rot").textContent = `⟳ ${settings.rotate}°`;
    $("#rot").classList.toggle("hidden", !settings.rotate && cam.native);
    $("#pc").textContent = remote() ? "💻 Connected" : "💻 PC";
    $("#pc").classList.toggle("on", remote());
  };
  labels();
  state = autoOn() ? "watch" : "idle";

  const sendState = () => {
    if (!link) return;
    mirrorSent = { text: null, ring: -1 }; mirror();      // (re)send the status line too
    return link.send({
      t: "state", book: book.name, mode, rotate: effRotate(), filter: book.filter || "magic", count, torch: cam.canTorch,
      orient, auto: !!settings.auto, lock: lock ? { pts: lock.pts } : null,
    });
  };
  // the page outline the phone is using, for the PC's live view (max ~2.5 per second)
  let lastGeoSent = 0;
  const sendGeo = () => {
    if (!remote() || !geo) return;
    const now = performance.now();
    if (now - lastGeoSent < 400) return;
    lastGeoSent = now;
    link.send({ t: "geo", geo: { found: geo.found, locked: !!geo.locked, mode: geo.mode, gutter: geo.gutter,
      pages: geo.pages.map((p) => (p.quad ? { quad: p.quad } : { x0: p.x0, x1: p.x1, top: p.top, bot: p.bot })) } });
  };

  const unlockAudio = () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {} };
  app.querySelector(".scan").addEventListener("pointerdown", unlockAudio, { once: true });

  $("#close").onclick = () => go("#/book/" + bookId);
  $("#done").onclick = () => go("#/book/" + bookId);
  $("#last").onclick = () => go("#/book/" + bookId);
  const setMode = async (m) => {
    mode = m;
    book = { ...book, mode };
    labels();                      // update the switch instantly, save in the background
    await DB.saveBook(book);
    sendState();
  };
  const setOrient = async (o) => {
    orient = o;
    book = { ...book, orient };
    labels();
    cam.setOrientation && cam.setOrientation(orient);
    await DB.saveBook(book);
    sendState();
  };
  $("#segMode").onclick = async (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v || v === mode) return;
    await setMode(v);
    lock = book.lock && book.lock.mode === mode ? book.lock : null;
    labels();
    toast(mode === "spread" ? "2 pages per photo (left page first, then right)" : "1 page per photo");
  };
  $("#segOrient").onclick = (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v || v === orient) return;
    setOrient(v);
    toast(v === "landscape" ? "Landscape: hold the phone sideways over the open book" : "Portrait");
  };
  $("#segAuto").onclick = (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v) return;
    if (v === "auto" && settings.auto && paused) { paused = false; labels(); state = "watch"; note("▶ Auto continues — turn the page", 2500); return; }
    if ((v === "auto") === !!settings.auto) return;
    settings.auto = v === "auto"; saveSettings(); paused = false; labels(); sendState();
    state = autoOn() ? "watch" : "idle"; stillSince = 0;
    if (settings.auto) {
      note(`🤖 Auto: turn the page, it shoots ${settings.delay}s after each page turn — pages already saved are skipped`, 4000);
      PN.init().catch(() => {});          // load the page-number reader in the background
    }
  };
  $("#delay").onclick = () => {
    const opts = [1, 1.5, 2, 3, 4];
    settings.delay = opts[(opts.indexOf(settings.delay) + 1) % opts.length]; saveSettings(); labels();
  };
  const rotateNext = () => { settings.rotate = (settings.rotate + 90) % 360; saveSettings(); labels(); sendState(); };
  $("#rot").onclick = () => { rotateNext(); toast("Photos will be rotated " + settings.rotate + "°"); };
  let torchOn = false;
  const setTorch = async (v) => { torchOn = v; await cam.torch(torchOn); $("#torch").classList.toggle("on", torchOn); };
  $("#torch").onclick = () => setTorch(!torchOn);
  $("#shutter").onclick = () => shoot();
  $("#pc").onclick = () => (remote() ? disconnectPc(true) : scanQR());
  $("#undo").onclick = () => undoLast();
  $("#lockbtn").onclick = async () => {
    let fresh = false;
    if (lock) {
      const v = await sheet("Locked page area", [
        { label: "✏️ Adjust the locked area (zoom in for exact corners)", value: "edit" },
        { label: "🎯 New area — find the page again and lock it", value: "new" },
        { label: "🔓 Unlock (automatic detection)", value: "unlock" },
      ]);
      if (v === "unlock") { await setLock(null); note("🔓 Unlocked — pages are detected automatically", 3000); return; }
      if (v !== "edit" && v !== "new") return;
      fresh = v === "new";
    }
    const pts = await lockEditor(fresh);
    if (!pts) return;
    await setLock(pts);
    note("🔒 Area locked — every photo uses it until you unlock", 3500);
  };

  async function setLock(pts) {
    lock = pts ? { mode, pts } : null;
    book = await DB.saveBook({ ...book, lock });
    if (lock) geo = P.geoFromLock(lock);
    labels(); sendState(); drawOverlay();
  }

  // find the page once on the current picture (also while locked), as corner points
  // (uses the live-outline worker, which is already loaded, so it answers quickly)
  let onceWaiters = [];
  function detectOnce() {
    return new Promise((resolve) => {
      const f = cam.frame(280);
      if (!f) return resolve(null);
      const t = setTimeout(() => { onceWaiters = onceWaiters.filter((x) => x !== done); resolve(null); }, 10000);
      const done = (g) => { clearTimeout(t); resolve(ptsFromGeo(g, mode)); };
      onceWaiters.push(done);
      const d = new Uint8ClampedArray(f.d);
      detWorker.postMessage({ id: "once", w: f.w, h: f.h, d, rot: effRotate(), mode }, [d.buffer]);
    });
  }
  // a full-resolution photo (shrunk to ~2000 px) so the lock editor can zoom in sharply
  async function sharpPicture() {
    if (busy) return null;
    busy = true;
    try {
      const blob = await cam.takePhoto();
      const probe = await createImageBitmap(blob);
      const big = Math.max(probe.width, probe.height);
      if (big <= 2000) return probe;
      const opts = probe.width >= probe.height ? { resizeWidth: 2000 } : { resizeHeight: 2000 };
      probe.close();
      return await createImageBitmap(blob, { ...opts, resizeQuality: "high" });
    } catch { return null; } finally { busy = false; }
  }
  const livePicture = () => {
    const src = cam.native ? cam.lastFrame : video;
    const w = cam.native ? src?.width : src?.videoWidth;
    return w ? src : null;
  };

  // full-screen editor: drag / zoom / move the area on the camera picture
  let editing = null;          // "phone" | "pc" while someone is adjusting the lock area (Auto waits)
  async function lockEditor(fresh = false) {
    const src = livePicture();
    if (!src) { toast("Camera not ready yet"); return null; }
    editing = "phone";
    try {
      let pts = !fresh && lock ? lock.pts : (lock ? await detectOnce() : ptsFromGeo(geo, mode));
      return await editLock({
        src, rot: effRotate(), mode, pts: pts || defaultPts(mode),
        title: fresh ? "New area: adjust and lock" : undefined,
        note: "Every photo will use this area until you unlock it.",
        hiRes: sharpPicture,
        detect: detectOnce,
        refresh: async () => ({ src: livePicture() }),
      });
    } finally { editing = null; stillSince = 0; }
  }

  async function undoLast(fromAuto = false) {
    if ((busy && !fromAuto) || !shots.length) return;
    busy = true;
    const capId = shots.pop();
    try {
      const before = count;
      const r = await DB.undoCapture(capId);
      if (r) {
        const nums = r.orders.map((_, i) => before - r.orders.length + 1 + i);
        count -= r.orders.length;
        $("#count").textContent = count;
        lastShotSig = null;
        setStatus(nums.length > 1 ? `Deleted pages ${nums[0]}–${nums[1]} — shoot again` : `Deleted page ${nums[0]} — shoot again`);
        savedAt = performance.now();
        if (remote()) { await link.send({ t: "undone", orders: nums }); sendState(); }
      }
    } catch (e) { toast("Could not delete: " + e.message); }
    $("#undo").classList.toggle("hidden", !shots.length);
    busy = false;
  }

  async function getWake() {
    try { if ("wakeLock" in navigator && document.visibilityState === "visible") wake = await navigator.wakeLock.request("screen"); } catch {}
  }
  const onVis = () => { if (document.visibilityState === "visible") getWake(); };
  document.addEventListener("visibilitychange", onVis);

  // ---------------------------------------------------------- PC link
  async function connectPc(code, quiet = false) {
    const local = R.isLocalAddress(code);
    if (!local) {
      code = R.normCode(code);
      if (code.length < 4) return toast("Enter the address or code shown on the PC");
    }
    if (!quiet) userUnlinked = false;
    if (link) { const old = link; link = null; old.close(); }
    setStatus("Connecting to PC…");
    const l = local ? new R.LocalLink() : new R.PhoneLink();
    try {
      if (local) await l.connect(code); else await l.connect(code, cam.stream);
    } catch (e) {
      l.close();
      if (!quiet) { note("Could not connect: " + (e.message || e), 8000); toast(e.message || String(e), 5000); }
      return;
    }
    if (!local && !cam.stream) l.startFrames(() => cam.jpegFrame(640, 0.6));   // real camera: send pictures over the data channel
    if (local) {
      l.startFrames(() => cam.jpegFrame(640, 0.6));
      if (l.address && l.address !== code) code = l.address;     // PC was found at a new address
    }
    if (!running) return l.close();
    link = l;
    state = "idle";
    labels();
    sendState();
    note("Connected — capture from the PC", 3000);
    if (!quiet) toast("Connected to PC ✓"); else toast("Reconnected to PC ✓");
    l.addEventListener("msg", (e) => onPcMessage(e.detail));
    pcCodeLast = code; userUnlinked = false;
    if (settings.lastPc !== code) { settings.lastPc = code; saveSettings(); }
    l.addEventListener("close", () => {
      if (link !== l) return;
      link = null; labels(); state = autoOn() ? "watch" : "idle";
      if (!userUnlinked) reconnectLoop(); else setStatus("PC disconnected");
    });
  }
  async function reconnectLoop() {
    if (reconnecting) return;
    reconnecting = true;
    toast("PC connection lost — reconnecting…");
    const until = Date.now() + 5 * 60 * 1000;
    while (running && !remote() && !userUnlinked && Date.now() < until) {
      setStatus("Reconnecting to PC…");
      await connectPc(pcCodeLast, true);
      if (remote()) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    reconnecting = false;
    if (!remote() && running && !userUnlinked) note("PC not reachable — tap 💻 PC to connect again", 60000);
  }
  function disconnectPc(user) {
    if (user) userUnlinked = true;
    if (!link) return;
    const l = link; link = null; l.close();
    labels();
    state = autoOn() ? "watch" : "idle";
    if (user) setStatus("Disconnected from PC");
  }
  async function onPcMessage(m) {
    if (!m || typeof m !== "object") return;
    if (m.t === "capture") { if (busy) link.send({ t: "busy" }); else shoot(); }
    else if (m.t === "undo") { if (shots.length) undoLast(); else link.send({ t: "error", msg: "nothing to retake in this session" }); }
    else if (m.t === "mode") { await setMode(m.mode === "single" ? "single" : "spread"); lock = book.lock && book.lock.mode === mode ? book.lock : null; labels(); }
    else if (m.t === "rotate") rotateNext();
    else if (m.t === "orient" && (m.v === "portrait" || m.v === "landscape")) await setOrient(m.v);
    else if (m.t === "auto") {
      settings.auto = !!m.on; saveSettings(); paused = false; labels();
      state = autoOn() ? "watch" : "idle"; stillSince = 0;
      if (settings.auto) PN.init().catch(() => {});
      sendState();
    } else if (m.t === "lock" && Array.isArray(m.pts) && m.pts.length === (mode === "spread" ? 6 : 4)
      && m.pts.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && v >= 0 && v <= 1))) {
      if (editing === "pc") editing = null;
      await setLock(m.pts);
      note(m.fresh ? "🔒 New page area locked from the PC" : "🔒 Page area locked from the PC", 3000);
    } else if (m.t === "unlock") {
      if (editing === "pc") editing = null;
      await setLock(null);
      note("🔓 Unlocked from the PC", 3000);
    } else if (m.t === "lock-editing") {
      if (m.on) { if (!editing) editing = "pc"; }
      else if (editing === "pc") { editing = null; stillSince = 0; }
    } else if (m.t === "detect-req") {
      link.send({ t: "detected", id: m.id, pts: await detectOnce() });
    } else if (m.t === "lock-photo-req") {
      let data = null;
      const bmp = await sharpPicture();
      if (bmp) {
        const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
        c.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
        data = c.toDataURL("image/jpeg", 0.85);
      }
      link.send({ t: "lock-photo", id: m.id, data });
    }
    else if (m.t === "filter" && P.FILTERS.includes(m.f)) { book = { ...book, filter: m.f }; await DB.saveBook(book); sendState(); }
    else if (m.t === "torch") await setTorch(!!m.on);
    else if (m.t === "pc-settings") pcOriginals = !!m.originals;
    else if (m.t === "sync") {
      const all = await DB.listPages(bookId);
      await link.send({ t: "sync-start", total: all.length });          // PC drops files beyond the last page
      for (let i = 0; i < all.length; i++) { if (!remote()) break; if (all[i].status === "done") await sendPage(all[i], i + 1); }
    } else if (m.t === "reject") { toast(m.reason || "PC refused the connection", 4000); disconnectPc(false); }
  }
  // The PC names files by the page's position in the book (1, 2, 3 …), so its
  // folder always matches the page numbers shown on the phone.
  async function sendPage(p, num = null) {
    if (num == null) num = (await DB.listPages(bookId)).findIndex((x) => x.id === p.id) + 1;
    if (num < 1) return;
    const blob = await DB.getBlob("full:" + p.id);
    if (!blob || !remote()) return;
    await link.send({ t: "page", id: p.id, order: num, side: p.side, filter: p.filter, w: p.w, h: p.h, blurry: !!p.blurry, sharp: p.sharp, jpeg: await blob.arrayBuffer() });
  }
  const offPage = on("page", (p) => {
    if (p.bookId !== bookId || p.status !== "done") return;
    if (remote()) sendPage(p);
    if (p.blurry && shots.length) {
      setStatus(`⚠ A page of the last photo looks blurry — tap ↶ Retake`);
      savedAt = performance.now() + 4000;
      try { navigator.vibrate?.([80, 60, 80]); } catch {}
    }
  });

  function connectDialog(typeOnly = false) {
    const hasQR = !typeOnly && "BarcodeDetector" in window;
    const m = modal(`<h3>💻 Connect to PC</h3>
      <p class="muted">${N.isNative() ? "On the computer, start <b>BookSnap PC</b> (Mac: double-click <b>Start BookSnap PC</b>). Phone and computer must be on the same Wi-Fi." : `On the computer open <b>${esc(new URL("pc.html", location.href).href)}</b>`}</p>
      ${hasQR ? '<button class="btn primary" id="qrscan" style="width:100%;margin-bottom:12px">📷 Scan the QR code on the PC</button><p class="muted" style="text-align:center">or type what the PC shows</p>' : '<p>Type what the PC shows:</p>'}
      <input class="input" id="pcc" placeholder="192.168.0.103:8765/AB12CD" maxlength="60" autocapitalize="characters" autocomplete="off" inputmode="url" style="font-size:18px;text-align:center">
      <div class="row end"><button class="btn" id="c">Cancel</button><button class="btn primary" id="o">Connect</button></div>`);
    const inp = m.el.querySelector("#pcc");
    if (settings.lastPc) inp.value = settings.lastPc;
    m.el.querySelector("#c").onclick = () => m.close();
    m.el.querySelector("#o").onclick = () => { m.close(); connectPc(inp.value); };
    inp.onkeydown = (e) => { if (e.key === "Enter") { m.close(); connectPc(inp.value); } };
    if (hasQR) m.el.querySelector("#qrscan").onclick = () => { m.close(); scanQR(); };
  }
  // full-screen QR scanner: point the phone at the QR code on the PC page
  let qrScanning = false;
  async function scanQR() {
    let det = null;
    try { if ("BarcodeDetector" in window) det = new BarcodeDetector({ formats: ["qr_code"] }); } catch {}
    if (!det) return connectDialog(true);
    if (qrScanning) return;
    qrScanning = true;
    const ov = document.createElement("div");
    ov.className = "qr-scan";
    ov.innerHTML = `<div class="qr-box"></div>
      <div class="qr-text">Point the phone at the QR code on the computer<br><span>On the computer open <b>booksnap-scanner.vercel.app</b></span></div>
      <div class="qr-actions"><button class="chip" id="qrType">⌨ Type code</button><button class="chip" id="qrCancel">✕ Cancel</button></div>`;
    app.querySelector(".scan").appendChild(ov);
    app.querySelector(".scan").classList.add("qr-mode");
    let stop = false;
    ov.querySelector("#qrCancel").onclick = () => { stop = true; };
    ov.querySelector("#qrType").onclick = () => { stop = true; connectDialog(true); };
    const until = performance.now() + 120000;
    let found = null;
    try {
      while (running && !stop && !found && performance.now() < until && !remote()) {
        try {
          const codes = await det.detect(cam.native ? cam.lastFrame : video);
          const hit = codes.find((c) => /booksnap=|#\/link\//.test(c.rawValue) || /^[A-Z0-9]{6}$/i.test(c.rawValue));
          if (hit) found = hit.rawValue;
        } catch {}
        if (!found) await new Promise((r) => setTimeout(r, 250));
      }
    } finally { ov.remove(); qrScanning = false; app.querySelector(".scan")?.classList.remove("qr-mode"); }
    if (found) { beep(); try { navigator.vibrate?.(50); } catch {} return connectPc(R.isLocalAddress(found) ? found : R.codeFromText(found)); }
    if (!remote() && !stop && running) note("No QR code found — tap 💻 PC to try again", 4000);
  }

  // ---------------------------------------------------------- capture
  let spaceWarned = false;
  // page areas of the current picture (left page first), for reading page numbers
  function currentRegions() {
    const g = lock ? P.geoFromLock(lock) : geo;
    const toPhoto = (q) => q.map((p) => P.unrotPoint(p, effRotate()));
    if (g && g.found && g.pages && g.pages.length) return g.pages.map((pg) => toPhoto(pg.quad || P.pageQuad(pg)));
    return mode === "spread"
      ? [[[0, 0], [0.5, 0], [0.5, 1], [0, 1]], [[0.5, 0], [1, 0], [1, 1], [0.5, 1]]]
      : [[[0, 0], [1, 0], [1, 1], [0, 1]]];
  }

  // detailed fingerprint of the page area in the live picture (Auto duplicate guard)
  let fpBox = null;
  function pageFp() {
    const f = cam.frame(640);
    if (!f) return null;
    const g = lock ? P.geoFromLock(lock) : geo;
    const tb = lock && bookRes && bookRes.ok && bookRes.textBox;
    if (tb) {
      // locked area: compare the text block inside it (a big lock also holds table, which looks
      // the same on every photo)
      const mx = (tb.x1 - tb.x0) * 0.04, my = (tb.y1 - tb.y0) * 0.04;
      fpBox = { x0: Math.max(0, tb.x0 - mx), y0: Math.max(0, tb.y0 - my), x1: Math.min(1, tb.x1 + mx), y1: Math.min(1, tb.y1 + my) };
    } else if (g && g.found && g.pages && g.pages.length) {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const q of currentRegions()) for (const [x, y] of q) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      if (x1 - x0 > 0.2 && y1 - y0 > 0.2) fpBox = { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(1, x1), y1: Math.min(1, y1) };
    }
    const box = fpBox || { x0: 0.08, y0: 0.06, x1: 0.92, y1: 0.94 };   // no outline yet: middle of the picture
    const wide = (box.x1 - box.x0) * f.w > (box.y1 - box.y0) * f.h;
    return PS.fingerprint(PS.pageCrop(f, box, wide ? 420 : PS.SIG_W, wide ? 300 : 420));
  }
  // is this page one we already saved in this session? (newest first)
  // (gives the screen a breather every few comparisons, so the preview never stutters)
  // "same page" limit for this book: half the typical difference between pages saved one after
  // another (they are different pages) — books with a very regular layout get a lower limit
  const diffHist = [];
  const sameCut = () => {
    if (diffHist.length < 2) return 6;
    const s_ = [...diffHist].sort((a, b) => a - b);
    return Math.min(PS.SAME_PAGE, Math.max(3.5, s_[s_.length >> 1] * 0.5));
  };
  async function seenBefore(sig, fp) {
    const cut = sameCut();
    for (let i = seenPages.length - 1, n = 0; i >= 0; i--, n++) {
      if (n && n % 6 === 0) await new Promise((r) => setTimeout(r, 0));
      const e = seenPages[i];
      if (e.fp && fp) { if (e.fp.w === fp.w && e.fp.h === fp.h && PS.isSame(e.fp, fp, cut)) return seenPages.length - i; }
      else if (e.sig && sig && !pageChanged(e.sig, sig)) return seenPages.length - i;
    }
    return 0;
  }
  function rememberPage(sig, fp) {
    const prev = seenPages.length ? seenPages[seenPages.length - 1].fp : null;
    if (prev && fp && prev.w === fp.w && prev.h === fp.h) {
      const d = PS.tileDistance(prev, fp);
      if (d < 1e8) { diffHist.push(d); if (diffHist.length > 30) diffHist.shift(); }
    }
    seenPages.push({ sig, fp });
    const k = seenPages.length - 1 - FP_KEEP;
    if (k >= 0) seenPages[k].fp = null;          // keep memory small on long books
  }

  async function shoot(opts = {}) {
    if (busy) return;
    // never fill the phone: stop before storage runs out
    const sp = await Dev.spaceCheck().catch(() => ({ level: "ok" }));
    if (sp.level === "full") {
      note(`⛔ Phone storage almost full (${Math.round(sp.free / 1048576)} MB left). Export a PDF and free some space, then continue.`, 15000);
      if (remote()) link.send({ t: "error", msg: "phone storage is almost full — photo not taken" });
      try { navigator.vibrate?.([200, 100, 200]); } catch {}
      return;
    }
    if (sp.level === "low" && !spaceWarned) { spaceWarned = true; toast(`Storage is getting low: ${Math.round(sp.free / 1048576)} MB left`, 5000); }
    busy = true;
    const flash = $(".flash");
    flash.classList.remove("go"); void flash.offsetWidth; flash.classList.add("go");
    setStatus("Saving…");
    try {
      const sig = opts.sig || blockSig(cam.frame(320));
      const fp = opts.auto ? pageFp() : null;
      const regions = currentRegions();
      // Auto: a page we already saved? The PICTURE decides (page numbers can be misread — Roman
      // numerals, numbers inside tables…), before the photo is even taken.
      const dupAgo = opts.auto ? await seenBefore(sig, fp) : 0;
      if (dupAgo) {
        lastShotSig = sig; turnSeen = false;
        note(dupAgo === 1 ? "Same page as the last photo — not saved. Turn to the next page." : `Already saved this page (${dupAgo} photos ago) — not saved. Turn to the next page.`, 3500);
        return;
      }
      cam.frame(240);
      const preview = cam.small.toDataURL("image/jpeg", 0.6);
      const blob = await cam.takePhoto();
      beep();
      try { navigator.vibrate?.(60); } catch {}
      $("#lastimg").src = preview;
      const ps = await DB.addCapture(bookId, blob, { rotate: effRotate(), mode, filter: book.filter || "magic", lock: lock ? { mode: lock.mode, pts: lock.pts, ...(lock.plain ? { plain: true } : {}) } : null });
      count += ps.length;
      $("#count").textContent = count;
      lastShotSig = sig; turnSeen = false;
      rememberPage(sig, opts.auto ? fp : pageFp());
      shots.push(ps[0].captureId);
      $("#undo").classList.remove("hidden");
      kickQueue();
      savedAt = performance.now();
      setStatus(mode === "spread" ? `Saved pages ${count - 1}–${count} ✓` : `Saved page ${count} ✓`);
      if (opts.auto) {
        // the page number is only read for the message and the "pages missing?" warning — after
        // saving, in the background, so it never slows down or blocks a photo
        const expected = lastNum != null ? lastNum + 1 : null, n = ps.length;
        if (lastNum != null) lastNum += n;                      // until the number is read
        const first = count - n + 1;
        PN.readNumberFromPhoto(blob, regions, expected).catch(() => null).then((num) => {
          if (!running) return;
          // trust printed numbers only once two photos in a row agree (a number inside the text,
          // a Roman-numeral page… must not count); after that: the next one or a small jump forward
          let fits = false;
          if (expected != null) fits = num != null && num >= expected && num <= expected + 6;
          else if (num != null && numGuess != null && num === numGuess + 1) fits = true;
          else numGuess = num != null ? num + n - 1 : null;
          if (fits) {
            if (expected != null && num > expected)
              note(`⚠ Page ${num} saved — page${num - expected > 1 ? "s" : ""} ${expected}${num - expected > 1 ? "–" + (num - 1) : ""} may be missing.`, 6000);
            else note(n > 1 ? `✓ Pages ${num}–${num + 1} saved` : `✓ Page ${num} saved`, 2500);
            lastNum = num + n - 1;
            numGuess = null;
          } else note(n > 1 ? `✓ Pages ${first}–${first + 1} saved` : `✓ Page ${first} saved`, 2500);
          book = { ...book, lastPageNo: lastNum };
          DB.saveBook(book);
        });
      }
      if (remote()) {
        const nums = ps.map((_, i) => count - ps.length + 1 + i);
        await link.send({ t: "shot", orders: nums, count });
        sendState();
        if (pcOriginals) link.send({ t: "original", captureId: ps[0].captureId, orders: nums, jpeg: await blob.arrayBuffer() });
      }
    } catch (e) {
      console.error(e);
      const full = /quota/i.test((e && (e.name + " " + e.message)) || "");
      note(full ? "⛔ Storage is full — the photo was NOT saved. Export a PDF and use ⋯ → Free up space, then continue."
                : "Could not take photo: " + (e.message || e), full ? 15000 : 6000);
      if (remote()) link.send({ t: "error", msg: "could not take photo: " + (e.message || e) });
    } finally {
      busy = false;
      state = autoOn() ? "watch" : "idle";
      stillSince = 0;
      setRing(0);
    }
  }

  function motionStep(now) {
    if (editing === "pc" && !remote()) editing = null;          // PC went away while adjusting
    if (editing) {
      stillSince = 0; setRing(0);
      setStatus(editing === "pc" ? "Adjusting the page area on the PC…" : "Adjusting the page area…");
      return;
    }
    // Manual mode: nothing to track (keeps the phone fast)
    if (state === "idle" && !paused) {
      if (now - savedAt > 2500) setStatus(remote() ? "Connected — capture from the PC" : "Tap the button to shoot");
      setRing(0);
      return;
    }
    const f = cam.frame(160);
    if (!f || f.id === lastFrameId) return;     // only compare new frames
    lastFrameId = f.id;
    const g = grayOf(f);
    const motion = meanDiff(prevG, g);
    prevG = g;
    // learn the camera's own flicker/noise level (lowest recent change) so "still"
    // works in dim light too; a page turn changes the picture far more than noise
    noiseHist.push(motion); if (noiseHist.length > 40) noiseHist.shift();
    const floor = Math.min(...noiseHist);
    const STILL_T = Math.max(2.5, floor * 1.6 + 0.6), MOVE_T = Math.max(8, floor * 3);
    // a page turn = movement over several frames (a hand + a page sweeping across), or one big
    // change; one flicker / focus hunt / auto-exposure step does not count
    if (motion > MOVE_T) { turnFrames++; if (turnFrames >= 2 || motion > MOVE_T * 2.5) turnSeen = true; }
    else turnFrames = 0;
    if (busy || checking) return;
    if (paused) { setRing(0); return; }
    if (state === "idle") {
      setRing(0);
      if (now - savedAt > 2500)
        setStatus(remote() ? "Connected — capture from the PC" : "Tap the button to shoot");
      return;
    }
    // Auto: no "hold still" — after a page turn a countdown of `delay` seconds runs and then the
    // photo is taken. Small shakes don't restart it; only a big movement (the next turn, a hand)
    // does. Before the photo: is it a clean book page, and a page not saved yet?
    const turnMsg = lastNum != null ? `Page ${lastNum} saved — turn to page ${lastNum + 1}` : "Turn the page";
    if (motion > MOVE_T) {
      stillSince = 0; setRing(0);
      if (now - savedAt > 2500) setStatus("Turning the page…");
      return;
    }
    if (lastShotSig && !turnSeen) {             // no page turn since the last photo: nothing to count down for
      stillSince = 0; setRing(0);
      if (now - savedAt > 2500) setStatus(turnMsg);
      return;
    }
    if (!stillSince) stillSince = now;
    const el = (now - stillSince) / 1000;
    // the page check must come from a frame taken after the turn ended
    const fresh = bookRes && bookRes.at >= stillSince;
    const why = fresh && !bookRes.ok ? bookRes.why : "";
    const waitMsg = why === "covered" ? "✋ Something is covering the page — waiting"
      : why ? "📖 No book page in view — waiting" : "";
    if (el < settings.delay) {
      setRing(el / settings.delay);
      if (now - savedAt > 2500) setStatus(waitMsg || `📸 Photo in ${Math.max(1, Math.ceil(settings.delay - el))}s`);
      return;
    }
    if (!fresh || !bookRes.ok) {                  // not a clean page (yet): no photo
      setRing(1);
      if (now - savedAt > 2500) setStatus(waitMsg || "Checking the page…");
      return;
    }
    const sig = blockSig(cam.frame(320));
    if (lastShotSig && !pageChanged(lastShotSig, sig)) {   // moved, but still the same page
      turnSeen = false; stillSince = 0; setRing(0);
      if (now - savedAt > 2500) setStatus(turnMsg);
      return;
    }
    shoot({ auto: true, sig });
  }

  function drawOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const cw = overlay.clientWidth, ch = overlay.clientHeight;
    if (overlay.width !== Math.round(cw * dpr) || overlay.height !== Math.round(ch * dpr)) {
      overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr);
    }
    const ctx = overlay.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!geo || !geo.found) return;
    const { w: vw, h: vh } = cam.size;
    const s = Math.min(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    const pt = (fx, fy) => { const [ux, uy] = P.unrotPoint([fx, fy], effRotate()); return [ox + ux * vw * s, oy + uy * vh * s]; };
    ctx.lineWidth = 3;
    ctx.strokeStyle = lock ? "#facc15" : "#22c55e";
    ctx.fillStyle = lock ? "rgba(250,204,21,0.10)" : "rgba(34,197,94,0.12)";
    for (const pg of geo.pages) {
      if (pg.quad) {
        ctx.beginPath();
        pg.quad.forEach(([qx, qy], i) => { const [a, b] = pt(qx, qy); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
        ctx.closePath(); ctx.fill(); ctx.stroke();
        continue;
      }
      ctx.beginPath();
      const N = 16;
      for (let k = 0; k <= N; k++) { const x = pg.x0 + ((pg.x1 - pg.x0) * k) / N; const [a, b] = pt(x, P.evalCurve(pg.top, x)); k ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
      for (let k = N; k >= 0; k--) { const x = pg.x0 + ((pg.x1 - pg.x0) * k) / N; const [a, b] = pt(x, P.evalCurve(pg.bot, x)); ctx.lineTo(a, b); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    if (geo.gutter != null) {
      const pg = geo.pages[1];
      ctx.setLineDash([8, 6]); ctx.strokeStyle = "#facc15";
      ctx.beginPath(); ctx.moveTo(...pt(geo.gutter, P.evalCurve(pg.top, geo.gutter))); ctx.lineTo(...pt(geo.gutter, P.evalCurve(pg.bot, geo.gutter))); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // page outline runs in its own worker; at most one check at a time
  const detWorker = new Worker(new URL("./detect-worker.js", import.meta.url), { type: "module" });
  let detBusy = false;
  // Auto: latest "is this a book page?" answer, from a frame taken at `at`
  let bookRes = null, detSentAt = 0;
  detWorker.onmessage = (e) => {
    if (e.data.id === "once") { const w = onceWaiters.shift(); if (w) w(e.data.geo); return; }
    detBusy = false;
    if (!e.data.locked && !lock) geo = e.data.geo;
    if (e.data.book) bookRes = { ...e.data.book, at: detSentAt };
    if (running) { drawOverlay(); sendGeo(); }
  };
  function detectStep() {
    if (isDoc) { geo = null; return; }                       // regular scan: no page detection
    const checking_ = autoOn() && !paused && !editing;
    if (lock) {
      geo = P.geoFromLock(lock); drawOverlay(); sendGeo();
      if (!checking_ || detBusy) return;            // locked: only the book check is needed
    }
    if (detBusy) return;
    const f = cam.frame(prof.detectSize || 480);
    if (!f) return;
    detBusy = true; detSentAt = performance.now();
    const d = new Uint8ClampedArray(f.d);   // own copy, transferred to the worker
    detWorker.postMessage({ id: f.id, w: f.w, h: f.h, d, rot: effRotate(), mode, check: checking_,
      lockPts: lock ? lock.pts : null }, [d.buffer]);
  }

  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);
    if (now - lastMotion > 100) { lastMotion = now; motionStep(now); }
    // Auto, picture still, waiting for a page check from a still frame: check back to back
    const waitingCheck = autoOn() && stillSince && !(bookRes && bookRes.at >= stillSince);
    if (now - lastDetect > (waitingCheck ? 60 : prof.detectEvery || 300)) { lastDetect = now; detectStep(); }
  }

  // hardware shutter: volume keys / Bluetooth remote (app), Enter or Space (keyboard remotes)
  let offKeys = () => {};
  N.onShutterKey(() => { if (running && !busy) shoot(); }).then((off) => { if (running) offKeys = off; else off(); });
  const onKey = (e) => {
    if (modalRoot.children.length || (e.target.closest && e.target.closest("input, textarea"))) return;
    if (["Enter", "Space", "AudioVolumeUp", "AudioVolumeDown"].includes(e.code) || e.key === "AudioVolumeUp") { e.preventDefault(); if (!busy) shoot(); }
  };
  document.addEventListener("keydown", onKey);

  cleanup = () => {
    running = false;
    detWorker.terminate();
    if (cam.setOrientation && !cam.native) cam.setOrientation("auto");
    offKeys();
    document.removeEventListener("keydown", onKey);
    offPage();
    disconnectPc(false);
    cam.stop();
    try { wake?.release(); } catch {}
    document.removeEventListener("visibilitychange", onVis);
    document.body.classList.remove("dark");
  };

  try {
    await cam.start();
    if (!running) { cam.stop(); return; }
    if (cam.setOrientation) cam.setOrientation(orient);
    if (settings.auto) PN.init().catch(() => {});
    if (cam.canTorch) $("#torch").classList.remove("hidden");
    getWake();
    DB.askPersist();
    setStatus(autoOn() ? "Auto: ready — the photo is taken a moment after each page turn" : "Tap the button to shoot");
    requestAnimationFrame(loop);
    if (pcCode === "qr") scanQR();
    else if (pcCode) connectPc(pcCode);
    else if (settings.lastPc && R.isLocalAddress(settings.lastPc)) {
      note("Looking for your PC…", 4000);
      connectPc(settings.lastPc, true).then(() => { if (!remote()) note("PC not found — tap 💻 PC to connect", 4000); });
    }
  } catch (e) {
    console.error(e);
    setStatus("Camera not available: " + (e.message || e.name || e) + ". Allow camera access, or use Import.");
  }
}

// ================================================================ LINK (opened from the PC's QR code)
async function viewLink(code) {
  code = R.normCode(code);
  const books = await DB.listBooks();
  app.innerHTML = `
    <header class="bar"><a class="icon" href="#/" aria-label="Back">‹</a><div class="title">Connect to PC · ${esc(code)}</div></header>
    <main class="lib">
      <p>Which book do you want to scan into?</p>
      <button class="btn primary big" id="new">＋ New book</button>
      <div class="books">${books.map((b) => `<a class="book" href="#/scan/${b.id}/${code}"><div class="info"><div class="name">${esc(b.name)}</div>
        <div class="meta">${fmtDate(b.updated)}</div></div><span class="chev">›</span></a>`).join("")}</div>
    </main>`;
  app.querySelector("#new").onclick = async () => {
    const name = await ask("Book name", "Book " + new Date().toLocaleDateString(), "Create");
    if (!name) return;
    DB.askPersist();
    const b = await DB.createBook(name);
    go(`#/scan/${b.id}/${code}`);
  };
}

// ================================================================ PAGE EDITOR
async function viewPage(pageId) {
  let page = await DB.get("pages", pageId);
  if (!page) return go("#/");
  const bookId = page.bookId;
  let list = await DB.listPages(bookId);
  let url = null;

  app.innerHTML = `
    <header class="bar">
      <a class="icon" href="#/book/${bookId}" aria-label="Back">‹</a>
      <div class="title" id="ptitle"></div>
      <button class="icon danger" id="del" aria-label="Delete page">🗑</button>
    </header>
    <main class="viewer" id="viewer"><img id="img" alt="page"><div class="busy hidden" id="busy"><span class="spin"></span> Processing…</div>
      <div class="busy warn hidden" id="blurry">⚠ Looks blurry — consider rescanning this page</div></main>
    <div class="filters" id="filters">${P.FILTERS.map((f) => `<button class="fbtn" data-f="${f}">${FILTER_NAMES[f]}</button>`).join("")}</div>
    <footer class="actions">
      <button class="act" id="prev"><span>◀</span>Prev</button>
      <button class="act" id="rotate"><span>⟳</span>Rotate</button>
      <button class="act" id="crop"><span>✂</span>Crop</button>
      <button class="act" id="move"><span>⇅</span>Move</button>
      <button class="act" id="next"><span>▶</span>Next</button>
    </footer>`;
  const $ = (s) => app.querySelector(s);

  async function show() {
    const idx = list.findIndex((p) => p.id === page.id);
    $("#ptitle").textContent = `Page ${idx + 1} of ${list.length}`;
    $("#prev").disabled = idx <= 0;
    $("#next").disabled = idx >= list.length - 1;
    app.querySelectorAll(".fbtn").forEach((b) => b.classList.toggle("active", b.dataset.f === page.filter));
    const busy = $("#busy");
    busy.innerHTML = page.status === "error" ? "⚠ Could not process this page. Try Crop." : '<span class="spin"></span> Processing…';
    busy.classList.toggle("hidden", page.status !== "pending" && page.status !== "error");
    $("#blurry").classList.toggle("hidden", !(page.blurry && page.status === "done"));
    const b = await DB.getBlob("full:" + page.id);
    if (url) URL.revokeObjectURL(url);
    url = b ? URL.createObjectURL(b) : null;
    $("#img").src = url || "";
  }
  await show();

  const edit = async (changes) => {
    const cap = await DB.get("captures", page.captureId);
    if (!cap || !cap.blob) return toast("The original photo of this page was removed to save space — it can't be changed.", 4000);
    const np = await DB.editPage(page.id, changes);
    if (np) { page = np; await show(); kickQueue(); }
  };
  app.querySelectorAll(".fbtn").forEach((b) => (b.onclick = () => b.dataset.f !== page.filter && edit({ filter: b.dataset.f })));
  $("#rotate").onclick = () => edit({ rot: ((page.rot || 0) + 90) % 360 });
  $("#crop").onclick = async () => {
    const r = await cropEditor(page);
    if (r.action === "apply") edit({ crop: { quad: r.quad } });
    else if (r.action === "auto") edit({ crop: null });
  };
  const step = (d) => {
    const idx = list.findIndex((p) => p.id === page.id) + d;
    if (idx >= 0 && idx < list.length) go("#/page/" + list[idx].id);
  };
  $("#prev").onclick = () => step(-1);
  $("#next").onclick = () => step(1);
  $("#move").onclick = async () => {
    const idx = list.findIndex((p) => p.id === page.id);
    const v = await ask(`Move to position (1–${list.length})`, String(idx + 1), "Move");
    const k = parseInt(v, 10);
    if (!k || k === idx + 1) return;
    const others = list.filter((p) => p.id !== page.id);
    let order;
    if (k <= 1) order = others[0].order - 1;
    else if (k > others.length) order = others[others.length - 1].order + 1;
    else order = (others[k - 2].order + others[k - 1].order) / 2;
    page = { ...page, order };
    await DB.putPage(page);
    list = await DB.listPages(bookId);
    await show();
    toast(`Moved to position ${Math.min(Math.max(k, 1), list.length)}`);
  };
  $("#del").onclick = async () => {
    if (!(await confirmBox("Delete this page?"))) return;
    const idx = list.findIndex((p) => p.id === page.id);
    await DB.deletePages([page.id]);
    const rest = list.filter((p) => p.id !== page.id);
    if (!rest.length) return go("#/book/" + bookId);
    go("#/page/" + rest[Math.min(idx, rest.length - 1)].id);
  };

  // swipe left/right
  let sx = null;
  const v = $("#viewer");
  v.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; }, { passive: true });
  v.addEventListener("touchend", (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    sx = null;
    if (Math.abs(dx) > 70) step(dx < 0 ? 1 : -1);
  });

  const off = on("page", async (p) => { if (p.id === page.id) { page = p; await show(); } });
  cleanup = () => { off(); if (url) URL.revokeObjectURL(url); };
}

// ---------------------------------------------------------------- crop editor (4 corners)
// Resolves {action: "apply"|"auto"|"cancel"|"skip"|"back"|"all", quad}
async function cropEditor(page, { title = "Drag the corners", batch = false, canBack = false } = {}) {
  const cap = await DB.get("captures", page.captureId);
  if (!cap || !cap.blob) { toast("The original photo of this page was removed to save space — it can't be re-cropped."); return { action: "skip" }; }
  const bmp = await createImageBitmap(cap.blob);
  const rot = cap.rotate || 0;
  const sw = rot % 180 ? bmp.height : bmp.width, sh = rot % 180 ? bmp.width : bmp.height;
  const sideName = page.side === "L" ? "left" : page.side === "R" ? "right" : "";

  return new Promise((resolve) => {
    const m = modal(`
      <div class="crop-head"><button class="btn" id="cc">${batch ? "Stop" : "Cancel"}</button><span class="crop-title">${esc(title)}</span>
        <button class="btn primary" id="ca">${batch ? "Apply ›" : "Apply"}</button></div>
      <div class="crop-stage"><canvas id="cv"></canvas></div>
      <div class="crop-foot">
        <button class="btn" id="cauto">↺ Auto</button><button class="btn" id="cfull">⛶ Whole photo</button>
        ${batch ? `${canBack ? '<button class="btn" id="cback">‹ Back</button>' : ""}<button class="btn" id="cskip">Skip ›</button>
        <button class="btn primary wide" id="call">Apply to all remaining ${sideName} pages</button>` : ""}
      </div>`, "full");
    const done = (action, extra = {}) => { m.close(); resolve({ action, ...extra }); };
    const cv = m.el.querySelector("#cv"), stage = m.el.querySelector(".crop-stage");
    const maxW = stage.clientWidth - 24, maxH = stage.clientHeight - 24;
    const scale = Math.min(maxW / sw, maxH / sh);
    const W = Math.max(50, Math.round(sw * scale)), H = Math.max(50, Math.round(sh * scale)), dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";

    const base = document.createElement("canvas");
    base.width = W * dpr; base.height = H * dpr;
    const bctx = base.getContext("2d");
    bctx.scale((W * dpr) / sw, (H * dpr) / sh);
    if (rot === 90) { bctx.translate(sw, 0); bctx.rotate(Math.PI / 2); }
    else if (rot === 180) { bctx.translate(sw, sh); bctx.rotate(Math.PI); }
    else if (rot === 270) { bctx.translate(0, sh); bctx.rotate(-Math.PI / 2); }
    bctx.drawImage(bmp, 0, 0);
    bmp.close();

    let quad = (page.crop?.quad || page.autoQuad || [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]]).map((p) => [...p]);
    const ctx = cv.getContext("2d");
    function draw() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(base, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const pts = quad.map(([x, y]) => [x * W, y * H]);
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.beginPath(); ctx.rect(0, 0, W, H);
      ctx.moveTo(...pts[0]); for (let i = 3; i >= 0; i--) ctx.lineTo(...pts[i]); ctx.closePath();
      ctx.fill("evenodd");
      ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 2.5;
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.stroke();
      for (const p of pts) {
        ctx.beginPath(); ctx.arc(p[0], p[1], 13, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(34,197,94,0.35)"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    draw();

    let drag = -1;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / W, (e.clientY - r.top) / H]; };
    cv.addEventListener("pointerdown", (e) => {
      const [x, y] = pos(e);
      let best = -1, bd = Infinity;
      quad.forEach(([qx, qy], i) => { const d = Math.hypot((qx - x) * W, (qy - y) * H); if (d < bd) { bd = d; best = i; } });
      if (bd < 48) { drag = best; cv.setPointerCapture(e.pointerId); }
    });
    cv.addEventListener("pointermove", (e) => {
      if (drag < 0) return;
      const [x, y] = pos(e);
      quad[drag] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
      draw();
    });
    cv.addEventListener("pointerup", () => { drag = -1; });
    cv.addEventListener("pointercancel", () => { drag = -1; });

    const q = (id) => m.el.querySelector(id);
    q("#cc").onclick = () => done("cancel");
    q("#cauto").onclick = () => done("auto");
    q("#cfull").onclick = () => { quad = [[0, 0], [1, 0], [1, 1], [0, 1]]; draw(); };
    q("#ca").onclick = () => done("apply", { quad });
    if (batch) {
      q("#cskip").onclick = () => done("skip");
      if (q("#cback")) q("#cback").onclick = () => done("back");
      q("#call").onclick = () => done("all", { quad });
    }
  });
}

// Crop selected pages one after another. "Apply to all remaining" copies the
// corners to every later selected page on the same side (left/right) — ideal
// when the phone sits on a stand and doesn't move.
async function batchCrop(ids, allPages) {
  const list = allPages.filter((p) => ids.includes(p.id));
  const handled = new Set();
  let i = 0;
  while (i < list.length) {
    if (handled.has(list[i].id)) { i++; continue; }
    const p = await DB.get("pages", list[i].id);
    if (!p) { i++; continue; }
    const num = allPages.findIndex((x) => x.id === p.id) + 1;
    const r = await cropEditor(p, { title: `Page ${num} · ${i + 1} of ${list.length}`, batch: true, canBack: i > 0 });
    if (r.action === "cancel") break;
    if (r.action === "back") { i = Math.max(0, i - 1); handled.delete(list[i].id); continue; }
    if (r.action === "apply") await DB.editPage(p.id, { crop: { quad: r.quad } });
    if (r.action === "auto") await DB.editPage(p.id, { crop: null });
    if (r.action === "all") {
      for (let j = i; j < list.length; j++) {
        if (list[j].side !== p.side || handled.has(list[j].id)) continue;
        await DB.editPage(list[j].id, { crop: { quad: r.quad } });
        handled.add(list[j].id);
      }
    }
    handled.add(p.id);
    i++;
  }
  kickQueue();
}

// One crop for many pages: set it once (per side for 2-page photos), applied to all.
async function batchCropAll(ids, allPages) {
  const list = allPages.filter((p) => ids.includes(p.id));
  const groups = [["L", "left pages"], ["R", "right pages"], ["S", "pages"]]
    .map(([side, label]) => [label, list.filter((p) => p.side === side)]).filter(([, g]) => g.length);
  for (const [label, group] of groups) {
    const first = await DB.get("pages", group[0].id);
    const r = await cropEditor(first, { title: `One crop for all ${group.length} ${label}` });
    if (r.action === "cancel") break;
    if (r.action !== "apply" && r.action !== "auto") continue;
    const m = modal(`<h3>Cropping ${group.length} ${label}…</h3><div class="progress"><div id="bar"></div></div>`);
    for (let i = 0; i < group.length; i++) {
      await DB.editPage(group[i].id, { crop: r.action === "apply" ? { quad: r.quad } : null });
      if (i % 20 === 0) m.el.querySelector("#bar").style.width = (100 * (i + 1)) / group.length + "%";
    }
    m.close();
    toast(`Crop applied to ${group.length} ${label}`);
  }
  kickQueue();
}

// "from page X to page Y"
function rangeBox(max) {
  return new Promise((res) => {
    const m = modal(`<h3>Select a range of pages</h3>
      <div class="row"><label class="col" style="flex:1">From<input class="input" id="a" type="number" min="1" max="${max}" value="1"></label>
      <label class="col" style="flex:1">To<input class="input" id="b" type="number" min="1" max="${max}" value="${max}"></label></div>
      <div class="row end"><button class="btn" id="c">Cancel</button><button class="btn primary" id="o">Select</button></div>`);
    m.el.querySelector("#c").onclick = () => { m.close(); res(null); };
    m.el.querySelector("#o").onclick = () => {
      let a = parseInt(m.el.querySelector("#a").value, 10), b = parseInt(m.el.querySelector("#b").value, 10);
      if (!a || !b) return;
      if (a > b) [a, b] = [b, a];
      m.close(); res([Math.max(1, a), Math.min(max, b)]);
    };
  });
}

// ---------------------------------------------------------------- start
if (!N.isNative() && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
route();
kickQueue();
// back from the background (or the phone woke up): continue any unfinished pages
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kickQueue(); });
