// BookSnap image processing — pure JS, no DOM. Runs in the worker, the main
// thread (live preview) and in Node (tests).
//
// Image = { w, h, d: Uint8ClampedArray RGBA }
// Geometry is always in FRACTIONS of the (rotated) photo: x,y in [0,1].

export function makeImg(w, h) {
  return { w, h, d: new Uint8ClampedArray(w * h * 4) };
}

// ---------------------------------------------------------------- basics
export function resize(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.w, img.h));
  if (s === 1) return img;
  const W = Math.max(1, Math.round(img.w * s)), H = Math.max(1, Math.round(img.h * s));
  const out = makeImg(W, H), src = img.d, dst = out.d;
  const fx = img.w / W, fy = img.h / H;
  const sX = Math.max(1, Math.floor(fx / 3)), sY = Math.max(1, Math.floor(fy / 3));
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.min(img.h, Math.max(y0 + 1, Math.floor((y + 1) * fy)));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.min(img.w, Math.max(x0 + 1, Math.floor((x + 1) * fx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy += sY) {
        let i = (yy * img.w + x0) * 4;
        for (let xx = x0; xx < x1; xx += sX, i += 4 * sX) { r += src[i]; g += src[i + 1]; b += src[i + 2]; n++; }
      }
      const o = (y * W + x) * 4;
      dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n; dst[o + 3] = 255;
    }
  }
  return out;
}

export function rotate(img, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return img;
  const { w, h } = img;
  const W = deg === 180 ? w : h, H = deg === 180 ? h : w;
  const out = makeImg(W, H);
  const s = new Uint32Array(img.d.buffer, img.d.byteOffset, w * h);
  const o = new Uint32Array(out.d.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = s[y * w + x];
      if (deg === 90) o[x * W + (h - 1 - y)] = v;
      else if (deg === 180) o[(h - 1 - y) * w + (w - 1 - x)] = v;
      else o[(w - 1 - x) * W + y] = v;
    }
  }
  return out;
}

// fraction point in the original photo -> fraction point after rotating by deg (clockwise)
export function rotPoint([x, y], deg) {
  deg = ((deg % 360) + 360) % 360;
  if (deg === 90) return [1 - y, x];
  if (deg === 180) return [1 - x, 1 - y];
  if (deg === 270) return [y, 1 - x];
  return [x, y];
}
export const unrotPoint = (p, deg) => rotPoint(p, 360 - (((deg % 360) + 360) % 360));

export function crop(img, x, y, w, h) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(img.w - x, Math.round(w)); h = Math.min(img.h - y, Math.round(h));
  const out = makeImg(w, h);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * img.w + x) * 4;
    out.d.set(img.d.subarray(s, s + w * 4), r * w * 4);
  }
  return out;
}

export function trim(img, frac) {
  if (!frac) return img;
  const dx = Math.round(img.w * frac), dy = Math.round(img.h * frac);
  return crop(img, dx, dy, img.w - 2 * dx, img.h - 2 * dy);
}

export function luma(img) {
  const n = img.w * img.h, g = new Uint8Array(n), d = img.d;
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}

function percentileFromHist(hist, total, p) {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
  return 255;
}

// ---------------------------------------------------------------- binary morphology (O(n))
function morph(m, w, h, r, dilate) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const pre = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + m[row + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r), b = Math.min(w, x + r + 1), c = pre[b] - pre[a];
      tmp[row + x] = dilate ? (c > 0 ? 1 : 0) : (c === b - a ? 1 : 0);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), b = Math.min(h, y + r + 1), c = pre[b] - pre[a];
      out[y * w + x] = dilate ? (c > 0 ? 1 : 0) : (c === b - a ? 1 : 0);
    }
  }
  return out;
}

// morphological close with zero padding, so the image border doesn't act like paper
function closeMask(m, w, h, r) {
  const W = w + 2 * r, H = h + 2 * r, p = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) p.set(m.subarray(y * w, y * w + w), (y + r) * W + r);
  const c = morph(morph(p, W, H, r, true), W, H, r, false);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(c.subarray((y + r) * W + r, (y + r) * W + r + w), y * w);
  return out;
}

function labelComponents(m, w, h) {
  const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n), comps = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (!m[i] || lab[i]) continue;
    next++;
    let sp = 0, area = 0;
    stack[sp++] = i; lab[i] = next;
    while (sp) {
      const p = stack[--sp]; area++;
      const x = p % w;
      if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = next; stack[sp++] = p + 1; }
      if (p >= w && m[p - w] && !lab[p - w]) { lab[p - w] = next; stack[sp++] = p - w; }
      if (p < n - w && m[p + w] && !lab[p + w]) { lab[p + w] = next; stack[sp++] = p + w; }
    }
    comps.push({ id: next, area });
  }
  return { lab, comps };
}

function boxes(lab, w, h, comps) {
  const map = new Map(comps.map((c) => [c.id, { x0: w, y0: h, x1: 0, y1: 0 }]));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = lab[y * w + x];
    if (!l) continue;
    const b = map.get(l);
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  }
  return map;
}

function fillHoles(m, w, h) {
  // flood the non-paper area from the border; everything not reached is paper
  const n = w * h, out = new Uint8Array(n).fill(1), stack = new Int32Array(n);
  let sp = 0;
  const push = (p) => { if (!m[p] && out[p]) { out[p] = 0; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp], x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < n - w) push(p + w);
  }
  return out;
}

// ---------------------------------------------------------------- curve fitting
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / (A[r][r] || 1e-12);
  }
  return x;
}

function median(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  return a[a.length >> 1];
}

// robust least-squares polynomial; t should be roughly in [-1,1]
function polyfit(t, y, deg) {
  const n = t.length;
  let wts = new Float64Array(n).fill(1), coef = [median(y)];
  for (let it = 0; it < 4; it++) {
    const m = deg + 1, A = Array.from({ length: m }, () => new Array(m).fill(0)), b = new Array(m).fill(0);
    for (let i = 0; i < n; i++) {
      if (!wts[i]) continue;
      const pw = [1];
      for (let k = 1; k <= 2 * deg; k++) pw[k] = pw[k - 1] * t[i];
      for (let r = 0; r < m; r++) {
        b[r] += pw[r] * y[i];
        for (let c = 0; c < m; c++) A[r][c] += pw[r + c];
      }
    }
    for (let r = 0; r < m; r++) A[r][r] += 1e-6;
    coef = solve(A, b);
    const res = t.map((ti, i) => Math.abs(polyval(coef, ti) - y[i]));
    const mad = median(res);
    const thr = Math.max(2.5 * 1.4826 * mad, 0.004);
    wts = res.map((r) => (r <= thr ? 1 : 0));
  }
  return coef;
}

function polyval(c, t) {
  let v = 0;
  for (let k = c.length - 1; k >= 0; k--) v = v * t + c[k];
  return v;
}

// A curve is a polynomial in t = (x - xc) / xs, optionally plus a "curl" term
// k * ((dir*t + 1) / 2)^p: a straight edge that bends only towards one end
// (a book page curling into the spine). That shape cannot wiggle -> no wavy pages.
export function evalCurve(cv, x) {
  let t = (x - cv.xc) / cv.xs;
  if (cv.lo != null) t = Math.min(cv.hi, Math.max(cv.lo, t));
  let v = polyval(cv.c, t);
  if (cv.k) v += cv.k * Math.pow(Math.min(1, Math.max(0, (cv.dir * t + 1) / 2)), cv.p);
  return Math.min(1, Math.max(0, v));
}

const flat = (y) => ({ xc: 0.5, xs: 0.5, c: [y] });

// ---------------------------------------------------------------- page finding from the printed text
// Works where brightness alone fails (white page on a white / light table): the
// text block tells where the page is, and the paper edge is the strongest smooth
// edge line just outside the text block.

// ink = pixels clearly darker than their surroundings (text, rules, figures)
function inkMask(g, w, h) {
  const r = Math.max(3, Math.round(Math.max(w, h) * 0.02)), W1 = w + 1;
  const I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) { s += g[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + s; }
  }
  const m = new Uint8Array(w * h), bg = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
      const mean = (I[yb * W1 + xb] - I[ya * W1 + xb] - I[yb * W1 + xa] + I[ya * W1 + xa]) / ((xb - xa) * (yb - ya));
      const v = g[y * w + x];
      bg[y * w + x] = mean;
      if (v < mean - Math.max(12, mean * 0.08)) m[y * w + x] = 1;
    }
  }
  m.bg = bg;
  return m;
}

// Text-like ink: small blobs (letters, words), not big dark objects (a hand, a chair, the table edge).
function textCells(g, w, h) {
  const ink = inkMask(g, w, h);
  const { lab, comps } = labelComponents(ink, w, h);
  const bx = boxes(lab, w, h, comps);
  const ok = new Uint8Array(comps.length + 1);
  const maxH = h * 0.06, maxW = w * 0.15, minH = Math.max(2, Math.round(h * 0.0065));
  // paper brightness: letters sit on bright paper, junk (shadows, chair, hands) on darker ground
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const paper = percentileFromHist(hist, g.length, 0.9), bg = ink.bg;
  const gl = [];
  for (const c of comps) {
    const b = bx.get(c.id), bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, fill = c.area / (bw * bh);
    if (bh < minH || bh > maxH || c.area < 3 || bh > bw * 8) continue;
    // a letter / word, or a whole joined text line (Bangla headline joins words): moderately filled, not a thin rule
    const word = bw <= maxW && bw <= bh * 14 && fill <= 0.75 + 4 / (bw * bh);
    const line = bw <= w * 0.5 && bh >= minH * 1.5 && fill >= 0.12 && fill <= 0.6;
    if (!word && !line) continue;
    if (bg[((b.y0 + b.y1) >> 1) * w + ((b.x0 + b.x1) >> 1)] < paper * 0.6) continue;
    gl.push({ id: c.id, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, bw, bh });
  }
  // real text: each letter / word has neighbours on the same line; broken junk (chair, table
  // edge, curled page edges) does not
  {
    const G = Math.max(8, Math.round(maxH)), gw = Math.ceil(w / G), gh = Math.ceil(h / G), bucket = new Map();
    gl.forEach((q, k) => { const key = ((q.cy / G) | 0) * gw + ((q.cx / G) | 0); if (!bucket.has(key)) bucket.set(key, []); bucket.get(key).push(k); });
    for (const q of gl) {
      const bxk = (q.cx / G) | 0, byk = (q.cy / G) | 0, R = Math.ceil((3.5 * q.bh + q.bw) / G) + 1;
      let nb = 0;
      for (let yy = byk - 1; yy <= byk + 1 && nb < 2; yy++) for (let xx = bxk - R; xx <= bxk + R && nb < 2; xx++) {
        if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
        for (const k of bucket.get(yy * gw + xx) || []) {
          const o = gl[k];
          if (o === q) continue;
          const mh = Math.max(q.bh, o.bh);
          if (Math.abs(o.cy - q.cy) < 0.6 * mh && Math.abs(o.cx - q.cx) < 3.5 * mh + (q.bw + o.bw) / 2 && o.bh < 2.5 * q.bh && q.bh < 2.5 * o.bh) { if (++nb >= 2) break; }
        }
      }
      if (nb >= 2) ok[q.id] = 1;
    }
  }
  const cs = Math.max(4, Math.round(Math.max(w, h) / 48));
  const cw = Math.ceil(w / cs), ch = Math.ceil(h / cs), cnt = new Uint16Array(cw * ch);
  let total = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = lab[y * w + x];
    if (l && ok[l]) { cnt[((y / cs) | 0) * cw + ((x / cs) | 0)]++; total++; }
  }
  const cells = new Uint8Array(cw * ch), thr = Math.max(2, cs * cs * 0.025);
  for (let i = 0; i < cells.length; i++) cells[i] = cnt[i] >= thr ? 1 : 0;
  const glyph = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { const l = lab[i]; if (l && ok[l]) glyph[i] = 1; }
  return { cells, cw, ch, cs, ink, lab, ok, glyph, inkFrac: total / (w * h) };
}

// largest run of "on" entries in a profile, allowing gaps up to maxGap; the run with most mass wins
function mainRun(prof, n, thr, maxGap, prefer) {
  let best = null, cur = null, gapN = 0;
  for (let k = 0; k <= n; k++) {
    const on = k < n && prof[k] >= thr;
    if (on) { if (!cur) cur = { a: k, b: k, m: 0 }; cur.b = k; cur.m += prof[k]; gapN = 0; }
    else if (cur && (++gapN > maxGap || k === n)) {
      const score = cur.m * (prefer != null && prefer >= cur.a && prefer <= cur.b ? 1.5 : 1);
      if (!best || score > best.score) best = { ...cur, score };
      cur = null; gapN = 0;
    }
  }
  return best;
}

// The text block from profiles of real letters (scattered junk cannot outvote lines of text).
function textBlock(g, w, h) {
  const T = textCells(g, w, h), gl = T.glyph;
  const cp = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cp[x] += gl[y * w + x];
  const sorted = Float32Array.from(cp).sort();
  const p90 = sorted[Math.floor(w * 0.9)];
  if (p90 < Math.max(3, h * 0.02)) return null;              // hardly any text
  const sm = (a, n, r) => { const o = new Float32Array(n); for (let k = 0; k < n; k++) { let s = 0, c = 0; for (let j = Math.max(0, k - r); j <= Math.min(n - 1, k + r); j++) { s += a[j]; c++; } o[k] = s / c; } return o; };
  const cps = sm(cp, w, Math.max(1, Math.round(w * 0.006)));
  const xr = mainRun(cps, w, p90 * 0.12, Math.round(w * 0.16), Math.round(w / 2));   // the spine gap (two inner margins) is bridged
  if (!xr || xr.b - xr.a < w * 0.15) return null;
  const x0 = xr.a, x1 = xr.b;
  // rows of text between x0..x1 (used for the overall block; each page refines its own)
  const rows = (a, b) => {
    // a text row has letters spread across the page (>= 3 of 8 sections); junk sits in one or two spots
    const NSEC = 8, span = Math.max(8, b - a + 1), r = Math.max(1, Math.round(h * 0.005));
    const hit = new Uint8Array(h * NSEC);
    for (let y = 0; y < h; y++) for (let x = a; x <= b; x++) if (gl[y * w + x]) hit[y * NSEC + Math.min(NSEC - 1, (((x - a) * NSEC) / span) | 0)] = 1;
    const spread = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      for (let k = 0; k < NSEC; k++) { let on = 0; for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r) && !on; yy++) on = hit[yy * NSEC + k]; c += on; }
      spread[y] = c;
    }
    // a big figure (few words) may sit between paragraphs: up to ~30% of the height
    return mainRun(spread, h, 2, Math.round(h * 0.3), Math.round(h / 2));
  };
  const yr = rows(x0, x1);
  if (!yr || yr.b - yr.a < h * 0.12) return null;
  return { x0, x1, y0: yr.a, y1: yr.b, rows, glyph: gl, area: ((x1 - x0) * (yr.b - yr.a)) / (w * h), inkFrac: T.inkFrac };
}

// Strongest smooth edge line in a band (dynamic programming, |dy| <= 2 per column).
// horizontal=true: a line y(x) for x in [a,b], band y in [lo(x), hi(x)].
// E(x,y) = edge strength; bias(x,y) is added (prefer edges near the text).
function seam(E, w, h, a, b, lo, hi, bias) {
  const n = b - a + 1;
  if (n < 5) return null;
  const H = h, cost = new Float32Array(n * H).fill(-1e9), from = new Int16Array(n * H);
  for (let i = 0; i < n; i++) {
    const x = a + i;
    let l = Math.max(1, Math.round(lo(x))), u = Math.min(H - 2, Math.round(hi(x)));
    if (l > u) { l = u = Math.min(H - 2, Math.max(1, Math.round((lo(x) + hi(x)) / 2))); }
    for (let y = l; y <= u; y++) {
      const e = E[y * w + x] + bias(x, y);
      if (i === 0) { cost[y] = e; continue; }
      let bv = -1e9, by = -1;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        const v = cost[(i - 1) * H + yy] - Math.abs(dy) * 1.5;
        if (v > bv) { bv = v; by = yy; }
      }
      if (bv < -1e8) {                       // band jumped: allow a bigger step, at a price
        for (let yy = 0; yy < H; yy++) {
          const v = cost[(i - 1) * H + yy] - Math.abs(yy - y) * 1.5;
          if (v > bv) { bv = v; by = yy; }
        }
      }
      cost[i * H + y] = bv + e; from[i * H + y] = by;
    }
  }
  let y = -1, bv = -1e9;
  for (let yy = 0; yy < H; yy++) if (cost[(n - 1) * H + yy] > bv) { bv = cost[(n - 1) * H + yy]; y = yy; }
  if (y < 0 || bv < -1e8) return null;
  const ys = new Float32Array(n), es = new Float32Array(n);
  for (let i = n - 1; i >= 0; i--) { ys[i] = y; es[i] = E[y * w + a + i]; y = from[i * H + y]; }
  return { ys, es };
}

// Edge features from a lightly blurred luma, for horizontal edges (and, transposed, vertical ones):
//  D  = signed step across the line (below minus above)
//  Ln = thin dark line (page edge / shadow line): darker than both sides
function edgeFeatures(g, w, h) {
  const b = boxBlur(Float32Array.from(g), w, h, 1);
  const mk = (bb, W, H, at) => {
    const D = new Float32Array(W * H), Ln = new Float32Array(W * H);
    for (let y = 3; y < H - 3; y++) for (let x = 0; x < W; x++) {
      const up2 = at(bb, x, y - 2), dn2 = at(bb, x, y + 2), c = at(bb, x, y);
      D[y * W + x] = dn2 - up2;
      const l = Math.min(at(bb, x, y - 3), at(bb, x, y + 3)) - c;
      Ln[y * W + x] = l > 0 ? l : 0;
    }
    return { D, Ln, W, H };
  };
  const hor = mk(b, w, h, (bb, x, y) => bb[y * w + x]);
  const ver = mk(b, h, w, (bb, x, y) => bb[x * w + y]);       // transposed: "x" runs along y
  return { hor, ver };
}

// Best edge line y(x) = y0 + s*(x - xm) [+ curl] inside a band, for x in [xa, xb].
// Score = how consistent the step / dark line is along the WHOLE line (texture and
// junk do not line up). Among strong candidates, the one nearest the text wins
// (top sheet edge before the stack of pages, before the table edge).
function edgeLine(F, xa, xb, yLo, yHi, nearY, curlDir, avoid, inside = 0) {
  const { D, Ln, W, H } = F;
  const m = Math.max(2, Math.round(H * 0.007));
  const xm = (xa + xb) / 2, half = Math.max(1, (xb - xa) / 2);
  const step = Math.max(1, Math.round((xb - xa) / 160));
  const allX = [];
  for (let x = Math.round(xa); x <= xb; x += step) if (x >= 0 && x < W) allX.push(x);
  if (allX.length < 10) return null;
  // a page curls only near the spine: the straight part is found on the outer 60 % first
  const outer = curlDir ? allX.filter((x) => curlDir * (x - xm) / half <= 0.2) : allX;
  let xsamp = outer;
  // avoid: text pixels (same layout as D) — a line running along text is a text line, not the paper edge
  const scoreOf = (yfun) => {
    let sd = 0, sl = 0, n = 0, hit = 0, tex = 0, tn = 0;
    for (const x of xsamp) {
      const y = Math.round(yfun(x));
      if (y < 3 || y >= H - 3) continue;
      const i = y * W + x;
      sd += D[i]; sl += Ln[i]; n++;
      if (avoid && (avoid[i] || avoid[i - W] || avoid[i + W])) hit++;
      // the inner side of a paper edge is blank paper margin: no text, no stripes
      if (inside) for (let k = 3; k < 3 + m; k++) {
        const yy = y + inside * k;
        if (yy < 3 || yy >= H - 3) continue;
        const j = yy * W + x;
        tex += Math.abs(D[j]); tn++;
        if (avoid && avoid[j]) hit += 1 / m;
      }
    }
    if (n < xsamp.length * 0.7 || hit > n * 0.08) return 0;
    const sc = Math.max(Math.abs(sd / n), sl / n);
    if (inside && tn && tex / tn > Math.max(5, sc * 0.45)) return 0;
    return sc;
  };
  const lo = Math.max(3, Math.floor(yLo)), hi = Math.min(H - 4, Math.ceil(yHi));
  if (hi - lo < 2) return null;
  const maxS = 0.18, sStep = Math.max(0.004, 1.5 / half);
  const cands = [];
  for (let y0 = lo; y0 <= hi; y0++) {
    let best = 0, bs = 0;
    for (let sl = -maxS; sl <= maxS + 1e-9; sl += sStep) {
      const sc = scoreOf((x) => y0 + sl * (x - xm));
      if (sc > best) { best = sc; bs = sl; }
    }
    cands.push({ y0, s: bs, sc: best });
  }
  const top = Math.max(...cands.map((c) => c.sc));
  if (top < 3) return null;
  // strongest, with a mild preference for edges nearer the text
  const bandSz = Math.max(1, hi - lo);
  let pick = null, pv = -1;
  for (const c of cands) {
    const v = c.sc * (1 - 0.35 * Math.min(1, Math.abs(c.y0 - nearY) / bandSz));
    if (c.sc >= 3 && v > pv) { pv = v; pick = c; }
  }
  if (!pick) return null;
  // fine slope
  let bestS = pick.s, bestSc = pick.sc, bestY = pick.y0;
  for (let y0 = pick.y0 - 1; y0 <= pick.y0 + 1; y0 += 0.5) for (let sl = pick.s - sStep; sl <= pick.s + sStep; sl += sStep / 4) {
    const sc = scoreOf((x) => y0 + sl * (x - xm));
    if (sc > bestSc) { bestSc = sc; bestS = sl; bestY = y0; }
  }
  const res = { xm, y0: bestY, s: bestS, sc: bestSc, k: 0, p: 0, dir: curlDir || 0, half };
  // curl towards the spine: y += k * ((dir*t + 1)/2)^p, t in [-1,1] — scored on the whole width
  if (curlDir) {
    xsamp = allX;
    res.sc = bestSc = scoreOf((x) => bestY + bestS * (x - xm));
    const span = (hi - lo) + 10;
    for (const p of [3, 6, 12]) for (let k = -span * 0.6; k <= span * 0.6; k += 1) {
      if (!k) continue;
      const sc = scoreOf((x) => bestY + bestS * (x - xm) + k * Math.pow(Math.max(0, (curlDir * (x - xm) / half + 1) / 2), p));
      if (sc > res.sc * 1.08 && sc > bestSc) { bestSc = sc; res.k = k; res.p = p; }
    }
    if (res.k) res.sc = bestSc;
  }
  res.at = (x) => res.y0 + res.s * (x - xm) + (res.k ? res.k * Math.pow(Math.min(1, Math.max(0, (res.dir * (x - xm) / half + 1) / 2)), res.p) : 0);
  return res;
}

// Edge curve model: straight line, optionally with a curl towards one end (dir = +1 right, -1 left).
// Robust: fits on points (x, y fractions), ignores outliers, keeps the curl only if clearly better.
function fitEdge(xs, ys, x0, x1, curlDirs) {
  const xc = (x0 + x1) / 2, xsc = Math.max(1e-3, (x1 - x0) / 2);
  const t = xs.map((x) => (x - xc) / xsc);
  const fitWith = (p, dir) => {
    let wt = new Float64Array(t.length).fill(1), c = [median(ys), 0], k = 0;
    for (let it = 0; it < 5; it++) {
      const m = p ? 3 : 2, A = Array.from({ length: m }, () => new Array(m).fill(0)), bb = new Array(m).fill(0);
      for (let i = 0; i < t.length; i++) {
        if (!wt[i]) continue;
        const f = [1, t[i]];
        if (p) f.push(Math.pow(Math.max(0, (dir * t[i] + 1) / 2), p));
        for (let r = 0; r < m; r++) { bb[r] += f[r] * ys[i]; for (let q = 0; q < m; q++) A[r][q] += f[r] * f[q]; }
      }
      for (let r = 0; r < m; r++) A[r][r] += 1e-7;
      const sol = solve(A, bb);
      c = [sol[0], sol[1]]; k = p ? sol[2] : 0;
      const res = t.map((ti, i) => Math.abs(c[0] + c[1] * ti + (p ? k * Math.pow(Math.max(0, (dir * ti + 1) / 2), p) : 0) - ys[i]));
      const thr = Math.max(2.5 * 1.4826 * median(res), 0.003);
      wt = res.map((r) => (r <= thr ? 1 : 0));
      if (it === 4) {
        const kept = res.filter((r, i) => wt[i]);
        return { c, k, p, dir, err: Math.sqrt(kept.reduce((s, v) => s + v * v, 0) / Math.max(1, kept.length)), inl: kept.length / t.length };
      }
    }
  };
  let best = fitWith(0, 1);
  for (const dir of curlDirs) for (const p of [3, 6, 12]) {
    const f = fitWith(p, dir);
    // a curl must explain the edge clearly better and bend a visible amount
    if (f.err < best.err * 0.7 && Math.abs(f.k) > 0.004 && f.inl >= best.inl - 0.05) best = f;
  }
  const cv = { xc, xs: xsc, c: best.c, lo: -1, hi: 1 };
  if (best.p) { cv.k = best.k; cv.p = best.p; cv.dir = best.dir; }
  cv.err = best.err; cv.inl = best.inl;
  return cv;
}

let whyNot = "";
// How much a fold line runs through lines of text, compared with an ordinary column of
// the text block: ~0 for the gutter between two pages (two blank inner margins), ~1 when
// the "fold" is really a line in the middle of ONE page (a figure, a table rule).
function foldCrossesText(glyph, w, h, y0, y1, xAt, x0, x1) {
  const r = Math.max(2, Math.round(w * 0.005));
  y0 = Math.max(0, Math.round(y0)); y1 = Math.min(h - 1, Math.round(y1));
  const hitRows = (fx) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      const xc = Math.round(fx(y));
      let on = 0;
      for (let x = Math.max(0, xc - r); x <= Math.min(w - 1, xc + r) && !on; x++) on = glyph[y * w + x];
      n += on;
    }
    return n;
  };
  const refs = [];
  for (let k = 1; k <= 9; k++) { const xc = x0 + ((x1 - x0) * k) / 10; refs.push(hitRows(() => xc)); }
  refs.sort((a, b) => a - b);
  const ref = refs[6];
  return ref < 8 ? 0 : hitRows(xAt) / ref;
}
const CROSS_MAX = 0.6;

function detectByContent(img, mode, gray) {
  whyNot = "";
  const { w, h } = img;
  const T = textBlock(gray, w, h);
  if (!T) return (whyNot = "no text", null);
  const F = edgeFeatures(gray, w, h);
  const ctop = T.y0, cbot = T.y1, chh = Math.max(10, cbot - ctop), cwid = T.x1 - T.x0;
  const midY = (ctop + cbot) / 2 / h;
  const gap = Math.max(2, Math.round(h * 0.006));
  // share of bright paper in a band beside x (dir -1: left of x, +1: right), over the text rows
  let paperV = 0;
  { const hs = new Uint32Array(256); let n = 0;
    for (let y = ctop; y <= cbot; y += 2) for (let x = T.x0; x <= T.x1; x += 2) { hs[gray[y * w + x]]++; n++; }
    paperV = percentileFromHist(hs, n, 0.85); }
  const paperBeyond = (x, dir) => {
    const xa = Math.round(dir > 0 ? x + w * 0.015 : x - w * 0.09), xb = Math.round(dir > 0 ? x + w * 0.09 : x - w * 0.015);
    const a = Math.max(0, xa), b = Math.min(w - 1, xb);
    if (b - a < 2) return 0;
    let n = 0, on = 0;
    for (let y = ctop; y <= cbot; y += 2) for (let xx = a; xx <= b; xx += 2) { n++; if (gray[y * w + xx] >= paperV * 0.75) on++; }
    return on / n;
  };
  // the fold first (from the text block extents), so each page gets its own edge lines
  let G = null, fold = null;
  const top0 = new Int32Array(w).fill(-1), bot0 = new Int32Array(w).fill(-1);
  for (let x = T.x0; x <= T.x1; x++) { top0[x] = Math.round(ctop); bot0[x] = Math.round(cbot); }
  let oneSide = 0;                     // -1: the other page is left of the text, +1: right of it
  if (mode === "spread") {
    // a "fold" straight through lines of text is a line on ONE page (figure, rule), not the fold
    const cuts = (fx) => foldCrossesText(T.glyph, w, h, ctop, cbot, fx, T.x0, T.x1) > CROSS_MAX;
    fold = findFoldLine(gray, w, h, top0, bot0, T.x0, T.x1);
    if (fold && cuts((y) => (fold.a + (fold.b * y) / h) * w)) fold = null;
    let onePage = !fold && cwid / chh < 1.1;
    if (!fold && !onePage) {
      const g = findGutter(img, top0, bot0, T.x0, T.x1);
      if (g != null && cuts(() => g)) onePage = true; else G = g;
    }
    // no fold in the middle and the text is ONE page (its shape, or every split cuts its lines):
    // e.g. the other page is almost empty, only partly in the picture, or not there at all —
    // the fold is just outside the text, not inside it
    if (onePage) {
      const m = Math.round(w * 0.16), inset = Math.round(w * 0.02);
      const at = (f) => (f.a + f.b * midY) * w;
      // a fold beside the text needs paper (the other page) beyond it — not the table
      let fl = T.x0 > w * 0.06 ? findFoldLine(gray, w, h, top0, bot0, T.x0, T.x1, T.x0 - m, T.x0 + inset) : null;
      let fr = T.x1 < w * 0.94 ? findFoldLine(gray, w, h, top0, bot0, T.x0, T.x1, T.x1 - inset, T.x1 + m) : null;
      if (fl && (paperBeyond(at(fl), -1) < 0.5 || cuts((y) => (fl.a + (fl.b * y) / h) * w))) fl = null;
      if (fr && (paperBeyond(at(fr), 1) < 0.5 || cuts((y) => (fr.a + (fr.b * y) / h) * w))) fr = null;
      const pick = fl && (!fr || fl.s >= fr.s) ? fl : fr;
      if (pick) { fold = pick; oneSide = pick === fl ? -1 : 1; }
      else {
        // no fold visible at all: never cut through the text — the other page is on the side
        // of the text with more room in the picture
        oneSide = T.x0 >= w - 1 - T.x1 ? -1 : 1;
        G = oneSide === -1 ? Math.max(1, T.x0 - Math.round(w * 0.015)) : Math.min(w - 2, T.x1 + Math.round(w * 0.015));
      }
    }
    if (fold) G = Math.round((fold.a + fold.b * midY) * w);
  }
  // side edges: vertical lines just outside the text
  const sideBand = Math.max(8, cwid * 0.1);
  const glyphT = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (T.glyph[y * w + x]) glyphT[x * h + y] = 1;
  const vL = edgeLine(F.ver, ctop, cbot, T.x0 - sideBand, T.x0 - gap, T.x0, 0, glyphT, +1);
  const vR = edgeLine(F.ver, ctop, cbot, T.x1 + gap, T.x1 + sideBand, T.x1, 0, glyphT, -1);
  const sideOf = (v, fallbackX) => (v ? { a: (v.y0 - v.s * v.xm) / w, b: (v.s * h) / w, ok: true } : { a: fallbackX / w, b: 0, ok: false });
  // v.at(y) = x  ->  x = (y0 - s*xm) + s*y  (pixels) -> fractions: a = (y0 - s*xm)/w, b = s*h/w
  const sideL = sideOf(vL, Math.max(0, T.x0 - sideBand * 0.4)), sideR = sideOf(vR, Math.min(w - 1, T.x1 + sideBand * 0.4));
  let L = Math.max(0, Math.round((sideL.a + sideL.b * midY) * w)), R = Math.min(w - 1, Math.round((sideR.a + sideR.b * midY) * w));
  // the other page (beyond the fold) reaches to the edge of the picture (or as wide as this page)
  // (no paper there at all — just the table: the other page is not in the picture, a sliver marks it)
  const sliver = Math.round(w * 0.02);
  if (oneSide === -1 && G != null) { L = Math.max(0, paperBeyond(G, -1) < 0.5 ? G - sliver : G - (R - G)); sideL.a = L / w; sideL.b = 0; sideL.ok = false; }
  if (oneSide === 1 && G != null) { R = Math.min(w - 1, paperBeyond(G, 1) < 0.5 ? G + sliver : G + (G - L)); sideR.a = R / w; sideR.b = 0; sideR.ok = false; }
  if (R - L < 0.2 * w) return (whyNot = "too narrow", null);
  const ranges = G == null ? [[L, R, 0]] : [[L, G, 1], [G, R, -1]];
  const band = Math.max(8, chh * 0.16);
  const edges = { left: sideL.ok, right: sideR.ok, top: true, bot: true };
  const pages = ranges.map(([a, b, dir]) => {
    // text top / bottom of this page, from its middle columns (a slanted page does not fool it)
    const ca = Math.max(a, T.x0), cb = Math.min(b, T.x1), q = (cb - ca) * 0.25;
    const yr = cb - ca > 10 ? T.rows(Math.round(ca + q), Math.round(cb - q)) : null;
    const pt = yr ? yr.a : ctop, pb = yr ? yr.b : cbot;
    const pad = Math.round((b - a) * 0.03);
    const xa = a + pad, xb = b - pad;
    const eT = edgeLine(F.hor, xa, xb, pt - band, pt - gap, pt, dir, T.glyph, +1);
    const eB = edgeLine(F.hor, xa, xb, pb + gap, pb + band, pb, dir, T.glyph, -1);
    if (!eT) edges.top = false;
    if (!eB) edges.bot = false;
    const lineT = eT || { at: () => pt - band * 0.45 }, lineB = eB || { at: () => pb + band * 0.45 };
    const n = 60, tx = [], ty = [], bx = [], by = [];
    for (let k = 0; k <= n; k++) { const x = a + ((b - a) * k) / n; tx.push(x / w); ty.push(lineT.at(x) / h); bx.push(x / w); by.push(lineB.at(x) / h); }
    const dirs = dir ? [dir] : [];
    const pg = { x0: a / w, x1: b / w, top: fitEdge(tx, ty, a / w, b / w, dirs), bot: fitEdge(bx, by, a / w, b / w, dirs) };
    return straightenIfFlat(pg);
  });
  pages.forEach((pg, i) => {
    if (!pg.flat) return;
    const foldSide = fold || { a: G / w, b: 0 };
    const left = i === 0 ? sideL : foldSide, right = i === pages.length - 1 ? sideR : foldSide;
    pg.quad = [corner(pg.top, left), corner(pg.top, right), corner(pg.bot, right), corner(pg.bot, left)];
  });
  return {
    _F: F, _glyph: T.glyph, _T: T,
    found: true, mode, by: "text", L: L / w, R: R / w, gutter: G == null ? null : G / w, fold, pages,
    text: { x0: T.x0 / w, x1: T.x1 / w, top: ctop / h, bot: cbot / h, area: T.area, ink: T.inkFrac },
    edges,
  };
}


// How well an outline fits the photo: consistent edge strength along every page
// boundary, and no text left outside the pages. Used to pick between detectors.
function geoScore(geo, F, glyph, w, h) {
  if (!geo || !geo.found) return -1;
  const along = (pts, M) => {               // pts: [x,y] pixels on a horizontal (M=hor) or vertical (M=ver) boundary
    let sd = 0, sl = 0, n = 0;
    for (const [x, y] of pts) {
      const X = Math.round(M === F.hor ? x : y), Y = Math.round(M === F.hor ? y : x);
      if (Y < 3 || Y >= M.H - 3 || X < 0 || X >= M.W) continue;
      const i = Y * M.W + X;
      sd += M.D[i]; sl += M.Ln[i]; n++;
    }
    return n < pts.length * 0.6 ? 0 : Math.min(40, Math.max(Math.abs(sd / n), sl / n));
  };
  let tot = 0, cnt = 0;
  const polys = [];
  geo.pages.forEach((pg, i) => {
    const q = (pg.quad || pageQuad(pg)).map(([x, y]) => [x * w, y * h]);
    polys.push(q);
    const N = 60, top = [], bot = [], lft = [], rgt = [];
    for (let k = 0; k <= N; k++) {
      const xf = pg.x0 + ((pg.x1 - pg.x0) * (0.05 + (0.9 * k) / N));
      top.push([xf * w, evalCurve(pg.top, xf) * h]); bot.push([xf * w, evalCurve(pg.bot, xf) * h]);
      const f = 0.08 + (0.84 * k) / N;
      lft.push([q[0][0] + (q[3][0] - q[0][0]) * f, q[0][1] + (q[3][1] - q[0][1]) * f]);
      rgt.push([q[1][0] + (q[2][0] - q[1][0]) * f, q[1][1] + (q[2][1] - q[1][1]) * f]);
    }
    tot += along(top, F.hor) + along(bot, F.hor); cnt += 2;
    // outer sides only (the fold is scored by its own finder)
    if (geo.pages.length === 1 || i === 0) { tot += along(lft, F.ver); cnt++; }
    if (geo.pages.length === 1 || i === geo.pages.length - 1) { tot += along(rgt, F.ver); cnt++; }
  });
  let score = tot / Math.max(1, cnt);
  if (glyph) {
    const inside = (x, y) => polys.some((q) => { let c = false; for (let a = 0, b = 3; a < 4; b = a++) { const [xa, ya] = q[a], [xb, yb] = q[b]; if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) c = !c; } return c; });
    let all = 0, out = 0;
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) if (glyph[y * w + x]) { all++; if (!inside(x, y)) out++; }
    if (all > 50) score *= Math.max(0, 1 - 2.5 * (out / all));
  }
  return score;
}

// ---------------------------------------------------------------- is this a book page? (Auto mode)
// A frame is only worth a photo when it shows a page of text, and nothing (a hand,
// an arm, the next page being turned) covers it. `pts`: the page area to check
// (fractions: 4 corners, or 6 for a locked 2-page area) — default: the detected pages.
// ref (optional, kept by the caller between frames, locked area only): where the paper was on the
// last clean frame. A hand / arm is then anything new that covers that paper — also where the
// text block shrank around it.
export function bookCheck(img, geo, pts = null, preT, ref = null) {
  const { w, h, d } = img, gray = luma(img);
  const T = preT !== undefined ? preT : textBlock(gray, w, h);
  // page polygon(s) in pixels
  let polys = [];
  if (pts && pts.length && Array.isArray(pts[0][0])) polys = pts;           // list of quads
  else if (pts && pts.length === 6) { const [a, b, c, e, f, g] = pts; polys = [[a, b, f, g], [b, c, e, f]]; }
  else if (pts && pts.length === 4) polys = [pts];
  else if (geo && geo.found) polys = geo.pages.map((pg) => pg.quad || pageQuad(pg));
  polys = polys.map((q) => q.map(([x, y]) => [x * w, y * h]));
  if (!polys.length) return { ok: false, why: "nopage", text: 0 };
  const inside = (x, y) => polys.some((q) => { let c = false; for (let a = 0, b = q.length - 1; a < q.length; b = a++) { const [xa, ya] = q[a], [xb, yb] = q[b]; if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) c = !c; } return c; });
  // page area and text inside it
  let area = 0, glyphIn = 0, rowsWithText = new Set();
  const step = 2;
  const pageMask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    if (!inside(x, y)) continue;
    area++;
    for (let yy = y; yy < Math.min(h, y + step); yy++) for (let xx = x; xx < Math.min(w, x + step); xx++) pageMask[yy * w + xx] = 1;
    if (T && T.glyph[y * w + x]) { glyphIn++; rowsWithText.add((y / (h * 0.02)) | 0); }
  }
  const areaFrac = (area * step * step) / (w * h);
  if (areaFrac < 0.15) return { ok: false, why: "small", text: 0 };
  const textRows = rowsWithText.size;                       // ~2 % tall bands that contain letters
  const locked = !!pts;
  const hasText = !!T && T.area > (locked ? 0.03 : 0.06) && textRows >= (locked ? 5 : 8) && glyphIn / area > (locked ? 0.002 : 0.004);
  // paper brightness inside the page
  const hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) if (pageMask[i]) hist[gray[i]]++;
  const paperV = percentileFromHist(hist, area * step * step, 0.8);
  // things covering the page: non-paper blobs (dark, or skin-coloured; not letters) that come in
  // from the photo border (an arm / hand) and reach into the page (shrunk 5 % so a slightly
  // too large outline over the table does not count)
  const inner = polys.map((q) => { const cx = q.reduce((s_, p_) => s_ + p_[0], 0) / q.length, cy = q.reduce((s_, p_) => s_ + p_[1], 0) / q.length; return q.map(([x, y]) => [cx + (x - cx) * 0.9, cy + (y - cy) * 0.9]); });
  const inInner = (x, y) => inner.some((q) => { let c = false; for (let a = 0, b = q.length - 1; a < q.length; b = a++) { const [xa, ya] = q[a], [xb, yb] = q[b]; if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) c = !c; } return c; });
  // the shadow in the fold between two pages runs from the table above the book to the table
  // below it: near the fold only skin-coloured things count (a finger), not dark shadow
  let foldX = null;
  if (pts && pts.length === 6) {
    const [, FT, , , FB] = pts, dy = FB[1] - FT[1] || 1;
    foldX = (y) => (FT[0] + ((FB[0] - FT[0]) * (y / h - FT[1])) / dy) * w;
  } else if (!pts && geo && geo.found && geo.mode === "spread" && geo.gutter != null) {
    const f = geo.fold || { a: geo.gutter, b: 0 };
    foldX = (y) => (f.a + (f.b * y) / h) * w;
  }
  const foldBand = Math.max(3, Math.round(w * 0.025));
  const occ = new Uint8Array(w * h);
  for (let y = 0, i = 0; y < h; y++) {
    const fx = foldX ? foldX(y) : -1e9;
    for (let x = 0; x < w; x++, i++) {
      if (T && T.glyph[i]) continue;
      const j = i * 4, r = d[j], g = d[j + 1], b = d[j + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      const skin = (sat > 0.25 && r > b + 15 && gray[i] < paperV * 0.95)
        || (sat > 0.18 && r > g + 12 && r > b + 25 && gray[i] < paperV * 0.97);      // skin (also pale, well lit)
      if (skin || (gray[i] < paperV * 0.62 && Math.abs(x - fx) > foldBand)) occ[i] = 1;
    }
  }
  const om = morph(morph(occ, w, h, 1, false), w, h, 2, true);
  const { lab, comps } = labelComponents(om, w, h);
  const border = new Set();
  for (let x = 0; x < w; x++) { if (lab[x]) border.add(lab[x]); if (lab[(h - 1) * w + x]) border.add(lab[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { if (lab[y * w]) border.add(lab[y * w]); if (lab[y * w + w - 1]) border.add(lab[y * w + w - 1]); }
  let covered = 0, innerArea = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    if (!inInner(x, y)) continue;
    innerArea++;
    const l = lab[y * w + x];
    if (l && border.has(l)) covered++;
  }
  // also inside the text block (an outline can bend around a hand; the text block hardly does)
  let coveredText = 0;
  if (T) {
    const mx = (T.x1 - T.x0) * 0.03, my = (T.y1 - T.y0) * 0.03;
    let n = 0, c = 0;
    for (let y = Math.round(T.y0 + my); y <= T.y1 - my; y += step) for (let x = Math.round(T.x0 + mx); x <= T.x1 - mx; x += step) { n++; const l = lab[y * w + x]; if (l && border.has(l)) c++; }
    coveredText = n ? c / n : 0;
  }
  // only what covers the TEXT counts (the page area can include some table around the page,
  // especially a locked area — a dark or wooden table must not look like a hand)
  let coveredFrac = T ? coveredText : covered / Math.max(1, innerArea);
  // a hand over the text makes the text block shrink around it, so the text alone misses it
  // (locked area, which may hold table: compare with where the paper was on the last clean frame)
  let byPage = 0;
  const G = 48, GR = Math.max(8, Math.round((G * h) / w)), cwp = w / G, chp = h / GR;
  let paperCells = null;
  if (locked && ref) {
    const pc = new Float32Array(G * GR), oc = new Float32Array(G * GR), nc = new Float32Array(G * GR);
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = y * w + x;
      if (!pageMask[i]) continue;
      const c = Math.min(GR - 1, (y / chp) | 0) * G + Math.min(G - 1, (x / cwp) | 0);
      nc[c]++;
      const j = i * 4, r = d[j], g = d[j + 1], b = d[j + 2], mx = Math.max(r, g, b);
      const sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
      if ((T && T.glyph[i]) || (gray[i] > paperV * 0.72 && sat < 0.22)) pc[c]++;
      const l = lab[i];
      if (l && border.has(l)) oc[c]++;
    }
    paperCells = new Float32Array(G * GR);
    for (let c = 0; c < G * GR; c++) paperCells[c] = nc[c] ? pc[c] / nc[c] : 0;
    if (ref.paper && ref.w === G && ref.h === GR) {
      // only paper well inside the old page (2 cells in from its edge: the book may shift a little)
      let base = 0, hit = 0;
      for (let cy = 2; cy < GR - 2; cy++) for (let cx = 2; cx < G - 2; cx++) {
        let solid = true;
        for (let dy = -2; dy <= 2 && solid; dy++) for (let dx = -2; dx <= 2; dx++) if (ref.paper[(cy + dy) * G + cx + dx] < 0.7) { solid = false; break; }
        if (!solid) continue;
        base++;
        const c = cy * G + cx;
        if (nc[c] && oc[c] / nc[c] > 0.4) hit++;
      }
      if (base > 40) byPage = hit / base;
    }
  }
  if (byPage > 0.03) coveredFrac = Math.max(coveredFrac, byPage);
  if (coveredFrac > 0.015) return { ok: false, why: "covered", text: textRows, covered: +coveredFrac.toFixed(3) };
  if (!hasText) return { ok: false, why: "notext", text: textRows, covered: +coveredFrac.toFixed(3) };
  if (ref && paperCells && hasText) { ref.paper = paperCells; ref.w = G; ref.h = GR; }   // clean page: remember its paper
  return { ok: true, why: "", text: textRows, covered: +coveredFrac.toFixed(3), textBox: T ? { x0: T.x0 / w, x1: T.x1 / w, y0: T.y0 / h, y1: T.y1 / h } : null };
}
// ---------------------------------------------------------------- page detection
// Finds the book/page (bright, low-saturation region) and, in "spread" mode,
// the gutter between the two pages. Returns per-page top/bottom edge curves,
// which follow the paper's bend and are used to flatten it.
export function detect(img, mode = "spread", dbg = null) {
  // two detectors: from the printed text (robust on white / light tables) and from the
  // paper's brightness (precise on contrasting tables). The outline that fits the
  // photo better wins.
  const gray = luma(img);
  let byText = null;
  try { byText = detectByContent(img, mode, gray); } catch (e) { if (dbg) dbg.err = e; }
  const byPaper = detectByPaper(img, mode, dbg);
  if (!byText) return byPaper;
  const F = byText._F, glyph = byText._glyph;
  if (dbg) dbg.T = byText._T;
  delete byText._F; delete byText._glyph; delete byText._T;
  if (!byPaper.found) return byText;
  const sT = geoScore(byText, F, glyph, img.w, img.h), sP = geoScore(byPaper, F, glyph, img.w, img.h);
  byText.score = +sT.toFixed(1); byPaper.score = +sP.toFixed(1);
  if (dbg) { dbg.scoreText = sT; dbg.scorePaper = sP; }
  // 2-page mode: an outline whose fold cuts through lines of text splits ONE page — never use it
  if (mode === "spread" && byText.text) {
    const t = byText.text, W = img.w, H = img.h;
    const cross = (g) => {
      if (g.gutter == null) return 0;
      const f = g.fold || { a: g.gutter, b: 0 };
      return foldCrossesText(glyph, W, H, t.top * H, t.bot * H, (y) => (f.a + (f.b * y) / H) * W, t.x0 * W, t.x1 * W);
    };
    const cT = cross(byText), cP = cross(byPaper);
    if (dbg) { dbg.crossText = cT; dbg.crossPaper = cP; }
    if (cP > CROSS_MAX && cT <= CROSS_MAX) return byText;
    if (cT > CROSS_MAX && cP <= CROSS_MAX) { byPaper.text = byText.text; return byPaper; }
  }
  if (sP > sT * 1.05) { byPaper.text = byText.text; return byPaper; }
  return byText;
}

function detectByPaper(img, mode = "spread", dbg = null) {
  const { w, h, d } = img, n = w * h;
  const V = new Uint8Array(n), S = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    V[i] = mx; S[i] = mx ? ((mx - mn) * 255) / mx : 0; hist[mx]++;
  }
  const p95 = percentileFromHist(hist, n, 0.95);
  const vThr = Math.max(45, p95 * 0.45);
  const side = Math.max(w, h);
  // local paper brightness: max-filter + blur of V. A pixel is paper only if it
  // is nearly as bright as the paper around it -> shadows/table split off.
  const Vf = Float32Array.from(V);
  const rl = Math.max(3, Math.round(side * 0.02));
  const Vbg = boxBlur(maxFilter(Vf, w, h, rl), w, h, rl);
  let m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = V[i] > vThr && V[i] > 0.72 * Vbg[i] && S[i] < 80 ? 1 : 0;

  const r1 = Math.max(2, Math.round(side * 0.012));
  const r2 = Math.max(1, Math.round(side * 0.006));
  // close small gaps from text first (they would fragment the page), then open
  // to cut thin bridges to neighbouring paper / cloth
  const rt = Math.max(1, Math.round(side * 0.004));
  m = closeMask(m, w, h, rt);
  m = morph(morph(m, w, h, r2, false), w, h, r2, true);

  if (dbg) dbg.raw = m.slice();
  const { lab, comps } = labelComponents(m, w, h);
  if (!comps.length) return fallback(mode);
  // prefer the component under the centre of the frame
  const votes = new Map();
  for (const fy of [0.4, 0.5, 0.6]) for (const fx of [0.35, 0.5, 0.65]) {
    const l = lab[Math.floor(fy * h) * w + Math.floor(fx * w)];
    if (l) votes.set(l, (votes.get(l) || 0) + 1);
  }
  let best = comps.reduce((a, c) => (c.area > a.area ? c : a));
  let bestVotes = -1;
  for (const c of comps) {
    const v = votes.get(c.id) || 0;
    if (v > bestVotes && c.area > 0.08 * n) { best = c; bestVotes = v; }
  }
  if (best.area < 0.1 * n) return fallback(mode);
  const keep = new Set([best.id]);
  if (mode === "spread") {
    // the gutter shadow may cut the spread in two: also keep a big piece
    // sitting right next to the chosen one (the other page)
    const box = boxes(lab, w, h, comps);
    const b0 = box.get(best.id);
    for (const c of comps) {
      if (c.id === best.id || c.area < 0.35 * best.area) continue;
      const b = box.get(c.id);
      const gap = Math.max(b.x0 - b0.x1, b0.x0 - b.x1);
      const vOverlap = Math.min(b.y1, b0.y1) - Math.max(b.y0, b0.y0);
      if (gap < 0.06 * w && vOverlap > 0.6 * Math.min(b.y1 - b.y0, b0.y1 - b0.y0)) keep.add(c.id);
    }
  }
  for (let i = 0; i < n; i++) m[i] = keep.has(lab[i]) ? 1 : 0;
  if (keep.size > 1) {
    // bridge the gutter gap between the two pieces
    const rg = Math.max(2, Math.round(w * 0.04));
    m = closeMask(m, w, h, rg);
  }
  m = fillHoles(m, w, h);
  m = closeMask(m, w, h, r1);   // smooth the outline
  m = fillHoles(m, w, h);

  if (dbg) { dbg.mask = m; dbg.w = w; dbg.h = h; }
  // per-column top/bottom of the paper
  const top = new Int32Array(w).fill(-1), bot = new Int32Array(w).fill(-1);
  let maxSpan = 0;
  for (let x = 0; x < w; x++) {
    let t = -1, b = -1;
    for (let y = 0; y < h; y++) if (m[y * w + x]) { t = y; break; }
    if (t < 0) continue;
    for (let y = h - 1; y >= t; y--) if (m[y * w + x]) { b = y; break; }
    top[x] = t; bot[x] = b;
    maxSpan = Math.max(maxSpan, b - t);
  }
  let L = -1, R = -1;
  for (let x = 0; x < w; x++) if (top[x] >= 0 && bot[x] - top[x] > 0.5 * maxSpan) { if (L < 0) L = x; R = x; }
  if (L < 0 || R - L < 0.2 * w) return fallback(mode);

  const gray = luma(img);
  const L0 = L, R0 = R;
  [L, R] = refineSides(gray, S, w, h, top, bot, L, R);
  // straight side edges (they slant when the photo is taken at an angle)
  const sideL = L === L0 ? sideLine(m, w, h, top, bot, L, R, "left") : { a: L / w, b: 0 };
  const sideR = R === R0 ? sideLine(m, w, h, top, bot, L, R, "right") : { a: R / w, b: 0 };

  // spread: find the fold between the pages — the crease line itself if visible
  let G = null, fold = null;
  if (mode === "spread") {
    fold = findFoldLine(gray, w, h, top, bot, L, R);
    if (fold) {
      const tops2 = [], bots2 = [];
      for (let x = L; x <= R; x++) if (top[x] >= 0) { tops2.push(top[x]); bots2.push(bot[x]); }
      G = Math.round((fold.a + fold.b * ((median(tops2) + median(bots2)) / 2 / h)) * w);
    } else G = findGutter(img, top, bot, L, R);
  }

  const ranges = G == null ? [[L, R]] : [[L, G], [G, R]];
  // near the gutter the edge bends fastest, so only a tiny pad there
  // single page: at most one gentle bend; spread pages: also the curl towards the gutter
  const ranges2 = G == null ? [[L, R, 0.03, 0.03, 2]] : [[L, G, 0.03, 0.006, 3], [G, R, 0.006, 0.03, 3]];
  const pages = ranges2.map(([a, b, pl, pr, md]) => fitPage(top, bot, a, b, w, h, pl, pr, md));
  // flat pages get a 4-corner quad -> true perspective correction (CamScanner-style crop)
  pages.forEach((pg, i) => {
    if (!pg.flat) return;
    const foldSide = fold || { a: G / w, b: 0 };
    const left = i === 0 ? sideL : foldSide;
    const right = i === pages.length - 1 ? sideR : foldSide;
    pg.quad = [corner(pg.top, left), corner(pg.top, right), corner(pg.bot, right), corner(pg.bot, left)];
  });
  return { found: true, mode, L: L / w, R: R / w, gutter: G == null ? null : G / w, fold, pages };
}

// The fold between two pages: a long, thin crease (dark line, often with a bright
// edge) running top to bottom, possibly slanted. Found band by band, then a
// straight line x = a + b*y (fractions) is fitted through the band positions.
function findFoldLine(g0, w, h, top, bot, L, R, xa = null, xb = null) {
  const tops = [], bots = [];
  for (let x = L; x <= R; x++) if (top[x] >= 0) { tops.push(top[x]); bots.push(bot[x]); }
  const yt = median(tops), yb = median(bots), sp = yb - yt;
  if (sp < h * 0.3) return null;
  const half = Math.max(1, Math.round(w * 0.002)), off = Math.max(3, Math.round(w * 0.006)), k = Math.max(2, Math.round(w * 0.004));
  // search range: the middle of [L,R] by default, or an explicit range [xa,xb]
  const x0 = Math.max(off + k + half, Math.round(xa != null ? xa : L + 0.32 * (R - L)));
  const x1 = Math.min(w - 1 - off - k - half, Math.round(xb != null ? xb : L + 0.68 * (R - L)));
  if (x1 - x0 < 3) return null;
  const bands = 12, pts = [];
  for (let bi = 0; bi < bands; bi++) {
    const ya = Math.round(yt + sp * (0.04 + (0.92 * bi) / bands)), yb2 = Math.round(yt + sp * (0.04 + (0.92 * (bi + 1)) / bands));
    // column profile of this band (vertical average)
    const prof = new Float32Array(w);
    for (let y = ya; y < yb2; y++) for (let x = x0 - off - k; x <= x1 + off + k; x++) prof[x] += g0[y * w + x];
    const n = Math.max(1, yb2 - ya);
    let best = -1, bs = 0;
    for (let x = x0; x <= x1; x++) {
      let c = 0, s1 = 0, s2 = 0;
      for (let j = -half; j <= half; j++) c += prof[x + j];
      for (let j = off; j < off + k; j++) { s1 += prof[x - j]; s2 += prof[x + j]; }
      c /= (2 * half + 1) * n; s1 /= k * n; s2 /= k * n;
      const score = Math.min(s1, s2) - c;          // darker than both sides = crease
      if (score > bs) { bs = score; best = x; }
    }
    if (best > 0 && bs > 4) pts.push({ y: (ya + yb2) / 2 / h, x: best / w, s: bs });
  }
  if (pts.length < 6) return null;
  // robust straight line through the band positions
  const c = polyfit(pts.map((p) => p.y * 2 - 1), pts.map((p) => p.x), 1);
  const a = c[0] - c[1], b = c[1] * 2;
  const good = pts.filter((p) => Math.abs(a + b * p.y - p.x) < 0.012).length;
  if (good < Math.max(6, pts.length * 0.6) || Math.abs(b) > 0.15) return null;
  return { a, b, s: pts.reduce((t, p) => t + p.s, 0) / pts.length };
}

// left/right page edge as a straight line x = a + b*y (fractions), from the paper mask
function sideLine(m, w, h, top, bot, L, R, which) {
  const tops = [], bots = [];
  for (let x = L; x <= R; x++) if (top[x] >= 0) { tops.push(top[x]); bots.push(bot[x]); }
  const yt = median(tops), yb = median(bots), sp = yb - yt;
  const ys = [], xs = [];
  for (let y = Math.round(yt + 0.12 * sp); y <= yb - 0.12 * sp; y += 2) {
    let x = -1;
    if (which === "left") { for (let k = Math.max(0, L - Math.round(w * 0.08)); k < (L + R) / 2; k++) if (m[y * w + k]) { x = k; break; } }
    else { for (let k = Math.min(w - 1, R + Math.round(w * 0.08)); k > (L + R) / 2; k--) if (m[y * w + k]) { x = k; break; } }
    if (x > 0 && x < w - 1) { ys.push(y / h); xs.push(x / w); }
  }
  const fallback = { a: (which === "left" ? L : R) / w, b: 0 };
  if (ys.length < 10) return fallback;
  const c = polyfit(ys.map((y) => y * 2 - 1), xs, 1);     // x as a function of y
  const b = c[1] * 2, a = c[0] - c[1];                       // back to x = a + b*y
  return Math.abs(b) > 0.35 ? fallback : { a, b };           // implausible slant -> keep vertical
}

// where a (straight) top/bottom edge meets a side line
function corner(cv, side) {
  let x = side.a, y = 0;
  for (let k = 0; k < 6; k++) { y = polyval(cv.c, (x - cv.xc) / cv.xs); x = side.a + side.b * y; }
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
}

function fitPage(top, bot, a, b, w, h, padL = 0.03, padR = 0.03, maxDeg = 2) {
  const pa = Math.round((b - a) * padL), pb = Math.round((b - a) * padR);
  const tx = [], ty = [], bx = [], by = [];
  for (let x = a + pa; x <= b - pb; x++) {
    if (top[x] < 0) continue;
    if (top[x] > 1) { tx.push(x / w); ty.push(top[x] / h); }
    if (bot[x] < h - 2) { bx.push(x / w); by.push(bot[x] / h); }
  }
  const x0 = a / w, x1 = b / w, xc = (x0 + x1) / 2, xs = Math.max(1e-3, (x1 - x0) / 2);
  const span = b - a - pa - pb;
  const rms = (c, t, y) => {
    const r = t.map((ti, i) => Math.abs(polyval(c, ti) - y[i])).sort((p, q) => p - q);
    const keep = r.slice(0, Math.max(1, Math.floor(r.length * 0.8)));     // ignore the worst 20 % (noise)
    return Math.sqrt(keep.reduce((s, v) => s + v * v, 0) / keep.length);
  };
  const fit = (xs_, ys_, edge) => {
    if (xs_.length < Math.max(8, span * 0.25)) return flat(edge);
    const t = xs_.map((x) => (x - xc) / xs);
    // straight line first; a curve only if it explains the edge clearly better
    let best = polyfit(t, ys_, 1), bestErr = rms(best, t, ys_);
    for (let d = 2; d <= maxDeg && xs_.length > 15 * d; d++) {
      const c = polyfit(t, ys_, d), e = rms(c, t, ys_);
      if (e < bestErr * 0.6) { best = c; bestErr = e; }
    }
    return { xc, xs, c: best, lo: t[0], hi: t[t.length - 1] };
  };
  const pg = { x0, x1, top: fit(tx, ty, 0), bot: fit(bx, by, 1) };
  return straightenIfFlat(pg);
}

// How far an edge bows away from the straight line between its ends (fraction of image height).
function bend(cv, x0, x1) {
  const ya = evalCurve(cv, x0), yb = evalCurve(cv, x1);
  let m = 0;
  for (let k = 1; k < 30; k++) {
    const f = k / 30, x = x0 + (x1 - x0) * f;
    m = Math.max(m, Math.abs(evalCurve(cv, x) - (ya + (yb - ya) * f)));
  }
  return m;
}
const chord = (cv, x0, x1) => {
  const ya = evalCurve(cv, x0), yb = evalCurve(cv, x1);
  return { xc: (x0 + x1) / 2, xs: Math.max(1e-3, (x1 - x0) / 2), c: [(ya + yb) / 2, (yb - ya) / 2] };
};

// CamScanner-style: a page that is (nearly) flat gets straight edges = clean
// 4-corner crop. Curves are kept only when the page is clearly bent.
function straightenIfFlat(pg) {
  const ph = Math.max(0.05, (evalCurve(pg.bot, (pg.x0 + pg.x1) / 2) - evalCurve(pg.top, (pg.x0 + pg.x1) / 2)));
  const bt = bend(pg.top, pg.x0, pg.x1) / ph, bb = bend(pg.bot, pg.x0, pg.x1) / ph;
  pg.bendTop = +bt.toFixed(3); pg.bendBot = +bb.toFixed(3);
  const curved = (bt > 0.02 && bb > 0.02) || Math.max(bt, bb) > 0.045;
  if (!curved) { pg.top = chord(pg.top, pg.x0, pg.x1); pg.bot = chord(pg.bot, pg.x0, pg.x1); pg.flat = true; }
  return pg;
}

// Pull the left/right edges in to a long vertical step edge (page brighter on
// the inside). Cuts off a neighbouring page or table that touches the page.
function refineSides(g0, S, w, h, top, bot, L, R) {
  const k = Math.max(2, Math.round(w * 0.005)), T = 12;
  // vertical smoothing: long edges survive, short text strokes fade
  const g = new Float32Array(w * h), rv = Math.max(3, Math.round(h * 0.01));
  for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let y = -rv; y < h; y++) {
      if (y + rv < h) { s += g0[(y + rv) * w + x]; c++; }
      if (y - rv - 1 >= 0) { s -= g0[(y - rv - 1) * w + x]; c--; }
      if (y >= 0) g[y * w + x] = s / c;
    }
  }
  const widths = [[2, Math.max(4, Math.round(w * 0.008))], [4, Math.max(6, Math.round(w * 0.012))]];
  const vo = widths[1][1];
  const tops = [], bots = [];
  for (let x = L; x <= R; x++) if (top[x] >= 0) { tops.push(top[x]); bots.push(bot[x]); }
  const yt = median(tops), yb = median(bots), sp = yb - yt;
  const y0 = Math.round(yt + 0.08 * sp), y1 = Math.round(yb - 0.08 * sp);
  const strength = (x, sign) => {
    let hit = 0, n = 0;
    for (let y = y0; y <= y1; y += 2) {
      const i = y * w + x;
      // a) step edge: page brighter on the inside
      let a = 0, b = 0;
      for (let j = 1; j <= k; j++) { a += g[i - j]; b += g[i + j]; }
      let ok = (sign * (a - b)) / k > T;
      // b) thin dark gap line between two sheets (neutral grey, not a coloured ruled line)
      if (!ok && S[i] < 60) {
        for (const [half, off] of widths) {
          let c = 0, s1 = 0, s2 = 0;
          for (let j = -half; j <= half; j++) c += g[i + j];
          for (let j = off; j < off + k; j++) { s1 += g[i - j]; s2 += g[i + j]; }
          if (Math.min(s1, s2) / k - c / (2 * half + 1) > 5) { ok = true; break; }
        }
      }
      if (ok) hit++;
      n++;
    }
    return n ? hit / n : 0;
  };
  const scan = (from, to, sign) => {
    let best = -1, bs = 0;
    for (let x = Math.max(vo + k + 1, from); x <= Math.min(w - vo - k - 2, to); x++) {
      const s = strength(x, sign);
      if (s > bs) { bs = s; best = x; }
    }
    return bs > 0.3 ? best : -1;
  };
  const span = R - L;
  const r = scan(Math.round(L + 0.7 * span), R - 1, +1);    // bright left of edge
  const l = scan(L + 1, Math.round(L + 0.3 * span), -1);    // bright right of edge
  return [l > L + 0.015 * w ? l : L, r > 0 && r < R - 0.015 * w ? r : R];
}

function findGutter(img, top, bot, L, R) {
  const { w, h } = img, g = luma(img);
  // integral image for a local-mean "ink" detector
  const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) { s += g[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + s; }
  }
  const r = Math.max(4, Math.round(w * 0.015));
  const lo = Math.round(L + 0.35 * (R - L)), hi = Math.round(L + 0.65 * (R - L));
  const ink = new Float64Array(w), bright = new Float64Array(w);
  for (let x = lo; x <= hi; x++) {
    const span = bot[x] - top[x];
    if (top[x] < 0 || span <= 0) { ink[x] = 1; bright[x] = 1; continue; }
    const y0 = Math.round(top[x] + 0.12 * span), y1 = Math.round(bot[x] - 0.12 * span);
    let ic = 0, bs = 0, c = 0;
    for (let y = y0; y <= y1; y++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1), ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
      const mean = (I[yb * W1 + xb] - I[ya * W1 + xb] - I[yb * W1 + xa] + I[ya * W1 + xa]) / ((xb - xa) * (yb - ya));
      const v = g[y * w + x];
      if (v < mean - 12) ic++;
      bs += v; c++;
    }
    ink[x] = c ? ic / c : 1; bright[x] = c ? bs / c / 255 : 1;
  }
  const win = Math.max(2, Math.round(w * 0.006));
  const smooth = (a) => {
    const o = new Float64Array(w);
    for (let x = lo; x <= hi; x++) {
      let s = 0, c = 0;
      for (let k = -win; k <= win; k++) if (x + k >= lo && x + k <= hi) { s += a[x + k]; c++; }
      o[x] = s / c;
    }
    return o;
  };
  const ki = smooth(ink), kb = smooth(bright);
  const norm = (a) => {
    let mn = Infinity, mx = -Infinity;
    for (let x = lo; x <= hi; x++) { mn = Math.min(mn, a[x]); mx = Math.max(mx, a[x]); }
    return (x) => (a[x] - mn) / (mx - mn + 1e-9);
  };
  const ni = norm(ki), nb = norm(kb);
  let best = lo, bestS = Infinity;
  for (let x = lo; x <= hi; x++) {
    const s = ni(x) + 0.8 * nb(x);
    if (s < bestS) { bestS = s; best = x; }
  }
  return best;
}

function fallback(mode) {
  const pages = mode === "spread"
    ? [{ x0: 0, x1: 0.5, top: flat(0), bot: flat(1) }, { x0: 0.5, x1: 1, top: flat(0), bot: flat(1) }]
    : [{ x0: 0, x1: 1, top: flat(0), bot: flat(1) }];
  return { found: false, mode, L: 0, R: 1, gutter: mode === "spread" ? 0.5 : null, pages };
}

// Page geometry from a user-locked area (fractions of the rotated photo).
// single: [TL, TR, BR, BL]; spread: [TL, foldTop, TR, BR, foldBottom, BL]
export function geoFromLock(lock) {
  const mk = (quad) => {
    const xs = quad.map((p) => p[0]);
    return { quad, x0: Math.min(...xs), x1: Math.max(...xs), top: flat(Math.min(quad[0][1], quad[1][1])), bot: flat(Math.max(quad[2][1], quad[3][1])), flat: true };
  };
  const q = lock.pts;
  if (lock.mode === "spread" && q.length === 6) {
    const [TL, FT, TR, BR, FB, BL] = q;
    return { found: true, locked: true, mode: "spread", L: TL[0], R: TR[0], gutter: (FT[0] + FB[0]) / 2, pages: [mk([TL, FT, FB, BL]), mk([FT, TR, BR, FB])] };
  }
  return { found: true, locked: true, mode: "single", L: q[0][0], R: q[1][0], gutter: null, pages: [mk(q.slice(0, 4))] };
}

export function pageQuad(pg) {
  return [
    [pg.x0, evalCurve(pg.top, pg.x0)], [pg.x1, evalCurve(pg.top, pg.x1)],
    [pg.x1, evalCurve(pg.bot, pg.x1)], [pg.x0, evalCurve(pg.bot, pg.x0)],
  ];
}

// ---------------------------------------------------------------- warping
function bilinear(src, x, y, dst, o) {
  const w = src.w, h = src.h, d = src.d;
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i = (y0 * w + x0) * 4, j = i + w * 4;
  for (let c = 0; c < 3; c++) {
    const a = d[i + c] + (d[i + 4 + c] - d[i + c]) * fx;
    const b = d[j + c] + (d[j + 4 + c] - d[j + c]) * fx;
    dst[o + c] = a + (b - a) * fy;
  }
  dst[o + 3] = 255;
}

// Flatten a bent page: every column is stretched so the curved top edge
// becomes y=0 and the curved bottom edge becomes y=H.
export function dewarp(src, pg, maxSide = 3600) {
  const X0 = pg.x0 * src.w, X1 = pg.x1 * src.w, cols = X1 - X0;
  const hs = [];
  for (let k = 0; k <= 40; k++) {
    const xf = pg.x0 + ((pg.x1 - pg.x0) * k) / 40;
    hs.push((evalCurve(pg.bot, xf) - evalCurve(pg.top, xf)) * src.h);
  }
  const Hpx = Math.max(10, median(hs));
  const sc = Math.min(1, maxSide / Math.max(cols, Hpx));
  const W = Math.max(1, Math.round(cols * sc)), H = Math.max(1, Math.round(Hpx * sc));
  const out = makeImg(W, H);
  for (let u = 0; u < W; u++) {
    const sx = X0 + (u + 0.5) / sc - 0.5, xf = sx / src.w;
    const ty = evalCurve(pg.top, xf) * src.h, by = evalCurve(pg.bot, xf) * src.h;
    const step = (by - ty) / H;
    for (let v = 0; v < H; v++) bilinear(src, sx, ty + (v + 0.5) * step - 0.5, out.d, (v * W + u) * 4);
  }
  return out;
}

function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = from[i], [x, y] = to[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  const h = solve(A, b);
  return [...h, 1];
}

// Manual crop: straighten the 4-corner quad (fractions, TL TR BR BL) to a rectangle.
export function warpQuad(src, quad, maxSide = 3600) {
  const p = quad.map(([x, y]) => [x * src.w, y * src.h]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(dist(p[0], p[1]), dist(p[3], p[2]));
  let H = Math.max(dist(p[0], p[3]), dist(p[1], p[2]));
  const sc = Math.min(1, maxSide / Math.max(W, H));
  W = Math.max(1, Math.round(W * sc)); H = Math.max(1, Math.round(H * sc));
  const M = homography([[0, 0], [W, 0], [W, H], [0, H]], p);
  const out = makeImg(W, H);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const X = u + 0.5, Y = v + 0.5, z = M[6] * X + M[7] * Y + 1;
      bilinear(src, (M[0] * X + M[1] * Y + M[2]) / z - 0.5, (M[3] * X + M[4] * Y + M[5]) / z - 0.5, out.d, (v * W + u) * 4);
    }
  }
  return out;
}

// ---------------------------------------------------------------- enhancement (CamScanner-like)
// Background (paper + lighting) for one channel: remove dark text with a max
// filter on a 1/f-scale copy, then blur. Returned as a small array.
function background(img, ch) {
  const { w, h, d } = img;
  const f = Math.max(w, h) > 1600 ? 4 : 2;
  const sw = Math.ceil(w / f), sh = Math.ceil(h / f), s = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let sum = 0, c = 0;
    for (let yy = y * f; yy < Math.min(h, y * f + f); yy++)
      for (let xx = x * f; xx < Math.min(w, x * f + f); xx++) {
        const i = (yy * w + xx) * 4;
        sum += ch < 0 ? (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) / 256 : d[i + ch];
        c++;
      }
    s[y * sw + x] = sum / c;
  }
  const r = Math.max(2, Math.round(Math.max(sw, sh) * 0.02));
  // closing (max then min): erases text but keeps shadow edges sharp,
  // so the division removes hard shadows instead of leaving a halo
  const cl = minFilter(maxFilter(s, sw, sh, r), sw, sh, r);
  const rb = Math.max(1, Math.round(r / 3));
  const bl = boxBlur(boxBlur(cl, sw, sh, rb), sw, sh, rb);
  return { bg: bl, sw, sh, f };
}

function maxFilter(a, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (a[y * w + k] > m) m = a[y * w + k];
    t[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (t[k * w + x] > m) m = t[k * w + x];
    o[y * w + x] = m;
  }
  return o;
}

function minFilter(a, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 1e9;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (a[y * w + k] < m) m = a[y * w + k];
    t[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 1e9;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (t[k * w + x] < m) m = t[k * w + x];
    o[y * w + x] = m;
  }
  return o;
}

function boxBlur(a, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0, c = 0;
    for (let x = -r; x < w; x++) {
      const add = x + r, rem = x - r - 1;
      if (add < w) { s += a[y * w + add]; c++; }
      if (rem >= 0) { s -= a[y * w + rem]; c--; }
      if (x >= 0) t[y * w + x] = s / c;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let y = -r; y < h; y++) {
      const add = y + r, rem = y - r - 1;
      if (add < h) { s += t[add * w + x]; c++; }
      if (rem >= 0) { s -= t[rem * w + x]; c--; }
      if (y >= 0) o[y * w + x] = s / c;
    }
  }
  return o;
}

// divide channel `ch` (or luma if ch<0) by its background -> write to out channel(s)
function flattenChannel(img, ch, outD, outCh) {
  const { w, h, d } = img, { bg, sw, sh, f } = background(img, ch);
  for (let y = 0; y < h; y++) {
    const by = Math.min(sh - 1.001, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = by | 0, fy = by - y0;
    for (let x = 0; x < w; x++) {
      const bx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = bx | 0, fx = bx - x0, k = y0 * sw + x0;
      const a = bg[k] + (bg[k + 1] - bg[k]) * fx, b = bg[k + sw] + (bg[k + sw + 1] - bg[k + sw]) * fx;
      const back = Math.max(8, a + (b - a) * fy);
      const i = (y * w + x) * 4;
      const v = ch < 0 ? (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) / 256 : d[i + ch];
      outD[i + outCh] = (v / back) * 255;
    }
  }
}

function lumaHist(d, n) {
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) hist[(d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8]++;
  return hist;
}

function otsu(hist, n) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// Even out vertical shading bands (the gutter shadow runs top-to-bottom):
// scale each column so its bright paper level matches the page.
export function columnFlatten(img) {
  const { w, h, d } = img;
  const lvl = new Float32Array(w), hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor(h / 400));
  for (let x = 0; x < w; x++) {
    hist.fill(0); let n = 0;
    for (let y = 0; y < h; y += step) { const i = (y * w + x) * 4; hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; n++; }
    lvl[x] = Math.max(20, percentileFromHist(hist, n, 0.9));
  }
  const r = Math.max(2, Math.round(w * 0.01)), sm = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += lvl[k]; c++; }
    sm[x] = s / c;
  }
  const ref = Float32Array.from(sm).sort()[Math.floor(w * 0.9)];
  const out = makeImg(w, h), o = out.d;
  for (let x = 0; x < w; x++) {
    const g = Math.min(2.5, Math.max(1, ref / sm[x]));
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      o[i] = d[i] * g; o[i + 1] = d[i + 1] * g; o[i + 2] = d[i + 2] * g; o[i + 3] = 255;
    }
  }
  return out;
}

export const FILTERS = ["magic", "original", "gray", "bw"];

export function enhance(img, mode) {
  if (mode === "original") return img;
  const { w, h } = img, n = w * h, out = makeImg(w, h), o = out.d;
  if (mode === "magic") {
    for (let c = 0; c < 3; c++) flattenChannel(img, c, o, c);
    for (let i = 3; i < n * 4; i += 4) o[i] = 255;
    const black = Math.min(110, percentileFromHist(lumaHist(o, n), n, 0.005) + 15), white = 238;
    const k = 255 / (white - black);
    for (let j = 0; j < n * 4; j += 4) {
      const r = (o[j] - black) * k, g = (o[j + 1] - black) * k, b = (o[j + 2] - black) * k;
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      let R = y + (r - y) * 1.35, Gc = y + (g - y) * 1.35, B = y + (b - y) * 1.35;
      // paper: anything close to white becomes clean white (no grey/brown blotches)
      const t = y <= 175 ? 0 : y >= 225 ? 1 : ((y - 175) / 50) ** 2 * (3 - (2 * (y - 175)) / 50);
      // ink: a little darker and crisper
      const d = y < 150 ? Math.pow(Math.max(0, y) / 150, 1.3) * 150 / Math.max(1, y) : 1;
      o[j] = (R * d) * (1 - t) + 255 * t; o[j + 1] = (Gc * d) * (1 - t) + 255 * t; o[j + 2] = (B * d) * (1 - t) + 255 * t;
    }
    return out;
  }
  flattenChannel(img, -1, o, 0);
  const hist = new Uint32Array(256);
  for (let j = 0; j < n * 4; j += 4) hist[o[j]]++;
  const black = Math.min(110, percentileFromHist(hist, n, 0.005) + 15);
  const white = mode === "bw" ? 230 : 238, k = 255 / (white - black);
  let thr = 0;
  if (mode === "bw") {
    const h2 = new Uint32Array(256);
    for (let j = 0; j < n * 4; j += 4) h2[Math.max(0, Math.min(255, Math.round((o[j] - black) * k)))]++;
    thr = Math.min(210, Math.max(90, otsu(h2, n)));
  }
  for (let j = 0; j < n * 4; j += 4) {
    let v = (o[j] - black) * k;
    if (mode === "bw") v = v > thr ? 255 : 0;
    o[j] = o[j + 1] = o[j + 2] = v; o[j + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------- quality: blur, skew, sharpen
// Blur score: how sharp edges are (2nd derivative vs 1st), per direction, so
// both focus blur and motion blur are caught. Independent of page contrast.
// Returns { score, blurry } or null for nearly blank pages.
export function sharpness(img) {
  const s = resize(img, 1200), g = luma(s), w = s.w, h = s.h;
  const measure = (thr) => {
    let lx = 0, gxs = 0, cx = 0, ly = 0, gys = 0, cy = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Math.abs(g[i + 1] - g[i - 1]), gy = Math.abs(g[i + w] - g[i - w]);
      if (gx > thr) { lx += Math.abs(2 * g[i] - g[i - 1] - g[i + 1]); gxs += gx; cx++; }
      if (gy > thr) { ly += Math.abs(2 * g[i] - g[i - w] - g[i + w]); gys += gy; cy++; }
    }
    return { lx, gxs, cx, ly, gys, cy };
  };
  // strong edges first; faint (blurred) text only shows with a gentler threshold
  let m = measure(25);
  if (m.cx + m.cy < 0.003 * w * h) m = measure(10);
  if (m.cx + m.cy < 0.003 * w * h) {
    let sum = 0, sq = 0;
    for (let i = 0; i < g.length; i++) { sum += g[i]; sq += g[i] * g[i]; }
    const sd = Math.sqrt(Math.max(0, sq / g.length - (sum / g.length) ** 2));
    return sd > 22 ? { score: 0, blurry: true } : null;      // blank page: can't judge
  }
  let rx = m.gxs ? m.lx / m.gxs : 1, ry = m.gys ? m.ly / m.gys : 1;
  // Few edges in one direction: either motion blur smeared them into soft
  // ramps (low ratio at a gentle threshold) or the page simply has none
  // (e.g. only ruled lines) -> then judge by the other direction only.
  if (m.cx < 0.1 * m.cy || m.cy < 0.1 * m.cx) {
    const s2 = measure(5);
    if (m.cx < 0.1 * m.cy) rx = s2.cx > 0.02 * s2.cy ? s2.lx / s2.gxs : 1;
    if (m.cy < 0.1 * m.cx) ry = s2.cy > 0.02 * s2.cx ? s2.ly / s2.gys : 1;
  }
  const score = Math.min(rx, ry);
  return { score: +score.toFixed(3), blurry: score < 0.38 };
}

// Small rotation (degrees) of the text lines, found with a projection profile.
export function skewAngle(img, maxDeg = 5) {
  const s = resize(img, 900), g = luma(s), w = s.w, h = s.h;
  const xs = [], ys = [];
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 250000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (g[y * w + x] < 110) { xs.push(x - w / 2); ys.push(y); }
  if (xs.length < 0.002 * (w * h) / (step * step)) return 0;
  const bins = new Float64Array(h + w + 2), off = w / 2 + 1;
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    bins.fill(0);
    for (let k = 0; k < xs.length; k++) bins[Math.round(ys[k] - xs[k] * t + off)]++;
    let sum = 0;
    for (let k = 0; k < bins.length; k++) sum += bins[k] * bins[k];
    return sum;
  };
  const base = score(0);
  let best = 0, bs = base;
  for (let a = -maxDeg; a <= maxDeg; a += 0.5) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  const c = best;
  for (let a = c - 0.5; a <= c + 0.5; a += 0.1) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  return bs > base * 1.04 ? +best.toFixed(2) : 0;
}

// rotate by a small angle so lines with slope tan(deg) become horizontal; white fill
export function rotateSmall(img, deg) {
  if (!deg) return img;
  const { w, h } = img, out = makeImg(w, h), o = out.d;
  const a = (deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a), cx = w / 2, cy = h / 2;
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    const dx = u + 0.5 - cx, dy = v + 0.5 - cy;
    const sx = cx + dx * ca - dy * sa - 0.5, sy = cy + dx * sa + dy * ca - 0.5;
    const j = (v * w + u) * 4;
    if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) { o[j] = o[j + 1] = o[j + 2] = o[j + 3] = 255; continue; }
    bilinear(img, sx, sy, o, j);
  }
  return out;
}

// gentle unsharp mask on brightness: crisper text without colour noise
export function sharpen(img, amount = 0.6) {
  const { w, h, d } = img, n = w * h, L = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  const B = boxBlur(boxBlur(L, w, h, 1), w, h, 1);
  const out = makeImg(w, h), o = out.d;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const k = amount * (L[i] - B[i]);
    o[j] = d[j] + k; o[j + 1] = d[j + 1] + k; o[j + 2] = d[j + 2] + k; o[j + 3] = 255;
  }
  return out;
}


// ---------------------------------------------------------------- text-line straightening
// Last step for every page: text lines must be straight. The page is cut into
// vertical strips; in each strip (top / middle / bottom band) the row profile of
// the ink is compared with the neighbouring strip, which tells how far the lines
// drift up or down across the page. Columns are then shifted so the lines are
// level. Fixes curl left over near the spine and any small waviness.
export function straightenLines(page, curlDirs = [1, -1]) {
  const sc0 = Math.min(1, 900 / Math.max(page.w, page.h));
  const sm = sc0 < 1 ? resize(page, Math.round(Math.max(page.w, page.h) * sc0)) : page;
  const { w, h } = sm, g = luma(sm), ink = inkMask(g, w, h);
  const NS = 16, NB = 5, S = Math.max(3, Math.round(h * 0.02));
  const sw = Math.floor(w / NS);
  if (sw < 12 || h < 120) return { img: page, shift: 0 };
  const prof = (k, b) => {
    const x0 = k * sw, x1 = x0 + sw, y0 = Math.floor((b * h) / NB), y1 = Math.floor(((b + 1) * h) / NB);
    const p = new Float32Array(h);
    for (let y = Math.max(0, y0 - S); y < Math.min(h, y1 + S); y++) { let c = 0; for (let x = x0; x < x1; x++) c += ink[y * w + x]; p[y] = c; }
    return { p, y0, y1 };
  };
  // shift (rows) that best aligns profile B to A inside rows [y0,y1)
  const align = (A, B) => {
    let best = 0, bv = -Infinity, sa = 0, saa = 0, n = 0;
    for (let y = A.y0; y < A.y1; y++) { sa += A.p[y]; saa += A.p[y] * A.p[y]; n++; }
    const ma = sa / n, va = saa / n - ma * ma;
    if (va < 0.5) return null;                                   // no text here
    const vals = [];
    for (let d = -S; d <= S; d++) {
      let sb = 0, sbb = 0, sab = 0;
      for (let y = A.y0; y < A.y1; y++) { const yb = y + d; const bv_ = yb >= 0 && yb < h ? B.p[yb] : 0; sb += bv_; sbb += bv_ * bv_; sab += A.p[y] * bv_; }
      const mb = sb / n, vb = sbb / n - mb * mb;
      const r = vb > 0.5 ? (sab / n - ma * mb) / Math.sqrt(va * vb) : -1;
      vals.push(r);
      if (r > bv) { bv = r; best = d; }
    }
    if (bv < 0.45) return null;
    // sub-row peak
    const i = best + S, l = vals[i - 1], r = vals[i + 1];
    const off = l != null && r != null && l + r - 2 * bv < 0 ? (0.5 * (l - r)) / (l + r - 2 * bv) : 0;
    return best + Math.max(-0.5, Math.min(0.5, off));
  };
  const shifts = [];
  for (let b = 0; b < NB; b++) {
    const P = []; for (let k = 0; k < NS; k++) P.push(prof(k, b));
    const sh = new Array(NS).fill(null), mid = NS >> 1;
    sh[mid] = 0;
    for (let k = mid + 1; k < NS; k++) { const d = align(P[k - 1], P[k]); sh[k] = d == null || sh[k - 1] == null ? null : sh[k - 1] + d; }
    for (let k = mid - 1; k >= 0; k--) { const d = align(P[k + 1], P[k]); sh[k] = d == null || sh[k + 1] == null ? null : sh[k + 1] + d; }
    shifts.push(sh);
  }
  // per band a smooth shape that cannot wiggle: straight (tilt) + optional curl towards the spine
  const xs = [...Array(NS).keys()].map((k) => ((k + 0.5) / NS) * 2 - 1);
  const evalC = (c, t) => c.a + c.b * t + (c.k ? c.k * Math.pow(Math.min(1, Math.max(0, (c.dir * t + 1) / 2)), c.p) : 0);
  const curves = shifts.map((sh) => {
    const t = [], y = [];
    sh.forEach((v, k) => { if (v != null) { t.push(xs[k]); y.push(v); } });
    if (t.length < NS * 0.5) return null;
    const fitOne = (p, dir) => {
      let wt = t.map(() => 1), sol = [0, 0, 0];
      for (let it = 0; it < 4; it++) {
        const m = p ? 3 : 2, A = Array.from({ length: m }, () => new Array(m).fill(0)), bb = new Array(m).fill(0);
        t.forEach((ti, i) => {
          if (!wt[i]) return;
          const f = [1, ti]; if (p) f.push(Math.pow(Math.max(0, (dir * ti + 1) / 2), p));
          for (let r = 0; r < m; r++) { bb[r] += f[r] * y[i]; for (let q = 0; q < m; q++) A[r][q] += f[r] * f[q]; }
        });
        for (let r = 0; r < m; r++) A[r][r] += 1e-6;
        sol = solve(A, bb);
        const c = { a: sol[0], b: sol[1], k: p ? sol[2] : 0, p, dir };
        const res = t.map((ti, i) => Math.abs(evalC(c, ti) - y[i]));
        const thr = Math.max(2.5 * 1.4826 * median(res), 0.6);
        wt = res.map((r) => (r <= thr ? 1 : 0));
        if (it === 3) { const kept = res.filter((r, i) => wt[i]); c.err = Math.sqrt(kept.reduce((s_, v) => s_ + v * v, 0) / Math.max(1, kept.length)); return c; }
      }
    };
    let best = fitOne(0, 1);
    for (const dir of curlDirs) for (const p of [2, 4, 8]) { const c = fitOne(p, dir); if (c.err < best.err * 0.75) best = c; }
    return best;
  });
  if (curves.every((c) => !c)) return { img: page, shift: 0 };
  const known = curves.map((c) => c || curves.find((q) => q));
  let maxShift = 0;
  for (const c of known) for (let k = 0; k <= 20; k++) maxShift = Math.max(maxShift, Math.abs(evalC(c, k / 10 - 1) - evalC(c, 0)));
  if (maxShift < 0.6 || maxShift > h * 0.06) return { img: page, shift: +maxShift.toFixed(1) };
  // remap the full-size page: y_src = y + shift(x, y), bands interpolated in y
  const out = makeImg(page.w, page.h), f = page.h / h;
  const bandY = [...Array(NB).keys()].map((b) => ((b + 0.5) / NB) * page.h);
  const colShift = known.map((c) => { const a = new Float32Array(page.w); const c0 = evalC(c, 0); for (let x = 0; x < page.w; x++) a[x] = (evalC(c, (x / page.w) * 2 - 1) - c0) * f; return a; });
  for (let y = 0; y < page.h; y++) {
    let b0 = 0; while (b0 < NB - 2 && y > bandY[b0 + 1]) b0++;
    const ty = Math.min(1, Math.max(0, (y - bandY[b0]) / (bandY[b0 + 1] - bandY[b0])));
    const A = colShift[b0], B = colShift[b0 + 1];
    for (let x = 0; x < page.w; x++) bilinear(page, x, y + A[x] + (B[x] - A[x]) * ty, out.d, (y * page.w + x) * 4);
  }
  return { img: out, shift: +maxShift.toFixed(1) };
}

// ---------------------------------------------------------------- full page pipeline
// side: "L" | "R" | "S" (single). crop: null (auto) or {quad}. rot: extra page rotation.
export function renderPage(img, geo, side, { filter = "magic", crop: manual = null, rot = 0, trimFrac = 0.012, deskew = true, maxSide = 3600, straighten = true } = {}) {
  let pg;
  if (geo.mode === "spread") pg = side === "R" ? geo.pages[1] : geo.pages[0];
  else pg = geo.pages[0];
  const autoQuad = pg.quad || pageQuad(pg);
  let page;
  if (manual && manual.quad) page = warpQuad(img, manual.quad, maxSide);
  else if (pg.quad) {
    // flat page: true perspective correction from the 4 corners
    page = warpQuad(img, pg.quad, maxSide);
    if (geo.found) {
      const t = trimFrac, g = geo.mode === "spread" ? 0.02 : t;
      const l = side === "R" ? g : t, r = side === "L" ? g : t;
      page = crop(page, page.w * l, page.h * t, page.w * (1 - l - r), page.h * (1 - 2 * t));
    }
  } else {
    page = dewarp(img, pg, maxSide);
    if (geo.found) {
      // trim edges; the gutter side gets a bit more (deep shadow / curl)
      const t = trimFrac, g = geo.mode === "spread" ? 0.025 : t;
      const l = side === "R" ? g : t, r = side === "L" ? g : t;
      page = crop(page, page.w * l, page.h * t, page.w * (1 - l - r), page.h * (1 - 2 * t));
    }
  }
  // text lines straight (fixes curl near the spine / slight waviness)
  let lineShift = 0;
  if (straighten) {
    const dirs = geo.mode === "spread" && !manual ? (side === "L" ? [1] : side === "R" ? [-1] : [1, -1]) : [1, -1];
    const r = straightenLines(page, dirs); page = r.img; lineShift = r.shift;
  }
  const sharp = sharpness(page);
  if (filter !== "original") page = columnFlatten(page);
  let out = enhance(page, filter);
  let skew = 0;
  if (deskew) { skew = skewAngle(out); if (Math.abs(skew) >= 0.3) out = rotateSmall(out, skew); }
  if (filter === "magic" || filter === "gray") out = sharpen(out, 0.6);
  if (rot) out = rotate(out, rot);
  return { page: out, autoQuad, sharp, skew, lineShift };
}

// for tests
export const _test = { why: () => whyNot, edgeFeatures: (...a) => edgeFeatures(...a), textCells: (...a) => textCells(...a), textBlock: (...a) => textBlock(...a), detectByContent: (...a) => detectByContent(...a), detectByPaper: (...a) => detectByPaper(...a) };
