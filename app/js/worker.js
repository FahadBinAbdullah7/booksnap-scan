// Background worker: decodes a photo, finds the page(s), flattens, enhances,
// encodes JPEGs. Keeps the UI smooth while scanning.
import * as P from "./imgproc.js";

// bigger photos are scaled down first (memory safety; lower on low-end phones)
async function decode(blob, maxPixels = 20e6) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, Math.sqrt(maxPixels / (bmp.width * bmp.height)));
  const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  const id = ctx.getImageData(0, 0, c.width, c.height);
  return { w: id.width, h: id.height, d: id.data };
}

async function encode(img, quality = 0.88) {
  const c = new OffscreenCanvas(img.w, img.h);
  c.getContext("2d").putImageData(new ImageData(img.d, img.w, img.h), 0, 0);
  return c.convertToBlob({ type: "image/jpeg", quality });
}

// Cache the last decoded photo: both pages of a spread come from it,
// and re-edits of the same page are instant.
let cache = { key: null, rotate: null, img: null, geo: {} };

async function load(key, blob, rotate, mode, maxPixels) {
  if (cache.key !== key || cache.rotate !== rotate || cache.maxPixels !== maxPixels) {
    cache = { key: null, rotate: null, img: null, geo: {} };   // free memory first
    let img = await decode(blob, maxPixels);
    img = P.rotate(img, rotate);
    cache = { key, rotate, img, geo: {}, maxPixels };
  }
  if (mode && !cache.geo[mode]) cache.geo[mode] = P.detect(P.resize(cache.img, 1000), mode);
  return { img: cache.img, geo: mode ? cache.geo[mode] : null };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === "process") {
      const { key, blob, rotate, mode, sides, lock, maxPixels = 20e6, maxSide = 3600 } = e.data;
      const loaded = await load(key, blob, rotate || 0, lock && lock.mode === mode ? null : mode, maxPixels);
      const img = loaded.img, geo = lock && lock.mode === mode ? P.geoFromLock(lock) : loaded.geo;
      const pages = [];
      for (const s of sides) {
        // regular scan: the whole photo as it is (no trimming, tilt fix or line straightening)
        const plain = !!(lock && lock.plain);
        const r = P.renderPage(img, geo, s.side, plain
          ? { filter: s.filter, crop: s.crop, rot: s.rot || 0, maxSide, trimFrac: 0, deskew: false, straighten: false }
          : { filter: s.filter, crop: s.crop, rot: s.rot || 0, maxSide });
        const full = await encode(r.page, s.filter === "bw" ? 0.8 : 0.88);
        const thumb = await encode(P.resize(r.page, 360), 0.7);
        pages.push({ full, thumb, w: r.page.w, h: r.page.h, autoQuad: r.autoQuad, sharp: r.sharp, skew: r.skew });
      }
      // some cameras hand over huge PNG/raw stills: store the original as JPEG instead
      let original = null;
      if (blob.type !== "image/jpeg" || blob.size > 3.5e6) {
        const un = P.rotate(img, (360 - (rotate || 0)) % 360);
        original = await encode(P.resize(un, 4640), 0.86);
      }
      self.postMessage({ id, ok: true, result: { pages, found: geo.found, original } });
    } else if (type === "shrink") {
      const { blob, maxSide = 1700, quality = 0.72 } = e.data;
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
      const g = c.getContext("2d"); g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
      self.postMessage({ id, ok: true, result: await c.convertToBlob({ type: "image/jpeg", quality }) });
    } else if (type === "release") {
      cache = { key: null, rotate: null, img: null, geo: {} };
      self.postMessage({ id, ok: true, result: null });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
};
