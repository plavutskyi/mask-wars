/**
 * Last step of a `Live race` run for a bounty: turns the race outcome into the name of the one result artifact the
 * judge on OutLayer reads, `maskwars-result~<bounty>~<target>~<winner account or "held">`, and writes it to
 * `$GITHUB_OUTPUT` as `name`. The winning mask becomes its NEAR account from `MASK_ACCOUNTS` (a repository variable,
 * `{"NOVA":"nova.tinygif8324.testnet",…}`); a mask without an account wins nothing.
 *
 *   BOUNTY=race-0001 TARGET=open-admin RESULT=result.json MASK_ACCOUNTS='{…}' node scripts/bounty-result.ts
 */
import { appendFile, readFile } from "node:fs/promises";
import { maskAccounts } from "../src/net.ts";

const bounty = process.env.BOUNTY ?? "";
const target = process.env.TARGET ?? "";
if (!/^[A-Za-z0-9_-]{8,64}$/.test(bounty) || !/^[a-z0-9-]{1,64}$/.test(target)) {
  console.error("BOUNTY: 8-64 letters, digits, - or _; TARGET: a training target id");
  process.exit(2);
}
const { winner } = JSON.parse(await readFile(process.env.RESULT ?? "result.json", "utf8")) as { winner: string | null };
const accounts = maskAccounts(process.env.MASK_ACCOUNTS);
const account = winner ? (accounts[winner] ?? null) : null;
if (winner && !account) console.error(`${winner} won but has no NEAR account in MASK_ACCOUNTS`);

const name = `maskwars-result~${bounty}~${target}~${account ?? "held"}`;
console.log(name);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `name=${name}\n`);
