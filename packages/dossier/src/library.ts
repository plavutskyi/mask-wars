// The arena's training targets: every hole in them is planted on purpose, and a page names it as planted. Titles as in
// each target's `contracts/challenges/<id>/challenge.json`, holes and levels as in `contracts/challenges/README.md`;
// test/library.test.ts keeps the titles in step with those files.

import type { LibraryEntry } from "./types.ts";

export const LIBRARY: readonly LibraryEntry[] = [
  {
    id: "open-admin",
    title: "Savings vault with an owner",
    hole: "set_owner has no owner check, so anyone can make themselves owner and then sweep",
    level: null,
  },
  {
    id: "over-withdraw",
    title: "Savings vault",
    hole: "withdraw checks the amount against the whole vault, not against the caller's own credit",
    level: null,
  },
  {
    id: "proof-replay",
    title: "Bridge exit pool",
    hole: "claim checks the signature but never records the nonce, so a valid proof pays again and again",
    level: null,
  },
  {
    id: "pause-bypass",
    title: "Paused rewards pool",
    hole: "claim checks the pause, claim_for does not, so a member claims from a pool that is meant to be frozen",
    level: 1,
  },
  {
    id: "batch-overflow",
    title: "Savings vault with gifts",
    hole: "gift counts its total in milliNEAR through a counter of 32 bits, so a huge gift truncates to no charge at all",
    level: 2,
  },
  {
    id: "fake-oracle",
    title: "Dollar savings desk",
    hole: "oracle_on_call never checks the caller is the oracle, so the attacker feeds a fake NEAR price",
    level: 3,
  },
  {
    id: "blind-callback",
    title: "Vault with an exit queue",
    hole: "book_exit never reads the result of check_exit, so an exit the rules refused is booked all the same",
    level: 3,
  },
  {
    id: "relay-trust",
    title: "Payroll vault that relays",
    hole: "relay lets a mask make the vault call its own private book, so the self-call credits the attacker",
    level: 4,
  },
  {
    id: "share-rounding",
    title: "Yield pool in shares",
    hole: "withdraw rounds the shares it burns down, so a withdrawal below the whole pool burns no shares",
    level: 4,
  },
  {
    id: "prefix-clash",
    title: "Savings vault with callsigns",
    hole: "credits and callsigns take the same storage prefix, so a crafted callsign reads back as an enormous credit",
    level: 5,
  },
  {
    id: "live-safe",
    title: "Live safe",
    hole: "set_owner lets a mask of the race make itself owner, and then sweep",
    level: null,
  },
];

export function libraryEntry(id: string): LibraryEntry | null {
  return LIBRARY.find((e) => e.id === id) ?? null;
}
