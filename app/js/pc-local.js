// PC Remote — direct Wi-Fi mode (page served by booksnap_pc.py).
// The phone app talks to the same little server; pages are saved by the
// server straight into the folder on this computer.
import * as P from "./imgproc.js";
import { buildPdf } from "./pdf.js";
import * as UI from "./pc-ui.js";

export async function start(session) {
  const $ = (id) => document.getElementById(id);
  const FILTER_NAMES = { magic: "Magic Color", original: "Original", gray: "Grayscale", bw: "B&W" };
  const T = session.token;
  const api = (route, params = {}) => `/api/${route}?` + new URLSearchParams({ t: T, ...params });
  let state = { book: session.book, mode: "spread", rotate: 0, filter: "magic", count: 0, torch: false };
  let online = false, busy = false, busyTimer = null, received = 0, torchOn = false, folder = session.folder;

  const pad = (n) => String(Math.round(n)).padStart(4, "0");
  const setStatus = (text, cls = "") => { const s = $("status"); s.textContent = text; s.className = "pill " + cls; };
  const toast = (msg, ms = 2800) => {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add("out"), ms); setTimeout(() => t.remove(), ms + 400);
  };
  const cmd = (c) => fetch(api("cmd"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });

  // ---------------------------------------------------------- pairing card
  $("code").textContent = session.address;
  $("code").classList.add("address");
  try {
    const q = qrcode(0, "M"); q.addData(session.qr); q.make();
    $("qr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch { $("qr").textContent = "QR unavailable — type the address"; }
  document.querySelector("#pair .steps").innerHTML = `
    <li>Phone and this computer on the <b>same Wi-Fi</b>.</li>
    <li>In the BookSnap app open a book → <b>Scan</b> → <b>💻 PC</b> → <b>Scan the QR code</b>.<br>
      <span class="muted">Or type this in the app:</span></li>`;
  $("newcode").classList.add("hidden");

  // ---------------------------------------------------------- folder card
  $("folder").textContent = "📁 Change folder";
  const openBtn = document.createElement("button");
  openBtn.className = "btn"; openBtn.textContent = "🗂 Open folder";
  $("folder").after(openBtn);
  const showFolder = () => { $("folderInfo").innerHTML = `Pages are saved automatically to:<br><b>${esc(folder)}/${esc(safe(state.book))}/</b>`; };
  $("folder").onclick = async () => {
    const r = await (await fetch(api("choose-folder"), { method: "POST" })).json().catch(() => ({}));
    if (r.error) return toast(r.error, 5000);
    if (r.folder) { folder = r.folder; showFolder(); toast("New pages will be saved in " + folder); }
  };
  openBtn.onclick = () => fetch(api("open-folder"), { method: "POST" });
  showFolder();

  function setOnline(v) {
    if (v === online) return;
    online = v;
    $("pair").classList.toggle("hidden", v);
    $("session").classList.toggle("hidden", !v);
    $("thumbsCard").classList.toggle("hidden", !v && !received);
    UI.setControlsEnabled(v);
    $("liveEmpty").classList.toggle("hidden", v);
    if (!v) UI.showPhoneStatus("");
    setStatus(v ? "Phone connected" : received ? "Phone disconnected — waiting…" : "Waiting for phone…", v ? "ok" : received ? "bad" : "");
    if (v) cmd({ t: "pc-settings", originals: $("originals").checked });
    if (!v) setBusy(false);
  }

  // ---------------------------------------------------------- events from the phone
  let since = 0;
  async function eventLoop() {
    for (;;) {
      try {
        const resp = await fetch(api("events", { since, wait: 20 }));
        if (resp.status === 403) { location.reload(); return; }
        const r = await resp.json();
        if (r.last < since) since = 0;           // BookSnap PC was restarted
        else since = r.last;
        if (r.folder) folder = r.folder;
        setOnline(!!r.phone);
        for (const e of r.events) await handle(e);
      } catch {
        setStatus("BookSnap PC program is not running — start it again", "bad");
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  }
  async function handle(m) {
    switch (m.t) {
      case "state": {
        state = { ...state, ...m };
        $("bookName").textContent = state.book || "Book";
        UI.showState(state);
        $("filter").value = state.filter;
        $("torch").classList.toggle("hidden", !state.torch);
        showFolder(); counts();
        break;
      }
      case "shot":
        setBusy(false);
        for (const o of m.orders || []) figFor(o).classList.add("pending");
        setStatus(m.orders && m.orders.length > 1 ? `Captured pages ${pad(m.orders[0])}–${pad(m.orders[1])}` : "Captured", "ok");
        break;
      case "page": {
        received++;
        $("thumbsCard").classList.remove("hidden");
        const blob = await (await fetch(api("file", { name: m.file }))).blob().catch(() => null);
        if (blob) setThumb(m.order, blob, m.blurry);
        counts();
        if (m.blurry) {
          $("blurwarn").textContent = `⚠ Page ${Math.round(m.order)} looks blurry. Press ⌫ to retake it before turning the page.`;
          $("blurwarn").classList.remove("hidden");
          setStatus(`Page ${Math.round(m.order)} looks blurry`, "bad");
        }
        break;
      }
      case "undone":
        for (const o of m.orders || []) { const f = $("thumbs").querySelector(`[data-o="${o}"]`); if (f) { const img = f.querySelector("img"); if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src); f.remove(); } }
        received = Math.max(0, received - (m.orders || []).length);
        $("blurwarn").classList.add("hidden");
        setStatus("Last photo deleted — capture again", "ok");
        counts();
        break;
      case "sync-start":
        for (const f of [...$("thumbs").children]) if (+f.dataset.o > m.total) { const img = f.querySelector("img"); if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src); f.remove(); }
        toast(`Getting all ${m.total} pages from the phone…`);
        break;
      case "geo": phoneGeo = m.geo; phoneGeoAt = Date.now(); break;
      case "status": UI.showPhoneStatus(m.text, m.ring); break;
      case "detected": case "lock-photo": UI.handleReply(m); break;
      case "busy": setBusy(false); toast("Phone is busy — try again"); break;
      case "error": setBusy(false); toast("Phone: " + m.msg, 4000); break;
    }
  }
  function counts() {
    $("counts").textContent = `${received} pages saved on this computer this session · ${state.count} in the book on the phone · ${FILTER_NAMES[state.filter] || state.filter}`;
    $("pdf").disabled = false;
  }

  // ---------------------------------------------------------- controls
  function setBusy(v) {
    busy = v;
    $("capture").classList.toggle("busy", v);
    $("capture").innerHTML = v ? "⏳ Capturing…" : "📸 Capture <kbd>Space</kbd>";
    clearTimeout(busyTimer);
    if (v) busyTimer = setTimeout(() => { setBusy(false); toast("No answer from the phone"); }, 20000);
  }
  const capture = () => {
    if (!online || busy) return;
    setBusy(true);
    $("blurwarn").classList.add("hidden");
    const f = $("flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
    cmd({ t: "capture" });
  };
  const retake = () => { if (online && !busy) cmd({ t: "undo" }); };
  $("capture").onclick = capture;
  $("undo").onclick = retake;
  document.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input, select, textarea")) return;
    if (["Space", "Enter", "PageDown", "ArrowRight"].includes(e.code)) { e.preventDefault(); capture(); }
    else if (e.code === "Backspace" || e.code === "KeyZ") { e.preventDefault(); retake(); }
  });
  let liveBmp = null, phoneGeo = null, phoneGeoAt = 0;
  UI.setupControls(cmd, () => state, async () => ({ bmp: liveBmp, geo: phoneGeo }));
  $("filter").onchange = () => cmd({ t: "filter", f: $("filter").value });
  $("torch").onclick = () => { torchOn = !torchOn; $("torch").classList.toggle("on", torchOn); cmd({ t: "torch", on: torchOn }); };
  $("originals").onchange = () => cmd({ t: "pc-settings", originals: $("originals").checked });
  $("sync").onclick = () => { cmd({ t: "sync" }); toast("Asking the phone for all pages…"); };
  $("pdf").onclick = async () => {
    $("pdf").disabled = true; $("pdf").textContent = "Making PDF…";
    try {
      const names = await (await fetch(api("list"))).json();
      if (!names.length) throw new Error("no pages in the folder yet");
      const blobs = [];
      for (const n of names) blobs.push(await (await fetch(api("file", { name: n }))).blob());
      const pdf = await buildPdf(blobs, { title: state.book });
      const name = safe(state.book) + ".pdf";
      const r = await (await fetch(api("file", { name }), { method: "POST", body: pdf })).json();
      toast(`PDF saved (${names.length} pages): ${r.path}`, 6000);
    } catch (e) { toast("PDF failed: " + e.message, 5000); }
    $("pdf").disabled = false; $("pdf").textContent = "⬇ Make PDF";
  };

  // ---------------------------------------------------------- thumbnails
  const MAX_THUMBS = 60;
  function figFor(order) {
    let f = $("thumbs").querySelector(`[data-o="${order}"]`);
    if (!f) {
      f = document.createElement("figure");
      f.dataset.o = order;
      f.innerHTML = `<img alt=""><figcaption>${Math.round(order)}</figcaption>`;
      const after = [...$("thumbs").children].find((x) => +x.dataset.o < order);
      $("thumbs").insertBefore(f, after || null);
      while ($("thumbs").children.length > MAX_THUMBS) {
        const last = $("thumbs").lastElementChild, img = last.querySelector("img");
        if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
        last.remove();
      }
    }
    return f;
  }
  async function setThumb(order, blob, blurry) {
    const f = figFor(order);
    f.classList.toggle("blurry", !!blurry);
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

  // ---------------------------------------------------------- live view (JPEG frames from the phone)
  const video = $("video"), overlay = $("overlay");
  video.classList.add("hidden");
  const live = document.createElement("img");
  live.id = "liveimg"; live.alt = "";
  overlay.before(live);
  const small = document.createElement("canvas"), sctx = small.getContext("2d", { willReadFrequently: true });
  let frameSeq = 0;
  async function frameLoop() {
    for (;;) {
      try {
        const r = await fetch(api("frame", { after: frameSeq }));
        if (r.status === 200) {
          frameSeq = +r.headers.get("X-Seq") || frameSeq + 1;
          const blob = await r.blob();
          const bmp = await createImageBitmap(blob);
          const old = live.src;
          live.src = URL.createObjectURL(blob);
          if (old.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(old), 1000);
          if (liveBmp) liveBmp.close();
          liveBmp = bmp;
          if (phoneGeo && Date.now() - phoneGeoAt < 3000) UI.drawGeo(overlay, bmp.width, bmp.height, phoneGeo, state.rotate, state.count + 1);
          else drawOutline(bmp);
        } else await new Promise((res) => setTimeout(res, 500));
      } catch { await new Promise((res) => setTimeout(res, 1000)); }
    }
  }
  function drawOutline(bmp) {
    const vw = bmp.width, vh = bmp.height;
    const ctx = overlay.getContext("2d"), dpr = window.devicePixelRatio || 1, cw = overlay.clientWidth, ch = overlay.clientHeight;
    if (overlay.width !== Math.round(cw * dpr)) { overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const s0 = 360 / Math.max(vw, vh), W = Math.round(vw * s0), H = Math.round(vh * s0);
    small.width = W; small.height = H;
    sctx.drawImage(bmp, 0, 0, W, H);
    let geo;
    try { geo = P.detect(P.rotate({ w: W, h: H, d: sctx.getImageData(0, 0, W, H).data }, state.rotate), state.mode); } catch { return; }
    if (!geo.found) return;
    const s = Math.min(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    const pt = (fx, fy) => { const [ux, uy] = P.unrotPoint([fx, fy], state.rotate); return [ox + ux * vw * s, oy + uy * vh * s]; };
    ctx.lineWidth = 3; ctx.strokeStyle = "#22c55e";
    geo.pages.forEach((pg, i) => {
      ctx.fillStyle = "rgba(34,197,94,0.12)";
      ctx.beginPath();
      for (let k = 0; k <= 16; k++) { const x = pg.x0 + ((pg.x1 - pg.x0) * k) / 16; const [a, b] = pt(x, P.evalCurve(pg.top, x)); k ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
      for (let k = 16; k >= 0; k--) { const x = pg.x0 + ((pg.x1 - pg.x0) * k) / 16; ctx.lineTo(...pt(x, P.evalCurve(pg.bot, x))); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      const mx = (pg.x0 + pg.x1) / 2, [lx, ly] = pt(mx, (P.evalCurve(pg.top, mx) + P.evalCurve(pg.bot, mx)) / 2);
      ctx.fillStyle = "rgba(15,23,42,.75)"; ctx.beginPath(); ctx.arc(lx, ly, 22, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 18px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(state.count + i + 1), lx, ly);
    });
  }

  function safe(s) { return (String(s || "Book").replace(/[\\/:*?"<>|#%]+/g, " ").replace(/\s+/g, " ").trim() || "Book").slice(0, 80); }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  setStatus("Waiting for phone…");
  eventLoop();
  frameLoop();
}
