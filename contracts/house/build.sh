#!/usr/bin/env bash
# Builds the house contract the same way anywhere, so the owner can check the sha256 of the code the deploy uses
# against CI's. The crate has no SDK and one tiny dependency; the cargo registry's path is written in as a fixed name,
# so a build in another folder, on another machine (WSL included), gives the same bytes. Needs the toolchain in
# rust-toolchain.toml with the wasm32-unknown-unknown target.
#   contracts/house/build.sh    → target/wasm/maskwars_house.wasm, and its size, sha256 and code hash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
cargo_home="$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
cd "$here"
export RUSTFLAGS="--cfg near -C link-arg=-s --remap-path-prefix=$cargo_home=/cargo"
export CARGO_TARGET_DIR="$here/target/build"
cargo build --release --locked --target wasm32-unknown-unknown
mkdir -p target/wasm
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/maskwars_house.wasm" target/wasm/
cd target/wasm
bytes=$(wc -c < maskwars_house.wasm)
# The code hash NEAR shows for the deployed account: base58 of the sha256.
code=$(python3 -c 'import hashlib,sys; n=int.from_bytes(hashlib.sha256(open(sys.argv[1],"rb").read()).digest(),"big"); a="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; s=""
while n: n,r=divmod(n,58); s=a[r]+s
print(s)' maskwars_house.wasm)
echo "maskwars_house.wasm  $bytes bytes  code hash $code  locks $(python3 -c "print($bytes / 100000)") NEAR"
sha256sum maskwars_house.wasm
