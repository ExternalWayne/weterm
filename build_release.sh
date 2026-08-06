#!/bin/bash
# Build both Apple Silicon and Intel DMGs for Weterm
# Output: ./releases/Weterm_<version>_aarch64.dmg and Weterm_<version>_x64.dmg
set -e

cd "$(dirname "$0")"
OUTDIR="$(pwd)/releases"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)"
mkdir -p "$OUTDIR"

build_dmg() {
  local arch="$1"
  local target="$arch-apple-darwin"
  local app_dir="src-tauri/target/$target/release/bundle/macos/Weterm.app"
  local stage="$OUTDIR/stage-$arch"

  echo "=== Building $target ==="
  npx tauri build --target "$target" --bundles app

  echo "=== Creating DMG for $arch ==="
  rm -rf "$stage"
  mkdir -p "$stage"
  cp -R "$app_dir" "$stage/Weterm.app"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname Weterm -srcfolder "$stage" -ov -format UDZO \
    "$OUTDIR/Weterm_${VERSION}_${arch}.dmg"
  rm -rf "$stage"
}

build_dmg aarch64
build_dmg x86_64

ls -lh "$OUTDIR/"
echo "=== Done ==="
