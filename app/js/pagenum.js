// Reads the printed page number of a page (English 0-9 or Bangla ০-৯) from its
// top and bottom margin, fully offline (Tesseract, English + Bangla models).
import { isAndroid } from "./native.js";
const BN = "০১২৩৪৫৬৭৮৯";
let workerP = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("could not load " + src));
    document.head.appendChild(s);
  });
}

export function init() {
  if (workerP) return workerP;
  workerP = (async () => {
    const base = new URL("../vendor/tesseract/", import.meta.url).href;
    if (!window.Tesseract) await loadScript(base + "tesseract.min.js");
    const w = await window.Tesseract.createWorker(["eng", "ben"], 1, {
      workerPath: base + "worker.min.js",
      corePath: base + "core",
      langPath: base + "lang",
      // the Android build unpacks *.traineddata.gz inside the app; the website and iPhone app keep them packed
      gzip: !isAndroid(),
      workerBlobURL: false,
      cacheMethod: "none",
    });
    await w.setParameters({ tessedit_char_whitelist: "0123456789" + BN, tessedit_pageseg_mode: "11" });
    return w;
  })();
  workerP.catch(() => { workerP = null; });
  return workerP;
}

const toInt = (s) => parseInt(String(s).replace(/[০-৯]/g, (d) => String(BN.indexOf(d))), 10);

function words(data) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) out.push(w);
  return out;
}

// Width/height of a JPEG from its header (no decoding), or null.
async function jpegSize(blob) {
  const b = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: (b[i + 7] << 8) | b[i + 8], h: (b[i + 5] << 8) | b[i + 6] };
    i += 2 + len;
  }
  return null;
}

// A picture source: either a decoded bitmap, or a photo whose margin bands are decoded on demand
// (decoding only bands is quicker and uses far less memory than a full 12–16 MP picture).
function source(blob, size, bmp) {
  const bands = new Map();
  return {
    w: size.w, h: size.h,
    // returns { img, ox, oy } covering rows [y, y+hh) and columns [x, x+ww)
    async get(key, x, y, ww, hh) {
      if (bmp) return { img: bmp, ox: 0, oy: 0 };
      if (!bands.has(key)) bands.set(key, createImageBitmap(blob, x, y, ww, hh).then((img) => ({ img, ox: x, oy: y })));
      return bands.get(key);
    },
    close() { if (bmp) bmp.close(); for (const p of bands.values()) p.then((b) => b.img.close()).catch(() => {}); },
  };
}

// OCR one piece of a margin: rows `where` (top/bottom of the page), columns [cx0, cx1] (pixels).
// Returns [{ num, conf, where, xf }] — xf = position across the page (0..1).
async function readPiece(w, src, page, where, cx0, cx1) {
  const { x0, y0, x1, y1 } = page, W = x1 - x0, H = y1 - y0;
  const stripH = Math.max(24, Math.round(H * 0.1)), cw = Math.max(20, cx1 - cx0);
  const y = where === "bottom" ? y1 - stripH : y0;
  // one decoded band per margin, shared by all pages and pieces
  const band = await src.get(where + ":" + page.key, x0, y, W, stripH);
  // page numbers are ~1.3 % of the page height; scale so they come out ~40 px high (reads well, stays fast)
  const scale = Math.min(3, 3200 / H, 1600 / cw);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(cw * scale)); c.height = Math.max(1, Math.round(stripH * scale));
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(band.img, cx0 - band.ox, y - band.oy, cw, stripH, 0, 0, c.width, c.height);
  const { data } = await w.recognize(c, {}, { blocks: true, text: false });
  const found = [];
  for (const wd of words(data)) {
    const t = (wd.text || "").trim();
    if (!/^[0-9০-৯]{1,4}$/.test(t) || wd.confidence < 45) continue;
    const n = toInt(t);
    const mid = wd.bbox ? (wd.bbox.x0 + wd.bbox.x1) / 2 / scale + cx0 : (cx0 + cx1) / 2;
    if (n > 0 && n < 5000) found.push({ num: n, conf: wd.confidence, where, xf: (mid - x0) / W });
  }
  return found;
}

// Where the number was last seen (top/bottom, across the page) — the next page is read there first.
let hint = null;
try { hint = JSON.parse(localStorage.getItem("booksnap.pnHint") || "null"); } catch {}
const saveHint = (h) => { hint = h; try { localStorage.setItem("booksnap.pnHint", JSON.stringify(h)); } catch {} };

// Read the page number of one page rectangle, piece by piece, stopping as soon as the expected
// number (or, without one, a confident number) turns up: first where it was last time (and the
// mirrored side — odd/even pages swap), then the bottom margin, then the top margin.
async function readPage(w, src, page, expected) {
  const W = page.x1 - page.x0, all = [], seen = new Set();
  const good = (list) => list.find((f) => (expected != null ? f.num === expected : f.conf >= 75));
  const pieces = [];
  const spot = (where, xf, half) => pieces.push([where, Math.max(page.x0, Math.round(page.x0 + (xf - half) * W)), Math.min(page.x1, Math.round(page.x0 + (xf + half) * W))]);
  if (hint) { spot(hint.where, hint.xf, 0.17); if (Math.abs(hint.xf - 0.5) > 0.12) spot(hint.where, 1 - hint.xf, 0.17); }
  for (const where of ["bottom", "top"]) { spot(where, 0.5, 0.2); spot(where, 0.15, 0.17); spot(where, 0.85, 0.17); }
  // last resort: the whole margin line at once (more context helps unclear digits)
  for (const where of ["bottom", "top"]) spot(where, 0.5, 0.5);
  for (const [where, a, b] of pieces) {
    const k = where + ":" + Math.round((a - page.x0) / W * 20) + ":" + Math.round((b - page.x0) / W * 20);
    if (seen.has(k) || b - a < 10) continue;
    seen.add(k);
    const r = await readPiece(w, src, page, where, a, b);
    all.push(...r);
    const hit = good(r);
    if (hit) { saveHint({ where: hit.where, xf: hit.xf }); break; }
  }
  all.sort((a, b) => b.conf - a.conf || (b.where === "bottom") - (a.where === "bottom"));
  return all;
}

// Candidate page numbers of a finished page image [{ num, conf, where }], best first.
export async function readPageNumbers(blob, expected = null) {
  const w = await init();
  const bmp = await createImageBitmap(blob);
  const src = source(blob, { w: bmp.width, h: bmp.height }, bmp);
  try { return await readPage(w, src, { key: 0, x0: 0, y0: 0, x1: bmp.width, y1: bmp.height }, expected); } finally { src.close(); }
}

// Page number of the FIRST page in a just-taken photo, read straight from the photo
// (no need to wait for page processing). regions: page quads in photo fractions,
// left page first. expected: the number we hope for (helps with unclear digits).
export async function readNumberFromPhoto(blob, regions, expected = null) {
  const w = await init();
  const size = await jpegSize(blob).catch(() => null);
  const bmp = size ? null : await createImageBitmap(blob);
  const src = source(blob, size || { w: bmp.width, h: bmp.height }, bmp);
  try {
    const W = src.w, H = src.h;
    for (let i = 0; i < regions.length; i++) {
      const xs = regions[i].map((p) => p[0]), ys = regions[i].map((p) => p[1]);
      const page = { key: i, x0: Math.round(Math.max(0, Math.min(...xs) * W)), x1: Math.round(Math.min(W, Math.max(...xs) * W)), y0: Math.round(Math.max(0, Math.min(...ys) * H)), y1: Math.round(Math.min(H, Math.max(...ys) * H)) };
      if (page.x1 - page.x0 < 40 || page.y1 - page.y0 < 40) continue;
      const exp = expected != null ? expected + i : null;
      const n = pickNumber(await readPage(w, src, page, exp), exp);
      if (n != null) return n - i;
    }
    return null;
  } finally { src.close(); }
}

// Pick the page number: the expected one if it was read at all, else a confident one.
export function pickNumber(cands, expected = null) {
  if (expected != null) { const hit = cands.find((c) => c.num === expected); if (hit) return hit.num; }
  const best = cands.find((c) => c.conf >= 70);
  return best ? best.num : null;
}

export async function readPageNumber(blob, expected = null) {
  return pickNumber(await readPageNumbers(blob, expected), expected);
}
