#!/usr/bin/env node
// Reads what a contract's wasm says about its own source (NEP-330): runs its `contract_source_metadata` with no node
// and no chain, the way NEAR would answer the view, and prints it with the file's size, sha256 and code hash.
//
//   node contracts/nep330.mjs <file.wasm>...           what each file says
//   node contracts/nep330.mjs --check <file.wasm>...   and exit 1 unless each names its version, a link to the public
//                                                      repository's commit and how to build it again (build_info)
//
// The contracts in this folder get their metadata at build time (contracts/README.md, "Source on chain"): near-sdk
// writes it for the contracts on the SDK, build.rs for house and home. Only `cargo near build reproducible-wasm`, which
// builds in a pinned image, fills build_info.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'https://github.com/plavutskyi/mask-wars';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A code hash as NEAR shows it: base58 of the sha256. */
export function codeHash(bytes) {
  const digest = createHash('sha256').update(bytes).digest();
  let n = BigInt(`0x${digest.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of digest) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/**
 * The JSON the wasm's `contract_source_metadata` returns, or null when it has no such method. The view needs nothing
 * from the host but `value_return`; any other host call it made would throw here, and so would fail the read.
 */
export async function sourceMetadata(bytes) {
  const module = await WebAssembly.compile(bytes);
  if (!WebAssembly.Module.exports(module).some((e) => e.name === 'contract_source_metadata' && e.kind === 'function')) return null;
  let memory = null;
  let returned = null;
  const host = new Proxy(
    {},
    {
      get: (_, name) =>
        name === 'value_return'
          ? (len, ptr) => {
              returned = Buffer.from(memory.buffer, Number(ptr), Number(len)).toString('utf8');
            }
          : () => {
              throw new Error(`contract_source_metadata called the host's ${String(name)}: a view of a constant needs nothing but value_return`);
            },
    },
  );
  const imports = {};
  for (const i of WebAssembly.Module.imports(module)) {
    if (i.kind !== 'function') throw new Error(`the wasm imports a ${i.kind} (${i.module}.${i.name}): not a NEAR contract`);
    imports[i.module] ??= host;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  memory = instance.exports.memory;
  instance.exports.contract_source_metadata();
  if (returned === null) throw new Error('contract_source_metadata returned nothing');
  return JSON.parse(returned);
}

/** Why the metadata does not say where the code comes from and how to build it again; empty when it does. */
export function faults(meta) {
  const out = [];
  if (!meta) return ['no contract_source_metadata'];
  if (typeof meta.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(meta.version)) out.push(`version: ${JSON.stringify(meta.version)}`);
  const rev = /^https:\/\/github\.com\/plavutskyi\/mask-wars\/tree\/([0-9a-f]{40})$/.exec(meta.link ?? '')?.[1];
  if (!rev) out.push(`link: ${JSON.stringify(meta.link)}, not ${REPOSITORY}/tree/<commit>`);
  if (!meta.standards?.some((s) => s.standard === 'nep330')) out.push('standards: no nep330');
  const b = meta.build_info;
  if (!b) {
    out.push('build_info: null (a plain build; only cargo near build reproducible-wasm fills it)');
    return out;
  }
  if (!/^sourcescan\/cargo-near:[^@\s]+@sha256:[0-9a-f]{64}$/.test(b.build_environment ?? '')) out.push(`build_info.build_environment: ${b.build_environment}`);
  if (!Array.isArray(b.build_command) || b.build_command.slice(0, 4).join(' ') !== 'cargo near build non-reproducible-wasm') out.push(`build_info.build_command: ${JSON.stringify(b.build_command)}`);
  if (!/^contracts\/[\w/-]+$/.test(b.contract_path ?? '')) out.push(`build_info.contract_path: ${b.contract_path}`);
  if (b.source_code_snapshot !== `git+${REPOSITORY}?rev=${rev}`) out.push(`build_info.source_code_snapshot: ${b.source_code_snapshot}, not the commit the link names`);
  return out;
}

async function main(argv) {
  const check = argv.includes('--check');
  const files = argv.filter((a) => a !== '--check');
  if (files.length === 0) {
    console.error('usage: node contracts/nep330.mjs [--check] <file.wasm>...');
    return 2;
  }
  let bad = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    const meta = await sourceMetadata(bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    console.log(`${basename(file)}  ${bytes.length} bytes  sha256 ${sha}  code hash ${codeHash(bytes)}`);
    console.log(`  ${JSON.stringify(meta)}`);
    if (check) {
      const why = faults(meta);
      for (const w of why) console.log(`  NOT OK: ${w}`);
      if (why.length > 0) bad += 1;
    }
  }
  return bad > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main(process.argv.slice(2)));
