/**
 * One MASK CHECK from the terminal, read live from NEAR:
 *
 *   pnpm --filter @maskwars/check check <account> [--network testnet|mainnet] [--json] [--exit-code]
 *
 * The network defaults to the one the account names: `.testnet` reads testnet; `.near`, implicit ids and every other
 * name read mainnet. `MASKCHECK_RPC` (testnet) and `MASKCHECK_MAINNET_RPC` (mainnet), comma-separated, replace the
 * default RPC endpoints. Exit code 3 on a bad account id or network; with `--exit-code`, also 0 allow, 1 warn, 2 block.
 * Exit code 4 when no RPC answered: the answer then carries no chain reading at all.
 */
import { InvalidAccountError, isNetwork, maskCheck, networkOf, readerFor, sharedLists } from "../src/index.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : i >= 0 ? (argv[i + 1] ?? "") : null;
};
const networkArg = flag("--network");
const account = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--network");
if (!account) {
  console.error("usage: check <account> [--network testnet|mainnet] [--json] [--exit-code]");
  process.exit(3);
}
if (networkArg !== null && !isNetwork(networkArg)) {
  console.error(`--network: testnet or mainnet, not ${networkArg || "nothing"}`);
  process.exit(3);
}
const network = networkArg ?? networkOf(account);

try {
  const r = await maskCheck(account, { network, reader: readerFor(network, { env: process.env }), list: sharedLists[network] });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`${r.verdict.toUpperCase()}  ${r.account}  (${r.network}, block ${r.block?.height ?? "unread"})`);
    for (const x of r.reasons) console.log(`  ${x.level.padEnd(5)} ${x.code}: ${x.text}`);
  }
  if (!r.block) process.exit(4);
  if (argv.includes("--exit-code")) process.exit(r.verdict === "allow" ? 0 : r.verdict === "warn" ? 1 : 2);
} catch (error) {
  if (error instanceof InvalidAccountError) {
    console.error(error.message);
    process.exit(3);
  }
  throw error;
}
