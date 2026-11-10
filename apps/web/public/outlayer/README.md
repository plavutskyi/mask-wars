# OutLayer modules

The wasm modules MASK WARS runs inside a TEE on OutLayer. A file's name is the SHA-256 of its bytes, and OutLayer
refuses a file whose bytes do not match the name. The site serves them at `https://maskwars.xyz/outlayer/<file>`.

The judge and the brain are built from this repository by their `build.sh`, which gives the same bytes in any folder
on any machine, so anyone can rebuild them and compare the SHA-256.

| Module | SHA-256 | Source | What it does |
| --- | --- | --- | --- |
| Judge v6 | `1f8e1aca…86f7` | `services/judge` | The current judge, one for testnet and mainnet. Reads a drain from the chain and checks the revealed plan of a sealed round; on mainnet it reads through three RPC operators |
| Brain, mainnet build | `65540964…a4fd` | `services/brain`, `build.sh --mainnet` | The mind of a forged mask on mainnet |
| Brain | `f3d6787d…1282` | `services/brain` | The mind of a forged mask on testnet, an earlier build |
| Judge v5 | `b3818697…ab83` | `services/judge` | Earlier judge: the bounty contract that holds no key |
| Judge v4 | `5048c290…08b0` | `services/judge` | Earlier judge: sealed rounds |
| Judge v3 | `f6cf7728…434d` | `services/judge` | Earlier judge: reads a drain from the chain. Paid `race-0003` on testnet |
| Vault | `876eee0f…558b` | `services/vault` | Seals a finding so that only the team whose code was broken reads it |

The two remaining judge files (`018b7143…`, `48850037…`) are the first versions of the judge.
