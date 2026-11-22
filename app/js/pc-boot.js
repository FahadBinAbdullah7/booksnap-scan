// Started by BookSnap PC (booksnap_pc.py)? -> direct Wi-Fi mode.
// Otherwise (page opened from a website) -> internet mode (PeerJS).
(async () => {
  let session = null;
  try {
    const r = await fetch("/api/session", { cache: "no-store" });
    if (r.ok) session = await r.json();
  } catch {}
  if (session && session.token) (await import("./pc-local.js")).start(session);
  else await import("./pc.js");
})();
