#!/usr/bin/env python3
"""
BookSnap PC — runs on the laptop.

* Serves the PC Remote page (http://localhost:8765/pc.html).
* The BookSnap phone app connects to it directly over Wi-Fi (no internet needed):
  the PC sends "capture" commands, the phone sends back finished pages,
  which are saved straight into a folder (default ~/Documents/BookSnap/<book>/).

Start:  python3 booksnap_pc.py            (or double-click "Start BookSnap PC.command")
"""
import argparse
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
CONFIG = os.path.join(os.path.expanduser("~"), ".booksnap_pc.json")


def load_config():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    try:
        with open(CONFIG, "w") as f:
            json.dump(cfg, f)
    except OSError:
        pass
MAX_BODY = 80 * 1024 * 1024


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))          # no packet is sent
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def safe_name(s):
    s = re.sub(r'[\\/:*?"<>|#%]+', " ", str(s or "Book"))
    return (re.sub(r"\s+", " ", s).strip() or "Book")[:80]


class Hub:
    """Shared state between the phone and the PC page."""

    def __init__(self, folder):
        self.cv = threading.Condition()
        cfg = load_config()
        # the pairing code is kept between runs, so the phone reconnects by itself
        self.token = cfg.get("token") or secrets.token_hex(3).upper()
        if cfg.get("token") != self.token:
            cfg["token"] = self.token
            save_config(cfg)
        self.folder = folder
        self.book = "Book"
        self.cmds = []
        self.events = []
        self.seq = 0
        self.frame = None
        self.frame_seq = 0
        self.phone_polls = 0
        self.phone_seen = 0.0
        self.state = {}

    def phone_online(self):
        return self.phone_polls > 0 or time.time() - self.phone_seen < 6

    def emit(self, ev):
        with self.cv:
            self.seq += 1
            self.events.append((self.seq, ev))
            del self.events[:-500]
            self.cv.notify_all()

    def push_cmd(self, cmd):
        with self.cv:
            self.cmds.append(cmd)
            self.cv.notify_all()

    def take_cmds(self, wait):
        with self.cv:
            self.phone_polls += 1
            was_online = self.phone_seen and time.time() - self.phone_seen < 6
            self.phone_seen = time.time()
            if not was_online:
                self.seq += 1
                self.events.append((self.seq, {"t": "phone", "online": True}))
                self.cv.notify_all()
            end = time.time() + wait
            while not self.cmds and time.time() < end:
                self.cv.wait(end - time.time())
            out, self.cmds = self.cmds, []
            self.phone_polls -= 1
            self.phone_seen = time.time()
            return out

    def events_since(self, since, wait):
        with self.cv:
            end = time.time() + wait
            while not any(s > since for s, _ in self.events) and time.time() < end:
                self.cv.wait(end - time.time())
            return [dict(e, seq=s) for s, e in self.events if s > since], self.seq

    def book_dir(self):
        d = os.path.join(self.folder, safe_name(self.book))
        os.makedirs(d, exist_ok=True)
        return d


class Handler(SimpleHTTPRequestHandler):
    hub: Hub = None
    port = 8765

    def __init__(self, *a, **k):
        super().__init__(*a, directory=APP_DIR, **k)

    def log_message(self, fmt, *args):      # keep the terminal quiet
        pass

    # ------------------------------------------------------------ helpers
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def reply(self, code=200, obj=None, body=None, ctype="application/json", extra=None):
        data = body if body is not None else json.dumps(obj if obj is not None else {"ok": True}).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("too large")
        return self.rfile.read(n) if n else b""

    def local_client(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ------------------------------------------------------------ routing
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.api("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self.api("POST")
        self.reply(404, {"error": "not found"})

    def api(self, method):
        hub = self.hub
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        route = u.path[len("/api/"):]
        try:
            if route == "session":                      # PC page only (same computer)
                if not self.local_client():
                    return self.reply(403, {"error": "local only"})
                ip = lan_ip()
                return self.reply(obj={
                    "token": hub.token, "ip": ip, "port": self.port,
                    "address": f"{ip}:{self.port}/{hub.token}",
                    "qr": f"http://{ip}:{self.port}/?booksnap={hub.token}",
                    "folder": hub.folder, "book": hub.book, "platform": sys.platform,
                })
            if q.get("t", "").upper() != hub.token:
                return self.reply(403, {"error": "wrong code"})

            # ---------------- phone side
            if route == "hello" and method == "POST":
                hub.emit({"t": "phone", "online": True})
                return self.reply(obj={"ok": True, "booksnap": 1, "token": hub.token, "book": hub.book})
            if route == "cmd" and method == "GET":
                return self.reply(obj=hub.take_cmds(min(25.0, float(q.get("wait", 20)))))
            if route == "msg" and method == "POST":
                m = json.loads(self.body() or b"{}")
                if m.get("t") == "state":
                    hub.state = m
                    hub.book = m.get("book") or hub.book
                if m.get("t") == "sync-start":
                    # mirror: remove page files beyond the book's last page
                    total = int(m.get("total", 0))
                    for n in os.listdir(hub.book_dir()):
                        mm = re.fullmatch(r"(\d{4})\.jpg", n)
                        if mm and int(mm.group(1)) > total:
                            os.remove(os.path.join(hub.book_dir(), n))
                if m.get("t") == "undone":
                    for o in m.get("orders", []):
                        p = os.path.join(hub.book_dir(), f"{int(round(o)):04d}.jpg")
                        if os.path.exists(p):
                            os.remove(p)
                hub.emit(m)
                return self.reply()
            if route == "page" and method == "POST":
                data = self.body()
                if q.get("book"):
                    hub.book = q["book"]
                name = f"{int(round(float(q['order']))):04d}.jpg"
                with open(os.path.join(hub.book_dir(), name), "wb") as f:
                    f.write(data)
                hub.emit({"t": "page", "order": float(q["order"]), "side": q.get("side"),
                          "blurry": q.get("blurry") == "1", "file": name, "bytes": len(data)})
                return self.reply()
            if route == "original" and method == "POST":
                data = self.body()
                d = os.path.join(hub.book_dir(), "originals")
                os.makedirs(d, exist_ok=True)
                orders = "-".join(f"{int(round(float(o))):04d}" for o in q.get("orders", "0").split(","))
                with open(os.path.join(d, orders + ".jpg"), "wb") as f:
                    f.write(data)
                return self.reply()
            if route == "frame" and method == "POST":
                data = self.body()
                with hub.cv:
                    hub.frame = data
                    hub.frame_seq += 1
                    hub.phone_seen = time.time()
                    hub.cv.notify_all()
                return self.reply()

            # ---------------- PC page side
            if route == "frame" and method == "GET":
                after = int(q.get("after", 0))
                with hub.cv:
                    end = time.time() + 2
                    while hub.frame_seq <= after and time.time() < end:
                        hub.cv.wait(end - time.time())
                    frame, seq = hub.frame, hub.frame_seq
                if not frame:
                    return self.reply(204, body=b"", ctype="text/plain")
                return self.reply(body=frame, ctype="image/jpeg", extra={"X-Seq": str(seq), "Access-Control-Expose-Headers": "X-Seq"})
            if route == "cmd" and method == "POST":
                hub.push_cmd(json.loads(self.body() or b"{}"))
                return self.reply()
            if route == "events":
                evs, last = hub.events_since(int(q.get("since", 0)), min(25.0, float(q.get("wait", 20))))
                return self.reply(obj={"events": evs, "last": last, "phone": hub.phone_online(),
                                       "state": hub.state, "folder": hub.folder, "book": hub.book})
            if route == "file" and method == "GET":
                name = os.path.basename(q.get("name", ""))
                p = os.path.join(hub.book_dir(), name)
                if not os.path.isfile(p):
                    return self.reply(404, {"error": "no such file"})
                with open(p, "rb") as f:
                    return self.reply(body=f.read(), ctype="image/jpeg" if name.endswith(".jpg") else "application/octet-stream")
            if route == "list":
                d = hub.book_dir()
                return self.reply(obj=sorted(n for n in os.listdir(d) if re.fullmatch(r"\d{4}\.jpg", n)))
            if route == "file" and method == "POST":
                name = os.path.basename(q.get("name", "file.bin"))
                with open(os.path.join(hub.book_dir(), name), "wb") as f:
                    f.write(self.body())
                return self.reply(obj={"ok": True, "path": os.path.join(hub.book_dir(), name)})
            if route == "choose-folder" and method == "POST":
                if sys.platform != "darwin":
                    return self.reply(400, {"error": "Start with --folder PATH to change the folder on this system."})
                r = subprocess.run(["osascript", "-e", 'POSIX path of (choose folder with prompt "Where should BookSnap save your books?")'],
                                   capture_output=True, text=True)
                if r.returncode == 0 and r.stdout.strip():
                    hub.folder = r.stdout.strip().rstrip("/")
                    cfg = load_config(); cfg["folder"] = hub.folder; save_config(cfg)
                return self.reply(obj={"folder": hub.folder})
            if route == "open-folder" and method == "POST":
                d = hub.book_dir()
                opener = "open" if sys.platform == "darwin" else "explorer" if os.name == "nt" else "xdg-open"
                subprocess.Popen([opener, d])
                return self.reply(obj={"folder": d})
            return self.reply(404, {"error": "unknown api"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:                       # report, don't crash the server
            try:
                self.reply(500, {"error": str(e)})
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser(description="BookSnap PC — control the phone scanner from this computer.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--folder", default=load_config().get("folder") or os.path.join(os.path.expanduser("~"), "Documents", "BookSnap"))
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.folder, exist_ok=True)
    Handler.hub = Hub(a.folder)
    Handler.port = a.port
    ThreadingHTTPServer.daemon_threads = True
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", a.port), Handler)
    except OSError:
        print(f"Port {a.port} is busy — BookSnap PC may already be running. Opening the page.")
        if not a.no_browser:
            webbrowser.open(f"http://localhost:{a.port}/pc.html")
        return
    ip = lan_ip()
    print("BookSnap PC is running.")
    print(f"  PC page:      http://localhost:{a.port}/pc.html")
    print(f"  Phone code:   {ip}:{a.port}/{Handler.hub.token}   (or scan the QR code on the PC page)")
    print(f"  Saving to:    {a.folder}")
    print("Keep this window open while scanning. Press Ctrl+C to stop.")
    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{a.port}/pc.html")).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
