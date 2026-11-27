// In-app updates for the Android app: the newest release on GitHub is compared
// with the installed version; if it is newer, a banner offers to download and
// install it. (The website updates itself — nothing to do there.)
import { registerPlugin } from "../vendor/capacitor-core.js";
import { isAndroid } from "./native.js";

const U = registerPlugin("Updater");
export const REPO = "FahadBinAbdullah7/booksnap-scan";
const KEY = "booksnap.update", EVERY = 6 * 3600 * 1000;

// "1.10.0" > "1.9.2"
export function newer(a, b) {
  const p = (v) => String(v || "0").replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Google Play edition: Play updates the app, so no update check or download here
let storeBuild = null;
export async function isStoreBuild() {
  if (storeBuild == null) { try { storeBuild = isAndroid() && !!(await U.info()).store; } catch { storeBuild = false; } }
  return storeBuild;
}

export async function installedVersion() {
  if (!isAndroid()) return null;
  try { return (await U.info()).version; } catch { return null; }
}

// only an APK from this repository's own releases (Android also checks it is signed with our key)
const okUrl = (u) => typeof u === "string" && u.startsWith(`https://github.com/${REPO}/releases/download/`) && /\.apk$/i.test(u);
export const WEB_VERSION = "https://booksnap-scanner.vercel.app/version.json";

// 1st: the website's version.json (no limits; published only once the APK is built)
async function fromWebsite() {
  const r = await fetch(WEB_VERSION + "?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("website " + r.status);
  const j = await r.json();
  if (!j || !j.version || !okUrl(j.apk)) throw new Error("website: no APK");
  return { version: String(j.version).replace(/^v/i, ""), url: j.apk, size: j.size || 0, notes: String(j.notes || "").slice(0, 600) };
}
// 2nd: GitHub's API (only 60 checks an hour per internet connection, shared by everyone on that Wi-Fi)
async function fromGitHub() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (!r.ok) throw new Error("GitHub " + r.status);
  const j = await r.json();
  const apk = (j.assets || []).find((a) => okUrl(a.browser_download_url));
  return apk ? { version: String(j.tag_name || "").replace(/^v/i, ""), url: apk.browser_download_url, size: apk.size, notes: (j.body || "").trim().slice(0, 600) } : null;
}

// latest release (cached for a few hours) -> { version, url, notes, size } | null
async function latest(force) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
  if (!force && cached && Date.now() - cached.at < EVERY) return cached.rel;
  let rel = null, web = null;
  try { web = await fromWebsite(); } catch {}
  try { rel = web || (await fromGitHub()); }
  catch (e) { if (!web) throw e; }
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), rel })); } catch {}
  return rel;
}

// a newer release than the installed app, or null
export async function check(force = false) {
  if (await isStoreBuild()) return null;
  const cur = await installedVersion();
  if (!cur) return null;
  const rel = await latest(force);
  return rel && newer(rel.version, cur) ? { ...rel, current: cur } : null;
}

// download + hand to Android's installer; onStatus(text) shows progress
export async function install(rel, onStatus = () => {}) {
  onStatus("Downloading… 0%");
  const sub = await U.addListener("progress", (p) => {
    onStatus(p.total > 0 ? `Downloading… ${Math.round((p.done / p.total) * 100)}%` : `Downloading… ${(p.done / 1048576).toFixed(1)} MB`);
  });
  try {
    const d = await U.download({ url: rel.url });
    onStatus("Opening the installer…");
    const r = await U.install({ path: d.path });
    return r.needsPermission ? "permission" : "started";
  } finally { sub.remove(); }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mb = (n) => (n ? ` (${(n / 1048576).toFixed(0)} MB)` : "");

// banner at the top of `container` when an update is waiting
export async function banner(container, { force = false, toast } = {}) {
  let rel = null;
  try { rel = await check(force); } catch (e) { if (force && toast) toast("Could not check for updates — check the internet and try again in a few minutes", 5000); return; }
  if (!rel) { if (force && toast) toast("BookSnap is up to date ✓"); return; }
  if (!container || !container.isConnected) return;
  container.querySelector(".update-banner")?.remove();
  const el = document.createElement("div");
  el.className = "update-banner";
  el.innerHTML = `<div class="ub-text"><b>🎉 New version ${esc(rel.version)}</b> <span class="muted">(you have ${esc(rel.current)})</span>
      ${rel.notes ? `<div class="ub-notes">${esc(rel.notes.split("\n").filter((l) => l.trim()).slice(0, 4).join(" · "))}</div>` : ""}</div>
    <div class="ub-actions"><button class="btn primary" data-a="go">⬇ Update${mb(rel.size)}</button><button class="btn" data-a="later">Later</button></div>
    <div class="ub-status muted small"></div>`;
  container.prepend(el);
  const status = el.querySelector(".ub-status"), go = el.querySelector('[data-a="go"]');
  el.querySelector('[data-a="later"]').onclick = () => el.remove();
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await install(rel, (t) => (status.textContent = t));
      status.textContent = r === "permission"
        ? "Allow BookSnap to install updates (switch on “Allow from this source”), then come back and tap Update again. Your books stay."
        : "Tap Update / Install in the Android window. Your books stay.";
    } catch (e) {
      status.textContent = "Update failed: " + (e.message || e) + " — try again later.";
    }
    go.disabled = false;
  };
}
