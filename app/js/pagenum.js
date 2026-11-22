// Reads the printed page number of a page (English 0-9 or Bangla ০-৯) from its
// top and bottom margin, fully offline (Tesseract, English + Bangla models).
import { isNative } from "./native.js";
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
      // the Android build unpacks *.traineddata.gz inside the app; the website serves them packed
      gzip: !isNative(),
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

// Read numbers in the top and bottom margin of a rectangle of an image
// (left, middle or right — the whole width of the margin is read).
async function readStrips(w, bmp, x0, y0, x1, y1) {
  const W = x1 - x0, H = y1 - y0;
  const stripH = Math.max(30, Math.round(H * 0.13));
  // enlarge small page numbers (digits need ~40+ px height to read reliably)
  const scale = Math.min(3, Math.max(1300 / W, 110 / stripH));
  const found = [];
  for (const [where, y] of [["bottom", y1 - stripH], ["top", y0]]) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(W * scale)); c.height = Math.max(1, Math.round(stripH * scale));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, x0, y, W, stripH, 0, 0, c.width, c.height);
    const { data } = await w.recognize(c, {}, { blocks: true, text: false });
    for (const wd of words(data)) {
      const t = (wd.text || "").trim();
      if (!/^[0-9০-৯]{1,4}$/.test(t) || wd.confidence < 45) continue;
      const n = toInt(t);
      if (n > 0 && n < 5000) found.push({ num: n, conf: wd.confidence, where });
    }
    // a confident number in the bottom margin is enough; otherwise also look at the top
    if (found.some((f) => f.where === "bottom" && f.conf >= 75)) break;
  }
  found.sort((a, b) => b.conf - a.conf || (b.where === "bottom") - (a.where === "bottom"));
  return found;
}

// Candidate page numbers of a finished page image [{ num, conf, where }], best first.
export async function readPageNumbers(blob) {
  const w = await init();
  const bmp = await createImageBitmap(blob);
  try { return await readStrips(w, bmp, 0, 0, bmp.width, bmp.height); } finally { bmp.close(); }
}

// Page number of the FIRST page in a just-taken photo, read straight from the photo
// (no need to wait for page processing). regions: page quads in photo fractions,
// left page first. expected: the number we hope for (helps with unclear digits).
export async function readNumberFromPhoto(blob, regions, expected = null) {
  const w = await init();
  const bmp = await createImageBitmap(blob, { resizeWidth: 2200, resizeQuality: "high" });
  try {
    const W = bmp.width, H = bmp.height;
    for (let i = 0; i < regions.length; i++) {
      const xs = regions[i].map((p) => p[0]), ys = regions[i].map((p) => p[1]);
      const x0 = Math.max(0, Math.min(...xs) * W), x1 = Math.min(W, Math.max(...xs) * W);
      const y0 = Math.max(0, Math.min(...ys) * H), y1 = Math.min(H, Math.max(...ys) * H);
      if (x1 - x0 < 40 || y1 - y0 < 40) continue;
      const n = pickNumber(await readStrips(w, bmp, Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)), expected != null ? expected + i : null);
      if (n != null) return n - i;
    }
    return null;
  } finally { bmp.close(); }
}

// Pick the page number: the expected one if it was read at all, else a confident one.
export function pickNumber(cands, expected = null) {
  if (expected != null) { const hit = cands.find((c) => c.num === expected); if (hit) return hit.num; }
  const best = cands.find((c) => c.conf >= 70);
  return best ? best.num : null;
}

export async function readPageNumber(blob, expected = null) {
  return pickNumber(await readPageNumbers(blob), expected);
}
