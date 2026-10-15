#!/usr/bin/env bash
# Builds the engine for the web build and writes JS bindings to app/src/core/pkg.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --profile wasm --target wasm32-unknown-unknown -p vol-wasm
BINDGEN="$(command -v wasm-bindgen || echo "${CARGO_HOME:-$HOME/.cargo}/bin/wasm-bindgen")"
"$BINDGEN" --target web --out-dir app/src/core/pkg "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/wasm/vol_wasm.wasm"
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int -o app/src/core/pkg/vol_wasm_bg.wasm app/src/core/pkg/vol_wasm_bg.wasm
fi
ls -la app/src/core/pkg/vol_wasm_bg.wasm
