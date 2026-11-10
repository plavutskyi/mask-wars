# @maskwars/mind

How the masks think and talk.

- **Mind.** One sealed pick before the bell (`primary`, `backup`, `call`), then one `HOLD` or `ROTATE` per minute
  until the rotate is spent. Open models run in Private TEE on NEAR AI Cloud. The model only proposes a move. The code
  checks it against the basket, the mask's manner and the fight rules. Anything late, malformed or against the rules is
  replaced by the mask's own default move, so a bad answer never breaks a fight.
- **Voice.** Six masks, 150+ hand-written lines each, tagged by fight event. A line goes on screen the moment the event
  happens. A model may tailor it to the fight afterwards. If that is late or off-voice, the written line stays.

## Use

```ts
import { Mind, NearAiProvider, MemoryJournal, Voice, LineMemory } from "@maskwars/mind";

const journal = new MemoryJournal();
const mind = new Mind({
  provider: new NearAiProvider({ apiKey: process.env.NEARAI_CLOUD_API_KEY!, trustedSigners }),
  model: "z-ai/glm-5.3-flash",
  journal,
});
const seal = await mind.seal("f-0-12", { mask: "onyx", rival: "nova", market });
// seal.move = { primary, backup, call }, seal.source = "model" | "default"

const voice = new Voice({ memory: new LineMemory(20) });
const line = voice.say("f-0-12", "onyx", "take_lead", { rival: "NOVA", points: "340" });
show(line.text);               // now
line.polished.then(swapIfStill); // maybe, later
```

`market` is passed in by the caller: one snapshot per minute, shared by every mask. The mind never fetches prices.

## Pieces

| File | What it does |
| --- | --- |
| `src/decision.ts` | zod schemas for both proposals, rule checks, default moves per manner |
| `src/near-ai.ts` | NEAR AI Cloud client: Private TEE allow list, canonical IDs, `x-no-aliasing: true`, no streaming, one deadline, signature fetch and check |
| `src/provider.ts` | `Provider` interface. Claude and Codex plug in through it with their own clients. `FakeProvider` for tests and keyless demos |
| `src/prompt.ts` | Our words in the system message. Market, fight state, rival history and viewer text go in one JSON object as data |
| `src/clean.ts` | Viewer text cleaning: invisible characters, bidi, tag characters, HTML and markdown payloads, links, handles, fake chat turns |
| `src/journal.ts` | Per decision: model, sha256 of the exact request and response bytes, TEE signature, whether it verified, cost, latency, model or default |
| `src/lines.ts`, `src/voice.ts` | Line book, slot filling, no repeats within a mask's last 20 fights, tailoring with checks |
| `src/attestation.ts`, `scripts/verify-attestation.ts` | Attestation check: Intel TDX quote, nonce, signer, config, boot log, NVIDIA GPUs |
| `voices/<mask>.md`, `voices/<mask>.json` | Voice bible and lines per mask |

## Cost

No model call per tick. At most five calls per mask per fight: one seal and up to four minute moves, and none once the
rotate is spent. At about 2 000 tokens in and 300 out, that is ≈$0.0003 per decision on `z-ai/glm-5.3-flash`. The market
digest is built once per snapshot and is byte-identical across masks, so the shared part of the prompt can come from the
provider's cache.

## Attestation

```sh
pnpm --filter @maskwars/mind verify:attestation                  # all three TEE models
pnpm --filter @maskwars/mind verify:attestation z-ai/glm-5.3-flash
```

For each model: a fresh 32-byte nonce, then `GET /v1/attestation/report?model=…&provider=near&signing_algo=ecdsa&nonce=…`
with `x-no-aliasing: true`. No key needed. The checks follow docs.near.ai/cloud/verification (8.11.2026) and run on the
gateway TEE and on every model TEE node in the report. Exit code 1 unless every check passed. The site runs the same
code for `/verified` (`apps/web/lib/verified.ts`).

**What is checked**

| Check | How |
| --- | --- |
| Intel TDX quote | [dcap-qvl](https://github.com/Phala-Network/dcap-qvl) verifies the quote up to Intel's root CA with Intel's collateral (PCK chain and CRLs, QE identity, TCB info, from Phala's PCCS). TCB `UpToDate` or `SWHardeningNeeded`, status and advisories shown |
| Not a debug TD | Bit 0 of TD_ATTRIBUTES in the verified quote is 0 |
| Fresh nonce | Our nonce is echoed and sits in bytes 32..64 of the verified quote's report data |
| Signing key | Bytes 0..32 hold the TEE signing address, zero-padded (or sha256 with the TLS fingerprint when one is bound) |
| Measured config | MRCONFIGID = `01` ‖ sha256(exact `app_compose` bytes) ‖ 15 zero bytes |
| Boot log | The RTMR3 event log, each digest recomputed, replays to the quote's RTMR3 |
| GPUs | Model nodes only. The NVIDIA payload carries our nonce; NVIDIA NRAS returns an overall pass and one token per GPU, each for our nonce, secure boot on, debug off, measurements matched, no warning, not expired |

Fail-closed: a check passes only when its evidence was obtained and holds. Evidence that could not be obtained
(network, NEAR AI rate limit, NVIDIA refusing a network with 403, PCCS down) is `unavailable`, never a pass.

**What it does not cover**

- Image provenance: which source built the containers named in `app_compose`.
- The NVIDIA token signature: the verdict is read over TLS straight from NVIDIA, as the docs' flow does.
- That a given answer came from the attested instance: instances of one model share a signing key.
- Our engine, the strategy and the race runner run outside the TEE; only the model's thinking runs inside.

**Offline tests.** `test/fixtures/attestation-qwen.json` is a real check recorded by `scripts/record-attestation.ts`:
report, Intel collateral and NVIDIA's answer under the recorded nonce and time. The tests replay it without network
or key, then tamper with it: another nonce, one changed quote byte, an edited `app_compose` or boot event, a swapped
signer, missing evidence, outages.
After a new recording, replace the two NVIDIA tokens allowed in `scripts/public-export/gitleaks.toml` with the new
ones: they are public attestation verdicts, and the public-copy scan lists exact values only.

Each answer's signature is checked when it arrives: the signed text must be `model:sha256(request):sha256(response)`
for our exact bytes, and the EIP-191 signer must be one of the model TEE addresses from a fresh attestation report. The
journal records whether that check passed. Claude and Codex do not run in Private TEE, and their journal entries carry
no TEE signature.

## Checks

```sh
pnpm --filter @maskwars/mind typecheck
pnpm --filter @maskwars/mind test
```

Tests cover the schemas, rules and defaults of every mask, injection attempts (including hidden markdown, HTML
comments, Unicode tag characters and fake chat turns), timeouts and hung providers, signature checks, attestation
checks on a recorded live report, line book rules (count, length, banned words, every event and rival covered) and repeats across fights.
