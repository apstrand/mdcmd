#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

# Parse command line options
SKIP_DMG=false
INSTALL=false
for arg in "$@"; do
  if [ "$arg" = "--no-dmg" ] || [ "$arg" = "-n" ]; then
    SKIP_DMG=true
  elif [ "$arg" = "--install" ] || [ "$arg" = "-i" ]; then
    INSTALL=true
  fi
done

# Clear visual spacer
echo "============================================="
echo "        Tauri Release Build Script           "
if [ "$SKIP_DMG" = true ]; then
  echo "        (DMG bundling is disabled)           "
fi
if [ "$INSTALL" = true ]; then
  echo "        (Installing after build)             "
fi
echo "============================================="

# Detect the Operating System
OS="$(uname -s)"
echo "Detected OS: $OS"

# Setup release directory
RELEASES_DIR="./releases"
mkdir -p "$RELEASES_DIR"

# 1. Ensure node dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "Node modules not found. Running npm install..."
  npm install
else
  echo "Node modules verified."
fi

# 2. Check and prepare system dependencies based on OS
if [ "$OS" = "Darwin" ]; then
  echo "Verifying macOS compilation targets..."

  # --- Code signing + notarization -----------------------------------------
  # Load local signing secrets (gitignored). See .env.signing.example.
  if [ -f ".env.signing" ]; then
    echo "Loading signing configuration from .env.signing..."
    set -a
    # shellcheck disable=SC1091
    . ./.env.signing
    set +a
  fi

  if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    echo "Code signing enabled: $APPLE_SIGNING_IDENTITY"
    if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
      echo "ERROR: signing identity not found in the keychain:"
      echo "  $APPLE_SIGNING_IDENTITY"
      echo "Available identities:"
      security find-identity -v -p codesigning || true
      exit 1
    fi
    export APPLE_SIGNING_IDENTITY

    if [ -n "$APPLE_API_KEY" ] && [ -n "$APPLE_API_ISSUER" ] && [ -n "$APPLE_API_KEY_PATH" ]; then
      if [ ! -f "$APPLE_API_KEY_PATH" ]; then
        echo "ERROR: APPLE_API_KEY_PATH does not point to a file: $APPLE_API_KEY_PATH"
        exit 1
      fi
      export APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
      echo "Notarization enabled (App Store Connect API key $APPLE_API_KEY)."
    else
      echo "WARNING: signing without notarization. Downloaded builds will still"
      echo "         show a Gatekeeper warning. Set APPLE_API_* in .env.signing"
      echo "         to enable notarization + stapling."
    fi
  else
    echo "WARNING: APPLE_SIGNING_IDENTITY not set - building UNSIGNED."
    echo "         Copy .env.signing.example to .env.signing to enable signing."
  fi

  # Check if rustup is installed to add targets
  if command -v rustup &> /dev/null; then
    echo "Adding macOS targets for universal binary..."
    rustup target add x86_64-apple-darwin aarch64-apple-darwin
  else
    echo "Warning: rustup not found. Compilation might fail if target targets are missing."
  fi
  
  # Run the universal build
  echo "Building macOS universal binary..."
  set +e
  if [ "$SKIP_DMG" = true ]; then
    npm run tauri build -- --target universal-apple-darwin --bundles app
  else
    npm run tauri build -- --target universal-apple-darwin
  fi
  BUILD_EXIT_CODE=$?
  set -e

  if [ $BUILD_EXIT_CODE -ne 0 ]; then
    echo ""
    echo "ERROR: Tauri build failed (Exit Code: $BUILD_EXIT_CODE)."
    if [ "$SKIP_DMG" = false ]; then
      echo "------------------------------------------------------------"
      echo "TIPS FOR macOS DMG BUNDLING FAILURES:"
      echo "This error (e.g. running bundle_dmg.sh) is common on macOS."
      echo "It typically occurs because AppleScript/Finder Automation"
      echo "permissions are not granted to the terminal or compile task."
      echo ""
      echo "You can bypass DMG generation and compile only the '.app' bundle by running:"
      echo "  ./build-release.sh --no-dmg"
      echo ""
      echo "To grant Finder control permissions (if you need a DMG):"
      echo "  Go to: System Settings > Privacy & Security > Automation"
      echo "  Enable permissions for your terminal application."
      echo "------------------------------------------------------------"
    fi
    exit $BUILD_EXIT_CODE
  fi

  # Find and copy macOS bundles
  echo "Organizing build assets into $RELEASES_DIR..."
  
  # Target paths for universal builds
  UNIVERSAL_BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
  
  if [ -d "$UNIVERSAL_BUNDLE_DIR" ]; then
    # Copy .dmg files (if they exist)
    find "$UNIVERSAL_BUNDLE_DIR" -type f -name "*.dmg" -exec cp {} "$RELEASES_DIR/" \; 2>/dev/null || true
    
    # Copy .app folders (using recursive copy since .app is a folder)
    find "$UNIVERSAL_BUNDLE_DIR" -type d -name "*.app" -prune -exec cp -R {} "$RELEASES_DIR/" \;
  else
    # Fallback to standard release build target if universal target didn't compile there
    STANDARD_BUNDLE_DIR="src-tauri/target/release/bundle"
    if [ -d "$STANDARD_BUNDLE_DIR" ]; then
      find "$STANDARD_BUNDLE_DIR" -type f -name "*.dmg" -exec cp {} "$RELEASES_DIR/" \; 2>/dev/null || true
      find "$STANDARD_BUNDLE_DIR" -type d -name "*.app" -prune -exec cp -R {} "$RELEASES_DIR/" \;
    fi
  fi

elif [ "$OS" = "Linux" ]; then
  echo "Checking Linux system dependencies..."
  
  # Define list of Debian/Ubuntu dependencies
  DEPS=("libwebkit2gtk-4.1-dev" "build-essential" "curl" "wget" "file" "libxdo-dev" "libssl-dev" "libayatana-appindicator3-dev" "librsvg2-dev" "libdbus-1-dev" "pkg-config")
  MISSING_DEPS=()
  
  if command -v dpkg -s &> /dev/null; then
    for dep in "${DEPS[@]}"; do
      if ! dpkg -s "$dep" &> /dev/null; then
        MISSING_DEPS+=("$dep")
      fi
    done
  fi
  
  if [ ${#MISSING_DEPS[@]} -ne 0 ]; then
    echo "Warning: The following package dependencies are missing:"
    for m_dep in "${MISSING_DEPS[@]}"; do
      echo "  - $m_dep"
    done
    echo "You may need to run: sudo apt-get update && sudo apt-get install -y ${MISSING_DEPS[*]}"
    echo "Attempting build anyway..."
  else
    echo "All Linux dependencies verified."
  fi

  # Run standard Linux build
  #
  # NO_STRIP=1 works around linuxdeploy bundling its own ancient `strip`
  # (binutils 2.35), which can't parse the `.relr.dyn` (SHT_RELR) section
  # emitted by libraries built with newer binutils/glibc (e.g. on Arch).
  # See: linuxdeploy AppImage's usr/bin/strip vs system strip --version.
  echo "Building Linux binaries..."
  NO_STRIP=1 npm run tauri build

  # Find and copy Linux bundles (.deb and .AppImage)
  echo "Organizing build assets into $RELEASES_DIR..."
  LINUX_BUNDLE_DIR="src-tauri/target/release/bundle"
  
  if [ -d "$LINUX_BUNDLE_DIR" ]; then
    find "$LINUX_BUNDLE_DIR" -type f \( -name "*.deb" -o -name "*.AppImage" \) -exec cp {} "$RELEASES_DIR/" \;
  fi

else
  echo "Unsupported OS for building macOS/Linux binaries: $OS"
  exit 1
fi

# 3. Optionally install the freshly built package
if [ "$INSTALL" = true ]; then
  echo "---------------------------------------------"
  echo "Installing built package..."

  if [ "$OS" = "Darwin" ]; then
    APP_BUNDLE="$(find "$RELEASES_DIR" -maxdepth 1 -type d -name "*.app" -print -quit)"
    if [ -z "$APP_BUNDLE" ]; then
      echo "ERROR: No .app bundle found in $RELEASES_DIR to install."
      exit 1
    fi
    APP_NAME="$(basename "$APP_BUNDLE")"
    DEST="/Applications/$APP_NAME"
    echo "Installing $APP_NAME to /Applications..."
    rm -rf "$DEST"
    cp -R "$APP_BUNDLE" "$DEST"
    echo "Installed to $DEST"

  elif [ "$OS" = "Linux" ]; then
    DEB_PKG="$(find "$RELEASES_DIR" -maxdepth 1 -type f -name "*.deb" -print -quit)"
    if [ -n "$DEB_PKG" ]; then
      echo "Installing $DEB_PKG (requires sudo)..."
      if command -v apt-get &> /dev/null; then
        sudo apt-get install -y "$DEB_PKG"
      else
        sudo dpkg -i "$DEB_PKG"
      fi
      echo "Installed $DEB_PKG"
    else
      APPIMAGE="$(find "$RELEASES_DIR" -maxdepth 1 -type f -name "*.AppImage" -print -quit)"
      if [ -n "$APPIMAGE" ]; then
        DEST="$HOME/.local/bin/$(basename "$APPIMAGE")"
        mkdir -p "$HOME/.local/bin"
        cp "$APPIMAGE" "$DEST"
        chmod +x "$DEST"
        echo "Installed AppImage to $DEST"
      else
        echo "ERROR: No .deb or .AppImage found in $RELEASES_DIR to install."
        exit 1
      fi
    fi
  fi
fi

# 4. Report completed outputs
echo "---------------------------------------------"
echo "Build complete! Output binaries in $RELEASES_DIR:"
ls -la "$RELEASES_DIR"
echo "============================================="
