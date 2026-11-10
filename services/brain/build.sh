#!/usr/bin/env bash
# Builds the mask's mind the same way anywhere, so anyone can check the sha256 OutLayer keys its version by. The paths of
# this checkout and of the cargo registry are written into the wasm as fixed names, so a build in another folder, on
# another machine, gives the same bytes. Needs the toolchain the CI job uses (1.97.0).
#   services/brain/build.sh             → prints the sha256 of target/wasm32-wasip2/release/maskwars-brain.wasm
#   services/brain/build.sh --mainnet   → the mainnet build, which also plays the masks of masks.maskwars.near
#                                         (src/mind.rs): only once the owner holds maskwars.near (scripts/mainnet/README.md)
set -euo pipefail
features=()
if [ "${1:-}" = "--mainnet" ]; then features=(--features mainnet); fi
cd "$(dirname "$0")"
here="$(pwd -P)"
repo="$(cd ../.. && pwd -P)"
cargo_home="$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
# The mind carries the live safe's source and manifest from contracts/challenges: its path is the repository's.
export RUSTFLAGS="--remap-path-prefix=$here=/maskwars/services/brain --remap-path-prefix=$repo=/maskwars --remap-path-prefix=$cargo_home=/cargo"
export CARGO_TARGET_DIR="$here/target"
cargo build --release --locked --target wasm32-wasip2 ${features[@]+"${features[@]}"}
# The module's manifest (manifest.json) travels inside the wasm, in the section OutLayer reads (src/main.rs). Without
# it OutLayer gives a request 30 seconds, and a model that thinks for minutes would never be heard.
if ! grep -qaF "outlayer.manifest$(cat manifest.json)" target/wasm32-wasip2/release/maskwars-brain.wasm; then
  echo "the wasm does not carry manifest.json in its outlayer.manifest section" >&2
  exit 1
fi
sha256sum target/wasm32-wasip2/release/maskwars-brain.wasm
