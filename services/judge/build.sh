#!/usr/bin/env bash
# Builds the judge module the same way anywhere, so anyone can check the fingerprint the bounty contract pins (A15).
# The paths of this checkout and of the cargo registry are written into the wasm as fixed names, so a build in another
# folder, on another machine, gives the same bytes as CI. Needs the toolchain in rust-toolchain.toml.
#   services/judge/build.sh          → prints the sha256 of target/wasm32-wasip2/release/maskwars-judge.wasm
set -euo pipefail
cd "$(dirname "$0")"
here="$(pwd -P)"
cargo_home="$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
export RUSTFLAGS="--remap-path-prefix=$here=/maskwars/services/judge --remap-path-prefix=$cargo_home=/cargo"
cargo build --release --locked --target wasm32-wasip2
sha256sum target/wasm32-wasip2/release/maskwars-judge.wasm
