#!/usr/bin/env bash
# Build and run on the iOS Simulator (macOS). Optional arg: a simulator UDID;
# otherwise xtool targets the booted simulator.
set -euo pipefail
cd "$(dirname "$0")/.."
udid="${1:-}"
if [ -n "$udid" ]; then
  exec xtool dev run --simulator --udid "$udid"
fi
exec xtool dev run --simulator
