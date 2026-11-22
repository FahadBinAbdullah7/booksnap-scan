// Minimal streaming PDF writer: each page is one JPEG embedded as-is.
// The PDF Blob is assembled from the stored JPEG Blobs without loading them
// into memory, so 2000+ page books work on a phone.

const enc = new TextEncoder();

// Read JPEG size + colour components from the SOF marker.
async function jpegInfo(blob) {
  const buf = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (buf[i + 5] << 8) | buf[i + 6], w: (buf[i + 7] << 8) | buf[i + 8], comps: buf[i + 9] };
    }
    i += 2 + len;
  }
  throw new Error("not a JPEG");
}

export async function buildPdf(jpegs, { title = "Book", onProgress } = {}) {
  const parts = [], offsets = [];
  let pos = 0;
  const add = (x) => {
    if (typeof x === "string") x = enc.encode(x);
    parts.push(x);
    pos += x instanceof Blob ? x.size : x.length;
  };
  const obj = (num, body) => { offsets[num] = pos; add(`${num} 0 obj\n${body}\nendobj\n`); };

  add(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + binary marker
  const n = jpegs.length;
  const pageNum = (i) => 4 + i * 3;
  const safeTitle = title.replace(/[()\\]/g, "").replace(/[^\x20-\x7e]/g, "?");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${jpegs.map((_, i) => `${pageNum(i)} 0 R`).join(" ")}] /Count ${n} >>`);
  obj(3, `<< /Title (${safeTitle}) /Producer (BookSnap) >>`);

  for (let i = 0; i < n; i++) {
    const blob = jpegs[i];
    const { w, h, comps } = await jpegInfo(blob);
    const pw = 595.28, ph = +((pw * h) / w).toFixed(2);             // A4 width, keep aspect
    const p = pageNum(i), im = p + 1, ct = p + 2;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
    offsets[im] = pos;
    add(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${comps === 1 ? "DeviceGray" : comps === 4 ? "DeviceCMYK" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode /Length ${blob.size} >>\nstream\n`);
    add(blob);
    add("\nendstream\nendobj\n");
    const s = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(ct, `<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
    if (onProgress && i % 10 === 0) onProgress(i + 1, n);
  }

  const total = 4 + n * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += String(offsets[k]).padStart(10, "0") + " 00000 n \n";
  add(x + `trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  onProgress && onProgress(n, n);
  return new Blob(parts, { type: "application/pdf" });
}
