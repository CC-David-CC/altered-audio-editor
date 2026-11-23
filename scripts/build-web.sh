#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Playground's browser build of Altered Audio Editor (patches/audition.yaml in github.com/daijro/openplayground), into
# the folder given ($1): the back end (src-tauri, with Tauri's stand-ins in apps/altered-web) as a wasm32-wasip1
# module, altered.wasm, and the interface built by Vite with apps/altered-web/vite.config.mjs.
#
# The project's name and logo are its authors' trademarks (TRADEMARKS.md): this build is renamed to $NAME in every
# string the app shows, except where it names the original project (its book, its donation link, "Based on").
set -euo pipefail
DIST=$(realpath -m "$1")
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME=${PLAYGROUND_NAME:-Retake}
TARGET=${CARGO_TARGET_DIR:-$ROOT/apps/altered-web/target}
mkdir -p "$TARGET"

# LAME (MP3 export) is C: wasi-sdk compiles it for WASI.
WASI_SDK_VERSION=34
SDK=$TARGET/wasi-sdk-$WASI_SDK_VERSION-webos-verified
if [ ! -f "$SDK/.webos-verified" ]; then
  asset="wasi-sdk-$WASI_SDK_VERSION.0-x86_64-linux.tar.gz"
  setup=$(mktemp -d "$TARGET/wasi-sdk-setup.XXXXXXXX")
  trap 'rm -rf "$setup"' EXIT
  curl -fsSL --retry 2 "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_SDK_VERSION/$asset" -o "$setup/$asset"
  printf '%s  %s
' b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4 "$setup/$asset" | sha256sum --check
  mkdir -p "$setup/sdk"
  tar -xzf "$setup/$asset" -C "$setup/sdk" --strip-components=1
  test -x "$setup/sdk/bin/clang"
  touch "$setup/sdk/.webos-verified"
  test ! -e "$SDK"
  mv "$setup/sdk" "$SDK"
fi
rustup target add wasm32-wasip1

cd "$ROOT"
if [ "$NAME" != "Altered Audio Editor" ]; then
  grep -rlE 'Altered Audio' src src-tauri/src index.html --include=*.ts --include=*.svelte --include=*.rs --include=*.html |
    xargs -r sed -i -E "/Podcasting Demystified|Support Altered Audio Editor|Based on Altered Audio Editor/!{s/Altered Audio Editor/$NAME/g; s/Altered Audio/$NAME/g}"
fi

cd apps/altered-web
CC_wasm32_wasip1="$SDK/bin/clang" AR_wasm32_wasip1="$SDK/bin/llvm-ar" \
  CFLAGS_wasm32_wasip1="--sysroot=$SDK/share/wasi-sysroot -D_WASI_EMULATED_SIGNAL -O3" \
  MP3LAME_SYS_OVERRIDE_HOST=wasm32-wasi \
  cargo build --locked --release --target wasm32-wasip1

cd "$ROOT"
npm ci --no-audit --no-fund
./node_modules/.bin/vite build --config apps/altered-web/vite.config.mjs --outDir "$DIST" --emptyOutDir
cp "$TARGET/wasm32-wasip1/release/altered_web.wasm" "$DIST/altered.wasm"
