// Local storage (IndexedDB). Everything stays on this device.
//   books    {id, name, created, updated, nextOrder, mode, filter}
//   captures {id, bookId, blob, rotate, mode, created}      original photos
//   pages    {id, bookId, captureId, side, order, filter, rot, crop, status, rev, w, h, autoQuad}
//   blobs    key "full:<pageId>" | "thumb:<pageId>" -> JPEG Blob
const DB_NAME = "booksnap";
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("books", { keyPath: "id" });
      db.createObjectStore("captures", { keyPath: "id" }).createIndex("bookId", "bookId");
      const p = db.createObjectStore("pages", { keyPath: "id" });
      p.createIndex("bookId", "bookId");
      p.createIndex("captureId", "captureId");
      p.createIndex("status", "status");
      db.createObjectStore("blobs");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    try { out = fn(t); } catch (e) { rej(e); return; }
    t.oncomplete = () => Promise.resolve(out).then(res, rej);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("transaction aborted"));
  });
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// Some WebKit builds can't store Blobs in IndexedDB. Detect once; if so,
// store {__ab: ArrayBuffer, type} instead and turn it back into a Blob on read.
let blobOK = null;
async function canStoreBlobs() {
  if (blobOK !== null) return blobOK;
  try {
    await run(["blobs"], "readwrite", (t) => { t.objectStore("blobs").put(new Blob(["probe"], { type: "text/plain" }), "__probe"); });
    blobOK = true;
  } catch { blobOK = false; }
  return blobOK;
}
const pack = async (b) => (b instanceof Blob && !(await canStoreBlobs()) ? { __ab: await b.arrayBuffer(), type: b.type } : b);
const unpack = (v) => (v && v.__ab ? new Blob([v.__ab], { type: v.type }) : v);

export const get = async (store, key) => {
  const v = await run([store], "readonly", (t) => wrap(t.objectStore(store).get(key)));
  if (store === "blobs") return unpack(v);
  if (store === "captures" && v) return { ...v, blob: unpack(v.blob) };
  return v;
};
export const put = async (store, val, key) => {
  if (store === "blobs") val = await pack(val);
  if (store === "captures" && val) val = { ...val, blob: await pack(val.blob) };
  return run([store], "readwrite", (t) => { t.objectStore(store).put(val, key); });
};
export const getBlob = (key) => get("blobs", key);
export const putBlob = (key, blob) => put("blobs", blob, key);

// ---------------------------------------------------------------- books
export async function listBooks() {
  const books = await run(["books"], "readonly", (t) => wrap(t.objectStore("books").getAll()));
  return books.sort((a, b) => b.updated - a.updated);
}

// kind "book": book scan (page detection, 2 pages, Auto…); "doc": regular scan (plain photos)
export async function createBook(name, kind = "book") {
  const now = Date.now();
  const b = kind === "doc"
    ? { id: uid(), name, kind: "doc", created: now, updated: now, nextOrder: 1, mode: "single", filter: "original" }
    // card / passport: one photo per side, landscape, real colours (front + back on one A4)
    : kind === "card" || kind === "passport"
    ? { id: uid(), name, kind, created: now, updated: now, nextOrder: 1, mode: "single", filter: "original", orient: "landscape" }
    : { id: uid(), name, created: now, updated: now, nextOrder: 1, mode: "spread", filter: "magic" };
  await put("books", b);
  return b;
}

// Save book settings. The page counter (nextOrder) is only changed by
// addCapture/undoCapture, so an older copy of the book can never rewind it.
export async function saveBook(b) {
  return run(["books"], "readwrite", (t) => new Promise((res, rej) => {
    const st = t.objectStore("books");
    const g = st.get(b.id);
    g.onerror = () => rej(g.error);
    g.onsuccess = () => {
      const cur = g.result;
      const merged = { ...(cur || {}), ...b, updated: Date.now() };
      if (cur) merged.nextOrder = cur.nextOrder;
      st.put(merged);
      res(merged);
    };
  }));
}

export const countPages = (bookId) =>
  run(["pages"], "readonly", (t) => wrap(t.objectStore("pages").index("bookId").count(bookId)));

export async function deleteBook(bookId) {
  await run(["books", "captures", "pages", "blobs"], "readwrite", (t) => {
    t.objectStore("books").delete(bookId);
    const blobs = t.objectStore("blobs");
    const pc = t.objectStore("pages").index("bookId").openCursor(bookId);
    pc.onsuccess = () => {
      const c = pc.result;
      if (!c) return;
      blobs.delete("full:" + c.value.id); blobs.delete("thumb:" + c.value.id);
      c.delete(); c.continue();
    };
    const cc = t.objectStore("captures").index("bookId").openCursor(bookId);
    cc.onsuccess = () => { const c = cc.result; if (c) { c.delete(); c.continue(); } };
  });
}

// ---------------------------------------------------------------- captures & pages
// One photo -> 1 page (single) or 2 pages (spread: left first, then right).
// `orders`: put the new page(s) at these positions (retake / add a page in between) instead of at the end
// `only`: keep just these sides of a 2-page photo (retake of a left or right page) · `extra`: page fields (retaken)
export async function addCapture(bookId, blob, { rotate = 0, mode = "spread", filter = "magic", lock = null, orders = null, only = null, extra = null } = {}) {
  blob = await pack(blob);
  return run(["books", "captures", "pages"], "readwrite", (t) => new Promise((res, rej) => {
    const bs = t.objectStore("books");
    const g = bs.get(bookId);
    g.onerror = () => rej(g.error);
    g.onsuccess = () => {
      const b = g.result;
      if (!b) return rej(new Error("book not found"));
      const cap = { id: uid(), bookId, blob, rotate, mode, lock, created: Date.now() };
      t.objectStore("captures").put(cap);
      const sides = (mode === "spread" ? ["L", "R"] : ["S"]).filter((sd) => !only || only.includes(sd));
      const pages = sides.map((side, i) => ({
        id: uid(), bookId, captureId: cap.id, side, order: orders && orders[i] != null ? orders[i] : b.nextOrder++,
        filter, rot: 0, crop: null, status: "pending", rev: 1, created: Date.now(), ...(extra || {}),
      }));
      for (const p of pages) t.objectStore("pages").put(p);
      b.updated = Date.now();
      bs.put(b);
      res(pages);
    };
  }));
}

export async function listPages(bookId) {
  const ps = await run(["pages"], "readonly", (t) => wrap(t.objectStore("pages").index("bookId").getAll(bookId)));
  return ps.sort((a, b) => a.order - b.order);
}

export const pagesOfCapture = (captureId) =>
  run(["pages"], "readonly", (t) => wrap(t.objectStore("pages").index("captureId").getAll(captureId)));

export const nextPending = () =>
  run(["pages"], "readonly", (t) => wrap(t.objectStore("pages").index("status").get("pending")));

export const pendingCount = () =>
  run(["pages"], "readonly", (t) => wrap(t.objectStore("pages").index("status").count("pending")));

export const putPage = (p) => put("pages", p);

// Store a finished page: images + record together, only if nobody edited it meanwhile.
export async function finishPage(pageId, rev, full, thumb, info) {
  full = await pack(full); thumb = await pack(thumb);
  return run(["pages", "blobs"], "readwrite", (t) => new Promise((res, rej) => {
    const ps = t.objectStore("pages");
    const g = ps.get(pageId);
    g.onerror = () => rej(g.error);
    g.onsuccess = () => {
      const p = g.result;
      if (!p || p.rev !== rev) return res(null);    // deleted or changed -> drop result
      const blobs = t.objectStore("blobs");
      blobs.put(full, "full:" + pageId);
      blobs.put(thumb, "thumb:" + pageId);
      const np = { ...p, ...info, status: "done", ver: (p.ver || 0) + 1 };
      ps.put(np);
      res(np);
    };
  }));
}

// Change page settings and queue it for re-processing.
export async function editPage(pageId, changes) {
  return run(["pages"], "readwrite", (t) => new Promise((res, rej) => {
    const ps = t.objectStore("pages");
    const g = ps.get(pageId);
    g.onerror = () => rej(g.error);
    g.onsuccess = () => {
      if (!g.result) return res(null);
      const np = { ...g.result, ...changes, status: "pending", rev: (g.result.rev || 0) + 1 };
      ps.put(np);
      res(np);
    };
  }));
}

export async function deletePages(ids) {
  const capIds = new Set();
  await run(["pages", "blobs"], "readwrite", (t) => {
    const ps = t.objectStore("pages"), bs = t.objectStore("blobs");
    for (const id of ids) {
      const g = ps.get(id);
      g.onsuccess = () => { if (g.result) capIds.add(g.result.captureId); };
      ps.delete(id); bs.delete("full:" + id); bs.delete("thumb:" + id);
    }
  });
  // drop original photos nobody uses any more
  for (const cid of capIds) {
    const left = await pagesOfCapture(cid);
    if (!left.length) await run(["captures"], "readwrite", (t) => { t.objectStore("captures").delete(cid); });
  }
}

export async function storageInfo() {
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    return { persisted, usage: est?.usage || 0, quota: est?.quota || 0 };
  } catch { return { persisted: false, usage: 0, quota: 0 }; }
}

export async function askPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

// Retake: remove one photo and its pages. If they were the newest pages, give
// their page numbers back so the next photo reuses them (no gaps).
export async function undoCapture(captureId) {
  return run(["books", "captures", "pages", "blobs"], "readwrite", (t) => new Promise((res, rej) => {
    const ps = t.objectStore("pages"), bs = t.objectStore("blobs"), cs = t.objectStore("captures"), books = t.objectStore("books");
    const q = ps.index("captureId").getAll(captureId);
    q.onerror = () => rej(q.error);
    q.onsuccess = () => {
      const pages = q.result;
      if (!pages.length) return res(null);
      const bookId = pages[0].bookId;
      const orders = pages.map((p) => p.order);
      for (const p of pages) { ps.delete(p.id); bs.delete("full:" + p.id); bs.delete("thumb:" + p.id); }
      cs.delete(captureId);
      const g = books.get(bookId);
      g.onsuccess = () => {
        const b = g.result;
        if (b && Math.max(...orders) === b.nextOrder - 1) { b.nextOrder = Math.min(...orders); books.put(b); }
        res({ bookId, orders });
      };
    };
  }));
}

// ---------------------------------------------------------------- storage helpers for big books
export async function originalsInfo(bookId) {
  const caps = await run(["captures"], "readonly", (t) => wrap(t.objectStore("captures").index("bookId").getAll(bookId)));
  let count = 0, bytes = 0;
  for (const c of caps) if (c.blob) { count++; bytes += c.blob.size || (c.blob.__ab ? c.blob.__ab.byteLength : 0); }
  return { count, bytes };
}

// Remove original photos of pages that are finished (pending/failed ones keep theirs).
export async function dropOriginals(bookId) {
  const pages = await run(["pages"], "readonly", (t) => wrap(t.objectStore("pages").index("bookId").getAll(bookId)));
  const busy = new Set(pages.filter((p) => p.status !== "done").map((p) => p.captureId));
  let freed = 0;
  await run(["captures"], "readwrite", (t) => new Promise((res) => {
    const cur = t.objectStore("captures").index("bookId").openCursor(bookId);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res();
      const v = c.value;
      if (v.blob && !busy.has(v.id)) { freed += v.blob.size || 0; c.update({ ...v, blob: null, dropped: true }); }
      c.continue();
    };
  }));
  return freed;
}
