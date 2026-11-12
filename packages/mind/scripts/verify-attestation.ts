/**
 * pnpm --filter @maskwars/mind verify:attestation [model ...]
 *
 * For each model: a fresh nonce, a live attestation report from NEAR AI Cloud (no key needed), then every check in
 * src/attestation.ts on the gateway and on every model node: Intel TDX quote against Intel's chain, debug off, nonce,
 * signer, measured config, boot log, NVIDIA GPUs. Exit code 1 unless every check passed.
 * Set NEARAI_CLOUD_API_KEY only if the keyless rate limit gets in the way.
 */
import { allChecks, verifyModel, type Check } from "../src/attestation.ts";
import { ATTESTED_MODELS } from "../src/models.ts";

const models = process.argv.slice(2).length ? process.argv.slice(2) : ATTESTED_MODELS;
const apiKey = process.env.NEARAI_CLOUD_API_KEY;
const mark = { pass: "ok  ", fail: "FAIL", unavailable: "n/a " } as const;
const line = (c: Check) => `    ${mark[c.outcome]} ${c.name}${c.detail ? ` (${c.detail})` : ""}`;

const results = await Promise.all(models.map((model) => verifyModel(model, apiKey ? { apiKey } : {})));
for (const v of results) {
  console.log(`\n${v.model}: ${v.outcome.toUpperCase()} in ${v.ms} ms\n  nonce ${v.nonce}`);
  for (const c of v.checks) console.log(line(c));
  for (const tee of [v.gateway, ...v.nodes]) {
    if (!tee) continue;
    const gpus = tee.gpus ? ` · ${tee.gpus.count} × ${tee.gpus.hwmodel ?? "GPU"}` : "";
    console.log(`  ${tee.role} ${tee.signer}${gpus}`);
    for (const c of tee.checks) console.log(line(c));
  }
}

const bad = results.flatMap((v) => allChecks(v)).filter((c) => c.outcome !== "pass").length;
console.log(
  "\nNot covered: image provenance of the measured containers, the NVIDIA token signature (the verdict is read over TLS" +
    "\nfrom NVIDIA), and which instance answered a given completion. See README, Attestation.",
);
console.log(bad ? `\n${bad} check(s) did not pass.` : "\nAll checks passed.");
process.exit(bad ? 1 : 0);
