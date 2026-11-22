#!/usr/bin/env python3
"""
BookSnap process: turn raw book photos into clean pages + one PDF.

For every photo in raw/:
  1. Finds the book (bright paper on a dark background) and straightens it.
  2. If it is a two-page spread, finds the gutter (middle fold) and splits it
     into LEFT and RIGHT pages.
  3. Enhances each page like CamScanner:
       magic    - Magic Color: white background, shadows removed, colours kept
       gray     - clean grayscale
       bw       - crisp black & white (smallest PDF, best for text-only books)
       original - just cropped/split
  4. Writes pages/0001.jpg, 0002.jpg ... in reading order and builds book.pdf.

Examples
  python process.py                         # raw/ -> pages/ + book.pdf (magic)
  python process.py --mode bw --ocr eng     # B&W + searchable PDF (needs ocrmypdf)
  python process.py --split off             # photos already show one page each
  python process.py --debug                 # also writes debug/ images showing the detected split
"""
import argparse
import os
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np

IMG_EXT = (".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".heic")


# ================================================================ geometry
def order_points(pts):
    pts = np.asarray(pts, dtype=np.float32)
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], np.float32)


def warp(img, quad):
    tl, tr, br, bl = order_points(quad)
    w = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    h = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    M = cv2.getPerspectiveTransform(np.array([tl, tr, br, bl]), dst)
    return cv2.warpPerspective(img, M, (w, h), flags=cv2.INTER_CUBIC)


def find_paper(img):
    """Return 4 corner points of the book/paper, or None if it fills the frame."""
    h, w = img.shape[:2]
    scale = 1000 / max(h, w)
    small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (7, 7), 0)
    _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # close text holes and the gutter shadow so the spread becomes one blob
    k = max(15, int(small.shape[1] * 0.04)) | 1
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area = small.shape[0] * small.shape[1]
    big = [c for c in cnts if cv2.contourArea(c) > 0.05 * area]
    if not big:
        return None
    pts = np.vstack(big).reshape(-1, 2)
    hull = cv2.convexHull(pts)
    frac = cv2.contourArea(hull) / area
    if frac < 0.15 or frac > 0.97:      # nothing found, or paper fills the whole photo
        return None
    approx = cv2.approxPolyDP(hull, 0.02 * cv2.arcLength(hull, True), True)
    quad = approx.reshape(-1, 2) if len(approx) == 4 else cv2.boxPoints(cv2.minAreaRect(hull))
    return quad.astype(np.float32) / scale


def find_gutter(img):
    """x position of the fold between the two pages."""
    h, w = img.shape[:2]
    scale = 800 / w
    small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    sh, sw = gray.shape
    band = gray[int(sh * 0.08):int(sh * 0.92)]
    # text density per column (the gutter has no text)
    ink = cv2.adaptiveThreshold(band, 1, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15)
    ink_col = ink.mean(0)
    bright_col = band.mean(0) / 255.0       # the gutter is usually shadowed (darker)
    win = max(3, int(sw * 0.015))
    kern = np.ones(win) / win
    ink_col = np.convolve(ink_col, kern, "same")
    bright_col = np.convolve(bright_col, kern, "same")
    lo, hi = int(sw * 0.35), int(sw * 0.65)
    e, b = ink_col[lo:hi], bright_col[lo:hi]
    norm = lambda a: (a - a.min()) / (np.ptp(a) + 1e-6)
    score = norm(e) + 0.8 * norm(b)
    return int((lo + int(np.argmin(score))) / scale)


# ================================================================ enhance
def background(gray_or_chan):
    """Estimate the paper (lighting) background by removing text and smoothing."""
    h, w = gray_or_chan.shape
    f = 0.25
    s = cv2.resize(gray_or_chan, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    k = max(5, int(s.shape[1] * 0.02)) | 1
    s = cv2.dilate(s, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))   # erase dark text
    s = cv2.medianBlur(s, min(255, k * 3 | 1))
    return cv2.resize(s, (w, h), interpolation=cv2.INTER_LINEAR)


def flatten(chan):
    """Divide by background: shadows/uneven light vanish, paper becomes white."""
    bg = background(chan).astype(np.float32) + 1
    return np.clip(chan.astype(np.float32) / bg * 255.0, 0, 255)


def levels(x, black=None, white=238):
    if black is None:
        black = min(110.0, float(np.percentile(x, 0.5)) + 15)
    y = np.clip((x - black) * 255.0 / max(1, white - black), 0, 255)
    return y.astype(np.uint8)


def enhance(img, mode):
    if mode == "original":
        return img
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if mode == "magic":
        flat = cv2.merge([flatten(c) for c in cv2.split(img)])
        g = cv2.cvtColor(flat.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
        black = min(110.0, float(np.percentile(g, 0.5)) + 15)
        out = levels(flat, black)
        hsv = cv2.cvtColor(out, cv2.COLOR_BGR2HSV).astype(np.float32)
        hsv[..., 1] = np.clip(hsv[..., 1] * 1.35, 0, 255)          # livelier colours
        return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    flat = flatten(gray)
    if mode == "gray":
        return levels(flat)
    if mode == "bw":
        g = levels(flat, white=230)
        _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return cv2.medianBlur(bw, 3)
    raise ValueError(mode)


def trim(img, frac):
    if frac <= 0:
        return img
    h, w = img.shape[:2]
    dy, dx = int(h * frac), int(w * frac)
    return img[dy:h - dy, dx:w - dx]


# ================================================================ pipeline
def process_one(job):
    path, opt = job
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        return path, [], "could not read"
    if opt["rotate"]:
        img = cv2.rotate(img, {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180,
                               270: cv2.ROTATE_90_COUNTERCLOCKWISE}[opt["rotate"]])
    quad = find_paper(img) if opt["crop"] else None
    book = warp(img, quad) if quad is not None else img
    h, w = book.shape[:2]

    split = opt["split"] == "on" or (opt["split"] == "auto" and w / h > 1.15)
    if split:
        gx = find_gutter(book)
        pages = [book[:, :gx], book[:, gx:]]
        if opt["rtl"]:
            pages.reverse()
    else:
        gx, pages = None, [book]

    if opt["debug"]:
        dbg = img.copy()
        if quad is not None:
            cv2.polylines(dbg, [order_points(quad).astype(np.int32)], True, (0, 255, 0), 8)
        d2 = book.copy()
        if gx is not None:
            cv2.line(d2, (gx, 0), (gx, h), (0, 0, 255), 6)
        s1 = 600 / dbg.shape[0]
        s2 = 600 / d2.shape[0]
        both = np.hstack([cv2.resize(dbg, None, fx=s1, fy=s1), cv2.resize(d2, None, fx=s2, fy=s2)])
        cv2.imwrite(os.path.join(opt["debug_dir"], os.path.basename(path)), both)

    out = [enhance(trim(p, opt["trim"]), opt["mode"]) for p in pages]
    return path, out, "split" if split else "single"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", default="raw")
    ap.add_argument("--output", default="pages")
    ap.add_argument("--pdf", default="book.pdf")
    ap.add_argument("--mode", default="magic", choices=["magic", "gray", "bw", "original"])
    ap.add_argument("--split", default="auto", choices=["auto", "on", "off"],
                    help="auto: split when the photo is wider than tall")
    ap.add_argument("--no-crop", dest="crop", action="store_false", help="don't detect/straighten the book outline")
    ap.add_argument("--trim", type=float, default=0.01, help="trim this fraction off each page edge")
    ap.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270])
    ap.add_argument("--rtl", action="store_true", help="right page comes first (Arabic/Urdu books)")
    ap.add_argument("--book-width-in", type=float, default=6.0, help="page width in inches for the PDF")
    ap.add_argument("--ocr", default="", help="make PDF searchable, e.g. 'eng' or 'eng+ben' (needs ocrmypdf)")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    args = ap.parse_args()

    files = sorted(os.path.join(args.input, f) for f in os.listdir(args.input) if f.lower().endswith(IMG_EXT))
    if not files:
        sys.exit(f"No images in {args.input}/")
    if os.path.isdir(args.output):
        shutil.rmtree(args.output)
    os.makedirs(args.output)
    debug_dir = "debug"
    if args.debug:
        os.makedirs(debug_dir, exist_ok=True)

    opt = dict(mode=args.mode, split=args.split, crop=args.crop, trim=args.trim,
               rotate=args.rotate, rtl=args.rtl, debug=args.debug, debug_dir=debug_dir)

    page_files = []
    n = 0
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        # map() keeps input order, so pages stay in reading order
        for i, (src, pages, info) in enumerate(ex.map(process_one, [(f, opt) for f in files]), 1):
            for p in pages:
                n += 1
                ext = ".png" if args.mode == "bw" else ".jpg"
                dst = os.path.join(args.output, f"{n:04d}{ext}")
                if ext == ".jpg":
                    cv2.imwrite(dst, p, [cv2.IMWRITE_JPEG_QUALITY, 88])
                else:
                    cv2.imwrite(dst, p, [cv2.IMWRITE_PNG_BILEVEL, 1])
                page_files.append(dst)
            print(f"[{i}/{len(files)}] {os.path.basename(src)} -> {info}, {len(pages)} page(s)")

    print(f"{n} pages written to {args.output}/")
    build_pdf(page_files, args.pdf, args.book_width_in)

    if args.ocr:
        if shutil.which("ocrmypdf"):
            print(f"Running OCR ({args.ocr}) ...")
            subprocess.run(["ocrmypdf", "-l", args.ocr, "--optimize", "1", "--jobs", str(args.workers),
                            args.pdf, args.pdf], check=False)
        else:
            print("ocrmypdf not installed:  brew install ocrmypdf tesseract-lang")


def build_pdf(page_files, pdf_path, width_in):
    import img2pdf

    def layout(imgwidthpx, imgheightpx, ndpi):
        w = img2pdf.in_to_pt(width_in)
        return w, w * imgheightpx / imgwidthpx, w, w * imgheightpx / imgwidthpx

    # img2pdf embeds JPEGs without re-encoding (fast, no quality loss)
    with open(pdf_path, "wb") as f:
        f.write(img2pdf.convert(page_files, layout_fun=layout))
    size = os.path.getsize(pdf_path) / 1e6
    print(f"PDF: {os.path.abspath(pdf_path)}  ({len(page_files)} pages, {size:.1f} MB)")


if __name__ == "__main__":
    main()
