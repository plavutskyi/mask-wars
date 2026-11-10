#!/usr/bin/env node
// Prepares publishing a version of the MASK CHECK module on OutLayer, up to the signatures: it sends nothing and
// holds no key. Run it once the wasm is in apps/web/public/outlayer under its sha256 and the site serves it:
//
//   node services/check/publish.mjs [--sha <sha256>]
//
// Which version it publishes is the build's word, not the folder's: it runs ./build.sh and takes the sha256 the build
// prints. On a machine without the Rust toolchain it takes the one file in the folder, or the one --sha names. Then it
// checks that the file under that name holds those bytes, that the site serves the same bytes, and reads from the
// chain whether the project and its signing seed exist. Last it writes the transaction's arguments and prints the
// commands the owner of the project runs: the one that publishes the version and, the first time, the one that has
// OutLayer generate the seed inside the TEE.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const deployment = JSON.parse(readFileSync(join(here, "deployment.json"), "utf8"));
const [owner, name] = deployment.project.split("/");
const testnet = deployment.outlayer === "testnet";
const contract = testnet ? "outlayer.testnet" : "outlayer.near";
const rpc = testnet ? "https://rpc.testnet.fastnear.com" : "https://rpc.mainnet.fastnear.com";
const profile = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")).author_secrets.profile;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function view(method, args) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "maskwars-check",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (!body.result?.result) throw new Error(`${contract}.${method}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
}

function fail(why) {
  console.error(`STOP: ${why}`);
  process.exit(1);
}

/**
 * The sha256 of the version to publish, and where it came from. A folder can hold several versions and a fresh clone
 * gives them all the same date, so the folder alone never chooses.
 */
function versionToPublish(folder) {
  const named = process.argv.indexOf("--sha");
  if (named >= 0) {
    const sha = process.argv[named + 1] ?? "";
    if (!/^[0-9a-f]{64}$/.test(sha)) fail("--sha takes the 64 hex characters of the wasm's sha256");
    return { hash: sha, from: "named with --sha" };
  }
  if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0) {
    const built = spawnSync(join(here, "build.sh"), { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    // build.sh ends with sha256sum's line: the hash, then the file.
    const last = (built.stdout ?? "").trim().split("\n").at(-1) ?? "";
    const sha = last.split(/\s+/)[0] ?? "";
    if (built.status !== 0 || !/^[0-9a-f]{64}$/.test(sha)) fail("services/check/build.sh did not build the module");
    return { hash: sha, from: "built here by build.sh" };
  }
  const files = readdirSync(folder).filter((f) => /^maskwars-check-[0-9a-f]{64}\.wasm$/.test(f));
  if (files.length === 1) return { hash: files[0].slice("maskwars-check-".length, -".wasm".length), from: "the one version in the folder; not rebuilt, no Rust toolchain here" };
  if (files.length === 0) fail("no maskwars-check-<sha256>.wasm in apps/web/public/outlayer: run services/check/build.sh and copy the wasm there under its sha256");
  return fail(`${files.length} versions lie in apps/web/public/outlayer and there is no Rust toolchain here to say which is this checkout's: name one with --sha <sha256>`);
}

const folder = join(root, "apps", "web", "public", "outlayer");
const { hash, from } = versionToPublish(folder);
const file = `maskwars-check-${hash}.wasm`;
if (!existsSync(join(folder, file))) fail(`apps/web/public/outlayer/${file} is not there: copy target/wasm32-wasip2/release/maskwars-check.wasm to that name and release the site`);
const bytes = readFileSync(join(folder, file));
if (sha256(bytes) !== hash) fail(`${file} holds other bytes: its sha256 is ${sha256(bytes)}`);
console.log(`module   ${file} (${bytes.length} bytes), ${from}`);

const url = `https://maskwars.xyz/outlayer/${file}`;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) fail(`${url} answers ${res.status}: the site does not serve this version yet. Release the site first`);
  if (sha256(Buffer.from(await res.arrayBuffer())) !== hash) fail(`${url} serves other bytes than the file here`);
  console.log(`site     serves the same bytes at ${url}`);
} catch (error) {
  fail(`${url} could not be read (${error.cause?.message ?? error.message}): OutLayer fetches the module from there`);
}

const project = await view("get_project", { project_id: deployment.project });
const versions = project ? await view("list_versions", { project_id: deployment.project, from_index: 0, limit: 100 }).catch(() => []) : [];
const published = project && JSON.stringify(versions).includes(hash);
const seeded = await view("secrets_exist", { accessor: { Project: { project_id: deployment.project } }, profile, owner });
console.log(`project  ${deployment.project} on ${contract}: ${project ? `exists, active version ${project.active_version}` : "not created yet"}`);
console.log(`seed     PROTECTED_CHECK_SEED, profile ${profile}: ${seeded ? "already generated; a new version keeps the key" : "not generated yet"}`);

const source = { WasmUrl: { url, hash, build_target: "wasm32-wasip2" } };
const args = project ? { project_name: name, source, set_active: true } : { name, source };
const method = project ? "add_version" : "create_project";
const out = join(root, ".scratch", "near", "check-publish-args.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(args));

console.log("");
if (published) {
  console.log(`This version is already published. Nothing to sign.`);
} else {
  console.log(`1. Publish the version (a storage deposit; what is not needed comes back). The owner chooses "send":`);
  console.log("");
  console.log(`   near contract call-function as-transaction ${contract} ${method} file-args ${out} prepaid-gas '50.0 Tgas' attached-deposit '0.02 NEAR' sign-as ${owner} network-config ${deployment.outlayer} sign-with-keychain`);
}
if (!seeded) {
  console.log("");
  console.log(`${published ? "1" : "2"}. Have OutLayer generate the signing seed inside the TEE (once; nobody ever sees it):`);
  console.log("");
  console.log(`   outlayer secrets set --generate PROTECTED_CHECK_SEED:hex32 --project ${deployment.project} --profile ${profile} --access allow-all`);
}
console.log("");
console.log(`Then the first calls, with a payment key of any account:`);
console.log("");
console.log(`   OUTLAYER_PAYMENT_KEY=<owner:nonce:secret> node services/check/live.mjs --record`);
console.log("");
console.log(`Until the seed is generated OutLayer runs no call of this project at all (its manifest names the seed), so make`);
console.log(`the first calls only after it. A caller who wants exactly this build pins it: "version_key": "${hash}".`);
