#!/bin/bash
# Build the signed + notarized DMG.
#   1. ./scripts/install-cert.sh     (once, after Apple issues the certificate)
#   2. cp .env.signing.example .env.signing && fill it in
#   3. npm run release
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.signing ] || { echo "✗ .env.signing missing — copy .env.signing.example and fill it in"; exit 1; }
set -a; . ./.env.signing; set +a

security find-identity -v -p codesigning | grep -q "Developer ID Application" \
  || { echo "✗ no Developer ID Application identity — run ./scripts/install-cert.sh first"; exit 1; }

echo "→ bundling renderer"
npm run build:renderer

echo "→ building, signing and notarizing (notarization takes a few minutes)"
npx electron-builder --mac dmg

echo ""
echo "=== done ==="
ls -lh dist/*.dmg 2>/dev/null
echo "Verify:  spctl -a -vvv -t install dist/*.dmg"
