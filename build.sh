#!/usr/bin/env bash
# Packs the extension for distribution.
#   ./build.sh            -> zip only (for the Chrome Web Store)
#   ./build.sh key.pem    -> zip + signed .crx (for self-hosting)
set -euo pipefail

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="fiton-invoice-$VERSION"

rm -f "$OUT.zip" "$OUT.crx"
zip -qr "$OUT.zip" manifest.json background.js content ui icons -x '*.DS_Store'
echo "built $OUT.zip"

if [ $# -ge 1 ]; then
  CHROME=${CHROME:-google-chrome}
  "$CHROME" --pack-extension="$PWD" --pack-extension-key="$1" --no-message-box
  mv ../"$(basename "$PWD")".crx "$OUT.crx" 2>/dev/null || mv "$(basename "$PWD")".crx "$OUT.crx"
  echo "built $OUT.crx  (upload with updates.xml, and bump the version in both)"
fi
