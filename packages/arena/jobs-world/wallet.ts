/**
 * An outside agent's own wallet on the local sandbox: it makes a key that stays in the agent's folder, and signs and
 * sends exactly the action the MCP job tools hand back (`{signer_id, receiver_id, method_name, args, deposit, gas}`).
 * Sandbox only: the NEAR CLI does the same on testnet (`near_cli` in each tool's answer). Built on `near.ts`, nothing
 * else: no key ever leaves the folder the agent runs it in.
 *
 *   node jobs-world/wallet.ts keygen <key file>                      → prints the public key; the secret stays in the file
 *   node jobs-world/wallet.ts send <key file> <rpc> '<action json>'  → signs as action.signer_id, prints the outcome
 *   node jobs-world/wallet.ts send <key file> <rpc> @<action file>    → the same, the action read from a file
 *   node jobs-world/wallet.ts balance <rpc> <account>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Key, NEAR, Rpc, send } from "./near.ts";

const [cmd, ...args] = process.argv.slice(2);
const near = (yocto: bigint) => {
  const whole = yocto / NEAR;
  const frac = (yocto % NEAR).toString().padStart(24, "0").slice(0, 5).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
};

switch (cmd) {
  case "keygen": {
    const [file] = args;
    if (!file) throw new Error("keygen <key file>");
    if (existsSync(file)) throw new Error(`${file} exists: one key, kept`);
    const { secret, key } = Key.random();
    writeFileSync(file, `${JSON.stringify({ public_key: key.publicKeyText, private_key: secret })}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ public_key: key.publicKeyText, file, keep: "the private key is in this file, readable by you alone" }));
    break;
  }
  case "send": {
    const [file, url, json] = args;
    if (!file || !url || !json) throw new Error("send <key file> <rpc> '<action json>'");
    const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
    const a = JSON.parse(json.startsWith("@") ? readFileSync(json.slice(1), "utf8") : json) as { signer_id: string; receiver_id: string; method_name: string; args: unknown; deposit: string; gas: string };
    for (const field of ["signer_id", "receiver_id", "method_name", "deposit", "gas"] as const) {
      if (typeof a[field] !== "string") throw new Error(`the action has no ${field}`);
    }
    const r = await send(new Rpc(url), a.signer_id, new Key(private_key), a.receiver_id, [{ kind: "call", method: a.method_name, args: a.args, gas: BigInt(a.gas), deposit: BigInt(a.deposit) }]);
    console.log(JSON.stringify({ tx: r.hash, ok: r.ok, value: r.value, failure: r.failure, events: r.logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)).event) }));
    if (!r.ok) process.exit(1);
    break;
  }
  case "balance": {
    const [url, account] = args;
    if (!url || !account) throw new Error("balance <rpc> <account>");
    const r = await new Rpc(url).call<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: account });
    console.log(`${account}: ${near(BigInt(r.amount))} NEAR`);
    break;
  }
  default:
    throw new Error("keygen | send | balance");
}
