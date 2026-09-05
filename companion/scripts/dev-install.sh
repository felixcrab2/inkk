#!/bin/bash
# Build the companion, sign it with the STABLE Apple Development identity, and
# install it to /Applications.
#
# Why this exists: ad-hoc signatures change on every build, so macOS treated
# each rebuild as a new app and revoked Accessibility/Input Monitoring every
# time — the grant-rebuild-reset loop. The Apple Development certificate
# (created when the iOS app was first provisioned) is a stable identity:
# grant the permissions once and they persist across every future rebuild.
#
# Developer ID (public distribution) still comes later via install-cert.sh +
# release.sh once the certificate exists; this is the development loop.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY=$(security find-identity -v -p codesigning | grep "Apple Development" | head -1 | sed 's/.*"\(.*\)"/\1/')
[ -n "$IDENTITY" ] || { echo "✗ no Apple Development identity in the keychain"; exit 1; }
echo "→ signing as: $IDENTITY"

npm run build:renderer
CSC_IDENTITY_AUTODISCOVERY=false npx electron-builder --dir --mac >/dev/null

APP="dist/mac-arm64/inkk.app"
codesign --force --deep --sign "$IDENTITY" \
  --entitlements build/entitlements.mac.plist "$APP"
codesign -v "$APP" && echo "✓ signed (stable identity)"

# a real install: quit the old copy, replace it, relaunch
pkill -f "/Applications/inkk.app" 2>/dev/null || true
rm -rf /Applications/inkk.app
cp -R "$APP" /Applications/inkk.app
open /Applications/inkk.app
echo "✓ installed and launched from /Applications"
