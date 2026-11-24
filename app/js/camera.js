// Camera: live preview, small frames for motion/page detection, full-res photos.

// some camera drivers never answer: never wait forever
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.ic = null;
    this.photoOpts = undefined;
    this.small = document.createElement("canvas");
    this.sctx = this.small.getContext("2d", { willReadFrequently: true });
  }

  async start() {
    // A small live preview keeps the picture smooth (real time). Full-size photos come from
    // ImageCapture (Chrome / Android); browsers without it (iPhone Safari) take the photo from
    // the stream itself, so they get a larger — but still smooth — 1920 px stream.
    const still = "ImageCapture" in window;
    const fps = { ideal: 30, max: 30 };
    const tries = still
      ? [
          { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: fps },
          { facingMode: { ideal: "environment" }, width: { ideal: 960 }, height: { ideal: 540 } },
          { facingMode: { ideal: "environment" } },
        ]
      : [
          { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 }, frameRate: fps },
          { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: fps },
          { facingMode: { ideal: "environment" } },
        ];
    let err;
    for (const video of tries) {
      try { this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); break; }
      catch (e) { err = e; }
    }
    if (!this.stream) throw err || new Error("camera unavailable");
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "");
    this.video.muted = true;
    await this.video.play();
    await new Promise((r) => (this.video.videoWidth ? r() : this.video.addEventListener("loadedmetadata", r, { once: true })));
    // continuous autofocus where supported
    try {
      const caps = this.track.getCapabilities?.() || {};
      if (caps.focusMode?.includes("continuous")) await withTimeout(this.track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }), 2000);
    } catch {}
    // full-resolution stills (Chrome/Android)
    if ("ImageCapture" in window) {
      try {
        this.ic = new ImageCapture(this.track);
        const pc = await withTimeout(this.ic.getPhotoCapabilities(), 3000);
        // Use the full sensor, but cap very large (50–200 MP) cameras at ~16 MP:
        // plenty for book pages and keeps memory/storage sane for 1000+ pages.
        if (pc?.imageWidth?.max) {
          const W = pc.imageWidth.max, H = pc.imageHeight.max, cap = (this.profile && this.profile.captureWidth) || 4640;
          const w = W > cap ? cap : W;
          this.photoOpts = { imageWidth: w, imageHeight: Math.round((H * w) / W) };
        }
      } catch { this.ic = null; }
    }
  }

  get canTorch() {
    try { return !!this.track?.getCapabilities?.().torch; } catch { return false; }
  }

  async torch(on) {
    try { await this.track.applyConstraints({ advanced: [{ torch: !!on }] }); return true; } catch { return false; }
  }

  get size() { return { w: this.video.videoWidth, h: this.video.videoHeight }; }

  // downscaled frame as {w,h,d}
  frame(maxSide) {
    const { w, h } = this.size;
    if (!w) return null;
    const s = maxSide / Math.max(w, h);
    const W = Math.round(w * s), H = Math.round(h * s);
    if (this.small.width !== W || this.small.height !== H) { this.small.width = W; this.small.height = H; }
    this.sctx.drawImage(this.video, 0, 0, W, H);
    const id = this.sctx.getImageData(0, 0, W, H);
    return { w: W, h: H, d: id.data, id: (this.frameNo = (this.frameNo || 0) + 1) };
  }

  // small JPEG of the live view (for the PC's live picture)
  jpegFrame(maxSide = 640, quality = 0.6) {
    const { w, h } = this.size;
    if (!w) return Promise.resolve(null);
    const s = Math.min(1, maxSide / Math.max(w, h));
    if (!this.lv) this.lv = document.createElement("canvas");
    this.lv.width = Math.round(w * s); this.lv.height = Math.round(h * s);
    this.lv.getContext("2d").drawImage(this.video, 0, 0, this.lv.width, this.lv.height);
    return new Promise((r) => this.lv.toBlob(r, "image/jpeg", quality));
  }

  async takePhoto() {
    if (this.ic) {
      try {
        const b = await withTimeout(this.ic.takePhoto(this.photoOpts), 8000);
        if (b && b.size > 1000) return b;
      } catch (e) {
        if (e.message !== "timeout") {
          try { const b = await withTimeout(this.ic.takePhoto(), 8000); if (b && b.size > 1000) return b; } catch {}
        }
        // a camera that hangs once will hang again: use video frames from now on
        if (e.message === "timeout") this.ic = null;
      }
    }
    // fallback: the live video frame at full stream resolution
    const { w, h } = this.size;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(this.video, 0, 0);
    return new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

// ---------------------------------------------------------------- real phone camera (Android app)
// Same interface as Camera, but uses the native CameraX preview (shown under
// the transparent page) and full-quality native photos.
import { Capacitor, registerPlugin } from "../vendor/capacitor-core.js";
export const NC = registerPlugin("NativeCamera");

function b64ToBlob(b64, type = "image/jpeg") {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}

export class NativeCamera {
  constructor() {
    this.small = document.createElement("canvas");
    this.sctx = this.small.getContext("2d", { willReadFrequently: true });
    this.lastFrame = null;   // ImageBitmap of the latest preview frame
    this.lastBlob = null;    // its JPEG
    this.frameId = 0;
    this.w = 0; this.h = 0;
    this.hasTorch = false;
    this.stream = null;      // no MediaStream: frames go to the PC as JPEGs
    this.native = true;
  }
  async start() {
    document.body.classList.add("native-cam");
    this.sub = await NC.addListener("frame", async (f) => {
      try {
        const blob = b64ToBlob(f.data);
        const bmp = await createImageBitmap(blob);
        if (this.lastFrame) this.lastFrame.close();
        this.lastFrame = bmp; this.lastBlob = blob;
        this.w = bmp.width; this.h = bmp.height; this.frameId++;
      } catch {}
    });
    const pr = this.profile || {};
    const r = await NC.start({ frameInterval: pr.frameInterval || 150, frameSize: pr.frameSize || 640, captureWidth: pr.captureWidth || 4640 });
    this.hasTorch = !!r.torch;
    for (let i = 0; i < 40 && !this.lastFrame; i++) await new Promise((res) => setTimeout(res, 100));
  }
  get size() { return { w: this.w, h: this.h }; }
  get canTorch() { return this.hasTorch; }
  async torch(on) { try { await NC.torch({ on: !!on }); return true; } catch { return false; } }
  focus(fx, fy) { NC.focus({ x: fx, y: fy }).catch(() => {}); }
  frame(maxSide) {
    const b = this.lastFrame;
    if (!b) return null;
    const s = maxSide / Math.max(b.width, b.height);
    const W = Math.round(b.width * s), H = Math.round(b.height * s);
    if (this.small.width !== W || this.small.height !== H) { this.small.width = W; this.small.height = H; }
    this.sctx.drawImage(b, 0, 0, W, H);
    return { w: W, h: H, d: this.sctx.getImageData(0, 0, W, H).data, id: this.frameId };
  }
  jpegFrame() { return Promise.resolve(this.lastBlob); }
  async takePhoto() {
    const r = await NC.capture();
    const blob = await (await fetch(Capacitor.convertFileSrc(r.path))).blob();
    NC.release({ path: r.path }).catch(() => {});
    return new Blob([blob], { type: "image/jpeg" });
  }
  stop() {
    NC.stop().catch(() => {});
    try { this.sub && this.sub.remove(); } catch {}
    if (this.lastFrame) { this.lastFrame.close(); this.lastFrame = null; }
    document.body.classList.remove("native-cam");
  }
}

// turn the scanner screen (and so the photos) to portrait/landscape
NativeCamera.prototype.setOrientation = function (mode) { return NC.setOrientation({ mode }).catch(() => {}); };
Camera.prototype.setOrientation = async function (mode) {
  try { if (mode === "auto") screen.orientation.unlock(); else await screen.orientation.lock(mode === "landscape" ? "landscape" : "portrait"); } catch {}
};
