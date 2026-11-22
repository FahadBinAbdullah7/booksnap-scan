#!/bin/bash
# Double-click this on the Mac: starts BookSnap PC and opens its page in the browser.
# The BookSnap phone app connects to it over Wi-Fi. Pages are saved to Documents/BookSnap.
cd "$(dirname "$0")" || exit 1
python3 booksnap_pc.py
