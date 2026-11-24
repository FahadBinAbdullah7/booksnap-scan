// Phone <-> PC link over WebRTC (PeerJS). Photos travel directly between the
// two devices; the PeerJS broker only helps them find each other.
export const PREFIX = "booksnap-v1-";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

export const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
export function newCode(n = 6) {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return [...a].map((v) => ALPHABET[v % ALPHABET.length]).join("");
}
// phone link inside the QR code: /app on the website (Vercel shortens /index.html), index.html elsewhere
export const linkUrl = (code) => new URL((location.pathname.endsWith(".html") ? "index.html" : "app") + "#/link/" + code, location.href).href;
export const codeFromText = (t) => {
  const m = String(t).match(/#\/link\/([A-Za-z0-9]+)/);
  return normCode(m ? m[1] : t);
};

let loading = null;
export function loadPeer() {
  if (window.Peer) return Promise.resolve(window.Peer);
  loading = loading || new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = new URL("../vendor/peerjs.min.js", import.meta.url).href;
    s.onload = () => res(window.Peer);
    s.onerror = () => { loading = null; rej(new Error("could not load the connection library")); };
    document.head.appendChild(s);
  });
  return loading;
}

// wait until the data channel has room (backpressure for big transfers)
export async function drain(conn, limit = 4e6) {
  const dc = conn && conn.dataChannel;
  while (dc && dc.readyState === "open" && dc.bufferedAmount > limit) await new Promise((r) => setTimeout(r, 40));
}

export class PhoneLink extends EventTarget {
  async connect(code, stream) {
    const Peer = await loadPeer();
    const target = PREFIX + normCode(code);
    this.peer = new Peer();
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("no internet connection to the link service")), 15000);
      this.peer.once("open", () => { clearTimeout(t); res(); });
      this.peer.once("error", (e) => { clearTimeout(t); rej(e); });
    });
    this.conn = this.peer.connect(target, { reliable: true, serialization: "binary" });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("PC not found. Check the code and that the PC page is open.")), 15000);
      this.conn.once("open", () => { clearTimeout(t); res(); });
      this.peer.once("error", (e) => {
        clearTimeout(t);
        rej(e.type === "peer-unavailable" ? new Error("PC not found. Check the code and that the PC page is open.") : e);
      });
    });
    // heartbeat: a link that went silent (phone slept, Wi-Fi dropped) is closed so the app
    // reconnects by itself. Only used once the PC answers pings (older PC pages don't).
    this.lastRx = this.lastTick = Date.now(); this.heard = false;
    this.conn.on("data", (d) => {
      this.lastRx = Date.now();
      if (d && (d.t === "ping" || d.t === "pong")) {
        this.heard = true;
        if (d.t === "ping") try { this.conn.send({ t: "pong" }); } catch {}
        return;
      }
      this.dispatchEvent(new CustomEvent("msg", { detail: d }));
    });
    this.conn.on("close", () => this.fireClose());
    this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch {} });
    this.beat = setInterval(() => {
      const now = Date.now();
      if (now - this.lastTick > 8000) this.lastRx = Math.max(this.lastRx, now - 7000);   // we were asleep: give it a moment
      this.lastTick = now;
      if (!this.open) return this.fireClose();
      try { this.conn.send({ t: "ping" }); } catch {}
      if (this.heard && now - this.lastRx > 15000) this.fireClose();
    }, 4000);
    if (stream) this.call = this.peer.call(target, stream);
  }
  fireClose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.beat);
    this.dispatchEvent(new Event("close"));
  }
  get open() { return !!(this.conn && this.conn.open); }
  // live view as small JPEGs over the data channel (used with the native camera)
  startFrames(getJpeg) {
    this.stopFrames();
    let busy = false;
    this.frameTimer = setInterval(async () => {
      const dc = this.conn && this.conn.dataChannel;
      // drop pictures instead of queueing them: the PC always shows the newest one (no growing delay)
      if (busy || !this.open || (dc && dc.bufferedAmount > 96 * 1024)) return;
      busy = true;
      try { const b = await getJpeg(); if (b && b !== this.lastSent && this.open) { this.lastSent = b; this.conn.send({ t: "frame", ts: Date.now(), jpeg: await b.arrayBuffer() }); } } catch {}
      busy = false;
    }, 140);
  }
  stopFrames() { clearInterval(this.frameTimer); this.frameTimer = null; }
  async send(obj) {
    if (!this.open) return false;
    await drain(this.conn);
    this.conn.send(obj);
    return true;
  }
  close() {
    this.closed = true;
    clearInterval(this.beat);
    this.stopFrames();
    try { this.call && this.call.close(); } catch {}
    try { this.conn && this.conn.close(); } catch {}
    try { this.peer && this.peer.destroy(); } catch {}
    this.conn = null;
  }
}

// ---------------------------------------------------------------- direct Wi-Fi link
// Talks to "BookSnap PC" (booksnap_pc.py) on the laptop over plain HTTP on the
// local network: no internet service, no relay. Address looks like
// "192.168.0.103:8765/AB12CD" or the QR text "http://192.168.0.103:8765/?booksnap=AB12CD".
export function parseLocal(text) {
  const t = String(text || "").trim();
  let m = t.match(/^https?:\/\/([^/?#\s]+)\/?\?booksnap=([A-Za-z0-9]+)/);
  if (m) return { host: m[1], token: m[2].toUpperCase() };
  m = t.match(/^(?:https?:\/\/)?((?:\d{1,3}\.){3}\d{1,3}(?::\d+)?|[A-Za-z0-9.-]+\.local(?::\d+)?)\s*[/\s]\s*([A-Za-z0-9]{4,})$/);
  if (m) return { host: m[1].includes(":") ? m[1] : m[1] + ":8765", token: m[2].toUpperCase() };
  return null;
}
export const isLocalAddress = (t) => !!parseLocal(t);

async function fetchT(url, opts = {}, ms = 8000, outer = null) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  const stop = () => ac.abort();
  if (outer) outer.addEventListener("abort", stop);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(id); if (outer) outer.removeEventListener("abort", stop); }
}

// Look for BookSnap PC on the same Wi-Fi when its address changed (router gave
// the computer a new IP): try every address in the subnet with the pairing code.
// only accept a real BookSnap PC with our pairing code (other devices may answer too)
async function isBookSnap(r, token) {
  try { const j = await r.json(); return j && j.booksnap === 1 && String(j.token).toUpperCase() === String(token).toUpperCase(); }
  catch { return false; }
}

export async function discoverPc(token, lastHost) {
  const m = String(lastHost).match(/^(\d+\.\d+\.\d+)\.(\d+)(?::(\d+))?$/);
  if (!m) return null;
  const [, net, , port = "8765"] = m;
  const hosts = [];
  for (let i = 1; i < 255; i++) hosts.push(`${net}.${i}:${port}`);
  let found = null, next = 0;
  const worker = async () => {
    while (!found && next < hosts.length) {
      const h = hosts[next++];
      try {
        const r = await fetchT(`http://${h}/api/hello?t=${token}`, { method: "POST" }, 1500);
        if (r.ok && !found && (await isBookSnap(r, token))) found = h;
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  return found;
}

export class LocalLink extends EventTarget {
  async connect(text, { discover = true } = {}) {
    const p = parseLocal(text);
    if (!p) throw new Error("That is not a BookSnap PC address");
    this.token = p.token;
    this.base = `http://${p.host}/api/`;
    let r = null;
    try {
      r = await fetchT(this.url("hello"), { method: "POST" }, 4000);
      if (r.ok && !(await isBookSnap(r.clone(), p.token))) r = null;      // something else lives at that address now
    } catch { r = null; }
    if (r && r.status === 403) throw new Error("Wrong code — check the code on the PC page");
    if (!r) {
      const h = discover ? await discoverPc(p.token, p.host) : null;
      if (!h) throw new Error("PC not reachable. Is BookSnap PC running, and are the phone and PC on the same Wi-Fi?");
      this.base = `http://${h}/api/`;
      r = await fetchT(this.url("hello"), { method: "POST" }, 4000);
    }
    this.address = this.base.replace(/^http:\/\//, "").replace(/\/api\/$/, "") + "/" + this.token;
    if (r.status === 403) throw new Error("Wrong code — check the code on the PC page");
    if (!r.ok) throw new Error("PC answered with error " + r.status);
    this.alive = true;
    this.life = new AbortController();     // aborts every request when the link closes
    this.poll();
  }
  url(route, params = {}) {
    const q = new URLSearchParams({ t: this.token, ...params });
    return this.base + route + "?" + q;
  }
  get open() { return !!this.alive; }
  async poll() {
    let fails = 0;
    while (this.alive) {
      try {
        const r = await fetchT(this.url("cmd", { wait: 20 }), {}, 26000, this.life.signal);
        if (r.status === 403) { this.alive = false; this.stopFrames(); this.dispatchEvent(new Event("close")); return; }
        if (!r.ok) throw new Error("status " + r.status);
        const cmds = await r.json();
        if (!this.alive) return;              // closed while waiting: leave commands for the new link
        fails = 0;
        for (const c of cmds) this.dispatchEvent(new CustomEvent("msg", { detail: c }));
      } catch {
        if (!this.alive) return;
        if (++fails >= 3) { this.alive = false; this.stopFrames(); this.dispatchEvent(new Event("close")); return; }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  async send(m) {
    if (!this.alive) return false;
    try {
      if (m.t === "page") {
        const r = await fetchT(this.url("page", { order: m.order, side: m.side || "", blurry: m.blurry ? 1 : 0, book: this.book || "" }),
          { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: new Blob([m.jpeg], { type: "image/jpeg" }) }, 60000);
        return r.ok;
      }
      if (m.t === "original") {
        const r = await fetchT(this.url("original", { orders: (m.orders || []).join(",") }),
          { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: new Blob([m.jpeg], { type: "image/jpeg" }) }, 120000);
        return r.ok;
      }
      if (m.t === "state") this.book = m.book;
      const r = await fetchT(this.url("msg"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m) }, 10000);
      return r.ok;
    } catch { return false; }
  }
  // live view for the PC page: small JPEG frames ~3 per second
  startFrames(getJpeg) {
    this.stopFrames();
    let busy = false;
    this.frameTimer = setInterval(async () => {
      if (busy || !this.alive) return;
      busy = true;
      try {
        const b = await getJpeg();
        if (b && b !== this.lastSent) { this.lastSent = b; await fetchT(this.url("frame"), { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: b }, 3000); }
      } catch {}
      busy = false;
    }, 140);
  }
  stopFrames() { clearInterval(this.frameTimer); this.frameTimer = null; }
  close() { this.alive = false; this.stopFrames(); try { this.life && this.life.abort(); } catch {} }
}
