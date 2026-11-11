#!/usr/bin/env bash
# Builds home for each network the same way anywhere, so anyone can check the code hash a mask runs against
# `home_code` in packages/network. The crate has no dependencies and its code holds no path, so the bytes depend only
# on the toolchain in rust-toolchain.toml and the flags below (CI builds it again in another folder and compares).
#   contracts/home/build.sh    → target/wasm/maskwars_home-mainnet.wasm and maskwars_home-testnet.wasm, and their sha256
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
cd "$here"
# Nothing from the caller's environment chooses the toolchain or the flags: rust-toolchain.toml and this line do, even
# when the build runs inside another cargo (the sandbox tests in contracts/challenges call this script).
unset CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_BUILD_TARGET RUSTUP_TOOLCHAIN RUSTC RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
export RUSTFLAGS="--cfg near -C link-arg=-s"
mkdir -p target/wasm
for net in mainnet testnet; do
  # One target folder per network: the two builds differ by a feature, and one would overwrite the other.
  CARGO_TARGET_DIR="$here/target/$net" cargo build --release --locked --target wasm32-unknown-unknown --features "$net"
  cp "target/$net/wasm32-unknown-unknown/release/maskwars_home.wasm" "target/wasm/maskwars_home-$net.wasm"
done
cd target/wasm
sha256sum maskwars_home-mainnet.wasm maskwars_home-testnet.wasm
