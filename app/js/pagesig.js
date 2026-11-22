// Page "fingerprints" for Auto mode: is this a new page or one we already have?
// Pure functions (no DOM) so they can be tested in Node too.

// grayscale of an RGBA frame {w,h,d}
export function gray(f) {
  const n = f.w * f.h, g = new Uint8Array(n), d = f.d;
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}

// Crop the page area (fractions bbox, shrunk a little so the page edge / hands /
// table are left out) and scale it to `W` px wide grayscale.
export function pageCrop(f, bbox, W = 200, fixedH = 0) {
  const inset = 0.04;
  const x0 = Math.max(0, (bbox.x0 + (bbox.x1 - bbox.x0) * inset) * f.w), x1 = Math.min(f.w, (bbox.x1 - (bbox.x1 - bbox.x0) * inset) * f.w);
  const y0 = Math.max(0, (bbox.y0 + (bbox.y1 - bbox.y0) * inset) * f.h), y1 = Math.min(f.h, (bbox.y1 - (bbox.y1 - bbox.y0) * inset) * f.h);
  const cw = Math.max(8, x1 - x0), ch = Math.max(8, y1 - y0);
  const H = fixedH || Math.max(8, Math.round((W * ch) / cw));
  const out = new Float32Array(W * H), g = gray(f);
  for (let y = 0; y < H; y++) {
    const sy0 = Math.floor(y0 + (y * ch) / H), sy1 = Math.max(sy0 + 1, Math.floor(y0 + ((y + 1) * ch) / H));
    for (let x = 0; x < W; x++) {
      const sx0 = Math.floor(x0 + (x * cw) / W), sx1 = Math.max(sx0 + 1, Math.floor(x0 + ((x + 1) * cw) / W));
      let s = 0, c = 0;
      for (let yy = sy0; yy < Math.min(sy1, f.h); yy++) for (let xx = sx0; xx < Math.min(sx1, f.w); xx++) { s += g[yy * f.w + xx]; c++; }
      out[y * W + x] = c ? s / c : 0;
    }
  }
  return { w: W, h: H, d: out };
}

// Fingerprint: lightly blurred, brightness/contrast normalised (so a lamp
// change or exposure change does not look like a new page). Stored as bytes.
export function fingerprint(c) {
  const { w, h, d } = c, b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) {
      const yy = y + k, xx = x + j;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += d[yy * w + xx]; n++; }
    }
    b[y * w + x] = s / n;
  }
  let mean = 0;
  for (let i = 0; i < b.length; i++) mean += b[i];
  mean /= b.length;
  let v = 0;
  for (let i = 0; i < b.length; i++) v += (b[i] - mean) ** 2;
  const sd = Math.sqrt(v / b.length) || 1;
  const o = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = Math.max(0, Math.min(255, 128 + ((b[i] - mean) / sd) * 40));
  return { w, h, d: o };
}

// Difference between two fingerprints, allowing a small shift of the book
// (up to ±maxShift px in 200-px space ≈ ±3 % of the page). 0 = identical.
export function distance(a, b, maxShift = 6, step = 2) {
  if (!a || !b || a.w !== b.w || Math.abs(a.h - b.h) > 3) return 1e9;
  const w = a.w, h = Math.min(a.h, b.h), m = maxShift;
  let best = 1e9;
  for (let dy = -m; dy <= m; dy += step) for (let dx = -m; dx <= m; dx += step) {
    let s = 0, n = 0;
    for (let y = m; y < h - m; y += 2) {
      const ra = y * w, rb = (y + dy) * w + dx;
      for (let x = m; x < w - m; x += 2) { s += Math.abs(a.d[ra + x] - b.d[rb + x]); n++; }
    }
    const v = s / Math.max(1, n);
    if (v < best) best = v;
    if (best < 4) return best;            // clearly the same: stop early
  }
  return best;
}

// Tile-wise comparison: every tile of the page is aligned on its own (handles a
// slight tilt / perspective change of the book), then the median tile score is
// used (a thumb or shadow on one tile does not matter).
export function tileDistance(a, b, cols = 4, rows = 5, maxShift = 10, stopAbove = Infinity) {
  if (!a || !b || a.w !== b.w || Math.abs(a.h - b.h) > 4) return 1e9;
  const w = a.w, h = Math.min(a.h, b.h), m = maxShift;
  const tw = Math.floor((w - 2 * m) / cols), th = Math.floor((h - 2 * m) / rows);
  const tileScore = (tx, ty, dx, dy) => {
    let s = 0, n = 0;
    for (let y = ty; y < ty + th; y += 2) {
      const ra = y * w, rb = (y + dy) * w + dx;
      for (let x = tx; x < tx + tw; x += 2) { s += Math.abs(a.d[ra + x] - b.d[rb + x]); n++; }
    }
    return s / Math.max(1, n);
  };
  const scores = [], half = Math.floor((rows * cols) / 2) + 1;
  let above = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const tx = m + c * tw, ty = m + r * th;
    let best = 1e9, bx = 0, by = 0;
    for (let dy = -m; dy <= m; dy += 2) for (let dx = -m; dx <= m; dx += 2) {
      const v = tileScore(tx, ty, dx, dy);
      if (v < best) { best = v; bx = dx; by = dy; }
    }
    for (let dy = by - 1; dy <= by + 1; dy++) for (let dx = bx - 1; dx <= bx + 1; dx++) {
      if (Math.abs(dx) > m || Math.abs(dy) > m) continue;
      const v = tileScore(tx, ty, dx, dy);
      if (v < best) best = v;
    }
    scores.push(best);
    if (best >= stopAbove && ++above >= half) return best;   // most tiles differ: clearly another page
  }
  scores.sort((p, q) => p - q);
  return scores[Math.floor(scores.length / 2)];
}

// Tuned on test pages (W=320 fingerprints): same page moved / dimmed / thumb on
// it <= 8.9, a different page of the same book >= 12.8.
export const SIG_W = 320;
export const SAME_PAGE = 11.5;
export const isSame = (a, b) => tileDistance(a, b, 4, 5, 10, SAME_PAGE) < SAME_PAGE;
