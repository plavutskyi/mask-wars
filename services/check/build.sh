#!/usr/bin/env bash
# Builds the MASK CHECK module the same way anywhere, so anyone can check the sha256 OutLayer runs and attests.
# The paths of this checkout and of the cargo registry are written into the wasm as fixed names, so a build in another
# folder, on another machine, gives the same bytes. Needs the toolchain in rust-toolchain.toml and the two shared
# lists next to it in the repo (packages/check/list.json, list.mainnet.json): the module carries them.
#   services/check/build.sh          → prints the sha256 of target/wasm32-wasip2/release/maskwars-check.wasm
set -euo pipefail
cd "$(dirname "$0")"
here="$(pwd -P)"
cargo_home="$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
export RUSTFLAGS="--remap-path-prefix=$here=/maskwars/services/check --remap-path-prefix=$cargo_home=/cargo"
export CARGO_TARGET_DIR="$here/target"
cargo build --release --locked --target wasm32-wasip2
sha256sum target/wasm32-wasip2/release/maskwars-check.wasm
