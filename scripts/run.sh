#!/usr/bin/env bash
# Builds the desktop app as one self-contained binary and starts it. No dev server needed.
#   scripts/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d app/node_modules ] || npm --prefix app install
npm --prefix app run build
cargo build --release -p volumen --features custom-protocol
exec ./target/release/volumen
