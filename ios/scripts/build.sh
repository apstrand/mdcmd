#!/usr/bin/env bash
# Build the iOS app (and embedded widget) with xtool. This is the CI gate and
# works on macOS and Linux. Extra args are passed through to `xtool dev build`
# (e.g. --configuration release, --ipa).
set -euo pipefail
cd "$(dirname "$0")/.."
exec xtool dev build "$@"
