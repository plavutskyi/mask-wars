import { readFileSync } from "node:fs";
import { sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Collateral } from "@phala/dcap-qvl";
import { describe, expect, it } from "vitest";
import {
  allChecks,
  checkGpus,
  checkTee,
  fetchCollateral,
  freshNonce,
  NVIDIA_NRAS_URL,
  pccsCollateral,
  replayRtmr3,
  Unavailable,
  verifyModel,
  type AttestationReport,
  type CollateralSource,
  type EventLogEntry,
  type TeeAttestation,
  type VerifiedQuote,
} from "../src/attestation.ts";

/**
 * A real check of Qwen/Qwen3.8-27B recorded by scripts/record-attestation.ts: the NEAR AI report (trimmed to the
 * fields the checks read, quotes and logs byte for byte), Intel's collateral for both quotes and NVIDIA's answer, all
 * under the recorded nonce and time. Replayed offline: no network, no key.
 */
interface Recording {
  readonly now: number;
  readonly model: string;
  readonly nonce: string;
  readonly report: AttestationReport;
  readonly collateral: Record<string, Collateral>;
  readonly nras: readonly unknown[];
}
const REC = JSON.parse(readFileSync(new URL("./fixtures/attestation-qwen.json", import.meta.url), "utf8")) as Recording;

const recorded: CollateralSource = {
  async get(fmspc, ca) {
    const c = REC.collateral[`${fmspc}:${ca}`];
    if (!c) throw new Error(`no recorded collateral for ${fmspc}:${ca}`);
    return c;
  },
  forget() {},
};

interface Calls {
  report: URL[];
  reportHeaders: Headers[];
  nras: number;
}

/** NEAR AI and NVIDIA as recorded, unless a step overrides the answer. */
function network(
  opts: { report?: AttestationReport; reportSteps?: (Response | Error)[]; nras?: Response } = {},
): { fetch: typeof fetch; calls: Calls } {
  const calls: Calls = { report: [], reportHeaders: [], nras: 0 };
  const steps = [...(opts.reportSteps ?? [])];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/attestation/report")) {
      calls.report.push(url);
      calls.reportHeaders.push(new Headers(init?.headers));
      const step = steps.shift();
      if (step instanceof Error) throw step;
      return step ?? Response.json(opts.report ?? REC.report);
    }
    if (String(input) === NVIDIA_NRAS_URL) {
      calls.nras++;
      return opts.nras ?? Response.json(REC.nras[0]);
    }
    throw new TypeError(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}

const replay = (fetcher: typeof fetch, extra: { nonce?: string; collateral?: CollateralSource } = {}) =>
  verifyModel(REC.model, { fetch: fetcher, collateral: recorded, nonce: REC.nonce, now: () => REC.now, ...extra });

/** A deep copy of the recorded report with one TEE entry changed. */
function tamper(edit: (r: { gateway_attestation: TeeAttestation; model_attestations: TeeAttestation[] }) => void): AttestationReport {
  const copy = structuredClone(REC.report) as { gateway_attestation: TeeAttestation; model_attestations: TeeAttestation[] };
  edit(copy);
  return copy;
}

const failing = (v: Awaited<ReturnType<typeof verifyModel>>) =>
  allChecks(v)
    .filter((c) => c.outcome !== "pass")
    .map((c) => `${c.id}:${c.outcome}`);

describe("a recorded live check", () => {
  it("passes every check on the gateway and the model node, offline", async () => {
    const { fetch, calls } = network();
    const v = await replay(fetch);
    expect(failing(v)).toEqual([]);
    expect(v.outcome).toBe("pass");
    expect(v.gateway?.tcb).toBe("UpToDate");
    expect(v.nodes).toHaveLength(1);
    expect(v.nodes[0]?.gpus).toMatchObject({ count: 1, hwmodel: "GH100" });
    expect(v.nodes[0]?.checks.map((c) => c.id)).toEqual(["quote", "debug", "nonce", "signer", "config", "boot", "gpu"]);
    expect(v.checkedAt).toBe(new Date(REC.now).toISOString());

    const url = calls.report[0]!;
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ model: REC.model, provider: "near", signing_algo: "ecdsa", nonce: REC.nonce });
    expect(calls.reportHeaders[0]?.get("x-no-aliasing")).toBe("true");
    expect(calls.reportHeaders[0]?.has("authorization")).toBe(false);
    expect(calls.nras).toBe(1);
  });

  it("a fresh nonce makes the replayed report fail, and the GPU evidence is never sent", async () => {
    const { fetch, calls } = network();
    const v = await replay(fetch, { nonce: freshNonce() });
    expect(v.outcome).toBe("fail");
    expect(failing(v)).toEqual(["nonce:fail", "nonce:fail", "gpu:fail"]);
    expect(v.nodes[0]?.checks.find((c) => c.id === "gpu")?.detail).toBe("GPU evidence for another nonce");
    expect(calls.nras).toBe(0);
  });

  it("an edited app_compose fails the measured config", async () => {
    const report = tamper((r) => {
      const tcb = r.gateway_attestation.info!.tcb_info as { app_compose: string };
      r.gateway_attestation = { ...r.gateway_attestation, info: { tcb_info: { app_compose: `${tcb.app_compose} ` } } };
    });
    const v = await replay(network({ report }).fetch);
    expect(failing(v)).toEqual(["config:fail"]);
    expect(v.gateway?.checks.find((c) => c.id === "config")?.detail).toBe("config differs from its measurement");
  });

  it("an edited boot event fails the log replay", async () => {
    const report = tamper((r) => {
      const log = (typeof r.model_attestations[0]!.event_log === "string"
        ? JSON.parse(r.model_attestations[0]!.event_log)
        : r.model_attestations[0]!.event_log) as EventLogEntry[];
      const i = log.findIndex((e) => e.imr === 3 && e.event_payload);
      const edited = log.map((e, j) => (j === i ? { ...e, event_payload: `00${e.event_payload!.slice(2)}`, digest: "" } : e));
      r.model_attestations[0] = { ...r.model_attestations[0]!, event_log: edited };
    });
    const v = await replay(network({ report }).fetch);
    expect(failing(v)).toEqual(["boot:fail"]);
    expect(v.nodes[0]?.checks.find((c) => c.id === "boot")?.detail).toBe("boot log differs from RTMR3");
  });

  it("a signing address the quote does not bind fails the signer", async () => {
    const report = tamper((r) => {
      r.model_attestations[0] = { ...r.model_attestations[0]!, signing_address: r.gateway_attestation.signing_address! };
    });
    const v = await replay(network({ report }).fetch);
    expect(failing(v)).toEqual(["signer:fail"]);
    expect(v.nodes[0]?.checks.find((c) => c.id === "signer")?.detail).toBe("quote binds another signing key");
  });

  it("one changed byte in a quote fails Intel's verification", async () => {
    const report = tamper((r) => {
      const q = r.model_attestations[0]!.intel_quote!;
      const at = 2 * (48 + 136); // first byte of MRTD in the TD report body
      r.model_attestations[0] = { ...r.model_attestations[0]!, intel_quote: q.slice(0, at) + (q.slice(at, at + 2) === "00" ? "01" : "00") + q.slice(at + 2) };
    });
    const v = await replay(network({ report }).fetch);
    expect(v.outcome).toBe("fail");
    expect(failing(v)).toEqual(["quote:fail", "debug:unavailable", "nonce:unavailable", "signer:unavailable", "config:unavailable", "boot:unavailable"]);
  });

  it("a report without NEAR model evidence, or for another model, fails", async () => {
    const none = tamper((r) => {
      r.model_attestations = [];
    });
    expect(failing(await replay(network({ report: none }).fetch))).toEqual(["nodes:fail"]);
    const other = tamper((r) => {
      r.model_attestations[0] = { ...r.model_attestations[0]!, model_name: "z-ai/glm-5.3-flash" };
    });
    expect(failing(await replay(network({ report: other }).fetch))).toEqual(["nodes:fail"]);
  });
});

describe("evidence that cannot be had is not a verdict", () => {
  it("NEAR AI rate limit: one retry after Retry-After", async () => {
    const limited = new Response("busy", { status: 429, headers: { "retry-after": "0.01" } });
    const { fetch, calls } = network({ reportSteps: [limited] });
    expect((await replay(fetch)).outcome).toBe("pass");
    expect(calls.report).toHaveLength(2);
  });

  it("NEAR AI down, rate limited twice or unreachable: unavailable", async () => {
    for (const steps of [
      [new Response("", { status: 503 })],
      [new Response("", { status: 429 }), new Response("", { status: 429 })],
      [new TypeError("fetch failed")],
    ]) {
      const v = await replay(network({ reportSteps: steps }).fetch);
      expect(v.outcome).toBe("unavailable");
      expect(failing(v)).toEqual(["report:unavailable"]);
    }
  });

  it("an unknown model is a failure, not an outage", async () => {
    const v = await replay(network({ reportSteps: [new Response('{"error":"model not found"}', { status: 404 })] }).fetch);
    expect(failing(v)).toEqual(["report:fail"]);
  });

  it("NVIDIA refusing this network or failing: GPU unavailable, never green", async () => {
    for (const status of [403, 500]) {
      const v = await replay(network({ nras: new Response("", { status }) }).fetch);
      expect(v.outcome).toBe("unavailable");
      expect(failing(v)).toEqual(["gpu:unavailable"]);
    }
  });

  it("Intel collateral unreachable: quotes unavailable", async () => {
    const down: CollateralSource = {
      get: async () => {
        throw new Unavailable("Intel collateral: no answer in time");
      },
      forget() {},
    };
    const v = await replay(network().fetch, { collateral: down });
    expect(v.outcome).toBe("unavailable");
    expect(v.gateway?.checks[0]).toMatchObject({ id: "quote", outcome: "unavailable" });
  });
});

describe("quote policy", () => {
  const nonce = freshNonce();
  const address = "0x" + "ab".repeat(20);
  const att: TeeAttestation = { signing_address: address, signing_algo: "ecdsa", request_nonce: nonce, event_log: [] };
  const quote = (over: Partial<VerifiedQuote>): VerifiedQuote => ({
    tcb: "UpToDate",
    advisories: [],
    tdAttributes: new Uint8Array(8),
    mrTd: new Uint8Array(48),
    mrConfigId: new Uint8Array(48),
    rtMr3: new Uint8Array(48),
    reportData: concatBytes(hexToBytes("ab".repeat(20)), new Uint8Array(12), hexToBytes(nonce)),
    ...over,
  });
  const outcome = (q: VerifiedQuote, id: string) => checkTee(att, nonce, q).find((c) => c.id === id);

  it("accepts UpToDate and SWHardeningNeeded with the advisories shown, refuses older TCB", () => {
    expect(outcome(quote({}), "quote")).toMatchObject({ outcome: "pass", detail: "TCB UpToDate" });
    expect(outcome(quote({ tcb: "SWHardeningNeeded", advisories: ["INTEL-SA-00837"] }), "quote")).toMatchObject({
      outcome: "pass",
      detail: "TCB SWHardeningNeeded · INTEL-SA-00837",
    });
    for (const tcb of ["OutOfDate", "ConfigurationNeeded", "Revoked"] as const) {
      expect(outcome(quote({ tcb }), "quote")?.outcome).toBe("fail");
    }
  });

  it("refuses a debug TD", () => {
    expect(outcome(quote({}), "debug")?.outcome).toBe("pass");
    expect(outcome(quote({ tdAttributes: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]) }), "debug")).toMatchObject({ outcome: "fail", detail: "debug TD" });
  });

  it("binds the address zero-padded, or hashed with the TLS fingerprint", () => {
    expect(outcome(quote({}), "signer")?.outcome).toBe("pass");
    const withTls = { ...att, tls_cert_fingerprint: "11".repeat(32) };
    expect(checkTee(withTls, nonce, quote({})).find((c) => c.id === "signer")?.outcome).toBe("fail");
    expect(checkTee({ ...att, signing_algo: "ed25519" }, nonce, quote({})).find((c) => c.id === "signer")?.outcome).toBe("fail");
  });
});

describe("RTMR3 replay", () => {
  it("extends SHA-384 digests of the imr 3 events in order", () => {
    const event = (type: number, name: string, payload: string): EventLogEntry => ({ imr: 3, event_type: type, event: name, event_payload: payload });
    const digest = (e: EventLogEntry) => {
      const t = new Uint8Array(4);
      new DataView(t.buffer).setUint32(0, e.event_type, true);
      return sha384(concatBytes(t, utf8ToBytes(":"), utf8ToBytes(e.event), utf8ToBytes(":"), hexToBytes(e.event_payload ?? "")));
    };
    const a = event(134217729, "app-id", "f550fdfb");
    const b = event(134217729, "compose-hash", "00".repeat(32));
    const expected = sha384(concatBytes(sha384(concatBytes(new Uint8Array(48), digest(a))), digest(b)));
    const log = [{ imr: 0, event_type: 1, event: "ignored", event_payload: "ff" }, a, { ...b, digest: bytesToHex(digest(b)) }];
    expect(bytesToHex(replayRtmr3(JSON.stringify(log)).rtmr3)).toBe(bytesToHex(expected));
    expect(replayRtmr3(log).events).toBe(2);
    expect(() => replayRtmr3([{ ...a, digest: "00".repeat(48) }])).toThrow(/app-id: digest/);
  });
});

describe("NVIDIA verdict", () => {
  const nonce = freshNonce();
  const now = 1_800_000_000_000;
  const token = (claims: Record<string, unknown>) =>
    ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2ln"].join(".");
  const gpu = { eat_nonce: nonce, secboot: true, dbgstat: "disabled", measres: "success", hwmodel: "GH100", exp: now / 1000 + 600, "x-nvidia-gpu-attestation-report-signature-verified": true };
  const answer = (overall: Record<string, unknown>, gpus: Record<string, unknown>[]) =>
    Response.json([["JWT", token({ "x-nvidia-overall-att-result": true, eat_nonce: nonce, exp: now / 1000 + 600, ...overall })], Object.fromEntries(gpus.map((g, i) => [`GPU-${i}`, token(g)]))]);
  const payload = (n = 2) => JSON.stringify({ nonce, arch: "HOPPER", evidence_list: Array.from({ length: n }, () => ({ evidence: "…" })) });
  const run = (res: Response, p = payload()) => checkGpus(p, nonce, { nowMs: now, fetch: (async () => res) as typeof fetch });

  it("passes when every GPU passes for our nonce", async () => {
    const r = await run(answer({}, [gpu, gpu]));
    expect(r.check).toMatchObject({ outcome: "pass", detail: "2 × GH100" });
    expect(r.gpus).toMatchObject({ count: 2, arch: "HOPPER", hwmodel: "GH100" });
  });

  it("fails on any weak GPU, a missing GPU, another nonce or an expired token", async () => {
    const cases: [Response, RegExp][] = [
      [answer({ "x-nvidia-overall-att-result": false }, [gpu, gpu]), /overall result/],
      [answer({}, [gpu, { ...gpu, secboot: false }]), /GPU-1: secure boot off/],
      [answer({}, [gpu, { ...gpu, dbgstat: "enabled" }]), /GPU-1: debug enabled/],
      [answer({}, [gpu, { ...gpu, "x-nvidia-gpu-attestation-report-signature-verified": false }]), /signature-verified is false/],
      [answer({}, [gpu]), /2 GPUs sent, 1 judged/],
      [answer({ eat_nonce: freshNonce() }, [gpu, gpu]), /another nonce/],
      [answer({}, [gpu, { ...gpu, exp: now / 1000 - 1 }]), /GPU-1: token expired/],
      [Response.json({ error: "bad" }), /unexpected NVIDIA answer/],
    ];
    for (const [res, why] of cases) {
      const r = await run(res);
      expect(r.check.outcome).toBe("fail");
      expect(r.check.detail).toMatch(why);
    }
  });

  it("no evidence, or evidence for another nonce, fails before anything is sent", async () => {
    let sent = 0;
    const fetcher = (async () => {
      sent++;
      return answer({}, [gpu]);
    }) as typeof fetch;
    expect((await checkGpus(undefined, nonce, { nowMs: now, fetch: fetcher })).check.outcome).toBe("fail");
    expect((await checkGpus(JSON.stringify({ nonce: freshNonce(), evidence_list: [{}] }), nonce, { nowMs: now, fetch: fetcher })).check.outcome).toBe("fail");
    expect(sent).toBe(0);
  });
});

describe("Intel collateral from a PCCS", () => {
  /** A PCCS that serves the recorded collateral the way Phala's does: DER CRL, hex root CRL, URL-encoded chains. */
  const [key, c] = Object.entries(REC.collateral)[0]!;
  const [fmspc, ca] = key.split(":") as [string, string];
  const pccs = (count: { n: number }, fail = false) =>
    (async (input: string | URL | Request) => {
      count.n++;
      if (fail) throw new TypeError("fetch failed");
      const url = new URL(String(input));
      const enc = (s: string) => encodeURIComponent(s);
      if (url.pathname.endsWith("/pckcrl")) return new Response(hexToBytes(c.pck_crl as string), { headers: { "SGX-PCK-CRL-Issuer-Chain": enc(c.pck_crl_issuer_chain) } });
      if (url.pathname.endsWith("/tcb")) {
        return new Response(`{"tcbInfo":${c.tcb_info},"signature":"${c.tcb_info_signature as string}"}`, { headers: { "TCB-Info-Issuer-Chain": enc(c.tcb_info_issuer_chain) } });
      }
      if (url.pathname.endsWith("/qe/identity")) {
        return new Response(`{"enclaveIdentity":${c.qe_identity},"signature":"${c.qe_identity_signature as string}"}`, {
          headers: { "SGX-Enclave-Identity-Issuer-Chain": enc(c.qe_identity_issuer_chain) },
        });
      }
      if (url.pathname.endsWith("/rootcacrl")) return new Response(`${c.root_ca_crl as string}\n`);
      return new Response("", { status: 404 });
    }) as typeof fetch;

  it("reads the four answers into the collateral dcap-qvl takes", async () => {
    expect(await fetchCollateral("https://pccs.example", fmspc, ca, pccs({ n: 0 }), 1000)).toEqual(c);
  });

  it("caches per platform family and never caches a failure", async () => {
    const count = { n: 0 };
    const source = pccsCollateral({ fetch: pccs(count) });
    await source.get(fmspc, ca);
    await source.get(fmspc, ca);
    expect(count.n).toBe(4);
    source.forget(fmspc, ca);
    await source.get(fmspc, ca);
    expect(count.n).toBe(8);

    const down = { n: 0 };
    const failingSource = pccsCollateral({ fetch: pccs(down, true) });
    await expect(failingSource.get(fmspc, ca)).rejects.toBeInstanceOf(Unavailable);
    await expect(failingSource.get(fmspc, ca)).rejects.toBeInstanceOf(Unavailable);
    expect(down.n).toBe(8);
  });
});
