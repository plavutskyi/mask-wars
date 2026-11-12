// The two judges of the jobs market on OutLayer: tee_tests (services/judge-tests) and ai_review
// (services/judge-review). Until a judge is recorded on the jobs contract, no job of its kind opens: only a drain. This
// script signs nothing. It checks that the wasm the site serves is the build of this repository, reads OutLayer and
// the jobs contract, and prints what the owner does, in order, with the exact arguments.
//
//   node --use-env-proxy scripts/testnet/jobs-judges.mjs              testnet: jobs.tinygif8324.testnet
//
// Every judge answers only the jobs contract written into its wasm (job.rs): jobs.tinygif8324.testnet in these builds.
// The mainnet builds (build.sh --mainnet) also serve jobs.maskwars.near: their own sha256, published the same way.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NET = JSON.parse(readFileSync(join(ROOT, 'packages/network/testnet.json'), 'utf8'));
const SCRATCH = join(ROOT, '.scratch', 'near');

/** The builds in apps/web/public/outlayer: build.sh of each module gives these bytes in any folder. */
export const JUDGES = [
  { kind: 'tee_tests', project: 'tests', module: 'judge-tests', sha256: 'fa96e527b73de238a0aa94a43f8ad2d4fdd63e4bc67cda34684dd399cdbeed0e', seed: 'PROTECTED_TESTS_SEED', extra: null },
  { kind: 'ai_review', project: 'review', module: 'judge-review', sha256: 'c28711aa0c01ca4bfbb7331163bf1b3c407cd71ecf1e3b8ece721feac0652a07', seed: 'PROTECTED_REVIEW_SEED', extra: 'NEARAI_API_KEY' },
];

export const fileOf = (j) => `maskwars-${j.module}-${j.sha256}.wasm`;
export const urlOf = (j) => `https://maskwars.xyz/outlayer/${fileOf(j)}`;

/** OutLayer's create_project: the name and the first source, which becomes the active version. */
export function projectArgs(j) {
  return { name: j.project, source: { WasmUrl: { url: urlOf(j), hash: j.sha256, build_target: 'wasm32-wasip2' } } };
}

async function view(contract, method, args = {}) {
  const res = await fetch(NET.rpc[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'maskwars', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
  });
  const body = await res.json();
  if (body.error || !body.result?.result) throw new Error(`${contract}.${method}: ${JSON.stringify(body.error ?? body.result).slice(0, 300)}`);
  return JSON.parse(Buffer.from(body.result.result).toString('utf8'));
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
  const cli = '.\\.scratch\\near\\near.exe';
  const config = await view(NET.jobs, 'config');
  const lines = [`The judges of ${NET.jobs} on ${NET.outlayer.contract}. Nothing here signs.`, ''];
  const say = (s = '') => lines.push(s);
  say(`Recorded on ${NET.jobs} now: ${config.judges.length ? config.judges.map((j) => `${j.kind} ${j.project} ${j.version.slice(0, 8)}…`).join(', ') : 'none (only drain jobs open)'}; pending: ${config.pending ? JSON.stringify(config.pending) : 'none'}`);
  say();
  mkdirSync(SCRATCH, { recursive: true });
  let step = 1;
  for (const j of JUDGES) {
    const file = join(ROOT, 'apps/web/public/outlayer', fileOf(j));
    const local = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
    if (local !== j.sha256) throw new Error(`${relative(ROOT, file)}: ${local ?? 'missing'}, not the build ${j.sha256}`);
    const id = `${NET.admin}/${j.project}`;
    const project = await view(NET.outlayer.contract, 'get_project', { project_id: id });
    const recorded = config.judges.find((r) => r.kind === j.kind);
    say(`${j.kind}: ${id}, version ${j.sha256} (${relative(ROOT, file)}, served at ${urlOf(j)} once the site is released)`);
    if (recorded?.version === j.sha256) {
      say('  recorded on the jobs contract: nothing to do');
      say();
      continue;
    }
    const args = join(SCRATCH, `${j.project}-project-args.json`);
    writeFileSync(args, JSON.stringify(projectArgs(j)));
    if (!project) {
      say(`  ${step++}. Make the project, this judge its first and active version (0.02 NEAR; the rest comes back):`);
      say(`     ${cli} contract call-function as-transaction ${NET.outlayer.contract} create_project file-args ${relative(ROOT, args).replaceAll('/', '\\')} prepaid-gas '50.0 Tgas' attached-deposit '0.02 NEAR' sign-as ${NET.admin} network-config testnet sign-with-keychain send`);
      say(`     args: ${JSON.stringify(projectArgs(j))}`);
    } else {
      say(`  the project is on ${NET.outlayer.contract}, active version ${project.active_version}`);
    }
    say(`  ${step++}. Its key, generated inside the TEE and readable only there; runs through ${NET.jobs} alone may use it:`);
    say(`     outlayer secrets set --generate ${j.seed}:hex32 --project ${id} --profile judge --access whitelist:${NET.admin} --direct --via ${NET.jobs}`);
    if (j.extra) {
      // `set` would overwrite the row and its generated seed; `update` merges and keeps every PROTECTED_ name.
      say(`     outlayer secrets update '{"${j.extra}":"<the NEAR AI key>"}' --project ${id} --profile judge`);
    }
    say(`  ${step++}. One run that answers the judge's public key (x25519:<hex>), signed by the enclave's attestation:`);
    say(`     outlayer run ${id} '{"action":"key"}'`);
    say(`  ${step++}. Record it on the jobs contract (the admin proposes; anyone applies an hour later; one change at a time):`);
    say(`     .\\scripts\\testnet\\jobs-change.ps1 -Judge ${j.kind} -Version ${j.sha256} -Key x25519:<hex>`);
    say('     .\\scripts\\testnet\\jobs-change.ps1 -Apply');
    say();
  }
  say(`From then on a ${JUDGES.map((j) => j.kind).join(' or ')} job opens on ${NET.jobs}, and the site and the agents' tools offer that kind.`);
  console.log(lines.join('\n'));
}
