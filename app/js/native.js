// Android-app features (Capacitor). In a normal browser these are unused.
import { Capacitor, registerPlugin } from "../vendor/capacitor-core.js";

export const isNative = () => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};
// the Android app has its own native camera, shutter keys and updater; the iPhone app
// uses the web camera (like the website)
export const platform = () => { try { return Capacitor.getPlatform(); } catch { return "web"; } };
export const isAndroid = () => isNative() && platform() === "android";
export const isIOS = () => isNative() && platform() === "ios";

const Filesystem = registerPlugin("Filesystem");
const Share = registerPlugin("Share");
const DIR = "DOCUMENTS";            // the phone's public Documents folder

export const safeName = (s) => (String(s || "Book").replace(/[\\/:*?"<>|#%]+/g, " ").replace(/\s+/g, " ").trim() || "Book").slice(0, 80);

function toBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// Write a Blob into Documents/<path> in 3 MB pieces, so even a 1 GB PDF
// never has to sit in memory at once. Returns a file:// uri.
export async function saveBlob(path, blob, onProgress) {
  const CH = 3 * 1024 * 1024;
  let off = 0, first = true;
  while (first || off < blob.size) {
    const part = new Uint8Array(await blob.slice(off, off + CH).arrayBuffer());
    const data = toBase64(part);
    if (first) await Filesystem.writeFile({ path, data, directory: DIR, recursive: true });
    else await Filesystem.appendFile({ path, data, directory: DIR });
    first = false;
    off += CH;
    if (onProgress) onProgress(Math.min(1, off / Math.max(1, blob.size)));
  }
  const { uri } = await Filesystem.getUri({ path, directory: DIR });
  return uri;
}

export async function shareFiles(uris, title) {
  await Share.share({ title, dialogTitle: title, files: uris });
}

export const documentsLabel = (path) => "Documents/" + path;

// Hardware shutter (volume keys, Bluetooth selfie remote, headset button).
const Shutter = registerPlugin("Shutter");
export async function onShutterKey(cb) {
  if (!isAndroid()) return () => {};
  try {
    const h = await Shutter.addListener("press", cb);
    await Shutter.setActive({ active: true });
    return () => { Shutter.setActive({ active: false }).catch(() => {}); h.remove(); };
  } catch { return () => {}; }
}
