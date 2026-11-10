/**
 * The operator of the sandbox world: what the client, the keeper and the judge's stand-in do while outside agents work
 * a job. Every action is a signed transaction on the local chain, or the sandbox's own clock.
 *
 *   node jobs-world/op.ts <world.json> now
 *   node jobs-world/op.ts <world.json> ff <minutes>                       sandbox time moves on
 *   node jobs-world/op.ts <world.json> account <name> <ed25519:public> [NEAR=5]   root makes <name>.<root> with that key
 *   node jobs-world/op.ts <world.json> open <id> <reward> <fuel> <bond> <slots> <work min> <reveal min> <appeal min> <client_key> <brief…>
 *        the client opens an ai_review job with its reference review sealed for the judge, and the judge checks it
 *   node jobs-world/op.ts <world.json> past <id> work|reveal|appeal       sandbox time moves past that window of the job
 *   node jobs-world/op.ts <world.json> burn <id> <mask> <milliNEAR>        the meter books what a mask's mind burned
 *   node jobs-world/op.ts <world.json> judge <id>                          anyone asks the judge; its stand-in answers
 *   node jobs-world/op.ts <world.json> settle <id>
 *   node jobs-world/op.ts <world.json> serve-delivery <id> [minutes=20]   answers the next delivery anyone asks for
 *
 * The judge's stand-in is what the judge module does in its TEE, with the judge's sandbox seed: it opens each revealed
 * box for its own mask, counts the strikes that open as work and calls fake every box that opens for nobody, names the
 * best strike, keeps the winner's boxes, and once the job is paid seals the winner's work for the client's key into the
 * judge project's public storage (a folder the indexer stand-in serves). Its answers are the judge modules' stdout.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeSecret, openWork, sealDelivery, sealWork } from "../src/jobs/box.ts";
import { Key, NEAR, Rpc, TGAS, send } from "./near.ts";

interface Judge {
  version: string;
  key: string;
  project: string;
  seed: string;
  info: string;
}

interface World {
  rpc: string;
  jobs: string;
  outlayer: string;
  storage: string;
  judges: Record<"ai_review" | "tee_tests", Judge>;
  accounts: Record<string, { id: string; key: string }>;
}

interface RawStep {
  seq: number;
  entrant: number;
  mask: string;
  role: string;
  content: string | null;
  copy_of: number | null;
}

const [path, cmd, ...args] = process.argv.slice(2);
if (!path || !cmd) throw new Error("usage: node jobs-world/op.ts <world.json> <command> …");
const world = JSON.parse(readFileSync(path, "utf8")) as World;
const rpc = new Rpc(world.rpc);
const actor = (name: string) => {
  const a = world.accounts[name];
  if (!a) throw new Error(`no ${name} in the world`);
  return { id: a.id, key: new Key(a.key) };
};
const yocto = (near: string) => {
  const [w, f = ""] = near.split(".");
  return BigInt(w!) * NEAR + BigInt((f + "0".repeat(24)).slice(0, 24));
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ns: bigint) => new Date(Number(ns / 1_000_000n)).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const review = world.judges.ai_review;
const secret = () => judgeSecret(Buffer.from(review.seed, "hex"), review.info);

async function call(who: string, receiver: string, method: string, a: unknown, gas = 100n, deposit = 0n, wait = true) {
  const { id, key } = actor(who);
  const r = await send(rpc, id, key, receiver, [{ kind: "call", method, args: a, gas: gas * TGAS, deposit }], wait);
  if (wait && !r.ok) throw new Error(`${who} → ${receiver}.${method}: ${JSON.stringify(r.failure)}`);
  return r;
}

async function job(id: string) {
  return rpc.view<{ client: string; terms: Record<string, string>; verdict: { at_ns: string; final: boolean } | null; phase: string; status: { state: string; winner?: number }; steps: number } | null>(world.jobs, "get", { id });
}

async function ffUntil(ns: bigint) {
  while ((await rpc.now()) <= ns) await rpc.fastForward(100);
  console.log(`sandbox time ${iso(await rpc.now())}`);
}

/** OutLayer's requests so far, as its stand-in keeps them. */
const requests = () => rpc.view<{ input: string | null }[]>(world.outlayer, "requests", {});

/** Waits for request number `index`, which a call just made, to reach OutLayer. */
async function nextRequest(index: number, seconds = 60) {
  for (let i = 0; i < seconds * 5; i++) {
    const all = await requests();
    if (all.length > index) return all[index]!;
    await sleep(200);
  }
  throw new Error("the judge's question never reached OutLayer");
}

/** OutLayer hands request `index` the judge module's stdout; the job's callback runs. */
async function answer(index: number, output: unknown) {
  return call("bob", world.outlayer, "answer", { index, output: JSON.stringify(output) }, 50n);
}

/** A value of a judge project's public storage, as OutLayer keeps it: the indexer stand-in serves the folder. */
function keepPublic(project: string, key: string, value: string) {
  const dir = join(world.storage, project.replaceAll("/", "%2F"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, key.replaceAll("/", "%2F")), value);
}

switch (cmd) {
  case "now":
    console.log(`sandbox time ${iso(await rpc.now())}`);
    break;
  case "ff": {
    const minutes = Number(args[0] ?? 1);
    await ffUntil((await rpc.now()) + BigInt(Math.round(minutes * 60)) * 1_000_000_000n);
    break;
  }
  case "account": {
    const [name, pk, near = "5"] = args;
    if (!name || !pk?.startsWith("ed25519:")) throw new Error("account <name> <ed25519:public key> [NEAR]");
    const root = actor("root");
    const id = `${name}.${root.id}`;
    const { base58Decode } = await import("./near.ts");
    const r = await send(rpc, root.id, root.key, id, [
      { kind: "create_account" },
      { kind: "transfer", deposit: yocto(near) },
      { kind: "add_key", publicKey: base58Decode(pk.slice("ed25519:".length)), access: "full" },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.failure));
    console.log(`${id} created with ${near} NEAR and the key ${pk} · tx ${r.hash}`);
    break;
  }
  case "open": {
    const [id, reward, fuel, bond, slots, work, reveal, appeal, clientKey, ...brief] = args;
    if (!id || !reward || !fuel || !bond || !slots || !work || !reveal || !appeal || !clientKey?.startsWith("x25519:") || !brief.length) {
      throw new Error("open <id> <reward> <fuel> <bond> <slots> <work> <reveal> <appeal> <client_key> <brief…>");
    }
    const text = brief.join(" ");
    const client = actor("client");
    const quote = await rpc.view<{ total: string }>(world.jobs, "quote", { reward: yocto(reward).toString(), fuel_per_mask: yocto(fuel).toString(), slots: Number(slots) });
    // The client's own reference review, sealed for the judge: the check must find it clears the bar.
    const reference = sealWork(review.key, world.jobs, id, client.id, { kind: "text", text: "reference review: the refund path checks the order's state before it pays, once." });
    const r = await call(
      "client",
      world.jobs,
      "open",
      {
        id,
        kind: "ai_review",
        brief: text,
        spec: sha(`spec: ${text}`),
        rubric: sha(`rubric: ${text}`),
        judge_version: review.version,
        round: null,
        secrets: null,
        bar: { win_at: 60, cases: null, fuel: null, reference },
        reward: yocto(reward).toString(),
        fuel_per_mask: yocto(fuel).toString(),
        slots: Number(slots),
        open_to: { who: "anyone" },
        work_minutes: Number(work),
        reveal_minutes: Number(reveal),
        appeal_minutes: Number(appeal),
        bond: yocto(bond).toString(),
        client_key: clientKey,
      },
      100n,
      BigInt(quote.total),
    );
    console.log(`${id} opened by ${client.id}: reward ${reward} NEAR, fuel ${fuel} × ${slots}, bond ${bond} NEAR, work sealed for ${clientKey.slice(0, 15)}… once paid · tx ${r.hash}`);
    // The judge checks the client's material and its reference review against the bar: masks may start.
    const before = (await requests()).length;
    const asked = await call("bob", world.jobs, "check", { id }, 250n, 0n, false);
    const q = await nextRequest(before);
    const opened = openWork(secret(), world.jobs, id, client.id, reference);
    console.log(`check asked · tx ${asked.hash} · input ${q.input} · the judge opens the client's reference review (${opened.kind === "text" ? opened.text.length : 0} chars) in its TEE`);
    const a = await answer(before, { success: true, output: { job: id, checked: true }, error: null });
    for (let i = 0; i < 100 && ["checking", "judging"].includes((await job(id))?.phase ?? ""); i++) await sleep(200);
    console.log(`check passed · tx ${a.hash} · ${id} is ${(await job(id))?.phase}`);
    break;
  }
  case "past": {
    const [id, which] = args;
    const j = await job(id ?? "");
    if (!j) throw new Error(`no job ${id}`);
    const until = which === "work" ? BigInt(j.terms["work_until"]!) : which === "reveal" ? BigInt(j.terms["reveal_until"]!) : j.verdict ? BigInt(j.verdict.at_ns) + BigInt(j.terms["appeal_minutes"]!) * 60_000_000_000n : 0n;
    await ffUntil(until);
    console.log(`${id} is ${(await job(id!))?.phase}`);
    break;
  }
  case "burn": {
    const [id, mask, milli] = args;
    const r = await call("meter", world.jobs, "burn", { id, mask, amount: (BigInt(milli ?? "0") * (NEAR / 1000n)).toString() }, 30n);
    console.log(`meter booked ${milli} mNEAR of ${mask}'s mind on ${id} · tx ${r.hash}`);
    break;
  }
  case "judge": {
    const [id] = args;
    const j = await job(id ?? "");
    if (!j) throw new Error(`no job ${id}`);
    const steps = await rpc.view<RawStep[]>(world.jobs, "steps", { id, from_index: 0, limit: 64 });
    // Inside the TEE: each revealed box opens for its own mask, or it is no work.
    const counted: number[] = [];
    const fake: number[] = [];
    const opened = new Map<number, string>();
    for (const s of steps) {
      if (s.content === null || s.copy_of !== null) continue;
      try {
        const w = openWork(secret(), world.jobs, id!, s.mask, s.content);
        if (w.kind !== "text") throw new Error("no text");
        opened.set(s.seq, w.text);
        counted.push(s.seq);
        console.log(`the judge opens step #${s.seq} of ${s.mask} in its TEE: ${w.text.length} chars of review, sha256 ${sha(w.text).slice(0, 12)}…`);
      } catch {
        fake.push(s.seq);
        console.log(`the judge cannot open step #${s.seq} of ${s.mask}: no work, fake`);
      }
    }
    const strike = steps.find((s) => s.role === "striker" && counted.includes(s.seq));
    const winner = strike ? strike.entrant : null;
    if (strike) {
      const won = steps.filter((s) => s.entrant === winner && counted.includes(s.seq)).map((s) => ({ seq: s.seq, mask: s.mask, role: s.role, content: s.content }));
      writeFileSync(join(world.storage, `won-${id}.json`), JSON.stringify({ steps: won }));
    }
    const before = (await requests()).length;
    const asked = await call("bob", world.jobs, "judge", { id }, 250n, 0n, false);
    const q = await nextRequest(before);
    console.log(`judge asked · tx ${asked.hash} · input ${q.input}`);
    const output = { success: true, output: { job: id, winner, counted, fake, rule: "review per entrant, winner on two seeds", asked: 2 }, error: null };
    const r = await answer(before, output);
    for (let i = 0; i < 100 && (await job(id!))?.phase === "judging"; i++) await sleep(200);
    console.log(`judge answered ${JSON.stringify(output)} · tx ${r.hash} · ${id} is ${(await job(id!))?.phase}`);
    break;
  }
  case "settle": {
    const r = await call("bob", world.jobs, "settle", { id: args[0] }, 250n);
    const e = r.logs.find((l) => l.includes('"event":"settle"'));
    console.log(`${args[0]} settled · tx ${r.hash}\n${e ?? ""}`);
    break;
  }
  case "serve-delivery": {
    // Whoever asks for the winning work pays the run; the judge's stand-in answers that request when it reaches OutLayer.
    const [id, minutes = "20"] = args;
    const seen = (await requests()).length;
    console.log(`waiting up to ${minutes} min for a delivery of ${id} to be asked…`);
    let index = -1;
    for (let i = 0; i < Number(minutes) * 300 && index < 0; i++) {
      const all = await requests();
      for (let k = seen; k < all.length; k++) {
        const input = JSON.parse(all[k]!.input ?? "{}") as { job?: string; deliver?: boolean };
        if (input.job === id && input.deliver) index = k;
      }
      if (index < 0) await sleep(200);
    }
    if (index < 0) throw new Error(`nobody asked for the delivery of ${id}`);
    const j = await job(id!);
    if (!j || j.status.state !== "paid") throw new Error(`${id} is not paid`);
    const kept = JSON.parse(readFileSync(join(world.storage, `won-${id}.json`), "utf8")) as { steps: { seq: number; mask: string; role: string; content: string }[] };
    const work = kept.steps.map((s) => {
      const w = openWork(secret(), world.jobs, id!, s.mask, s.content);
      return { seq: s.seq, mask: s.mask, role: s.role, ...(w.kind === "text" ? { text: w.text } : { module: Buffer.from(w.bytes).toString("base64url") }) };
    });
    const payload = JSON.stringify({ job: id, contract: world.jobs, entrant: j.status.winner, work, why: "Scored on two seeds by the published rubric: the review finds the double refund and shows the calls that cause it." });
    const boxed = sealDelivery(secret(), j.terms["client_key"]!, world.jobs, id!, j.client, Buffer.from(payload));
    const at = `delivery/${world.jobs}/${id}`;
    keepPublic(review.project, at, boxed);
    console.log(`the judge opens the winner's ${work.length} box${work.length === 1 ? "" : "es"} in its TEE and seals the work for ${j.terms["client_key"]!.slice(0, 15)}…: ${boxed.length} chars at ${at}`);
    const r = await answer(index, { success: true, output: { job: id, delivered: at, sha256: sha(boxed) }, error: null });
    console.log(`delivery answered · tx ${r.hash} · sha256 ${sha(boxed)}`);
    break;
  }
  default:
    throw new Error(`unknown command ${cmd}`);
}
