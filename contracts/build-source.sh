#!/usr/bin/env bash
# The code a deploy uses, built so anyone can build the same bytes again from the public source (NEP-330). Each
# contract is built by `cargo near build reproducible-wasm` in the image its Cargo.toml pins
# (`[package.metadata.near.reproducible_build]`), from the commit at HEAD: the code then names that commit, the folder,
# the image and the command in `contract_source_metadata`, and nearblocks links the account to its source.
#
# Run it in a clone of the public repository (https://github.com/plavutskyi/mask-wars) at a commit that is pushed
# there: the link in the code points at that commit, so it must exist publicly. Needs Docker, the toolchain in each
# rust-toolchain.toml and cargo-near 0.22.0 (https://github.com/near/cargo-near/releases), and node for the check.
#
#   contracts/build-source.sh                       every contract → out/source/<name>.wasm, then the check
#   contracts/build-source.sh live-safe home        only these
#   contracts/build-source.sh --any-remote ...      on a commit that is not public (CI): the bytes are not for a deploy
#
# Prints each file's size, sha256 and code hash, and exits 1 unless every file names its version, the commit and how
# to build it again (contracts/nep330.mjs --check).
set -euo pipefail
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"

public=https://github.com/plavutskyi/mask-wars
any_remote=false
names=()
for a in "$@"; do
  case "$a" in
    --any-remote) any_remote=true ;;
    *) names+=("$a") ;;
  esac
done

# name, crate folder, and the build variant (none: the crate's own command).
contracts=(
  "live-safe contracts/challenges/live-safe"
  "bounty contracts/bounty"
  "house contracts/house"
  "home-mainnet contracts/home"
  "home-testnet contracts/home testnet"
  "season contracts/season"
  "jobs contracts/jobs"
  "crews contracts/crews"
  "mask contracts/masks/mask"
  "factory contracts/masks/factory"
)

if [ -n "$(git status --porcelain)" ]; then
  echo "the tree has changes that are not committed: the code would name a commit that is not what it was built from" >&2
  exit 1
fi
rev=$(git rev-parse HEAD)
if ! $any_remote; then
  origin=$(git remote get-url origin)
  case "$origin" in
    "$public" | "$public.git" | git@github.com:plavutskyi/mask-wars.git) ;;
    *) echo "origin is $origin, not $public: build in a clone of the public repository" >&2; exit 1 ;;
  esac
  git fetch --quiet origin
  if [ -z "$(git branch -r --contains "$rev")" ]; then
    echo "$rev is not on $public yet: push it first, the code's link must open" >&2
    exit 1
  fi
fi

out="$root/out/source"
mkdir -p "$out"
built=()
for entry in "${contracts[@]}"; do
  read -r name path variant <<<"$entry"
  if [ ${#names[@]} -gt 0 ] && ! printf '%s\n' "${names[@]}" | grep -qx -e "$name" -e "${name%-*}"; then
    continue
  fi
  echo "== $name ($path${variant:+, variant $variant})"
  dir="$out/$name"
  rm -rf "$dir"
  (cd "$path" && cargo near build reproducible-wasm ${variant:+--variant "$variant"} --out-dir "$dir")
  wasm=$(find "$dir" -maxdepth 1 -name '*.wasm' | head -1)
  cp "$wasm" "$out/$name.wasm"
  built+=("$out/$name.wasm")
done

echo
echo "commit $rev"
node "$root/contracts/nep330.mjs" --check "${built[@]}"
