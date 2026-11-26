// Offline support: network first (so updates arrive), cache as fallback.
const CACHE = "booksnap-v37";
const FILES = ["./", "index.html", "css/app.css", "js/app.js", "js/db.js", "js/imgproc.js", "js/worker.js",
  "js/pdf.js", "js/camera.js", "js/remote.js", "js/pc.js", "js/pc-boot.js", "js/detect-worker.js", "js/pagenum.js", "js/pc-ui.js", "js/device.js", "js/pagesig.js", "js/lockedit.js", "js/zoomview.js", "js/pageview.js", "js/updater.js", "js/pc-local.js", "js/native.js", "vendor/capacitor-core.js", "pc.html", "css/pc.css",
  "vendor/peerjs.min.js", "vendor/qrcode.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => {
    if (r) return r;
    // offline: the PC page must not turn into the phone app
    return caches.match(/\/pc(\.html)?$/.test(new URL(req.url).pathname) ? "pc.html" : "index.html");
  })));
});
