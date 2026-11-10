/**
 * node --use-env-proxy scripts/record-attestation.ts <model> <out.json>
 *
 * Records one live check for the offline tests: the report trimmed to the fields the checks read (quotes, logs and
 * app_compose byte for byte), Intel's collateral for each quote and NVIDIA's answer for each model node, under the
 * nonce and the time of the recording.
 */
import { writeFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Quote, intel, type Collateral } from "@phala/dcap-qvl";
import { fetchCollateral, fetchReport, freshNonce, NVIDIA_NRAS_URL, PHALA_PCCS_URL, type TeeAttestation } from "../src/attestation.ts";

const [model, out] = process.argv.slice(2);
if (!model || !out) {
  console.error("usage: record-attestation.ts <model> <out.json>");
  process.exit(2);
}

const nonce = freshNonce();
const now = Date.now();
const report = await fetchReport({ model, nonce });
const gateway = report.gateway_attestation;
const nodes = report.model_attestations ?? [];
if (!gateway || nodes.length === 0) throw new Error("report has no gateway or no model evidence");

function keep(a: TeeAttestation, gpu: boolean): TeeAttestation {
  const raw = a.info?.tcb_info;
  const tcb = (typeof raw === "string" ? JSON.parse(raw) : raw) as { app_compose?: string } | undefined;
  return {
    ...(a.model_name ? { model_name: a.model_name } : {}),
    ...(a.signing_address ? { signing_address: a.signing_address } : {}),
    ...(a.signing_algo ? { signing_algo: a.signing_algo } : {}),
    ...(a.request_nonce ? { request_nonce: a.request_nonce } : {}),
    ...(a.report_data ? { report_data: a.report_data } : {}),
    ...(a.intel_quote ? { intel_quote: a.intel_quote } : {}),
    ...(a.event_log ? { event_log: a.event_log } : {}),
    ...(tcb?.app_compose ? { info: { tcb_info: { app_compose: tcb.app_compose } } } : {}),
    ...(gpu && a.nvidia_payload ? { nvidia_payload: a.nvidia_payload } : {}),
  };
}

const collateral: Record<string, Collateral> = {};
for (const a of [gateway, ...nodes]) {
  const quote = Quote.parse(Buffer.from(hexToBytes(a.intel_quote ?? "")));
  const fmspc = bytesToHex(intel.getFmspc(quote)).toUpperCase();
  const ca = intel.getCa(quote);
  collateral[`${fmspc}:${ca}`] ??= await fetchCollateral(PHALA_PCCS_URL, fmspc, ca, fetch, 20_000);
}

const nras: unknown[] = [];
for (const a of nodes) {
  const res = await fetch(NVIDIA_NRAS_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: typeof a.nvidia_payload === "string" ? a.nvidia_payload : JSON.stringify(a.nvidia_payload),
  });
  if (!res.ok) throw new Error(`NVIDIA answered ${res.status}`);
  nras.push(await res.json());
}

const trimmed = { gateway_attestation: keep(gateway, false), model_attestations: nodes.map((a) => keep(a, true)) };
writeFileSync(out, `${JSON.stringify({ recorded: new Date(now).toISOString(), now, model, nonce, report: trimmed, collateral, nras })}\n`);
console.log(`recorded ${model} under nonce ${nonce}: ${nodes.length} node(s), collateral ${Object.keys(collateral).join(", ")}`);
console.log("Now replace the NVIDIA tokens allowed in scripts/public-export/gitleaks.toml with the new ones (public verdicts).");
