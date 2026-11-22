#!/usr/bin/env python3
"""
BookSnap capture: hands-free auto-capture while you turn pages.

How it works
  - Watches the camera continuously.
  - When it sees movement (your hand turning a page) and then the scene stays
    still for --still seconds, it takes a photo and beeps.
  - If the hand came and went but the page did not change, it does NOT save a
    duplicate.

Sources
  --source 0                         Mac webcam / iPhone Continuity Camera (try 0, 1, 2)
  --source http://192.168.1.5:8080   Android "IP Webcam" app (full-resolution photos)

Keys (in the preview window)
  P      pause / resume auto-capture (starts paused)
  SPACE  take a photo now (manual)
  U      undo: delete the last photo
  Q/ESC  quit
"""
import argparse
import os
import re
import subprocess
import sys
import time

import cv2
import numpy as np

try:
    import requests
except ImportError:  # only needed for IP Webcam
    requests = None


# ---------------------------------------------------------------- helpers
def beep():
    snd = "/System/Library/Sounds/Tink.aiff"
    if sys.platform == "darwin" and os.path.exists(snd):
        subprocess.Popen(["afplay", snd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        print("\a", end="", flush=True)


def small_gray(frame, width=320):
    h, w = frame.shape[:2]
    s = cv2.resize(frame, (width, int(h * width / w)), interpolation=cv2.INTER_AREA)
    g = cv2.cvtColor(s, cv2.COLOR_BGR2GRAY)
    return cv2.GaussianBlur(g, (5, 5), 0)


def changed_fraction(a, b, thresh=22):
    return float(np.mean(cv2.absdiff(a, b) > thresh))


def next_index(out_dir):
    nums = [int(m.group(1)) for f in os.listdir(out_dir) if (m := re.match(r"(\d+)\.jpg$", f))]
    return max(nums, default=0) + 1


class Camera:
    def __init__(self, source, rotate):
        self.rotate = rotate
        self.ip_base = None
        if str(source).startswith("http"):
            if requests is None:
                sys.exit("pip install requests  (needed for IP Webcam)")
            self.ip_base = source.rstrip("/")
            self.cap = cv2.VideoCapture(self.ip_base + "/video")
        else:
            self.cap = cv2.VideoCapture(int(source))
            # ask for the highest resolution the camera supports
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 4096)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 3072)
        if not self.cap.isOpened():
            sys.exit(f"Could not open camera source: {source}")

    def _rot(self, img):
        return {
            90: cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE),
            180: cv2.rotate(img, cv2.ROTATE_180),
            270: cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE),
        }.get(self.rotate, img)

    def read(self):
        ok, frame = self.cap.read()
        return self._rot(frame) if ok else None

    def photo(self, live_frame):
        """Full-resolution still. IP Webcam: real camera photo; webcam: the live frame."""
        if self.ip_base:
            try:
                r = requests.get(self.ip_base + "/photoaf.jpg", timeout=15)
                img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
                if img is not None:
                    return self._rot(img)
            except Exception as e:  # fall back to the video frame
                print(f"  ! photo request failed ({e}); using video frame")
        return live_frame


# ---------------------------------------------------------------- main loop
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="0", help="camera index or IP Webcam URL")
    ap.add_argument("--out", default="raw", help="folder for captured photos")
    ap.add_argument("--still", type=float, default=0.7, help="seconds of stillness before capture")
    ap.add_argument("--motion", type=float, default=0.02, help="fraction of pixels that must change to count as a page turn")
    ap.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270])
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    idx = next_index(args.out)
    cam = Camera(args.source, args.rotate)

    still_thresh = args.motion / 5
    paused = True
    state = "waiting"          # waiting -> moving -> (still long enough) -> capture -> waiting
    still_since = None
    prev = None
    last_cap_small = None
    last_saved = None
    flash_until = 0.0
    msg = "PAUSED - press P to start"

    print(f"Saving to {os.path.abspath(args.out)}  (next: {idx:04d}.jpg)")
    print("P = start/pause   SPACE = manual shot   U = undo   Q = quit")

    def save(frame_for_photo, small):
        nonlocal idx, last_cap_small, last_saved, flash_until
        img = cam.photo(frame_for_photo)
        path = os.path.join(args.out, f"{idx:04d}.jpg")
        cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        h, w = img.shape[:2]
        print(f"  saved {path}  ({w}x{h})")
        last_saved, last_cap_small = path, small
        idx += 1
        flash_until = time.time() + 0.25
        beep()

    while True:
        frame = cam.read()
        if frame is None:
            print("Camera stream ended / unavailable.")
            break
        small = small_gray(frame)
        motion = changed_fraction(small, prev) if prev is not None else 0.0
        prev = small
        now = time.time()

        if not paused:
            if state == "waiting":
                msg = "Turn the page..."
                if motion > args.motion:
                    state, still_since = "moving", None
            elif state == "moving":
                msg = "Hold still..."
                if motion < still_thresh:
                    still_since = still_since or now
                    if now - still_since >= args.still:
                        # only save if the page actually changed since the last photo
                        if last_cap_small is None or changed_fraction(small, last_cap_small) > 0.03:
                            save(frame, small)
                        state = "waiting"
                else:
                    still_since = None

        # ---- preview
        h, w = frame.shape[:2]
        scale = 900 / max(h, w)
        view = cv2.resize(frame, (int(w * scale), int(h * scale)))
        if now < flash_until:
            view = cv2.addWeighted(view, 0.4, np.full_like(view, 255), 0.6, 0)
        bar = int(min(motion / (args.motion * 2), 1.0) * 200)
        cv2.rectangle(view, (10, 10), (210, 24), (60, 60, 60), -1)
        cv2.rectangle(view, (10, 10), (10 + bar, 24), (0, 200, 255), -1)
        cv2.putText(view, f"{msg}   pages shot: {idx - 1}", (10, 50),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0) if not paused else (0, 0, 255), 2)
        cv2.imshow("BookSnap capture", view)

        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        elif key == ord("p"):
            paused = not paused
            state, msg = "waiting", ("PAUSED - press P to start" if paused else "Turn the page...")
        elif key == ord(" "):
            save(frame, small)
            state = "waiting"
        elif key == ord("u") and last_saved and os.path.exists(last_saved):
            os.remove(last_saved)
            print(f"  undo: deleted {last_saved}")
            idx -= 1
            last_saved, last_cap_small = None, None

    cam.cap.release()
    cv2.destroyAllWindows()
    print(f"Done. {idx - 1} photos in {os.path.abspath(args.out)}")


if __name__ == "__main__":
    main()
