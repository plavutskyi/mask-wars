/**
 * After a `Live race` with a bounty on a live safe: the winning mask takes its winning plan into the sealed round on
 * testnet (RULES.md). Right away, while the commit window is open, it seals the plan: only the hash goes on chain.
 * Once the window closes it plays the plan on the real safe with its own keys, in its own turn, reveals it and claims
 * the drain. This runs in the drain job, on a clean runner that never ran the race: the plan comes in `FINDING_BOX`,
 * sealed by the race job for this mask's key (seal-finding.ts), and only that key opens it. The log shows only methods
 * and transaction hashes, which the chain shows anyway.
 *
 *   BOUNTY=s1-0007-3fa9c2 CHALLENGE=live-safe FINDING_BOX=finding-box.json MASK_ACCOUNTS='{"NOVA":"nova.…"}'
 *   MASK_KEYS='{"NOVA":{"seed":"<64 hex>"}}' node scripts/drain-live.ts
 *
 * By hand, `FINDING=finding.json` takes a plain finding instead.
 *
 * `MASK_KEYS` is a secret of the `live-race` environment: per mask, the seed every race key of the mask comes from
 * (src/keys.ts): its key on the round's safe, whichever safe the season made, and its key on the bounty contract, the
 * one key the box opens with. A `MASK_KEYS` from before seasons, `{"safe":"ed25519:…","claim":"ed25519:…"}`, still
 * plays the one safe its key was made for.
 *
 * A person's mask that won (`HUMAN_MASKS`, from the arm job) plays with the two keys the keeper put on it for this
 * round, both from `KEEPER_SEED`, a secret of the same environment. In a round with any of the people's masks every
 * sealed sweep asks for the round's `min_loot`, ours too: an early seal leaves every later plan whole.
 * Optional: `CHALLENGE` (the library target the round runs, default live-safe), `BOUNTY_CONTRACT` and `NEAR_RPC` (by
 * default those of MASKWARS_NETWORK, packages/network), `BOUNTY_TEAM`: the teams whose rounds the mask plays,
 * comma-separated, by default the network's admin and season treasury. Whatever it says, the mask plays only a round
 * that the safe's own team opened. `STRIKER`: the striker of our crew on a drain job of this round (the `Jobs`
 * workflow names it): it plays the plan whichever of our masks found it, so the crew wins the job by its split.
 *
 * If the mask already sealed in this round (an earlier job died after `commit`), it does not seal again: the salt comes
 * from its key, the plan from the same finding, and once they give the seal on chain it plays, reveals and claims.
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NET, teams } from "@maskwars/network";
import { maskAccounts, onThisNetwork } from "../src/net.ts";
import { humanMasksFrom } from "../src/brain.ts";
import { CHALLENGES_DIR, loadChallenge } from "../src/challenge.ts";
import { openFinding, type FindingBox } from "../src/finding-box.ts";
import { humanKey, humanRoundKeys } from "../src/keeper.ts";
import { claimKeyOf, roundKeys, secretsOf, type MaskSecret } from "../src/keys.ts";
import { playLive, resumeLive, sealLive, sweepRuleOf, type RoundView, type SafeRace } from "../src/live.ts";
import { holdsKey, JsonRpc, view } from "../src/near-tx.ts";
import { Plan } from "../src/plan.ts";
import { DEFAULT_VARIANT } from "../src/challenge.ts";
import { vaultVariant, withoutFailed } from "../src/variant.ts";

const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};

const bountyId = process.env.BOUNTY ?? "";
if (!/^[A-Za-z0-9_-]{8,64}$/.test(bountyId)) fail("BOUNTY: the live race's id");
const accounts = maskAccounts(process.env.MASK_ACCOUNTS);
const keys = JSON.parse(process.env.MASK_KEYS || "{}") as Record<string, MaskSecret>;
for (const secret of secretsOf(keys)) console.log(`::add-mask::${secret}`);
const challengeId = process.env.CHALLENGE || "live-safe";
if (!/^[a-z0-9-]{1,40}$/.test(challengeId)) fail("CHALLENGE: a target of the library");
const bountyContract = onThisNetwork("BOUNTY_CONTRACT", process.env.BOUNTY_CONTRACT || NET.bounty);

// The people's masks the keeper armed for this round: their keys come from KEEPER_SEED, for this round only.
const humans = humanMasksFrom(process.env.HUMAN_MASKS);
const keeperSeed = (process.env.KEEPER_SEED ?? "").trim();
if (keeperSeed) console.log(`::add-mask::${keeperSeed}`);
const humanOf = (id: string) => humans.find((h) => h.name.toUpperCase() === id);
for (const h of humans) accounts[h.name.toUpperCase()] ??= h.account;

type Finding = { attacker: string; plan: unknown; replay?: { steps?: unknown } | null };
const readFinding = async (): Promise<Finding | null> => {
  if (process.env.FINDING_BOX) {
    const boxes = [JSON.parse(await readFile(process.env.FINDING_BOX, "utf8")) as FindingBox | FindingBox[]].flat();
    const human = humanOf(boxes[0]?.mask ?? "");
    // The box opens with the mask's key on the bounty contract: from its seed, or the old `claim` key; for a person's
    // mask, the key the keeper derived for this round.
    const claim = (() => {
      try {
        if (human) return humanKey(keeperSeed, human.account, bountyId, bountyContract);
        const secret = keys[boxes[0]?.mask ?? ""] ?? fail(`${boxes[0]?.mask} has no keys in MASK_KEYS`);
        return claimKeyOf(secret, bountyContract);
      } catch (e) {
        return fail(`${boxes[0]?.mask}: ${(e as Error).message}`);
      }
    })();
    const box = boxes.find((b) => b.to === claim.publicKeyText) ?? fail("no box is sealed for the mask's key");
    if (accounts[box.mask] !== box.account) fail(`the finding was sealed for ${box.account}, not ${accounts[box.mask]}`);
    const finding = JSON.parse(openFinding(box, claim)) as Finding;
    if (finding.attacker !== box.mask) fail("the sealed finding names another mask");
    return finding;
  }
  return JSON.parse(await readFile(process.env.FINDING ?? "finding.json", "utf8").catch(() => "null")) as Finding | null;
};
const finding = await readFinding();
if (!finding) {
  console.log("no winner, nothing to seal");
  process.exit(0);
}

// A crew on a drain job (contracts/jobs/README.md, crews): its striker plays what any of our masks found in the race.
// The scout's mind found the plan, the race replayed it in a second clean sandbox, and the striker seals it, plays it
// on the safe with its own keys and claims the drain, so the round pays the crew's striker and the job pays the crew by
// its split. Only a finding of our own masks: a person's mask always plays its own plan.
const striker = (process.env.STRIKER ?? "").trim().toUpperCase();
if (striker && !/^[A-Z0-9_-]{1,32}$/.test(striker)) fail("STRIKER: the name of the crew's striker in MASK_ACCOUNTS");
const playAs = striker && !humanOf(finding.attacker) && keys[finding.attacker] && keys[striker] ? striker : finding.attacker;
if (striker && playAs !== striker) console.log(`STRIKER ${striker}: ${finding.attacker} plays its own finding (no keys for ${striker}, or a person's mask)`);
if (playAs !== finding.attacker) console.log(`${finding.attacker} found the plan; the crew's striker ${playAs} plays it`);
const mask = accounts[playAs] ?? fail(`${playAs} has no NEAR account in MASK_ACCOUNTS`);
const chain = new JsonRpc(process.env.NEAR_RPC || NET.rpc[0]!);
const race =
  (await view<SafeRace | null>(chain, bountyContract, "get_safe", { id: bountyId })) ??
  fail(`${bountyId} is not a live race on ${bountyContract}`);
if (!race.masks.includes(mask)) fail(`${bountyId} does not let ${playAs} (${mask}) in`);
const winner = humanOf(playAs);
const { safeKey, claimKey, anyMethod } = (() => {
  try {
    // A person's mask plays with the two keys the keeper put on it for this round: set_owner and sweep on the safe.
    if (winner) return { ...humanRoundKeys(keeperSeed, winner.account, bountyId, race.safe, bountyContract), anyMethod: false };
    const own = keys[playAs] ?? fail(`${playAs} has no keys in MASK_KEYS`);
    return roundKeys(own, race.safe, bountyContract);
  } catch (e) {
    return fail(`${playAs}: ${(e as Error).message}`);
  }
})();

// The mask plays on the safe only with its key there, and it plays after the commit window: a key found missing then
// comes too late for this round. So it is asked now, before anything is sealed.
const keyed = await holdsKey(chain, mask, safeKey).catch(() => null);
if (keyed === false) {
  fail(`${playAs} (${mask}) holds no key on ${race.safe}: nothing was sealed. Put the masks' keys on it first (scripts/testnet/season-keys.ps1 -Safe ${race.safe} -SafeOnly)`);
}

const live = {
  chain,
  bountyContract,
  bountyId,
  mask,
  safeKey,
  claimKey,
  // Comma-separated: the owner's account and the season's treasury both open our rounds.
  team: process.env.BOUNTY_TEAM ? process.env.BOUNTY_TEAM.split(",").map((t) => t.trim()).filter(Boolean) : [...teams(NET)],
  // A round with any of the people's masks: a sealed sweep asks for min_loot, so an early seal spoils no later plan.
  sweep: sweepRuleOf(race.masks, Object.entries(accounts).filter(([id]) => !humanOf(id)).map(([, a]) => a)),
  log: (line: string) => console.log(line),
};

const round = await view<RoundView | null>(live.chain, live.bountyContract, "get_round", { id: bountyId });
const resuming = round?.seals.some((s) => s.mask === mask && s.state === "sealed") ?? false;
// The vault's kind (src/variant.ts). The owner kind, every vault before 1.7.0 and a chain that does not say play the
// plan as it was found, as always. On another kind the mask leaves out the calls the sandbox refused: on chain a
// failed call ends its run, and the judge confirms only a plan played whole.
const kind = await vaultVariant(chain, race.safe).catch(() => DEFAULT_VARIANT);
const found = Plan.parse(finding.plan);
const whole = kind === DEFAULT_VARIANT ? found : withoutFailed(found, finding.replay as Parameters<typeof withoutFailed>[1]);
if (kind !== DEFAULT_VARIANT) console.log(`the vault is of the ${kind} kind${whole === found ? "" : `: ${found.steps.length - whole.steps.length} call(s) the sandbox refused are left out`}`);
const seal = {
  ...live,
  challenge: await loadChallenge(join(CHALLENGES_DIR, challengeId)),
  plan: whole,
  ...(anyMethod ? { safeMethods: null } : {}),
};
const sealed = await (resuming ? resumeLive(seal) : sealLive(seal)).catch((e: Error) =>
  fail(
    resuming
      ? `the seal is on chain but cannot be rebuilt: ${e.message}`
      : `${e.message}. If the race ate the commit window, open the next round with a longer commit_minutes`,
  ),
);
const minutes = Number((sealed.commitUntil - BigInt(Date.now()) * 1_000_000n) / 60_000_000_000n);
console.log(`sealed as #${sealed.seq}; the window closes in about ${Math.max(minutes, 0)} min`);
const result = await playLive(live, sealed);

const lines = [
  `### ${playAs} on ${NET.id}`,
  "",
  ...(playAs !== finding.attacker ? [`${finding.attacker} found the plan in the race; the crew's striker ${playAs} played it.`, ""] : []),
  `Mask: \`${mask}\`, seal #${sealed.seq}`,
  ...result.calls.map((c) => `- \`${c.method}\` ${c.ok ? "ok" : "failed"}: ${c.hash}`),
  `- \`reveal\`: ${result.revealTx ?? "not sent"}`,
  `- drain: ${result.drainTx ?? "none"}`,
  `- \`claim_drain\`: ${result.claimTx ?? "not sent"}`,
  `- ${bountyId}: ${result.status ?? "unknown"}, seal ${result.seal ?? "unknown"}`,
];
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
if (result.status !== "drained" && result.seal === "confirmed") {
  console.log("confirmed: an earlier seal can still win until the reveal window ends; then settle.ps1 pays");
  process.exit(0);
}
if (result.status !== "drained" && result.revealTx && result.drainTx) {
  console.log(`not paid yet: by hand, claim-drain.ps1 -Tx ${result.drainTx} -Mask ${mask}`);
}
if (result.status !== "drained") process.exit(1);
