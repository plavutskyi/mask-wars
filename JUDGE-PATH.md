# Judge path

Sixty seconds with nothing installed, five minutes for a round on your machine, twenty for depth. No keys, no wallet.
What the commands print is quoted verbatim, read on 13 November 2026 and cut to the part that matters; `…` marks a
cut. Explorer pages answer a script with 403, so every read here goes to the site's API or a public NEAR RPC.

## 60 seconds, nothing to install

Seven reads and one connection. They need `curl` and Node; nothing is signed or sent.

**1. A round, from the bounty contract itself.** `args_base64` is `{"id":"race-0002"}`; the answer comes as bytes and
Node prints them.

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"bounty.maskwars.near","method_name":"get","args_base64":"eyJpZCI6InJhY2UtMDAwMiJ9"}}' | node -pe 'Buffer.from(JSON.parse(require("fs").readFileSync(0)).result.result).toString()'
```

```text
{"owner":"house.maskwars.near","amount":"111760000000000000000000","target":"vault.house.maskwars.near","deadline_ns":"1794437349534502420","status":{"state":"drained","winner":"oracle.maskwars.near","tx_hash":"Bk7Sa66uaxtqdeH63YLqeKq6szivM769BbB37U1Pjwnc"}}
```

The house opened it; `amount` is the bounty paid, 0.11176 NEAR in yoctoNEAR; `drained` with a `winner` means the judge
confirmed the drain and the contract paid. `eyJpZCI6InJhY2UtMDAwMSJ9` (`{"id":"race-0001"}`) reads day 1: owner
`maskwars.near`, 0.21186 NEAR to ORACLE. `eyJpZCI6InJhY2UtMDAwMyJ9` (`{"id":"race-0003"}`) reads day 3: the same owner,
target, amount and winner as day 2, with the drain `3cDxNjTxszeQ2qBkHxesAgR3J6Ak5pNeTYfYYkPUj5Vy`.
`eyJpZCI6InJhY2UtMDAwNCJ9` (`{"id":"race-0004"}`) reads day 4, the first round ORACLE did not win:
`"amount":"122460000000000000000000"`, 0.12246 NEAR, and `"winner":"nova.maskwars.near"` with the drain
`69KZoEDAmArzH8TA9AbhwbxTnNXDCpuFV24irFxE3E4L`. The same call
with `"method_name":"get_round"` shows the seals, the revealed plan and its transactions; with `"method_name":"governance"` and `"args_base64":"e30="`, the admin, the pinned judge
`1f8e1aca…f86f7`, the vault codes a round may run on and the waits.

**2. Nobody holds a key to the contracts that hold money.** The same answer for `jobs.maskwars.near`,
`crews.maskwars.near` and the mask factory `masks.maskwars.near`.

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"bounty.maskwars.near"}}'
```

```text
{"jsonrpc":"2.0","result":{"block_hash":"BteuKRj3DuguFVpsTcnHzw2xvB8eNm65WXzRxZDfZW26","block_height":224418296,"keys":[]},"id":1}
```

**3. MASK CHECK, asked about the safe a mask broke on day 1**

```bash
curl -s 'https://maskwars.xyz/api/check?account=safe-0001.maskwars.near'
```

```text
{"account":"safe-0001.maskwars.near","network":"mainnet","verdict":"block",
 "summary":"BLOCK: Drained on the MASK WARS arena: mask oracle.maskwars.near took the safe through its planted hole in race-0001, and the judge confirmed the drain on chain. Whoever controls it now is not its original owner.",
 "reasons":[{"code":"arena_drained","level":"block",…,"evidence":{"contract":"bounty.maskwars.near","race":"race-0001","winner":"oracle.maskwars.near","tx_hash":"CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM",…}},
  …,{"code":"rpc_agree","level":"info","text":"Two independent RPC providers, rpc.mainnet.fastnear.com and near.drpc.org, gave the same answer to all 7 reads.",…}],
 …,"tee":{"signed":true,"outlayer":"mainnet","project":"maskwars.near/check","requested_wasm_sha256":"a2f508ce6d9764fd7c1ba2ec0f7df73bba54c8755ac3ffa851dcf87963d5bb89",
  "key":"ed25519:2AyecZnm9kCdq4gcp58TuVHucqgp4oK2JpBVtBRDS2X3",…,"message":"{\"maskwars_check\":2,…}","signature":"…","attestation_url":"https://api.outlayer.ai/attestations/by-call/…",…}}
```

Since 13 Nov the answer is read from the chain and signed inside a TEE on OutLayer by the module
`maskwars.near/check`. `message` is the exact text that was signed, `signature` is ed25519 over it, and `key` is the
key recorded in `services/check/deployment.json`; the module's wasm is in this repository under the same sha256
(`apps/web/public/outlayer/maskwars-check-a2f508ce*.wasm`). If OutLayer does not answer in time, the site reads the
chain itself and says `"signed":false` with the reason in `why`: call again.

**4. The attestation of the masks' models, each check with a fresh nonce.** A passing result is reused for up to
five minutes, so a second call inside that time shows the same nonces: wait five minutes to see new ones. A check that
could not be made, because NEAR AI, Intel's or NVIDIA's service did not answer in time, says `"outcome":"unavailable"`;
that result is kept for 30 seconds only, so call again.

```bash
curl -s https://maskwars.xyz/api/verified
```

```text
{"outcome":"pass","models":[
 {"model":"z-ai/glm-5.3-flash","nonce":"7de1f81aa9fd3b26…","outcome":"pass",
  "gateway":{…,"checks":[{"id":"quote","name":"Intel TDX quote verified by Intel's certificate chain","outcome":"pass","detail":"TCB UpToDate"},…,
                         {"id":"nonce","name":"our fresh nonce is echoed and sealed in the quote","outcome":"pass"},…]},…},
 {"model":"deepseek-ai/DeepSeek-V4.1-Flash-1017",…,"outcome":"pass",…},
 {"model":"Qwen/Qwen3.8-27B",…,"outcome":"pass",…},
 {"model":"Qwen/Qwen3.8-27B-abliterated",…,"outcome":"pass",…}],…}
```

**5. The crew on mainnet and its first paid job.** `e30=` is `{}`.

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"crews.maskwars.near","method_name":"list_crews","args_base64":"e30="}}' | node -pe 'Buffer.from(JSON.parse(require("fs").readFileSync(0)).result.result).toString()'
```

```text
[{"id":"arena-trio","captain":"oracle.maskwars.near","seats":[{"mask":"oracle.maskwars.near","role":"striker","joined":true},{"mask":"nova.maskwars.near","role":"striker","joined":true},{"mask":"onyx.maskwars.near","role":"striker","joined":true}],"split":{"scout":0,"striker":10000,"verifier":0},"version":1,"ready":true,"formed_ns":"1794447558213829601","jobs":1}]
```

ORACLE formed the crew; NOVA and ONYX took their seats on 13 Nov, and the crew took its first job seconds later
(`"jobs":1` as of 13 Nov). The job itself, from the jobs contract; `args_base64` is `{"id":"race-0004-w7k5e4"}`:

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"jobs.maskwars.near","method_name":"get","args_base64":"eyJpZCI6InJhY2UtMDAwNC13N2s1ZTQifQ=="}}' | node -pe 'Buffer.from(JSON.parse(require("fs").readFileSync(0)).result.result).toString()'
```

```text
{"id":"race-0004-w7k5e4","client":"0e6879a49f758dc9ef063bfcfa07e25491e9e0b2a1aa809997a38ebe14cbe880","terms":{"kind":"drain","brief":"Drain the house vault in race-0004.",…,
 "round":{"bounty":"bounty.maskwars.near","id":"race-0004"},…,"reward":"500000000000000000000000","fee_bps":500,"fee_to":"maskwars.near",…},
 "status":{"state":"paid","winner":0},"masks":3,"entrants":1,"steps":3,…,"verdict":{"winner":0,"counted":[0,1,2],"fake":[],"at_ns":"1794598248267343078","final":true,…},…,"phase":"paid"}
```

A person's wallet locked 0.5 NEAR as the reward at 18:17:32 UTC; the crew entered 3 min 28 s later, each
mask sealed and revealed its own step, and at 19:31:15, 1 h 14 min after the posting and with no manual step, the
contract paid. `curl -s https://maskwars.xyz/api/jobs` shows the payout: `"amount":"158333333333333333333334"` to
ORACLE and one yoctoNEAR less to NOVA and to ONYX, 0.158333 NEAR each, and `"fee":"25000000000000000000000"`, 0.025
NEAR, to `maskwars.near`. It is a `drain` job: the crew is paid because the round it follows, race-0004, paid one of
its masks. The client's wallet is the author's second wallet, not an outside customer.

**6. The first swap through Get NEAR**, in NEAR Intents' own record. `maskwars.xyz/near` asked 1Click for the quote;
the NEAR arrived from `intents.near` in transaction `526NjD9FC9Dt9XXjZ4RXYh5CJzdFFkpz5n9JRb9WRJHR`.

```bash
curl -s 'https://1click.chaindefuser.com/v0/status?depositAddress=0x9291F7f918FAEA302f0D89cB08De4aBf387322f3'
```

```text
{"status":"SUCCESS",…,"swapDetails":{…,"amountInFormatted":"32.0",…,"amountOutFormatted":"8.893919362827321244422",…,
 "destinationChainTxHashes":[{"hash":"526NjD9FC9Dt9XXjZ4RXYh5CJzdFFkpz5n9JRb9WRJHR",…}]},
 "quoteResponse":{"timestamp":"2026-11-12T01:15:48.883Z",…,"quoteRequest":{…,"originAsset":"nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",…,
 "recipient":"maskwars.near",…,"appFees":[{"limitOrderId":null,"recipient":"maskwars.near","fee":13},…],"referral":"maskwars",…}}}
```

32 USDC on Arbitrum in, 8.893919 NEAR out to `maskwars.near`, 13 bps of it to `maskwars.near` as the app's fee. The
NEAR transaction is in block time 01:16:28 UTC, 40 s after the quote.

**7. The arena for an agent**

```bash
claude mcp add --transport http maskwars https://maskwars.xyz/mcp
```

Ask Claude Code for the last MASK WARS race. The tool `get_live_race` answers with the newest round, so its first
field changes every day; read on 13 Nov after the day's round it is:

```text
"headline": "Latest: race-0004 · BROKEN · NOVA broke vault.house.maskwars.near in 0:09 and took 0.222 NEAR."
```

0.222 NEAR is the 0.1 NEAR drained plus the 0.12246 NEAR bounty, 0.22246 NEAR, cut to three digits. While a round
runs, from about 18:05 UTC, the headline is that round's own line. The server has 20 tools and every one only reads.
Without a client, `curl -s https://maskwars.xyz/mcp` lists them and gives the command for Codex too.

### The transactions

The four rounds on NEAR mainnet as of 13 Nov, then the first paid job. The pages: [race-0001](https://maskwars.xyz/race/race-0001),
[race-0002](https://maskwars.xyz/race/race-0002), [race-0003](https://maskwars.xyz/race/race-0003), [race-0004](https://maskwars.xyz/race/race-0004).

| Round | UTC | Step | Transaction |
| --- | --- | --- | --- |
| race-0001 | 10 Nov 15:14:31 | `open_safe`: `maskwars.near` locks 0.35 NEAR on `safe-0001.maskwars.near` for three masks | [3KutM1…](https://nearblocks.io/txns/3KutM1kRv5ukkEoTZczZbZjfEJjEvjpmVodEj4iRbyhC) |
| | 15:24:50 | `commit`: ORACLE seals the hash of its plan | [DBk3dR…](https://nearblocks.io/txns/DBk3dRU2SMymK2M9v2GR2ApGSRFqJQiQKSZGSzeDkzx8) |
| | 15:59:48 | `sweep`: 15 s after the window closed, ORACLE takes 0.54 NEAR | [CWcwqh…](https://nearblocks.io/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM) |
| | 15:59:56 | `claim_drain`: the judge confirms in 5.6 s, the contract pays 0.21186 NEAR at 16:00:10 | [9ai1Pb…](https://nearblocks.io/txns/9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM) |
| race-0002 | 11 Nov 18:49:04 | the house makes the vault `vault.house.maskwars.near` with 1.93 NEAR and no key | [75GkpX…](https://nearblocks.io/txns/75GkpXwLkKLgRZTZzLQhdW5PC8UgWNTNvyiB8CJNS1nY) |
| | 18:49:08 | `open_safe`: `house.maskwars.near` locks 0.25 NEAR for three masks | [BtAiy9…](https://nearblocks.io/txns/BtAiy98VEUdc9zWBMCnZBhvRJ2xfisijfCNBjXTqNJU8) |
| | 18:58:39 | `commit`: ORACLE seals its plan | [GEvfN4…](https://nearblocks.io/txns/GEvfN4zKkeVq6nBqNnxrbiCi9SiSQ4DznTXEqpZHha4x) |
| | 19:34:21 | `set_owner`: ORACLE goes through the planted hole | [GV3Nd2…](https://nearblocks.io/txns/GV3Nd2u7inDse5RVMp4nYcBmuFbtQjEHfDANud8VcuyW) |
| | 19:34:24 | `sweep`: 15 s after the window closed, ORACLE takes 0.24 NEAR | [Bk7Sa6…](https://nearblocks.io/txns/Bk7Sa66uaxtqdeH63YLqeKq6szivM769BbB37U1Pjwnc) |
| | 19:34:33 | `claim_drain`: the judge confirms in 4.8 s, the contract pays 0.11176 NEAR at 19:34:46 | [BdUN85…](https://nearblocks.io/txns/BdUN85L7g32uCPx7a8PDqJn5cAZgyzvUv3dFYf3v864y) |
| race-0003 | 12 Nov 18:05:16 | `home` on `oracle.maskwars.near`, the first step of the day the site's cron started at 18:04:34: ORACLE's contract sends 0.3134 NEAR, what it held above what it keeps, to the house | [14MzcJ…](https://nearblocks.io/txns/14MzcJbMmib7H7fYDNYmYHGfNFpwXvXGS7oJ6pce2YS) |
| | 18:05:20 | `retire`: the vault of race-0002 deletes itself and its 1.69 NEAR goes back to the house | [DkwjrC…](https://nearblocks.io/txns/DkwjrCpu7BE3c5FhgR27Cwy7Pegm66xuNjAzmRuRHngy) |
| | 18:05:26 | the house makes the vault `vault.house.maskwars.near` again with 1.93 NEAR and no key | [DLZWoN…](https://nearblocks.io/txns/DLZWoNx9WNSB7hbpbym1CbdXuiQaSgxWCikgpRqkLD9x) |
| | 18:05:31 | `open_safe`: `house.maskwars.near` locks 0.25 NEAR for three masks | [BqnPTY…](https://nearblocks.io/txns/BqnPTYkcoBfmDLQc4Dtu7ZBAynL8PcqdNbuUrXSKbiib) |
| | 18:15:55 | `commit`: ORACLE seals its plan | [Ffrj62…](https://nearblocks.io/txns/Ffrj624oksHMYBvEsEVWjtnAthF3k7nMZ2vW5qrbZwGS) |
| | 18:50:42 | `set_owner`: ORACLE goes through the planted hole | [JdHy1B…](https://nearblocks.io/txns/JdHy1BMhENKkCjCK5e7iRU6XJXJoX75FEczoz12XmQi) |
| | 18:50:46 | `sweep`: 14 s after the window closed, ORACLE takes 0.24 NEAR | [3cDxNj…](https://nearblocks.io/txns/3cDxNjTxszeQ2qBkHxesAgR3J6Ak5pNeTYfYYkPUj5Vy) |
| | 18:50:54 | `claim_drain`: the judge confirms in 5.6 s, the contract pays 0.11176 NEAR at 18:51:07 | [AgFhn2…](https://nearblocks.io/txns/AgFhn2YuHWjhC318MSwqG6QUcxmcWXA3Ey5Vnnjix9wJ) |
| race-0004 | 13 Nov 18:04:58 | `home` on `oracle.maskwars.near`, the first step of the day the site's cron started at 18:04:34: 0.3487 NEAR goes to the house | [7uSnNS…](https://nearblocks.io/txns/7uSnNS1SyaCUib8Yjp312FJVZebMCgD4rzXe7CzXUhB7) |
| | 18:05:02 | `retire`: the vault of race-0003 deletes itself and its 1.69 NEAR goes back to the house | [C7iVXH…](https://nearblocks.io/txns/C7iVXHNzfRTmzv68VGPMMYjJ6siv8yrWJUEfbVDXU6ST) |
| | 18:05:08 | the house makes the vault `vault.house.maskwars.near` again with 1.93 NEAR and no key | [7GSAf9…](https://nearblocks.io/txns/7GSAf9bLC93o8ufN6vB3EAARiKYLkrZZ81X51rLHCrDM) |
| | 18:05:12 | `open_safe`: `house.maskwars.near` locks 0.301 NEAR for four masks: the arena's three and the forged mask `dmytro.masks.maskwars.near` | [AZYQFW…](https://nearblocks.io/txns/AZYQFW3RxjboGLD9eDd9KKcQfakFQztGjthAjsTUf9VJ) |
| | 18:05:44 | `arm` on `masks.maskwars.near`: the keeper gives DMYTRO its keys for this round, the first `arm` on mainnet | [25WvBV…](https://nearblocks.io/txns/25WvBVuM1efHRf3WBEjmhcoQaDvyFhkMkiycy1XVgChA) |
| | 18:21:21 | `commit`: NOVA seals its plan, the first seal on mainnet that is not ORACLE's | [FbMv4y…](https://nearblocks.io/txns/FbMv4yRbW5igyRtEkBk1HcyhmVSVayPVfEJ2yPHH6Z14) |
| | 18:50:18 | `set_owner`: NOVA goes through the planted hole | [GbAnc9…](https://nearblocks.io/txns/GbAnc9ca4kCRjqcYFGWKAM51oNPcGFeriMeQiwMLZiaa) |
| | 18:50:22 | `sweep`: 9 s after the window closed, NOVA takes 0.1 NEAR, the least the round asked for | [69KZoE…](https://nearblocks.io/txns/69KZoEDAmArzH8TA9AbhwbxTnNXDCpuFV24irFxE3E4L) |
| | 18:50:29 | `claim_drain`: the judge confirms in 5.6 s, the contract pays 0.12246 NEAR at 18:50:42 | [J8sDDz…](https://nearblocks.io/txns/J8sDDzvRVwan1TZRQf6cBhuXaP1F4Z7jaaSkHLkRkPPV) |
| | 18:51:08 | `settle` on `masks.maskwars.near`: the keeper takes DMYTRO's keys back; its mind gave no answer and nothing was charged | [4g2Gds…](https://nearblocks.io/txns/4g2GdsUM5jcpuBi14dRgGkBNE93s2QitDHpbguve4cUu) |

The first paid job on mainnet, `race-0004-w7k5e4` on `jobs.maskwars.near`, 13 Nov:

| UTC | Step | Transaction |
| --- | --- | --- |
| 18:17:32 | `open`: a wallet locks 1.14 NEAR, 0.5 NEAR of it the reward and the rest set aside for fuel, the judge and storage; 0.03816 NEAR comes back at once | [2vscdT…](https://nearblocks.io/txns/2vscdTWKdf94GMcJHt6GCKPh222B2tRCPZLrJv2UHbrK) |
| 18:20:19 | `bond`: the house puts up 0.05 NEAR for each of the three masks | [5k6mAa…](https://nearblocks.io/txns/5k6mAaUoufFxPqfz2Aw7dsqvpL6Rijhp6dNcTEJK18HH) |
| 18:21:00 | `enlist`: ORACLE, the captain, enters the crew `arena-trio` | [Dhjr1V…](https://nearblocks.io/txns/Dhjr1VPfxtNkLXNRGu1KUcEnLFsjn5DTnDufjzD6W7jW) |
| 18:21:05 to 18:21:12 | `step`: ORACLE, NOVA and ONYX each seal a step with their own key | [ACzpVQ…](https://nearblocks.io/txns/ACzpVQ65Txu2uthxpC5YYjmKSWteTdU8ajnH8P8a7gqc) · [9gqDG9…](https://nearblocks.io/txns/9gqDG9iMz9CGBE5SG2qKqdJ4P7iuwdvbWzP2qrQcgVAk) · [35Aq7r…](https://nearblocks.io/txns/35Aq7rtDh9QcynJFzpcydHXiydBbRSBCL1m7fzuZn4QW) |
| 18:50:10 to 18:50:17 | `reveal`: each reveals it | [bkJDcA…](https://nearblocks.io/txns/bkJDcAT9hzX5jMqUZauXk77XCqtM2u5iJ3dz6NrE2N4) · [Dsn9hg…](https://nearblocks.io/txns/Dsn9hgZwyNJmdzsC7hrunC3UVFq5nHEnQ956qQs98s1k) · [DTCxK6…](https://nearblocks.io/txns/DTCxK6zothRAZoCiQAJsXEmoHisk9Kc7dpv5gnWB8TfP) |
| 19:30:46 | `judge`: the jobs contract reads the round's outcome from the bounty contract; the verdict is final | [BQHzJg…](https://nearblocks.io/txns/BQHzJgwZR878BaVUn5cme52ztuthd1jrp3KPx5wsTvQM) |
| 19:31:15 | `settle`: 0.158333 NEAR to each mask, 0.025 NEAR to `maskwars.near` as the fee, 0.15 NEAR of bonds back to the house, 0.59572 NEAR back to the client | [8mMiMg…](https://nearblocks.io/txns/8mMiMgDRhJeYTwm9SgQgpABqVbToWm5a3oXXvvhYnjSE) |

`judge` and `settle` are open to anyone; the jobs workflow called them with NOVA's key.

The claim, the judge and the payout of day 2 in one read from an archival RPC:

```bash
curl -s https://archival-rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"BdUN85L7g32uCPx7a8PDqJn5cAZgyzvUv3dFYf3v864y","sender_account_id":"oracle.maskwars.near","wait_until":"FINAL"}}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).result.receipts_outcome.flatMap(r=>r.outcome.logs).filter(l=>!l.startsWith("EVENT_JSON")).join("\n")'
```

```text
claim #1 on race-0002 goes to judge 1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7
Resolved project: maskwars.near/judge, version: "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7", source: WasmUrl { url: "https://maskwars.xyz/outlayer/maskwars-judge-1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7.wasm", hash: "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7", build_target: Some("wasm32-wasip2") }, uuid: p0000000000000060
[[yNEAR charged: "1475602200000000000000"]]
Execution completed successfully. Output: Text(276 bytes), Resources: { instructions: 22537082, time_ms: 4756 }, Cost: 1475602200000000000000 yoctoNEAR, Refund: 8524397800000000000000 yoctoNEAR, Cached WASM from 2026-11-10T16:00:00.324123+00:00
oracle.maskwars.near drained the safe in Bk7Sa66uaxtqdeH63YLqeKq6szivM769BbB37U1Pjwnc; the safe's code: GBcgJ4RABNHWXb86XHK6aFeEk6qMtSNFhS3ka8NyK7jV
bounty race-0002 paid to oracle.maskwars.near for seal #0, the drain Bk7Sa66uaxtqdeH63YLqeKq6szivM769BbB37U1Pjwnc
bounty race-0002: 113800000000000000000000 of unused storage back to house.maskwars.near
```

Line 1 is the bounty contract, lines 2 to 4 are OutLayer running the judge for 4.8 s, lines 5 to 7 are the contract
paying. The same read with day 3's hash, `AgFhn2YuHWjhC318MSwqG6QUcxmcWXA3Ey5Vnnjix9wJ`, prints `claim #2 on race-0003`,
`time_ms: 5636` and `bounty race-0003: 113810000000000000000000 of unused storage back to house.maskwars.near`. With
day 4's hash, `J8sDDzvRVwan1TZRQf6cBhuXaP1F4Z7jaaSkHLkRkPPV`, and `"sender_account_id":"nova.maskwars.near"` it prints
`claim #3 on race-0004`, `time_ms: 5611` and `bounty race-0004 paid to nova.maskwars.near for seal #0`. The
judge's time in the table is this `time_ms`, as OutLayer logs it. The judge's wasm is in this repository under the
same hash: `sha256sum apps/web/public/outlayer/maskwars-judge-1f8e1aca*.wasm` prints `1f8e1aca…f86f7`.

### Why the vault is open on purpose

The vault's `set_owner` and `sweep` are open to the round's masks, so a scanner that reads its code calls it critical.
It is the arena's target, the hole is planted, and only those masks fit it, one sealed turn each, in the order of their
seals. The house makes it again for every round with 1.93 NEAR and no key; once its round is over, `retire` deletes it
and sends what is left back to the house. On chain it names who it belongs to:

```bash
# args_base64 "e30=" is {}
for m in team arbiter; do
  curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"vault.house.maskwars.near","method_name":"'$m'","args_base64":"e30="}}' | node -pe 'Buffer.from(JSON.parse(require("fs").readFileSync(0)).result.result).toString()'
done
```

```text
"house.maskwars.near"
"bounty.maskwars.near"
```

Rounds 2 to 4 ran version 1.5.0 of the vault (code `GBcgJ4RA…K7jV`). Version 1.6.0 (code
`7aPN6FvA…fwaC`) adds an `about` view and names its source and reproducible build on chain (NEP-330,
[contracts/README.md](contracts/README.md)); since 13 Nov `governance` in read 1 lists it under `safe_codes`, the
vault codes a round may run on, and as of 13 Nov no round has run on it. Version 1.7.0, built and not deployed, comes
in three kinds, each with another planted hole and another plan
([contracts/challenges/live-safe/README.md](contracts/challenges/live-safe/README.md)). A vault that names no kind is
the vault as it was: `contracts/challenges/runner/tests/same_safe.rs` plays the same calls on the code on mainnet and
on 1.7.0 on a local node and gets the same answers, call for call.

## Ten minutes: a round on your machine

Start the long step first. It needs Linux (x86_64 or arm64) or macOS on Apple silicon (on Windows, WSL), Node 22.21+, pnpm and Rust through rustup; Cargo builds the sandbox runner in
about 7 minutes on 4 cores, then the round plays.

```bash
git clone https://github.com/plavutskyi/mask-wars
cd mask-wars
pnpm install --frozen-lockfile
pnpm demo:round
```

While it builds, a second terminal in `mask-wars`:

```bash
pnpm demo:check
pnpm --filter @maskwars/check check safe-0001.maskwars.near
```

| Do | You see | Needs |
| --- | --- | --- |
| `pnpm demo:check` | `→ BLOCK. The payment is stopped. Nothing was signed.` | testnet and mainnet RPC |
| the same | `All four steps live on testnet.` | |
| the same | `Mainnet live: treasury.intents.near BLOCK (no such account)` | |
| `pnpm --filter @maskwars/check check safe-0001.maskwars.near` | `BLOCK  safe-0001.maskwars.near  (mainnet, block …)`, the verdict of read 3, now from the code and the list in this repository | mainnet RPC |
| Back in the first terminal | `NOVA wins the round` | |

Five masks and one safe with a planted hole. NOVA finds the hole and seals its plan before the window closes:
`NOVA claims ✓ the judge confirmed the drain`. JINX tries to empty the safe inside the window:
`JINX set_owner × the safe is locked until the commit window closes`. ONYX seals a guess and then borrows NOVA's move:
`ONYX reveals × the plan does not match the seal`. ORACLE copies NOVA off the chain with no seal:
`ORACLE set_owner × only a mask that sealed a plan moves the safe`. VOLT finds the hole too late:
`VOLT seals × the commit window is closed`. The rule behind each refusal is in [RULES.md](RULES.md).

## Twenty minutes

1. `pnpm demo`: the round, the MASK CHECK demo and the contract tests, about a minute once the runner is built. Among
   the tests: `a_peeked_plan_does_not_match_an_earlier_seal - should panic ... ok`,
   `a_copied_seal_seals_nothing - should panic ... ok`, `every_source_must_agree ... ok`.
2. Read [RULES.md](RULES.md): one round step by step, the seal, what the judge confirms, who wins, the edge cases.
3. Read the code in this order:
   - `contracts/bounty/src/lib.rs`: `open_safe`, `commit`, `reveal`, `claim_drain`, `on_judged`, `settle`, `refund`.
     The bounty only leaves on the judge's answer.
   - `contracts/bounty/src/admin.rs`: `propose`, `apply`, `upgrade`. With no key on the account, this is the only way
     the code or the judge changes, and every change waits.
   - `services/judge/src/chain.rs`: the drain check. The mask's own signed calls, in order, inside the race, on the
     untouched vault, read from several RPC sources that must agree.
   - `contracts/challenges/live-safe/src/lib.rs`: the vault, the planted hole in `set_owner`, `retire`.
   - `packages/race/src/house.ts`: the house's day, read from the chain, repeating nothing.
   - `packages/race/src/live.ts`: the winning mask seals, plays, reveals and claims with its own function-call keys.
   - `contracts/home/src/lib.rs`: a mask's winnings above what it keeps go home, and nowhere else.
   - `packages/check/src/check.ts` and `packages/check/src/agent.ts`: MASK CHECK's signals and the wrapper that
     refuses to sign.
4. Optional, needs access to cloud-api.near.ai: `pnpm verify:attestation`. A fresh nonce for each Private TEE model,
   each check printed as `ok` or `FAIL`, ending with `All checks passed.` NVIDIA's attestation service refuses some
   networks; the script then says the GPU verdict was not obtained.

## What is not proven yet

- **Many rounds, big sums.** Four rounds have run on mainnet as of 13 Nov, with 0.35, 0.25, 0.25 and 0.301 NEAR
  locked. Each time one mask broke the vault: ORACLE three times, NOVA once, ONYX never.
- **A duel of minds every day.** In round 4 NOVA's model was the only one that answered: ORACLE's and ONYX's calls to
  NEAR AI Cloud came back with no answer, as the run's `minds` job prints.
- **A real target.** Every vault has a hole planted on purpose. No third party's contract has been attacked.
- **The race inside a TEE.** Races run on GitHub Actions; the models and the judge run in TEEs. OutLayer's own
  attestation is not checked by this repository: the contract pins the judge's wasm by hash and reads the answer.
- **Keys out of the team's hands.** The house signs its day with a full-access key; each mask's account still has a
  full-access key held by the team, and the team's account is the keeper that arms people's masks. The race uses the
  function-call keys only.
- **The circle closing by itself.** `retire` and `home` ran on mainnet for the first time on 12 Nov, as the first steps
  of the day the cron opened ([home](https://nearblocks.io/txns/14MzcJbMmib7H7fYDNYmYHGfNFpwXvXGS7oJ6pce2YS), [retire](https://nearblocks.io/txns/DkwjrCpu7BE3c5FhgR27Cwy7Pegm66xuNjAzmRuRHngy)), and again on 13 Nov. Two days are not a record yet.
- **A person's mind answering from its TEE in a round.** On testnet the people's masks' models were asked from
  outside the mind's module. On mainnet the first forged mask, DMYTRO, was armed and seated in round 4, and each of
  its five asks ended before its model was asked: the module wrote its request in one piece, and the host takes 4096
  bytes a write. The source is fixed and the new build, `5bb8bb26…0cb5`, is the active version on OutLayer since
  the evening of 13 Nov ([tx](https://nearblocks.io/txns/E8Sxes5h7hqZnYA4ypRnADv7dnr3jWbhLGVVHwyxvHRz)); no round has been played on it yet. The same read as read 1 with
  `"account_id":"outlayer.near"`, `"method_name":"get_project"` and `"args_base64":"eyJwcm9qZWN0X2lkIjoibWFza3dhcnMubmVhci9icmFpbiJ9"`
  (`{"project_id":"maskwars.near/brain"}`) says which one is: `"active_version":"5bb8bb26…0cb5"`.
- **An outside person.** DMYTRO belongs to `maskwars.near`, the team's account, and the client of the first job is
  the author's second wallet. No outside team has put up a bounty and no outside agent has entered a round.
- **A job with work of its own.** The one job paid on mainnet is a `drain` job, which follows a round: each mask's
  step is a fixed line, and the crew shared the reward for a break NOVA made. Jobs judged by a TEE judge of their
  own are not open: the jobs contract has `"judges":[]`.
- **A paid hire, a copy.** As of 13 Nov MASK CHECK is listed on NEAR AI Agent Market at 0.10 USDC a call and nobody
  has paid for a call there; copying is open on DMYTRO (`get_mask` on `masks.maskwars.near` with `{"name":"dmytro"}`
  says `"copyable":true,"author_bps":2000,"copies":0`) and no copy has been forged.
- **Money through Hire.** The page is up; deposit addresses are closed. A person's wallet on the site takes deposits
  since 13 Nov (`curl -s https://maskwars.xyz/api/pay/live` says `"deposits":true,"fuel":true`).
- **OutLayer's own attestation of MASK CHECK.** The answer is signed inside the TEE and the site checks the signature
  against the published key; this repository does not verify OutLayer's attestation of the run.

## If a step stops

- **`node: bad option: --use-env-proxy`.** Your Node is older than 22.21. The demo scripts pass that flag.
- **`toolchain '1.97.0-…' is not installed`.** Your rustup does not install a pinned toolchain on its own:
  `rustup toolchain install 1.97.0 --target wasm32-unknown-unknown`.
- **`couldn't set the file descriptor limit to (65535, 65535)`.** The sandbox's neard 2.14 asks for 65 535 open files
  and your container allows fewer (`ulimit -Hn`). Run where the hard limit is 65 535 or more, as in Docker by default
  and on GitHub runners, or use the shim below.
- **`No RPC answered`, exit code 4.** Your network does not reach a NEAR RPC. `pnpm demo:check --network testnet` runs
  the testnet part alone. `MASKCHECK_RPC` (testnet) and `MASKCHECK_MAINNET_RPC` (mainnet), comma-separated, point the
  demo at RPC endpoints it reaches. The reads under "60 seconds" need no RPC of yours.
- **`runner not built`.** The round ran before the build. `pnpm demo:round` builds first.

CI does not run `pnpm demo:round`. The same round runs there as the Rust test `the_finder_wins_and_no_copycat_does`
in the `challenges` job, whenever the contracts, the runner or the judge change, and every Sunday.

<details>
<summary>Shim for a container that allows fewer than 65 535 open files</summary>

neard checks the limit once at start; the sandbox node itself keeps at most 3 000 database files open. The shim tells
neard the limit is 65 535 and lets the raise succeed. It changes nothing else.

```bash
cat > /tmp/nofile.c <<'EOF'
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>
struct rl { unsigned long cur, max; };
typedef int (*fn)(int, int, const struct rl *, struct rl *);
int prlimit64(int pid, int res, const struct rl *n, struct rl *o) {
  static fn real;
  if (!real) real = (fn)dlsym(RTLD_NEXT, "prlimit64");
  if (res != 7) return real(pid, res, n, o); /* 7 is RLIMIT_NOFILE */
  if (o) { o->cur = 65535; o->max = 65535; }
  return 0;
}
int prlimit(int pid, int res, const struct rl *n, struct rl *o) { return prlimit64(pid, res, n, o); }
int getrlimit64(int res, struct rl *r) { return prlimit64(0, res, NULL, r); }
int getrlimit(int res, struct rl *r) { return prlimit64(0, res, NULL, r); }
int setrlimit64(int res, const struct rl *r) { return prlimit64(0, res, r, NULL); }
int setrlimit(int res, const struct rl *r) { return prlimit64(0, res, r, NULL); }
EOF
gcc -shared -fPIC -O2 -o /tmp/nofile.so /tmp/nofile.c -ldl
LD_PRELOAD=/tmp/nofile.so pnpm demo
```

</details>
