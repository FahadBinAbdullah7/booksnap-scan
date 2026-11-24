// Adapt BookSnap to the phone: low-memory phones get smaller photos and
// processing sizes (pages stay sharp enough to read and print), and we keep an
// eye on free storage so a long scan never fills the phone.
import { isAndroid } from "./native.js";

import { NC } from "./camera.js";   // one registration only
let cached = null;

export async function info() {
  let totalMem = 0, lowRam = false, freeDisk = null;
  if (isAndroid()) {
    try { const r = await NC.deviceInfo(); totalMem = r.totalMem || 0; lowRam = !!r.lowRam; freeDisk = r.freeDisk ?? null; } catch {}
  }
  if (!totalMem && navigator.deviceMemory) totalMem = navigator.deviceMemory * 1024 ** 3;
  if (freeDisk == null) {
    try { const e = await navigator.storage.estimate(); freeDisk = Math.max(0, (e.quota || 0) - (e.usage || 0)); } catch {}
  }
  return { totalMem, lowRam, freeDisk };
}

// GB of RAM -> safe sizes (test override: localStorage "booksnap.forceRamGB")
export async function profile() {
  if (cached) return cached;
  const i = await info();
  let gb = i.totalMem ? i.totalMem / 1024 ** 3 : 4;
  try { const f = parseFloat(localStorage.getItem("booksnap.forceRamGB")); if (f > 0) gb = f; } catch {}
  const tier = i.lowRam || gb <= 2.2 ? "low" : gb <= 3.5 ? "mid" : gb <= 5 ? "good" : "high";
  const T = {
    low:  { captureWidth: 3264, maxPixels: 8e6,  maxSide: 2600, frameSize: 480, frameInterval: 260, detectEvery: 700, detectSize: 400 },
    mid:  { captureWidth: 4000, maxPixels: 12e6, maxSide: 3000, frameSize: 560, frameInterval: 200, detectEvery: 450, detectSize: 440 },
    good: { captureWidth: 4640, maxPixels: 16e6, maxSide: 3400, frameSize: 640, frameInterval: 160, detectEvery: 330, detectSize: 480 },
    high: { captureWidth: 4640, maxPixels: 20e6, maxSide: 3600, frameSize: 640, frameInterval: 150, detectEvery: 300, detectSize: 480 },
  }[tier];
  cached = { tier, ramGB: +gb.toFixed(1), ...T };
  return cached;
}

const MB = 1024 * 1024;
// before each photo: "ok" | "low" (warn) | "full" (stop, nothing would be saved safely)
export async function spaceCheck() {
  const { freeDisk } = await info();
  if (freeDisk == null) return { level: "ok", free: null };
  if (freeDisk < 300 * MB) return { level: "full", free: freeDisk };
  if (freeDisk < 1024 * MB) return { level: "low", free: freeDisk };
  return { level: "ok", free: freeDisk };
}
