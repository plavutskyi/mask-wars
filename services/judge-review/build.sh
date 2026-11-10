#!/usr/bin/env bash
# Builds the ai_review judge the same way anywhere, so anyone can check the sha256 a job pins as its judge version.
# The paths of this checkout and of the cargo registry are written into the wasm as fixed names, so a build in another
# folder, on another machine, gives the same bytes. Needs the toolchain in rust-toolchain.toml.
#   services/judge-review/build.sh             → prints the sha256 of target/wasm32-wasip2/release/maskwars-judge-review.wasm
#   services/judge-review/build.sh --mainnet   → the mainnet build, which also serves jobs.maskwars.near (src/job.rs): only
#                                           once the owner holds maskwars.near (scripts/mainnet/README.md); another sha256
set -euo pipefail
features=()
if [ "${1:-}" = "--mainnet" ]; then features=(--features mainnet); fi
cd "$(dirname "$0")"
here="$(pwd -P)"
cargo_home="$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
export RUSTFLAGS="--remap-path-prefix=$here=/maskwars/services/judge-review --remap-path-prefix=$cargo_home=/cargo"
export CARGO_TARGET_DIR="$here/target"
cargo build --release --locked --target wasm32-wasip2 -p maskwars-judge-review ${features[@]+"${features[@]}"}
sha256sum target/wasm32-wasip2/release/maskwars-judge-review.wasm
