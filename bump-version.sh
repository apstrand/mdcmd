#!/usr/bin/env bash
#
# Bumps the shared release version across every place it's duplicated:
#   - package.json (and package-lock.json, via `npm version`)
#   - cli/Cargo.toml (and cli/Cargo.lock)
#   - src-tauri/Cargo.toml (and src-tauri/Cargo.lock) — this is what the
#     desktop GUI shows, via env!("CARGO_PKG_VERSION")
#   - flatpak/com.mdcmd.App.yml's git source `tag:` pin
#
# Does not touch git: no commit, tag, or push. Run this, review the diff,
# then commit/tag/push yourself.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NEW_VERSION="$1"
if [ -z "$NEW_VERSION" ]; then
  echo "Usage: $0 <new-version>" >&2
  echo "Example: $0 0.1.7" >&2
  exit 1
fi

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: version must be plain semver (e.g. 0.1.7), no 'v' prefix." >&2
  exit 1
fi

echo "============================================="
echo " Bumping release version to $NEW_VERSION"
echo "============================================="

# 1. package.json (+ package-lock.json), via npm so both stay consistent.
echo "-> package.json"
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null

# 2. cli/Cargo.toml — only the [package] version, not any dependency's
#    inline version constraint, so replace just the first `version = `.
echo "-> cli/Cargo.toml"
sed -i "0,/^version = \".*\"/s//version = \"$NEW_VERSION\"/" cli/Cargo.toml

# Regenerate cli/Cargo.lock's own "mdc" entry to match. `cargo check` only
# rewrites the lockfile for the version bump already made to Cargo.toml, it
# doesn't need to touch the network.
echo "-> cli/Cargo.lock"
(cd cli && cargo check --offline --quiet 2>/dev/null || cargo check --quiet)

# 3. src-tauri/Cargo.toml — same first-`version =` trick as cli. The desktop
#    GUI's version footer reads this via env!("CARGO_PKG_VERSION").
echo "-> src-tauri/Cargo.toml"
sed -i "0,/^version = \".*\"/s//version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml

echo "-> src-tauri/Cargo.lock"
(cd src-tauri && cargo check --offline --quiet 2>/dev/null || cargo check --quiet)

# 4. flatpak manifest's git source pin. Only the tag: local dev builds off
#    this; CI (release.yml) overwrites both tag: and commit: with the
#    actual release tag/commit at build time, so commit: is left alone here
#    (it would need the bump commit's own hash, which doesn't exist yet).
echo "-> flatpak/com.mdcmd.App.yml"
sed -i "s/tag: .*/tag: v$NEW_VERSION/" flatpak/com.mdcmd.App.yml

echo "============================================="
echo "Done. Changed files:"
git diff --stat -- package.json package-lock.json cli/Cargo.toml cli/Cargo.lock src-tauri/Cargo.toml src-tauri/Cargo.lock flatpak/com.mdcmd.App.yml
echo "============================================="
echo "Next steps:"
echo "  git add package.json package-lock.json cli/Cargo.toml cli/Cargo.lock src-tauri/Cargo.toml src-tauri/Cargo.lock flatpak/com.mdcmd.App.yml"
echo "  git commit -m \"bump version to $NEW_VERSION\""
echo "  git tag v$NEW_VERSION"
echo "  git push && git push origin v$NEW_VERSION"
