// Live page outline for the scanner, off the screen thread (keeps the UI smooth).
// With `check`: also "is this a book page with nothing covering it?" for Auto mode.
//   lockPts: the locked area (no detection needed)
import * as P from "./imgproc.js";
// locked area: where the paper was on the last clean frame (finds a hand that hides text)
let ref = { key: "" };
self.onmessage = (e) => {
  const { id, w, h, d, rot, mode, check, lockPts } = e.data;
  let geo = null, book = null;
  try {
    const img = P.rotate({ w, h, d }, rot), dbg = {};
    if (!lockPts) geo = P.detect(img, mode, dbg);
    if (check) {
      const key = lockPts ? JSON.stringify(lockPts) + "|" + img.w + "x" + img.h : "";
      if (key !== ref.key) ref = { key };
      book = P.bookCheck(img, geo, lockPts || null, lockPts ? undefined : dbg.T || null, lockPts ? ref : null);
    }
  } catch {}
  self.postMessage({ id, geo, book, locked: !!lockPts });
};
