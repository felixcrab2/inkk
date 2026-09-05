#!/bin/bash
# Install the Developer ID certificate Apple issued into the login keychain,
# pairing it with the private key we generated in ~/.inkk-signing.
#
#   1. Download "developerID_application.cer" from developer.apple.com
#   2. ./scripts/install-cert.sh [path-to-.cer]     (defaults to ~/Downloads)
#
# Afterwards `security find-identity -v -p codesigning` shows a
# "Developer ID Application: …" identity and release builds can sign.
set -euo pipefail

CER="${1:-$HOME/Downloads/developerID_application.cer}"
KEY="$HOME/.inkk-signing/devid.key"
WORK="$HOME/.inkk-signing"

[ -f "$CER" ] || { echo "✗ certificate not found: $CER"; echo "  pass the path: ./scripts/install-cert.sh ~/Downloads/yourcert.cer"; exit 1; }
[ -f "$KEY" ] || { echo "✗ private key missing: $KEY (was ~/.inkk-signing deleted?)"; exit 1; }

echo "→ converting certificate to PEM"
openssl x509 -inform DER -in "$CER" -out "$WORK/devid.pem" 2>/dev/null \
  || openssl x509 -inform PEM -in "$CER" -out "$WORK/devid.pem"

echo "→ ensuring Apple's Developer ID intermediate CA is present"
curl -fsSL -o "$WORK/DeveloperIDG2CA.cer" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer || true
if [ -f "$WORK/DeveloperIDG2CA.cer" ]; then
  security import "$WORK/DeveloperIDG2CA.cer" -k "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null || true
fi

echo "→ bundling certificate + private key into a PKCS#12"
openssl pkcs12 -export -inkey "$KEY" -in "$WORK/devid.pem" \
  -out "$WORK/devid.p12" -passout pass:inkk -name "inkk Developer ID" \
  -legacy -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 2>/dev/null

echo "→ importing into the login keychain"
security import "$WORK/devid.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P inkk -T /usr/bin/codesign -T /usr/bin/productsign -A

echo ""
echo "=== codesigning identities now available ==="
security find-identity -v -p codesigning | grep -i "Developer ID Application" \
  && echo "✓ ready — run: npm run release" \
  || { echo "✗ no Developer ID Application identity found."; echo "  Check you downloaded a 'Developer ID Application' cert (not 'Apple Development')."; exit 1; }
