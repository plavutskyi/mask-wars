// One sealed round → its record, read from the chain through the arena reader. Nobody writes the record by hand.
//
//   pnpm --filter @maskwars/media round s1-0001-d74851 --network testnet     a season's round → races/s1-0001-d74851.json
//   pnpm --filter @maskwars/media round race-0005 --network testnet          a round opened by hand → races/race-0005.json
//   pnpm --filter @maskwars/media round <id> --network <testnet|mainnet> [--out <file>] [--answers <file>]
//   pnpm --filter @maskwars/media round example-0000 --replay <answers.json> no network: read recorded answers
//
// Only a round that ended in a paid drain makes a record; for any other the script says in one line where the round
// stands, and writes nothing. A chain or an indexer that does not answer is said as that.
// --answers keeps every answer the chain gave, in the format the tests replay (packages/arena: `Recording`).
// --replay reads such a file instead of the network. Made-up answers (`simulated`) tell an example round only and
// give a record marked SIMULATED, written to out/, never to races/.
// Then: pnpm --filter @maskwars/media race <id>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// pnpm runs this in the package; paths the person typed are read from where they typed them.
const here = process.env.INIT_CWD ?? process.cwd();
const argv = process.argv.slice(2);
const VALUE_FLAGS = ["--network", "--out", "--answers", "--replay"];
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const path = (p) => (isAbsolute(p) ? p : resolve(here, p));
const id = argv.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1] ?? ""));
const network = flag("--network") ?? "testnet";
if (!id || !["testnet", "mainnet"].includes(network)) {
  console.error("usage: round <round id: s1-0001-d74851 or race-0005> [--network testnet|mainnet] [--out file] [--answers file] [--replay answers.json]");
  process.exit(2);
}

// The arena reads its contracts, masks and endpoints for one network, named before it loads.
process.env.MASKWARS_NETWORK = network;
const { Arena, Indexer, RPCS } = await import("@maskwars/arena");
const { recordFetch, replayFetch } = await import("@maskwars/arena/replay");
const { ChainReader } = await import("@maskwars/check");
const { roundFromChain } = await import("../src/race/chain.ts");

let net = fetch;
let now = Date.now;
let source = "LIVE";
// Made-up answers come with the made-up arena they are about: its contracts, treasuries and masks.
let about = {};
if (flag("--replay")) {
  const file = path(flag("--replay"));
  if (!existsSync(file)) {
    console.error(`no recorded answers at ${file}`);
    process.exit(2);
  }
  const recording = JSON.parse(readFileSync(file, "utf8"));
  net = replayFetch(recording);
  now = () => recording.recordedAt;
  if (recording.simulated) source = "SIMULATED";
  about = recording.arena ?? {};
}
const kept = flag("--answers") ? recordFetch(net) : null;
if (kept) net = kept.fetch;
const readAt = now();
const indexer = new Indexer({ fetch: net });
const arena = new Arena({ ...about, rpc: new ChainReader({ endpoints: RPCS, fetch: net }), indexer, now: () => readAt });

let record;
try {
  record = await roundFromChain(id, { arena, indexer, now: () => readAt }, source);
} catch (e) {
  // A round with no payout, a chain that does not answer: say which, in one line, not where in the code.
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

// A made-up record never lands among the records of real rounds.
const out = flag("--out") ? path(flag("--out")) : source === "LIVE" ? join(root, "races", `${id}.json`) : join(root, "out", id, "record.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
if (kept) {
  const file = path(flag("--answers"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ recordedAt: readAt, exchanges: kept.exchanges }, null, 1)}\n`);
  console.log(`${kept.exchanges.length} answers → ${file}`);
}
const seal = record.sealed.seals.find((s) => s.mask === record.winner);
const drains = record.drain.txs.filter((t) => t.amount);
console.log(`${record.id} on ${record.network}, ${record.source}: ${record.winner} drained ${record.drain.amount} NEAR and was paid ${record.payout.amount} NEAR → ${out}`);
console.log(`  opened   ${record.opened.at}  ${record.season ? `by ${record.season}, ${record.safe} NEAR in the vault, ` : "by hand, "}${record.bounty} NEAR bounty`);
console.log(`  sealed   ${seal.at}  ${record.winner}, seal #${seal.seq} of ${record.sealed.seals.length}`);
console.log(`  closed   ${record.sealed.closedAt}  the ${record.sealed.minutes} minute window`);
console.log(`  drained  ${record.drain.at}  ${record.drain.amount} NEAR in ${drains.length} transaction${drains.length === 1 ? "" : "s"}: ${record.drain.txs.map((t) => (t.amount ? `${t.method} ${t.amount}` : t.method)).join(" → ")}`);
console.log(`  judged   request ${record.judge.request}, ${record.judge.seconds} s, ${record.judge.cost} NEAR`);
console.log(`  paid     ${record.payout.at}  ${record.payout.amount} NEAR to ${record.winner}`);
console.log(record.next ? `  next     round ${record.next.round} of the season, ${record.next.at}, as its treasury says` : "  next     none in the record: no card will name a next round");
