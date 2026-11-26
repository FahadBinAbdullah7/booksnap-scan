// BookSnap PC Remote: live view of the phone camera, capture from the PC,
// receive finished pages and save them into a folder on this computer.
import * as P from "./imgproc.js";
import { buildPdf } from "./pdf.js";
import { PREFIX, newCode, linkUrl } from "./remote.js";
import * as UI from "./pc-ui.js";
import { pageViewer } from "./pageview.js";
import * as N from "./native.js";

const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay");
const FILTER_NAMES = { magic: "Magic Color", original: "Original", gray: "Grayscale", bw: "B&W" };

let peer = null, conn = null, code = null;
let state = { book: "", mode: "spread", rotate: 0, filter: "magic", count: 0, torch: false };
let torchOn = false, busy = false, busyTimer = null;
const pages = new Map();          // order -> { blob, side, id }
let rootDir = null, bookDir = null, bookDirName = "";
let autoDownload = false;

// ---------------------------------------------------------------- small UI helpers
function setStatus(text, cls = "") { const s = $("status"); s.textContent = text; s.className = "pill " + cls; }
function toast(msg, ms = 2500) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 400);
}
// Inside the BookSnap app (another phone is the receiver): pages go straight into
// Documents/BookSnap/Received/<book>/ on this phone, PDFs too (then the share sheet opens).
const inApp = N.isNative();
const RECV = "BookSnap/Received";
if (inApp) {
  document.body.classList.add("in-app");
  $("backApp").classList.remove("hidden");
  $("tag").textContent = "Receiver";
  document.title = "BookSnap Receiver";
  $("step1").innerHTML = "On the <b>scanning phone</b> open BookSnap, open a book and tap <b>💻 PC</b>.";
  $("codeNote").textContent = "This code stays the same on this phone — the scanning phone remembers it and reconnects by itself.";
  $("folder").classList.add("hidden");
  $("folderInfo").textContent = "Pages are saved on this phone in Documents/" + RECV + "/<book name>/";
}
// any browser: keep the screen on while receiving (the app does this by itself)
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (conn && conn.open) keepAwake(true); });
const pad = (n) => String(Math.round(n)).padStart(4, "0");
const safeName = (s) => (String(s || "Book").replace(/[\\/:*?"<>|]+/g, " ").trim() || "Book").slice(0, 80);

// ---------------------------------------------------------------- pairing
function getSavedCode() { try { return localStorage.getItem("booksnap.pccode"); } catch { return null; } }
function saveCode(c) { try { localStorage.setItem("booksnap.pccode", c); } catch {} }

function showQR() {
  $("code").textContent = code.slice(0, 3) + " " + code.slice(3);
  try {
    const q = qrcode(0, "M");
    q.addData(linkUrl(code));
    q.make();
    $("qr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch (e) { $("qr").textContent = "QR unavailable — type the code"; }
}

// The code stays the same (saved in this browser), so the phone can reconnect by itself after
// a reload. Right after a reload the link service may still hold the code for a moment:
// try the same code again for up to a minute before making a new one.
let takenTries = 0;
function startPeer(fresh = false) {
  restartAt = 0; lostAt = 0;
  try { peer && peer.destroy(); } catch {}
  if (fresh) takenTries = 0;
  code = (!fresh && getSavedCode()) || newCode();
  saveCode(code);
  showQR();
  setStatus("Starting…");
  peer = new Peer(PREFIX + code);
  peer.on("open", () => { takenTries = 0; setStatus(conn && conn.open ? "Phone connected" : "Waiting for phone…", conn && conn.open ? "ok" : ""); });
  peer.on("error", (e) => {
    if (e.type === "unavailable-id") {
      if (conn && conn.open) { restartAt = Date.now() + 5000; return; }   // never drop a working phone link for this
      if (++takenTries <= 12) { setStatus("Getting your code back…"); restartAt = Date.now() + 5000; return; }
      return startPeer(true);                                          // really taken: make a new one
    }
    if (e.type === "network" || e.type === "server-error" || e.type === "socket-error") { setStatus("No connection to link service — retrying", "bad"); setTimeout(checkLink, 3000); }
    else console.warn("peer error", e.type, e);
  });
  const me = peer;
  me.on("disconnected", () => setTimeout(() => { if (peer === me && !me.destroyed) try { me.reconnect(); } catch {} }, 1500));
  me.on("close", () => { if (peer === me) setTimeout(() => peer === me && startPeer(false), 3000); });
  me.on("connection", (c) => {
    // The newest phone wins: when the phone comes back (screen was off, Wi-Fi dropped, app
    // restarted) the old link often still looks open here. Refusing it used to force a new QR scan.
    if (conn && conn !== c) { const old = conn; conn = null; try { old.close(); } catch {} }
    conn = c;
    c.on("open", () => { if (conn === c) { lastRx = Date.now(); onConnected(); } });
    c.on("data", (m) => {
      if (conn !== c) return;
      lastRx = Date.now();
      if (m && m.t === "ping") { phoneBeats = true; try { c.send({ t: "pong" }); } catch {} return; }
      if (m && m.t === "pong") return;
      onMessage(m);
    });
    c.on("close", () => { if (conn === c) onDisconnected(); });
    c.on("error", (e) => console.warn("conn error", e));
  });
  me.on("call", (call) => {
    try { liveCall && liveCall !== call && liveCall.close(); } catch {}
    liveCall = call;
    call.answer();
    call.on("stream", (s) => { video.srcObject = s; video.play().catch(() => {}); $("liveEmpty").classList.add("hidden"); });
  });
}
$("newcode").onclick = () => startPeer(true);

// Keep the link service connection alive (sleep, Wi-Fi changes): if it is lost, rejoin with the
// same code so the phone finds this PC again by itself. Also drop a phone link that went silent.
let lastRx = 0, phoneBeats = false, liveCall = null, lostAt = 0, restartAt = 0;
function checkLink() {
  if (restartAt && Date.now() >= restartAt) {
    if (conn && conn.open) { restartAt = 0; try { peer.reconnect(); } catch {} }
    else { startPeer(false); return; }
  }
  if (!peer || peer.destroyed) { startPeer(false); return; }
  if (peer.disconnected) {
    if (!lostAt) lostAt = Date.now();
    try { peer.reconnect(); } catch {}
    if (Date.now() - lostAt > 12000 && !(conn && conn.open)) { lostAt = 0; startPeer(false); }
  } else lostAt = 0;
  if (conn && conn.open && phoneBeats && Date.now() - lastRx > 20000) {
    const c = conn; conn = null; try { c.close(); } catch {}
    onDisconnected();
  }
}
// Ticks come from a worker: Chrome slows the page's own timers to about once a minute when the
// tab is in the background or the laptop screen is locked (worse once no phone is connected), and
// the link service then forgets this PC, so the phone can't find it. A worker keeps ticking, and
// on each tick the PC also tells the link service it is still here.
function keepAlive() {
  try { const ws = peer && !peer.disconnected && peer.socket && peer.socket._socket; if (ws && ws.readyState === 1) ws.send('{"type":"HEARTBEAT"}'); } catch {}
}
let ticker = null;
try {
  ticker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 4000);"], { type: "text/javascript" })));
  ticker.onmessage = () => { keepAlive(); checkLink(); };
} catch { ticker = null; }
if (!ticker) setInterval(() => { keepAlive(); checkLink(); }, 4000);
window.addEventListener("online", () => setTimeout(checkLink, 500));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkLink(); });

function onConnected() {
  keepAwake(true);
  setBusy(false);                                   // a capture sent down a dead link is not coming back
  setStatus("Phone connected", "ok");
  $("pair").classList.add("hidden");
  $("session").classList.remove("hidden");
  $("thumbsCard").classList.remove("hidden");
  UI.setControlsEnabled(true);
  send({ t: "pc-settings", originals: $("originals").checked });
  scheduleSync();                                   // get the pages already in the phone's book
}
let syncTimer = null;
const scheduleSync = (ms = 900) => { clearTimeout(syncTimer); syncTimer = setTimeout(() => autoSync(), ms); };
// ask only for the pages this PC doesn't have yet (the phone skips matching ones)
function autoSync(manual = false) {
  if (!conn || !conn.open) return;
  send({ t: "sync", auto: !manual, have: [...pages.entries()].map(([o, p]) => [o, p.id]) });
}

function onDisconnected() {
  conn = null; phoneBeats = false;
  keepAwake(false);
  setStatus("Phone disconnected — waiting…", "bad");
  UI.showPhoneStatus("");
  video.srcObject = null;
  $("liveEmpty").classList.remove("hidden");
  $("pair").classList.remove("hidden");
  UI.setControlsEnabled(false);
  phoneGeo = null;
  setBusy(false);
}

function send(m) { if (conn && conn.open) conn.send(m); }

// ---------------------------------------------------------------- messages from the phone
async function onMessage(m) {
  if (!m || typeof m !== "object") return;
  switch (m.t) {
    case "geo": phoneGeo = m.geo; phoneGeoAt = Date.now(); break;
    case "status": UI.showPhoneStatus(m.text, m.ring); break;
    case "detected": case "lock-photo": UI.handleReply(m); break;
    case "frame": {
      // live view sent as pictures (phone uses its real camera)
      if (m.ts) { window.__frameDelay = Date.now() - m.ts; window.__frames = (window.__frames || 0) + 1; }
      const blob = new Blob([m.jpeg], { type: "image/jpeg" });
      try {
        const bmp = await createImageBitmap(blob);
        if (lastBmp) lastBmp.close();
        lastBmp = bmp;
        let img = $("liveimg");
        if (!img) { img = document.createElement("img"); img.id = "liveimg"; img.alt = ""; overlay.before(img); video.classList.add("hidden"); UI.rotateLive(state.rotate); }
        const old = img.src;
        img.src = URL.createObjectURL(blob);
        if (old.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(old), 1000);
        $("liveEmpty").classList.add("hidden");
      } catch {}
      break;
    }
    case "state": {
      const bookChanged = m.book !== state.book;
      state = { ...state, ...m };
      $("bookName").textContent = state.book || "Book";
      UI.showState(state);
      UI.rotateLive(state.rotate);
      $("filter").value = state.filter;
      $("torch").classList.toggle("hidden", !state.torch);
      if (bookChanged) { pages.clear(); $("thumbs").innerHTML = ""; bookDir = null; if (rootDir) await openBookDir();
        if (inApp) { bookDirName = safeName(state.book); $("folderInfo").textContent = `Saving on this phone: Documents/${RECV}/${bookDirName}/`; } if (state.book) scheduleSync(); }
      updateCounts();
      break;
    }
    case "shot": {
      setBusy(false);
      for (const o of m.orders || []) addPendingThumb(o);
      setStatus(m.orders && m.orders.length > 1 ? `Captured pages ${pad(m.orders[0])}–${pad(m.orders[1])}` : "Captured", "ok");
      break;
    }
    case "page": {
      const blob = new Blob([m.jpeg], { type: "image/jpeg" });
      pages.set(m.order, { blob, side: m.side, id: m.id, blurry: !!m.blurry, retaken: !!m.retaken });
      await saveFile(`${pad(m.order)}.jpg`, blob);
      setThumb(m.order, blob, !!m.blurry, !!m.retaken);
      updateCounts();
      if (m.blurry) {
        $("blurwarn").textContent = `⚠ Page ${Math.round(m.order)} looks blurry. Press ⌫ to retake it before turning the page.`;
        $("blurwarn").classList.remove("hidden");
        setStatus(`Page ${Math.round(m.order)} looks blurry`, "bad");
      }
      break;
    }
    case "undone": {
      for (const o of m.orders || []) {
        pages.delete(o);
        await removeFile(`${pad(o)}.jpg`);
        const f = $("thumbs").querySelector(`[data-o="${o}"]`);
        if (f) { const img = f.querySelector("img"); if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src); f.remove(); }
      }
      $("blurwarn").classList.add("hidden");
      setStatus("Last photo deleted — capture again", "ok");
      updateCounts();
      break;
    }
    case "original": {
      if ($("originals").checked) await saveFile(`originals/${(m.orders || []).map(pad).join("-") || m.captureId}.jpg`, new Blob([m.jpeg], { type: "image/jpeg" }));
      break;
    }
    case "sync-start": {
      for (const o of [...pages.keys()]) if (o > m.total) { pages.delete(o); await removeFile(`${pad(o)}.jpg`); const f = $("thumbs").querySelector(`[data-o="${o}"]`); if (f) f.remove(); }
      updateCounts();
      break;
    }
    case "sync-done": {
      if (m.sent) toast(`Got ${m.sent} page${m.sent > 1 ? "s" : ""} from the phone`);
      else if (!m.quiet) toast(m.total ? "All pages are already on this PC" : "No pages in this book yet");
      break;
    }
    case "page-deleted": {
      setStatus(`Page ${Math.round(m.order)} deleted`, "ok");
      updateCounts();
      break;
    }
    case "busy": setBusy(false); toast("Phone is busy — try again"); break;
    case "error": setBusy(false); toast("Phone: " + m.msg, 4000); break;
    case "reject": toast(m.reason || "Rejected"); break;
  }
}

// ---------------------------------------------------------------- capture
function setBusy(v) {
  busy = v;
  $("capture").classList.toggle("busy", v);
  $("capture").innerHTML = v ? "⏳ Capturing…" : "📸 Capture <kbd>Space</kbd>";
  clearTimeout(busyTimer);
  if (v) busyTimer = setTimeout(() => { setBusy(false); toast("No answer from the phone"); }, 20000);
}
function retake() {
  if (!conn || !conn.open || busy) return;
  send({ t: "undo" });
}
$("undo").onclick = retake;

function capture() {
  if (!conn || !conn.open || busy) return;
  setBusy(true);
  $("blurwarn").classList.add("hidden");
  const f = $("flash");
  f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  send({ t: "capture" });
}
$("capture").onclick = capture;
document.addEventListener("keydown", (e) => {
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  if (document.querySelector(".zoomview, .modal-wrap")) return;      // page viewer / a question is open: no photo, no retake
  if (e.code === "Space" || e.code === "Enter" || e.code === "PageDown" || e.code === "ArrowRight") { e.preventDefault(); capture(); }
  else if (e.code === "Backspace" || e.code === "KeyZ") { e.preventDefault(); retake(); }
});
UI.setupControls(send, () => state, async () => {
  let bmp = lastBmp;
  if (!bmp && video.videoWidth) bmp = await createImageBitmap(video);
  return { bmp, geo: phoneGeo };
});
$("filter").onchange = () => send({ t: "filter", f: $("filter").value });
$("torch").onclick = () => { torchOn = !torchOn; $("torch").classList.toggle("on", torchOn); send({ t: "torch", on: torchOn }); };
$("originals").onchange = () => send({ t: "pc-settings", originals: $("originals").checked });
$("sync").onclick = () => { autoSync(true); toast("Asking the phone for missing pages…"); };

// 🗑 delete a page (on the phone too); later pages move up one number
async function deletePage(order) {
  const p = pages.get(order);
  if (!p || !conn || !conn.open) return toast(conn && conn.open ? "Wait until this page has arrived" : "Phone not connected");
  if (!(await UI.confirmBox(`Remove page ${Math.round(order)}? It is deleted on the phone too, and the pages after it move up one number.`))) return false;
  send({ t: "delete-page", id: p.id });
  return true;
}
UI.onDeletePage(deletePage);

// click a page: look through all pages like a PDF (‹ ›, strip, zoom, ✕ to remove)
let viewer = null, viewerTimer = null;
const sortedPages = () => [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([order, p]) => ({ order, blob: p.blob, blurry: p.blurry, retaken: p.retaken }));
UI.onOpenPage((order) => {
  if (viewer) viewer.close();
  viewer = pageViewer(order, { list: sortedPages, remove: deletePage, onClose: () => { viewer = null; } });
});
function pagesChanged() {
  if (!viewer) return;
  clearTimeout(viewerTimer);
  viewerTimer = setTimeout(() => viewer && viewer.refresh(), 250);
}

// ---------------------------------------------------------------- saving on this PC
async function openBookDir() {
  bookDirName = safeName(state.book);
  bookDir = await rootDir.getDirectoryHandle(bookDirName, { create: true });
  $("folderInfo").textContent = `Saving to: ${rootDir.name}/${bookDirName}/`;
  for (const [order, p] of pages) await saveFile(`${pad(order)}.jpg`, p.blob);
}

$("folder").onclick = async () => {
  if (!window.showDirectoryPicker) {
    autoDownload = !autoDownload;
    $("folder").textContent = autoDownload ? "⬇ Auto-download: ON" : "⬇ Auto-download each page";
    $("folderInfo").textContent = autoDownload
      ? "Each new page downloads to your Downloads folder. (Use Chrome or Edge to save straight into a chosen folder.)"
      : "This browser can't write to a folder. Use Chrome or Edge, or Make PDF.";
    return;
  }
  try {
    rootDir = await window.showDirectoryPicker({ id: "booksnap", mode: "readwrite" });
    await openBookDir();
    $("folder").textContent = "📁 Change folder";
    toast("Pages will be saved in " + rootDir.name + "/" + bookDirName);
  } catch (e) { if (e.name !== "AbortError") toast("Folder error: " + e.message, 4000); }
};
if (!window.showDirectoryPicker) {
  $("folder").textContent = "⬇ Auto-download each page";
  $("folderInfo").textContent = "Use Chrome or Edge to save straight into a folder. Here you can auto-download pages or Make PDF.";
}

async function removeFile(path) {
  if (inApp) { if (bookDirName) await N.deleteFile(`${RECV}/${bookDirName}/${path}`); return; }
  if (!bookDir) return;
  try { await bookDir.removeEntry(path); } catch {}
}

async function saveFile(path, blob) {
  try {
    if (inApp) {
      if (!bookDirName) bookDirName = safeName(state.book);
      await N.saveBlob(`${RECV}/${bookDirName}/${path}`, blob);
    } else if (bookDir) {
      const parts = path.split("/");
      let d = bookDir;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    } else if (autoDownload) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safeName(state.book)}-${path.replace(/\//g, "-")}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
  } catch (e) {
    console.error(e);
    toast("Could not save " + path + ": " + e.message, 4000);
  }
}

$("pdf").onclick = async () => {
  const list = [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p.blob);
  if (!list.length) return;
  $("pdf").disabled = true; $("pdf").textContent = "Making PDF…";
  try {
    const pdf = await buildPdf(list, { title: state.book });
    const name = safeName(state.book) + ".pdf";
    if (inApp) {
      const uri = await N.saveBlob(`${RECV}/${name}`, pdf);
      toast(`Saved Documents/${RECV}/${name}`, 4000);
      N.shareFiles([uri], name).catch(() => {});
    } else {
      if (bookDir) { await saveFile(name, pdf); toast("Saved " + name + " in the folder"); }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(pdf); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  } catch (e) { toast("PDF failed: " + e.message, 4000); }
  $("pdf").disabled = false; $("pdf").textContent = "⬇ Make PDF";
};

// ---------------------------------------------------------------- thumbnails (newest first, capped)
const MAX_THUMBS = 100000;          // every page (thumbnails are small); the list scrolls
function figFor(order) {
  let f = $("thumbs").querySelector(`[data-o="${order}"]`);
  if (!f) {
    f = document.createElement("figure");
    f.dataset.o = order;
    f.innerHTML = `<img alt=""><figcaption>${Math.round(order)}</figcaption><button type="button" class="tdel" title="Delete this page (on the phone too)" aria-label="Delete page">🗑</button>`;
    const figs = [...$("thumbs").children];
    const after = figs.find((x) => +x.dataset.o < order);
    $("thumbs").insertBefore(f, after || null);
    while ($("thumbs").children.length > MAX_THUMBS) {
      const last = $("thumbs").lastElementChild;
      const img = last.querySelector("img");
      if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
      last.remove();
    }
  }
  return f;
}
function addPendingThumb(order) { const f = figFor(order); if (!f.querySelector("img").src) f.classList.add("pending"); }
async function setThumb(order, blob, blurry = false, retaken = false) {
  const f = figFor(order);
  f._full = blob;                        // click the thumbnail to zoom the page
  f.classList.toggle("blurry", blurry);
  f.classList.toggle("retaken", retaken);
  try {
    const bmp = await createImageBitmap(blob, { resizeWidth: 240 });
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
    const tb = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.7));
    const img = f.querySelector("img");
    if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(tb);
    f.classList.remove("pending");
  } catch {}
}
function updateCounts() {
  pagesChanged();
  $("thumbsN").textContent = pages.size ? `(${pages.size})` : "";
  $("counts").textContent = `${pages.size} pages received on this PC · ${state.count} in the book on the phone · filter: ${FILTER_NAMES[state.filter] || state.filter}`;
  $("pdf").disabled = !pages.size;
}

// ---------------------------------------------------------------- live page outline on the PC view
const small = document.createElement("canvas");
const sctx = small.getContext("2d", { willReadFrequently: true });
let lastBmp = null, phoneGeo = null, phoneGeoAt = 0;
function detectLoop() {
  const srcN = video.videoWidth ? video : lastBmp;
  const nW = srcN ? srcN.videoWidth || srcN.width : 0, nH = srcN ? srcN.videoHeight || srcN.height : 0;
  if (conn && phoneGeo && Date.now() - phoneGeoAt < 3000) {          // the phone's own outline (incl. lock)
    setTimeout(detectLoop, 250);
    UI.drawGeo(overlay, nW, nH, phoneGeo, state.rotate, state.count + 1);
    return;
  }
  setTimeout(detectLoop, 500);
  const src = video.videoWidth ? video : lastBmp;
  const vw = src ? src.videoWidth || src.width : 0, vh = src ? src.videoHeight || src.height : 0;
  const ctx = overlay.getContext("2d");
  const dpr = window.devicePixelRatio || 1, cw = overlay.clientWidth, ch = overlay.clientHeight;
  if (overlay.width !== Math.round(cw * dpr)) { overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!vw || !conn) return;
  const s0 = 360 / Math.max(vw, vh), W = Math.round(vw * s0), H = Math.round(vh * s0);
  small.width = W; small.height = H;
  sctx.drawImage(src, 0, 0, W, H);
  const f = sctx.getImageData(0, 0, W, H);
  let geo;
  try { geo = P.detect(P.rotate({ w: W, h: H, d: f.data }, state.rotate), state.mode); } catch { return; }
  if (!geo.found) return;
  const s = Math.min(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  const pt = (fx, fy) => { const [ux, uy] = P.unrotPoint([fx, fy], state.rotate); return [ox + ux * vw * s, oy + uy * vh * s]; };
  ctx.lineWidth = 3; ctx.strokeStyle = "#22c55e"; ctx.fillStyle = "rgba(34,197,94,0.12)";
  geo.pages.forEach((pg, i) => {
    ctx.beginPath();
    for (let k = 0; k <= 16; k++) { const x = pg.x0 + ((pg.x1 - pg.x0) * k) / 16; const [a, b] = pt(x, P.evalCurve(pg.top, x)); k ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
    for (let k = 16; k >= 0; k--) { const x = pg.x0 + ((pg.x1 - pg.x0) * k) / 16; ctx.lineTo(...pt(x, P.evalCurve(pg.bot, x))); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // page number label: left = N, right = N+1
    const [lx, ly] = pt((pg.x0 + pg.x1) / 2, (P.evalCurve(pg.top, (pg.x0 + pg.x1) / 2) + P.evalCurve(pg.bot, (pg.x0 + pg.x1) / 2)) / 2);
    ctx.save(); ctx.translate(lx, ly); ctx.rotate((-(state.rotate || 0) * Math.PI) / 180);
    ctx.fillStyle = "rgba(15,23,42,.75)"; ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 18px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(state.count + i + 1), 0, 0);
    ctx.restore();
    ctx.fillStyle = "rgba(34,197,94,0.12)";
  });
}

startPeer();
detectLoop();
