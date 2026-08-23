#!/usr/bin/env bash
# Build the app icon (ios/AppIcon.png) from the shared brand icon.
#
# We reuse the same mark as the web app and the Tauri iOS build
# (src-tauri/icons/icon.png) so all three look identical. That master is a
# rounded-square logo on a transparent background; iOS app icons must be opaque
# and full-bleed (the OS applies its own corner mask), so we flatten it onto the
# icon's own navy and scale to 1024. Requires ImageMagick (`magick`).
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="../src-tauri/icons/icon.png"          # 512x512 brand master (transparent corners)
NAVY="#101E2A"                              # the logo card's background navy

magick "$SRC" -background "$NAVY" -alpha remove -alpha off \
  -resize 1024x1024 \
  -define png:color-type=2 AppIcon.png

echo "Wrote AppIcon.png ($(identify -format '%wx%h %[colorspace] alpha=%A' AppIcon.png))"
