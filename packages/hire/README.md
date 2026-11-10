# @maskwars/hire

"Hire the swarm": a button any NEAR app can embed so that a team funds its own vault for a job for MASK WARS masks. The
team describes the job, proves the vault is its own, and pays from any wallet and network through NEAR Intents. The
money logic is `@maskwars/pay` (imported, not copied); this package adds the job, the proof of vault ownership, the
quote check, the checkout messages and the element itself.

```html
<script src="https://maskwars.xyz/hire/v1.<hash>.js" integrity="sha384-…" crossorigin="anonymous" async></script>
<mask-wars-hire job="Attack my contract before launch" target="vault.acme.near" usd="250"></mask-wars-hire>
```

`maskwars.xyz/hire` gives the exact line with the current `<hash>` and `integrity` (the Copy button). `/hire/v1.js` is
the same script without pinning: always the newest.

## How it works

| What | How |
| --- | --- |
| Button | `<mask-wars-hire>` (`src/element.ts`): its own shadow root, a word and an amount; attributes `job`, `target`, `team`, `usd` or `near`, `chain`, `label`, `origin`. Parts `button`, `label`, `amount` for host styling. All internal state is private (`#`), so React props cannot overwrite it |
| Script | `pnpm --filter @maskwars/hire build` writes `apps/web/public/hire/v1.js`, the immutable `v1.<10 hex sha256>.js` and `apps/web/app/hire/release.json` with `integrity` (sha384). Older pinned files stay, so a host that pinned an earlier one keeps working. `v1.js` is cached for 5 minutes, `v1.<hash>.js` forever (`immutable`). A test catches any mismatch |
| Checkout origin | `origin` is accepted only as maskwars.xyz, the host page itself, or a local server on a local page (`checkoutOrigin`); otherwise it is the site the script came from, or maskwars.xyz |
| Checkout | a click opens a sheet over the page with a frame of `maskwars.xyz/hire/embed`; money is calculated only there. Outside a frame the checkout does not render: a browser that sends a `Sec-Fetch-Dest` other than `iframe` gets a 307 to `/hire`, and a page with no parent goes there itself. Job text that comes from the page is signed with its origin ("By northwind.example", as the browser named it, not a URL), and the recipient is shown in the line "Paid to …’s vault, not MASK WARS" |
| Vault proof | before any address is issued, the payer opens a `maskwars.xyz/hire/prove` window (a separate page with an address bar, not a frame) and signs one line about the job with the vault's key: a passkey, or a NEAR wallet that owns the account (`src/proof.ts`). Both paths sign the same 32 bytes: the NEP-413 hash of the line. The server checks the signature, the passkey's domain and origin, freshness (30 min), the page and the job, and for a named account it also checks on chain: a full-access key of the account, or a key NEAR Intents already knows for the vault. If the page named a `team`, only a proof of that exact vault is accepted |
| Job | text of 8–280 characters with no hidden characters; the contract is a NEAR account (mainnet or testnet); the vault is a NEAR mainnet account; the fingerprint is the sha256 of canonical JSON (`jobHash`) |
| Money | `hireRequest` is the vault top-up from `@maskwars/pay` (`topUpRequest`): 1Click `FLEX_INPUT`, a coin from a network → NEAR on the vault's account in NEAR Intents, refunds to the same account |
| Check | `checkHire` runs on the server before an address is issued and again in the checkout: everything from `checkQuote` (coins, recipient and refund are the vault, the minimum is within 1% and no lower than shown), the lower bound of the deposit is no higher than the shown amount, the amount to send is within 5% of the agreed dollars, the promised NEAR is no lower than 90%. The server also checks the fee (`feeHeld`) |
| Events | `hire:open`, `hire:deposit`, `hire:dropped`, `hire:progress`, `hire:funded`, `hire:refunded`, `hire:failed`, `hire:close` on the element. The checkout sends them only to the host's origin; the element accepts them only from its own frame and the checkout origin |
| React | `@maskwars/hire/react`: `<HireButton … onFunded={…} />` is the same element, with events as callbacks |

## Events are not proof of payment

`hire:*` events tell the page what the checkout saw, so that the page can update its own screen. Any script on the page
can call `dispatchEvent` on the element itself, so an event proves nothing.

**Verify on chain. Never grant access on an event.** Verification needs no keys:

- `hire:funded.detail.txs` holds NEAR transaction hashes: `https://nearblocks.io/txns/<hash>` or the RPC method `tx`;
- the vault balance in NEAR Intents: `intents.near`, view method `mt_balance_of({"account_id": "<team>", "token_id": "nep141:wrap.near"})`, before and after.

## Switches and fee

| Variable | What it does |
| --- | --- |
| `HIRE_LIVE=1` | opens address issuance for hire. Separate from `PAY_LIVE` (`/wallet`): either can be on without the other. Without it prices are live and `/api/hire/quote` answers `closed` |
| `HIRE_FEE_BPS`, `HIRE_FEE_ACCOUNT` | the site's share through 1Click `appFees`: 1–300 basis points to a NEAR Intents account. The default is 0: without both variables there is no fee. The checkout shows the fee in the details, and the server does not issue an address if 1Click returned a different one |
| `HIRE_FRAME_ANCESTORS` | narrows who can embed the checkout; without it, any https page can |

## Limits

Nothing goes to 1Click or RPC until a person touches the checkout in the frame (a trusted event that the host page
cannot fake). The preview price is requested only when the coin or the amount changes, and it is shared among everyone
for 10 s. Every fresh request to 1Click, every proof and every address spends the hourly budget of the page that
embedded the checkout and the shared budget of all pages (`BUDGET` in `apps/web/lib/hire.ts`). Job tickets are stored
in a private Vercel Blob under the deposit address (`hire/open/<deposit>.<closes>.<page>.json`), one per deposit, with
an hourly limit for all pages together and for each page separately; after the address closes, unpaid tickets are
deleted and paid ones move to `hire/funded/`.

## Current limitation

The jobs contract is not wired into hire, so hire money is the team's NEAR in its vault in NEAR Intents with the job's
note beside it (id, fingerprint and deposit in the site's private storage). The team can withdraw it at any time
through `/wallet`; the checkout says so. The receiver is set in one function, `hireRequest`, and `checkHire` reads that
receiver back from the quote.

## Checks

```sh
pnpm --filter @maskwars/hire test   # job, proof, request and check on recorded 1Click responses, the element in the DOM, the build
node apps/web/scripts/hire-shots.mjs # a third-party page, the proof window with a passkey, the full path to Funded; desktop 1440 and phone 375
```
