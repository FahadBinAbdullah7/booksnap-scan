# BookSnap: hands-free book scanner

Turn the pages yourself. The tool captures each page automatically, splits two-page photos into separate pages, cleans them like CamScanner's Magic Color, and builds one PDF. There's no page limit.

## Setup (once)
```bash
cd ~/Downloads/scan
source .venv/bin/activate            # already created
# (fresh machine: uv venv --python 3.12 .venv && uv pip install -r requirements.txt)
brew install ocrmypdf tesseract-lang  # optional: searchable PDF (Bangla = ben)
```

## Physical setup
- Mount the phone **directly above** the open book, pointing straight down. Frame both pages.
- Put the book on a **dark cloth or table** so the paper stands out. This is how the book gets auto-detected.
- Lay a **clear acrylic or glass sheet** on the pages to flatten the curve. Keep your hands out of the frame while it shoots.
- Use two lamps at 45° (left and right) so the glass doesn't reflect glare.

## 1. Capture
**Android:** install **IP Webcam** (free), press "Start server", note the URL it shows.
```bash
python capture.py --source http://192.168.1.5:8080
```
**iPhone / Mac webcam:** use Continuity Camera (try 0, 1 or 2):
```bash
python capture.py --source 1
```
Press **P** to start. Then: turn page, hands away, beep, turn page, and so on.
`SPACE` takes a photo now · `U` deletes the last photo · `Q` quits. Photos go to `raw/0001.jpg…`.
If you stop and start again later, numbering continues where it left off.

Tune it: `--still 1.0` waits longer before shooting · `--motion 0.04` ignores small movements · `--rotate 90` if the image is sideways.

## 2. Process
```bash
python process.py                    # Magic Color, auto-split -> pages/ + book.pdf
python process.py --mode bw          # crisp B&W, much smaller PDF (text books)
python process.py --mode gray
python process.py --ocr eng+ben      # searchable PDF
python process.py --debug            # debug/ shows the detected book outline + split line
python process.py --split off        # photos that show only one page each
```

## Publishing an update (Android app)

Installed apps check GitHub for a newer release and offer **⬇ Update** on the home screen. Their books are kept.

1. Push your code changes to `main`.
2. On GitHub, open **Releases → Draft a new release**. Create a tag with a higher version than the last one, like `v1.2.0`. Write what changed, then click **Publish release**.
3. GitHub Actions builds the signed APK (about 5 minutes) and attaches `BookSnap-v1.2.0.apk` to the release.
4. Phones running the app see the update the next time they open the home screen. They check every 6 hours, and **Check for updates** checks right away.

The version always comes from the tag (`v1.2.0` → version 1.2.0, build 10200), and every new tag must be higher than the last.

Every build must be signed with the same key, or Android refuses the update. GitHub keeps the key in the repository secrets `BOOKSNAP_KEYSTORE_BASE64`, `BOOKSNAP_KEYSTORE_PASSWORD`, `BOOKSNAP_KEY_ALIAS` and `BOOKSNAP_KEY_PASSWORD`. Keep a backup of the key file. If it's lost, people must uninstall and reinstall the app, which deletes their books.
