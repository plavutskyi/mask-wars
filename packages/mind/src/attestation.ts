/**
 * NEAR AI Cloud attestation, checked the way docs.near.ai/cloud/verification describes it (read 8.11.2026).
 *
 * One check is one fresh 32-byte nonce and one report from `GET /v1/attestation/report` (no key needed). For the
 * gateway TEE and for every model TEE node in the report:
 *
 * - quote:   the Intel TDX quote verifies up to Intel's root CA with Intel's collateral (dcap-qvl), TCB status accepted;
 * - debug:   the TD is not a debug TD (bit 0 of TD_ATTRIBUTES);
 * - nonce:   our nonce is echoed and sits in bytes 32..64 of the verified quote's report data;
 * - signer:  bytes 0..32 bind the TEE signing address (zero-padded, or sha256(address ‖ TLS fingerprint));
 * - config:  MRCONFIGID = 01 ‖ sha256(app_compose) ‖ 15 zero bytes: the measured config is the one in the report;
 * - boot:    the RTMR3 event log replays to the quote's RTMR3;
 * - gpu:     model nodes only: NVIDIA's attestation service passes every GPU for our nonce, secure boot on, debug off.
 *
 * Not covered here: image provenance of the containers named in app_compose; the NVIDIA token signature (the verdict
 * is read over TLS straight from NVIDIA, as the docs' flow does); which instance answered a given completion
 * (instances of one model share a signing key). Each answer's own signature is checked in near-ai.ts.
 *
 * Outcomes are fail-closed: "pass" only when the evidence was obtained and holds; "fail" when it was obtained and does
 * not hold; "unavailable" when it could not be obtained (network, rate limit, a verifier service down).
 */
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { Quote, intel, verify as verifyWithCollateral, type Collateral, type TcbStatus } from "@phala/dcap-qvl";
import { NEAR_AI_BASE_URL } from "./models.ts";

export const NVIDIA_NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
/** Phala's caching mirror of Intel's PCS, the default of dcap-qvl and of the NEAR AI docs. */
export const PHALA_PCCS_URL = "https://pccs.phala.network";
/**
 * Intel TCB statuses we accept. SWHardeningNeeded: the platform is patched, the TD software carries the mitigations
 * the listed advisories ask for. Anything older, misconfigured or revoked fails. The status is always shown.
 */
export const ACCEPTED_TCB: readonly TcbStatus[] = ["UpToDate", "SWHardeningNeeded"];

export type Outcome = "pass" | "fail" | "unavailable";
export type CheckId = "report" | "nodes" | "quote" | "debug" | "nonce" | "signer" | "config" | "boot" | "gpu";

export interface Check {
  readonly id: CheckId;
  readonly name: string;
  readonly outcome: Outcome;
  readonly detail?: string;
}

export interface EventLogEntry {
  readonly imr: number;
  readonly event_type: number;
  readonly digest?: string;
  readonly event: string;
  readonly event_payload?: string;
}

/** One TEE in the report: the gateway, or one model node. Field names as NEAR AI returns them. */
export interface TeeAttestation {
  readonly model_name?: string;
  readonly signing_address?: string;
  readonly signing_algo?: string;
  readonly request_nonce?: string;
  readonly report_data?: string;
  readonly intel_quote?: string;
  readonly event_log?: string | readonly EventLogEntry[];
  readonly info?: { readonly tcb_info?: string | { readonly app_compose?: string } };
  readonly nvidia_payload?: string | Record<string, unknown>;
  readonly tls_cert_fingerprint?: string;
}

export interface AttestationReport {
  readonly gateway_attestation?: TeeAttestation;
  readonly model_attestations?: readonly TeeAttestation[];
}

export interface GpuSummary {
  readonly count: number;
  readonly arch: string | null;
  /** NVIDIA's hardware model, e.g. GH100 for an H100. */
  readonly hwmodel: string | null;
  readonly driver: string | null;
}

export interface TeeResult {
  readonly role: "gateway" | "model";
  readonly signer: string;
  readonly tcb: TcbStatus | null;
  readonly advisories: readonly string[];
  readonly mrtd: string | null;
  readonly gpus: GpuSummary | null;
  readonly checks: readonly Check[];
}

export interface ModelVerification {
  readonly model: string;
  readonly nonce: string;
  /** When the report was requested, ISO 8601. */
  readonly checkedAt: string;
  readonly ms: number;
  readonly outcome: Outcome;
  readonly gateway: TeeResult | null;
  readonly nodes: readonly TeeResult[];
  /** Report-level checks: the report itself and its model nodes. */
  readonly checks: readonly Check[];
}

/** Evidence could not be obtained: network, timeout, rate limit, a verifier service down. Not a verdict on the TEE. */
export class Unavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unavailable";
  }
}

export function freshNonce(): string {
  return bytesToHex(randomBytes(32));
}

/** Every check passed: pass. Any check failed: fail. Otherwise something could not be checked: unavailable. */
export function outcomeOf(checks: readonly Check[]): Outcome {
  if (checks.length === 0) return "unavailable";
  if (checks.some((c) => c.outcome === "fail")) return "fail";
  if (checks.some((c) => c.outcome === "unavailable")) return "unavailable";
  return "pass";
}

/** All checks of one verification, report-level first, then the gateway, then each model node. */
export function allChecks(v: ModelVerification): Check[] {
  return [...v.checks, ...(v.gateway?.checks ?? []), ...v.nodes.flatMap((n) => n.checks)];
}

/** Model TEE signing addresses named by a report, lower-case. Feed these to NearAiProvider.trust(). */
export function modelSigners(report: AttestationReport): string[] {
  return [...new Set((report.model_attestations ?? []).map((a) => (a.signing_address ?? "").toLowerCase()).filter(Boolean))];
}

// ---------------------------------------------------------------------------------------------------------------------
// Network

async function request(fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number, what: string) {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Unavailable(`${what}: ${reason(error)}`);
  }
}

async function bodyText(res: Response, what: string): Promise<string> {
  try {
    return await res.text();
  } catch (error) {
    throw new Unavailable(`${what}: ${reason(error)}`);
  }
}

function reason(error: unknown): string {
  const e = error as { name?: string; message?: string; cause?: { message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "no answer in time";
  return [e?.message, e?.cause?.message].filter(Boolean).join(": ") || String(error);
}

function retryAfterMs(res: Response): number {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 3) * 1000 : 1000;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ReportRequest {
  readonly model: string;
  readonly nonce: string;
  readonly baseUrl?: string;
  /** Optional. Without a key the report is still served; keyless callers share a small concurrency limit. */
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The gateway report plus NEAR model evidence for the canonical model ID; never an alias. One retry on 429. */
export async function fetchReport(o: ReportRequest): Promise<AttestationReport> {
  if (!/^[0-9a-f]{64}$/.test(o.nonce)) throw new Error("nonce: 64 lower-case hex characters");
  const base = (o.baseUrl ?? NEAR_AI_BASE_URL).replace(/\/$/, "");
  const params = new URLSearchParams({
    model: o.model,
    provider: "near",
    include_tls_fingerprint: "false",
    signing_algo: "ecdsa",
    nonce: o.nonce,
  });
  const headers: Record<string, string> = { accept: "application/json", "x-no-aliasing": "true" };
  if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
  const what = "NEAR AI attestation report";
  for (let attempt = 0; ; attempt++) {
    const res = await request(o.fetch ?? fetch, `${base}/attestation/report?${params}`, { headers }, o.timeoutMs ?? 30_000, what);
    if (res.status === 429 && attempt === 0) {
      await sleep(retryAfterMs(res));
      continue;
    }
    const text = await bodyText(res, what);
    if (res.status === 429 || res.status >= 500) throw new Unavailable(`${what}: ${res.status}`);
    if (!res.ok) throw new Error(`${what}: ${res.status} ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as AttestationReport;
    } catch {
      throw new Error(`${what} is not JSON`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Intel TDX quote

/** Intel collateral for one platform family, by FMSPC and PCK CA (`processor` or `platform`). */
export interface CollateralSource {
  get(fmspc: string, ca: string): Promise<Collateral>;
  /** Drop a cached entry, e.g. after a verification that may have failed on stale collateral. */
  forget(fmspc: string, ca: string): void;
}

/** Collateral from a PCCS (Phala's by default), cached per platform family for `ttlMs`. Failures are not cached. */
export function pccsCollateral(o: { url?: string; fetch?: typeof fetch; ttlMs?: number; timeoutMs?: number } = {}): CollateralSource {
  const cache = new Map<string, { at: number; value: Promise<Collateral> }>();
  const ttl = o.ttlMs ?? 60 * 60_000;
  return {
    get(fmspc, ca) {
      const key = `${fmspc}:${ca}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttl) return hit.value;
      const value = fetchCollateral(o.url ?? PHALA_PCCS_URL, fmspc, ca, o.fetch ?? fetch, o.timeoutMs ?? 15_000);
      cache.set(key, { at: Date.now(), value });
      value.catch(() => {
        if (cache.get(key)?.value === value) cache.delete(key);
      });
      return value;
    },
    forget(fmspc, ca) {
      cache.delete(`${fmspc}:${ca}`);
    },
  };
}

/** The four PCCS calls dcap-qvl makes for a TDX quote, with deadlines. Hex strings, so it caches and records cleanly. */
export async function fetchCollateral(url: string, fmspc: string, ca: string, fetcher: typeof fetch, timeoutMs: number): Promise<Collateral> {
  const base = url.replace(/\/$/, "");
  const sgx = `${base}/sgx/certification/v4`;
  const tdx = `${base}/tdx/certification/v4`;
  const get = async (path: string) => {
    const res = await request(fetcher, path, {}, timeoutMs, "Intel collateral");
    if (!res.ok) throw new Unavailable(`Intel collateral: ${res.status} for ${path.slice(base.length)}`);
    return res;
  };
  const header = (res: Response, ...names: string[]) => {
    for (const name of names) {
      const value = res.headers.get(name);
      if (value) return decodeURIComponent(value);
    }
    throw new Unavailable(`Intel collateral: no ${names[0]} header`);
  };
  const [pckCrl, tcb, qe, rootCrl] = await Promise.all([
    get(`${sgx}/pckcrl?ca=${encodeURIComponent(ca)}&encoding=der`),
    get(`${tdx}/tcb?fmspc=${encodeURIComponent(fmspc)}`),
    get(`${tdx}/qe/identity?update=standard`),
    get(`${sgx}/rootcacrl`),
  ]);
  const tcbJson = JSON.parse(await bodyText(tcb, "Intel collateral")) as { tcbInfo: unknown; signature: string };
  const qeJson = JSON.parse(await bodyText(qe, "Intel collateral")) as { enclaveIdentity: unknown; signature: string };
  return {
    pck_crl_issuer_chain: header(pckCrl, "SGX-PCK-CRL-Issuer-Chain"),
    pck_crl: bytesToHex(new Uint8Array(await pckCrl.arrayBuffer())),
    // PCCS serves the root CA CRL as hex text.
    root_ca_crl: (await bodyText(rootCrl, "Intel collateral")).trim(),
    tcb_info_issuer_chain: header(tcb, "SGX-TCB-Info-Issuer-Chain", "TCB-Info-Issuer-Chain"),
    tcb_info: JSON.stringify(tcbJson.tcbInfo),
    tcb_info_signature: tcbJson.signature,
    qe_identity_issuer_chain: header(qe, "SGX-Enclave-Identity-Issuer-Chain"),
    qe_identity: JSON.stringify(qeJson.enclaveIdentity),
    qe_identity_signature: qeJson.signature,
  };
}

export interface VerifiedQuote {
  readonly tcb: TcbStatus;
  readonly advisories: readonly string[];
  readonly tdAttributes: Uint8Array;
  readonly mrTd: Uint8Array;
  readonly mrConfigId: Uint8Array;
  readonly rtMr3: Uint8Array;
  readonly reportData: Uint8Array;
}

/**
 * Verify a TDX quote with dcap-qvl against Intel's root CA: PCK chain and CRLs, QE report and identity, quote
 * signature, TCB level. Debug TDs are refused here already. Throws Unavailable when the collateral cannot be had.
 */
export async function verifyIntelQuote(quoteHex: string, collateral: CollateralSource, nowMs: number): Promise<VerifiedQuote> {
  const raw = Buffer.from(hexToBytes(quoteHex.replace(/^0x/i, "")));
  const quote = Quote.parse(raw);
  const fmspc = bytesToHex(intel.getFmspc(quote)).toUpperCase();
  const ca = intel.getCa(quote);
  const run = async () => verifyWithCollateral(raw, await collateral.get(fmspc, ca), Math.floor(nowMs / 1000));
  let verified;
  try {
    verified = await run();
  } catch (error) {
    if (error instanceof Unavailable) throw error;
    // A cached CRL or TCB info can expire between fetches; one fresh try before calling the quote bad.
    collateral.forget(fmspc, ca);
    verified = await run();
  }
  const td = verified.report.asTd10();
  if (!td) throw new Error("not a TDX quote");
  return {
    tcb: verified.status,
    advisories: verified.advisory_ids,
    tdAttributes: td.tdAttributes,
    mrTd: td.mrTd,
    mrConfigId: td.mrConfigId,
    rtMr3: td.rtMr3,
    reportData: td.reportData,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Report checks

/** RTMR3 from the event log: SHA-384 per event over `type (4 bytes LE) ‖ ":" ‖ event ‖ ":" ‖ payload`, then extend. */
export function replayRtmr3(log: TeeAttestation["event_log"]): { rtmr3: Uint8Array; events: number } {
  const events = (typeof log === "string" ? JSON.parse(log) : log) as unknown;
  if (!Array.isArray(events)) throw new Error("event log is not a list");
  let rtmr3 = new Uint8Array(48);
  let count = 0;
  for (const e of events as EventLogEntry[]) {
    if (e?.imr !== 3) continue;
    if (!Number.isInteger(e.event_type) || e.event_type < 0 || e.event_type > 0xffffffff) throw new Error("bad event type");
    const type = new Uint8Array(4);
    new DataView(type.buffer).setUint32(0, e.event_type, true);
    const colon = utf8ToBytes(":");
    const digest = sha384(concatBytes(type, colon, utf8ToBytes(String(e.event)), colon, hexToBytes(e.event_payload ?? "")));
    if (e.digest && e.digest.toLowerCase() !== bytesToHex(digest)) throw new Error(`event ${e.event}: digest does not match its payload`);
    rtmr3 = sha384(concatBytes(rtmr3, digest));
    count++;
  }
  return { rtmr3, events: count };
}

/** What report_data[0..32] must hold: the signing identity zero-padded, or sha256(identity ‖ TLS fingerprint). */
export function boundIdentity(att: TeeAttestation): Uint8Array {
  const identity = hexToBytes((att.signing_address ?? "").replace(/^0x/i, ""));
  const size = ({ ecdsa: 20, ed25519: 32 } as Record<string, number>)[att.signing_algo ?? ""];
  if (size === undefined || identity.length !== size) throw new Error(`unsupported signing identity (${att.signing_algo ?? "no algorithm"})`);
  if (att.tls_cert_fingerprint) return sha256(concatBytes(identity, hexToBytes(att.tls_cert_fingerprint)));
  const out = new Uint8Array(32);
  out.set(identity);
  return out;
}

/** The measured config: MRCONFIGID = 01 ‖ sha256(exact app_compose bytes) ‖ 15 zero bytes. */
export function expectedMrConfigId(att: TeeAttestation): Uint8Array {
  const raw = att.info?.tcb_info;
  const tcbInfo = (typeof raw === "string" ? JSON.parse(raw) : raw) as { app_compose?: unknown } | undefined;
  if (typeof tcbInfo?.app_compose !== "string") throw new Error("no app_compose in the report");
  return concatBytes(new Uint8Array([1]), sha256(utf8ToBytes(tcbInfo.app_compose)), new Uint8Array(15));
}

const NAMES: Record<CheckId, string> = {
  report: "attestation report fetched",
  nodes: "model TEE nodes present for this exact model",
  quote: "Intel TDX quote verified by Intel's certificate chain",
  debug: "not a debug TD",
  nonce: "our fresh nonce is echoed and sealed in the quote",
  signer: "the quote binds the TEE signing address",
  config: "measured config matches the reported app_compose",
  boot: "boot event log replays to RTMR3",
  gpu: "NVIDIA attests every GPU for our nonce",
};

function check(id: CheckId, outcome: Outcome | boolean, detail?: string): Check {
  const o: Outcome = typeof outcome === "boolean" ? (outcome ? "pass" : "fail") : outcome;
  return detail === undefined ? { id, name: NAMES[id], outcome: o } : { id, name: NAMES[id], outcome: o, detail };
}

/** Run one check; a pass carries `pass` as detail, a failure says what differs, an exception says why. */
function attempt(id: CheckId, run: () => boolean | string, pass?: string, fail?: string): Check {
  try {
    const r = run();
    if (typeof r === "string") return check(id, "fail", r);
    return r ? check(id, "pass", pass) : check(id, "fail", fail);
  } catch (error) {
    return check(id, "fail", (error as Error).message);
  }
}

/** Everything that follows from one TEE's report entry and its verified quote (or the reason there is none). */
export function checkTee(att: TeeAttestation, nonce: string, quote: VerifiedQuote | Error): Check[] {
  const n = nonce.toLowerCase();
  if (quote instanceof Error) {
    const outcome: Outcome = quote instanceof Unavailable ? "unavailable" : "fail";
    const skipped = (["debug", "nonce", "signer", "config", "boot"] as const).map((id) =>
      check(id, "unavailable", "needs a verified quote"),
    );
    return [check("quote", outcome, quote.message), ...skipped];
  }
  const reportData = bytesToHex(quote.reportData);
  return [
    check("quote", ACCEPTED_TCB.includes(quote.tcb), tcbDetail(quote)),
    attempt("debug", () => (quote.tdAttributes[0]! & 1) === 0, undefined, "debug TD"),
    attempt("nonce", () => {
      if (att.request_nonce?.toLowerCase() !== n) return "nonce not echoed";
      if (reportData.slice(64) !== n) return "quote holds another nonce";
      if (att.report_data && att.report_data.replace(/^0x/i, "").toLowerCase() !== reportData) {
        return "reported report_data differs from the quote";
      }
      return true;
    }),
    attempt(
      "signer",
      () => reportData.slice(0, 64) === bytesToHex(boundIdentity(att)),
      (att.signing_address ?? "").toLowerCase(),
      "quote binds another signing key",
    ),
    attempt("config", () => bytesToHex(quote.mrConfigId) === bytesToHex(expectedMrConfigId(att)), undefined, "config differs from its measurement"),
    bootCheck(att, quote),
  ];
}

function bootCheck(att: TeeAttestation, quote: VerifiedQuote): Check {
  try {
    const { rtmr3, events } = replayRtmr3(att.event_log);
    return bytesToHex(rtmr3) === bytesToHex(quote.rtMr3)
      ? check("boot", "pass", `${events} events`)
      : check("boot", "fail", "boot log differs from RTMR3");
  } catch (error) {
    return check("boot", "fail", (error as Error).message);
  }
}

function tcbDetail(q: VerifiedQuote): string {
  return q.advisories.length ? `TCB ${q.tcb} · ${q.advisories.join(", ")}` : `TCB ${q.tcb}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// NVIDIA GPUs

function claims(token: unknown): Record<string, unknown> {
  if (typeof token !== "string") throw new Error("NVIDIA answer has no token");
  const part = token.split(".")[1];
  if (!part) throw new Error("NVIDIA token is malformed");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Why one GPU token is not a pass, or null. */
function gpuProblem(name: string, c: Record<string, unknown>, nonce: string, nowSecs: number): string | null {
  if (String(c.eat_nonce ?? "").toLowerCase() !== nonce) return `${name}: token for another nonce`;
  if (c.secboot !== true) return `${name}: secure boot off`;
  if (c.dbgstat !== "disabled") return `${name}: debug ${String(c.dbgstat)}`;
  if (c.measres !== "success") return `${name}: measurements ${String(c.measres)}`;
  if (c["x-nvidia-attestation-warning"] != null) return `${name}: ${String(c["x-nvidia-attestation-warning"])}`;
  const failed = Object.keys(c).find((k) => k.startsWith("x-nvidia-") && c[k] === false);
  if (failed) return `${name}: ${failed} is false`;
  if (typeof c.exp !== "number" || c.exp <= nowSecs) return `${name}: token expired`;
  return null;
}

/**
 * GPU evidence: the payload must carry our nonce before it is sent; then NVIDIA NRAS must return an overall pass
 * and one token per GPU, each for our nonce, with secure boot on, debug off, measurements matched and no warning.
 */
export async function checkGpus(
  payload: TeeAttestation["nvidia_payload"],
  nonce: string,
  o: { fetch?: typeof fetch; nowMs: number; timeoutMs?: number },
): Promise<{ check: Check; gpus: GpuSummary | null }> {
  const n = nonce.toLowerCase();
  let evidence: { nonce?: unknown; arch?: unknown; evidence_list?: unknown };
  try {
    if (payload === undefined) throw new Error("no GPU evidence in the report");
    evidence = (typeof payload === "string" ? JSON.parse(payload) : payload) as typeof evidence;
  } catch (error) {
    return { check: check("gpu", "fail", (error as Error).message), gpus: null };
  }
  const count = Array.isArray(evidence.evidence_list) ? evidence.evidence_list.length : 0;
  if (count === 0) return { check: check("gpu", "fail", "no GPU evidence in the report"), gpus: null };
  if (String(evidence.nonce ?? "").toLowerCase() !== n) return { check: check("gpu", "fail", "GPU evidence for another nonce"), gpus: null };

  const what = "NVIDIA attestation";
  let answer: unknown;
  try {
    const res = await request(
      o.fetch ?? fetch,
      NVIDIA_NRAS_URL,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
      o.timeoutMs ?? 30_000,
      what,
    );
    const text = await bodyText(res, what);
    // NVIDIA's edge answers 403 to networks it blocks: that says nothing about the GPU.
    if (res.status === 403) throw new Unavailable(`${what}: this network was refused (403)`);
    if (res.status === 429 || res.status >= 500) throw new Unavailable(`${what}: ${res.status}`);
    if (!res.ok) return { check: check("gpu", "fail", `${what}: ${res.status} ${text.slice(0, 120)}`), gpus: null };
    answer = JSON.parse(text);
  } catch (error) {
    if (error instanceof Unavailable) return { check: check("gpu", "unavailable", error.message), gpus: null };
    return { check: check("gpu", "fail", (error as Error).message), gpus: null };
  }

  try {
    const nowSecs = Math.floor(o.nowMs / 1000);
    if (!Array.isArray(answer) || !Array.isArray(answer[0]) || answer[0][0] !== "JWT") throw new Error("unexpected NVIDIA answer");
    const overall = claims(answer[0][1]);
    const perGpu = Object.entries((answer[1] ?? {}) as Record<string, unknown>).map(([name, t]) => [name, claims(t)] as const);
    const gpus: GpuSummary = {
      count: perGpu.length,
      arch: typeof evidence.arch === "string" ? evidence.arch : null,
      hwmodel: typeof perGpu[0]?.[1].hwmodel === "string" ? perGpu[0][1].hwmodel : null,
      driver: typeof perGpu[0]?.[1]["x-nvidia-gpu-driver-version"] === "string" ? perGpu[0][1]["x-nvidia-gpu-driver-version"] : null,
    };
    const problem =
      (overall["x-nvidia-overall-att-result"] !== true && "overall result is not a pass") ||
      (String(overall.eat_nonce ?? "").toLowerCase() !== n && "overall token for another nonce") ||
      (typeof overall.exp !== "number" || overall.exp <= nowSecs ? "overall token expired" : null) ||
      (perGpu.length !== count && `${count} GPUs sent, ${perGpu.length} judged`) ||
      perGpu.map(([name, c]) => gpuProblem(name, c, n, nowSecs)).find(Boolean) ||
      null;
    const detail = `${gpus.count} × ${gpus.hwmodel ?? gpus.arch ?? "GPU"}`;
    return { check: check("gpu", problem === null, problem ?? detail), gpus };
  } catch (error) {
    return { check: check("gpu", "fail", (error as Error).message), gpus: null };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// One model, end to end

export interface VerifyOptions {
  readonly fetch?: typeof fetch;
  readonly collateral?: CollateralSource;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /** Tests only: replay a recorded report under its own nonce. A live check always makes a fresh one. */
  readonly nonce?: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

let sharedCollateral: CollateralSource | undefined;

/** Fresh nonce, fresh report, every check above on the gateway and on every model node. Never throws. */
export async function verifyModel(model: string, o: VerifyOptions = {}): Promise<ModelVerification> {
  const now = o.now ?? Date.now;
  const nonce = o.nonce ?? freshNonce();
  const started = now();
  // One cache per process for the real network; a caller with its own fetch gets its own source.
  const collateral = o.collateral ?? (o.fetch ? pccsCollateral({ fetch: o.fetch }) : (sharedCollateral ??= pccsCollateral()));
  const done = (fields: Pick<ModelVerification, "gateway" | "nodes" | "checks">): ModelVerification => {
    const result = { model, nonce, checkedAt: new Date(started).toISOString(), ms: now() - started, outcome: "pass" as Outcome, ...fields };
    return { ...result, outcome: outcomeOf(allChecks(result)) };
  };

  let report: AttestationReport;
  try {
    report = await fetchReport({
      model,
      nonce,
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      ...(o.apiKey ? { apiKey: o.apiKey } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    });
  } catch (error) {
    const outcome: Outcome = error instanceof Unavailable ? "unavailable" : "fail";
    return done({ gateway: null, nodes: [], checks: [check("report", outcome, (error as Error).message)] });
  }

  const tee = async (role: TeeResult["role"], att: TeeAttestation): Promise<TeeResult> => {
    let quote: VerifiedQuote | Error;
    try {
      quote = await verifyIntelQuote(att.intel_quote ?? "", collateral, now());
    } catch (error) {
      quote = error instanceof Error ? error : new Error(String(error));
    }
    const checks = checkTee(att, nonce, quote);
    let gpus: GpuSummary | null = null;
    if (role === "model") {
      const gpu = await checkGpus(att.nvidia_payload, nonce, {
        nowMs: now(),
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      });
      checks.push(gpu.check);
      gpus = gpu.gpus;
    }
    const verified = quote instanceof Error ? null : quote;
    return {
      role,
      signer: (att.signing_address ?? "").toLowerCase(),
      tcb: verified?.tcb ?? null,
      advisories: verified?.advisories ?? [],
      mrtd: verified ? bytesToHex(verified.mrTd) : null,
      gpus,
      checks,
    };
  };

  const candidates = report.model_attestations ?? [];
  const [gateway, ...nodes] = await Promise.all([
    report.gateway_attestation ? tee("gateway", report.gateway_attestation) : Promise.resolve(null),
    ...candidates.map((att) => tee("model", att)),
  ]);
  const wrongModel = candidates.find((a) => a.model_name !== undefined && a.model_name !== model);
  const checks = [
    check("report", "pass"),
    candidates.length === 0
      ? check("nodes", "fail", "no NEAR model evidence for this model")
      : wrongModel
        ? check("nodes", "fail", `evidence for ${wrongModel.model_name}`)
        : check("nodes", "pass", `${candidates.length} node${candidates.length === 1 ? "" : "s"}`),
  ];
  if (!gateway) checks.push(check("quote", "fail", "no gateway attestation in the report"));
  return done({ gateway, nodes: nodes.filter((n): n is TeeResult => n !== null), checks });
}
