import { load } from './io.mjs';
const P = await import('/Users/cm/Downloads/scan/app/js/imgproc.js');
const G = await import('/Users/cm/Downloads/scan/app/js/pagesig.js');
const frame = (im) => P.resize(im, 640);
const shift = (im, dx, dy, dim = 1) => { const o = P.makeImg(im.w, im.h); for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) { const sx = Math.min(im.w - 1, Math.max(0, x - dx)), sy = Math.min(im.h - 1, Math.max(0, y - dy)); const i = (y * im.w + x) * 4, j = (sy * im.w + sx) * 4; o.d[i] = im.d[j] * dim; o.d[i + 1] = im.d[j + 1] * dim; o.d[i + 2] = im.d[j + 2] * dim; o.d[i + 3] = 255; } return o; };
const fpOf = (f) => { const g = P.detect(f, 'spread'); let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (const pg of g.pages) for (const [x, y] of (pg.quad || P.pageQuad(pg))) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } const wide = (x1 - x0) * f.w > (y1 - y0) * f.h; return G.fingerprint(G.pageCrop(f, { x0, y0, x1, y1 }, wide ? 420 : 320, wide ? 300 : 420)); };
const a = frame(P.rotate(load('user2.png'), 270)), b = frame(P.rotate(load('user1.png'), 270));
const fa = fpOf(a), fa2 = fpOf(shift(a, 8, 5, 0.88)), fb = fpOf(b);
console.log('same page (moved + dimmer):', G.tileDistance(fa, fa2).toFixed(1), '| different page:', G.tileDistance(fa, fb).toFixed(1), '| default cut 6, learned cut = half the typical difference');
