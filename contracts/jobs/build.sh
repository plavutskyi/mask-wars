#!/usr/bin/env bash
# Builds the jobs and crews contracts the same way anywhere, so anyone can check the sha256 of the code a deploy uses.
# Cargo writes the absolute path of the crews crate into its code (it sits outside the workspace root), so the build
# runs on a copy of both crates at one fixed path, and the cargo registry's path is written in as a fixed name: a build
# from another folder, on another machine, gives the same bytes. Needs the toolchain in rust-toolchain.toml.
#   contracts/jobs/build.sh    → prints the sha256 of target/wasm/maskwars_jobs.wasm and maskwars_crews.wasm
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
build=/tmp/maskwars-contracts
cargo_home="$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
rm -rf "$build/contracts"
mkdir -p "$build/contracts"
tar -C "$here/.." --exclude=target -cf - jobs crews | tar -C "$build/contracts" -xf -
cd "$build/contracts/jobs"
export RUSTFLAGS="--cfg near -C link-arg=-s --remap-path-prefix=$cargo_home=/cargo"
export CARGO_TARGET_DIR="$build/target"
cargo build --release --locked --target wasm32-unknown-unknown -p maskwars-jobs -p maskwars-crews
mkdir -p "$here/target/wasm"
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/maskwars_jobs.wasm" \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/maskwars_crews.wasm" "$here/target/wasm/"
cd "$here/target/wasm"
sha256sum maskwars_jobs.wasm maskwars_crews.wasm
