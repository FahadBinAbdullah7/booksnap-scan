# BookSnap: phone book scanner

An installable web app (PWA) for Android and iPhone. Everything is processed and stored **on the phone**: no server and no uploads.

| | Link |
|---|---|
| 🌐 Website (landing page) | https://booksnap-scanner.vercel.app |
| 📱 Phone web app | https://booksnap-scanner.vercel.app/app |
| 💻 PC Remote | https://booksnap-scanner.vercel.app/pc |
| 🔒 Privacy policy | https://booksnap-scanner.vercel.app/privacy |
| 🤖 Android app (APK) | https://github.com/FahadBinAbdullah7/booksnap-scan/releases/latest |

**Scan:** Book (hands-free Auto, 2-page split), Regular, Cheque book (1 page per photo, or 2), Card (front + back on one A4), Passport. **PDF tools:** E-sign, Watermark. **Connect:** PC Remote, or receive on another phone.

Website pages: `site.html` (landing, served at `/` and `/home`), `privacy.html` (`/privacy`), `index.html` (phone app, `/app`), `pc.html` (PC Remote, `/pc`). Routes are set in `vercel.json`.

## What it does
- **PC remote:** open `pc.html` on the computer and connect the phone by QR code or a 6-letter code. The PC shows the phone camera live. Press **Capture** or **Space** on the PC, and the phone takes the photo, saves it, processes the pages and sends them to the PC. The PC saves them as `0001.jpg`, `0002.jpg`… into a folder you choose (Chrome or Edge), and can make a PDF.
- **Auto-capture (optional, off by default):** turn the page, it waits until still, then shoots. It is always off while a PC is connected.
- **Two pages per photo:** hold the phone sideways over the open book. It finds the fold and saves the **left page first, then the right**.
- **Page detection:** finds the paper, including bent pages and a next page that is partly visible. A green outline shows live on the camera.
- **Flattening:** straightens curved page edges, so text lines come out straight.
- **Filters:** Magic Color, Original, Grayscale, B&W. Removes shadows, including hard hand or phone shadows and the dark fold. Magic and Grayscale are lightly sharpened for crisp text.
- **Auto-straighten:** tilted text lines are detected and straightened (up to 5°).
- **Blur warning:** every page is checked for focus and motion blur. Blurry pages get a ⚠ badge, and the phone vibrates. On the PC a yellow warning appears so you can retake before turning the page. Tap "⚠ N blurry" in a book to select them all.
- **Retake:** ↶ on the phone, or ⌫ / Z on the PC, deletes the last photo. The next photo reuses the same page numbers, so there are no gaps.
- **Auto-reconnect:** if Wi-Fi drops or the PC page reloads, the phone reconnects by itself (it keeps trying for 5 minutes).
- **Space-saving:** non-JPEG camera stills (some phones return huge PNGs) are stored as JPEG.
- **Editing:** crop by dragging 4 corners, rotate, move, delete.
- **Batch editing:** tap ☑ in a book, then pick **All** or **Range…** (for example pages 100–250). Then use **Filter**, **Rotate**, **Crop** or **Delete**. Batch Crop goes page by page, and **Apply to all remaining left/right pages** copies one crop to the rest (good when the phone sits on a stand).
- **Import:** add photos from your gallery.
- **PDF:** builds one PDF for the whole book. A 2000+ page PDF builds in seconds.
- Works offline, keeps the screen awake while scanning, and has a torch button.

## Files
| File | What |
|---|---|
| `index.html`, `css/app.css` | app shell and styles |
| `js/app.js` | screens: library, book grid, scanner, page editor, crop, export |
| `js/imgproc.js` | page detection, fold split, flattening, Magic Color (pure JS) |
| `js/worker.js` | processes photos in the background |
| `js/db.js` | storage on the phone (IndexedDB) |
| `js/pdf.js` | PDF builder |
| `js/camera.js` | camera, full-resolution photos |
| `js/remote.js` | phone ↔ PC link (WebRTC through PeerJS) |
| `pc.html`, `js/pc.js`, `css/pc.css` | PC remote page |
| `vendor/` | PeerJS 1.5.4 and qrcode-generator 1.4.4 (MIT) |
| `sw.js`, `manifest.webmanifest` | offline support and install |

## Latest: real camera, modes, auto page check, PC website
- **Real phone camera (Android app):** a native CameraX preview, the same system camera apps use. Smooth, with continuous autofocus, **tap to focus** and full-quality photos (about 1–2 s per photo).
- **Scanner choices** (remembered per book): **📄 1 page / 📖 2 pages**, **▯ Portrait / ▭ Landscape** (Landscape turns the scanner sideways; the result is upright pages, left page first), **✋ Manual / 🤖 Auto**.
- **🤖 Auto:** shoots 2 s after a page turn, then reads the printed page number (English 1 2 3 or Bangla ১ ২ ৩, top or bottom margin, offline). Next page → continue. Same or earlier page → photo deleted and paused. Pages skipped → paused with a message. Number not visible → saved, continues. Tap ⏸ to continue.
- **PC website:** https://booksnap-scanner.vercel.app opens the PC Remote page. In the app: **Scan → 💻 PC → Scan the QR code**. Press **Space** to capture. The website needs internet on both devices. If it can't connect on your network, use **Start BookSnap PC.command** (Wi-Fi only, no internet).
- Redeploy the website: `cd ~/Downloads/scan/app && npx vercel deploy --prod` (then delete the `.env.local` file it creates).

## Android app (APK): recommended
`~/Downloads/scan/BookSnap.apk` is the whole app as a normal Android app. It works offline, needs no website, and has no USB debugging.

**Install:** send `BookSnap.apk` to the phone (Google Drive, Telegram or WhatsApp "message yourself", email, or a USB file copy). On the phone, tap the file, allow **Install unknown apps** for that app when asked, then tap **Install**. If Play Protect warns "unknown developer", tap **More details → Install anyway**.

In the app:
- **PDF** is saved to `Documents/BookSnap/<book>/<book>.pdf`. There's a **Share** button for Drive and WhatsApp.
- **⋯ → Save page images** writes `Documents/BookSnap/<book>/pages/0001.jpg …`.
- Scanned pages are kept inside the app until you delete them. Uninstalling the app deletes them, so export first.
- In the scanner, **💻 PC** can scan the QR code shown on the PC page.

**PC side (Mac):** double-click **`Start BookSnap PC.command`** in `~/Downloads/scan`. This starts BookSnap PC (`booksnap_pc.py`) and opens its page in the browser. Keep the Terminal window open while scanning.
- The phone app connects **directly over your Wi-Fi**, with no internet or relay. Phone and computer must be on the same Wi-Fi.
- In the app: **Scan → 💻 PC → Scan the QR code**, or type the address shown on the PC page (like `192.168.0.107:8765/8AD0D8`).
- Pages are saved straight into **`~/Documents/BookSnap/<book>/0001.jpg …`**. Use **Change folder** or **Open folder** on the page. **Make PDF** writes `<book>.pdf` into the same folder.
- The first time, macOS may ask "Allow python3 to accept incoming network connections?". Click **Allow**, or the phone can't reach the PC.
- **Next time it connects by itself:** the app remembers your PC, and BookSnap PC keeps the same code. If the computer's Wi-Fi address changes, the app searches your Wi-Fi and finds it again (about 10 s).
- **Shutter buttons:** in the app scanner, the **volume buttons**, a **Bluetooth selfie remote** or a headset button take a photo. On the PC: **Space**, Enter, → or PageDown, or a Bluetooth foot pedal or presenter.
- **⇅ Get all pages from phone** makes the PC folder an exact copy of the book: it renumbers after deletions and removes leftovers.

**Rebuild after changing the code:**
```bash
cd ~/Downloads/scan && npx cap sync android
cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
cp app/build/outputs/apk/debug/app-debug.apk ../BookSnap.apk
```
Installing a new build over the old one keeps your books, as long as it is built on this Mac.

## Run on this Mac (test with the webcam)
```bash
cd ~/Downloads/scan/app && python3 -m http.server 8765
# open http://localhost:8765
```

## Put it on your phone
The phone camera only works over **HTTPS**, so the folder must be hosted. These are static files, so any static host works: GitHub Pages, Netlify, Vercel or Cloudflare Pages. Open the link on the phone, then:
- **Android (Chrome):** menu, then **Install app**
- **iPhone (Safari):** Share, then **Add to Home Screen**

## Using the PC remote
1. On the computer, open `https://<where you host it>/pc.html` in Chrome or Edge. It shows a QR code and a code.
2. On the phone, open a book, tap **Scan**, then **💻 PC**, and scan the QR code (Android) or type the code. You can also scan the QR with the phone's camera app.
3. On the PC, click **📁 Choose save folder**. Pages are saved into `<folder>/<book name>/`.
4. Turn the page, then press **Space** on the PC (or →, PageDown, Enter, or a Bluetooth foot pedal or presenter clicker). If a page shows ⚠ blurry, press **⌫** and shoot again.
5. **⇅ Get all pages from phone** re-sends every finished page, for example after batch edits.

The phone and PC find each other through the free PeerJS service. Photos then go straight from the phone to the PC over WebRTC. Only if a direct connection is impossible are they relayed by PeerJS's public relay server. Using the same Wi-Fi keeps it direct and fast.

## Scanning tips
- Use a **dark or plain cloth** under the book and even light from two sides.
- In **2 pages** mode, hold the phone **sideways (landscape)** with the whole spread in frame.
- If photos come out sideways, tap **⟳** in the scanner to set the rotation.
- Keep your hands out of the frame during the 2-second countdown.
- After scanning, check a few pages. If one is badly cropped, use **Crop** (drag the corners).
