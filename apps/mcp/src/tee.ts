// The paid MASK CHECK: the same check run inside a TEE on OutLayer, its answer signed there (services/check). Where it
// is published is a file of that module; `check_account` hands an agent the call it would make, as data.
import type { Network } from "@maskwars/check";
import { z } from "zod";
import published from "../../../services/check/deployment.json" with { type: "json" };

/** services/check/deployment.json. */
export interface TeeDeployment {
  /** Which OutLayer the project is published on: `testnet` or `mainnet`. */
  outlayer: string;
  /** OutLayer's HTTPS API the project is published on. */
  api: string;
  /** `owner/name` of the project. */
  project: string;
  /** What a signed verdict costs, in millionths of a dollar: the value of `X-Attached-Deposit`. */
  price_usd_micro: number;
  /** The sha256 of the module OutLayer runs; `null` until a version is published. */
  wasm_sha256: string | null;
  /** What that version states in every message it signs, as `module.rules`; `null` until a version is published. */
  rules: string | null;
  /** The ed25519 key the module signs with; `null` until a version is published. */
  key: string | null;
}

export const TEE_DEPLOYMENT: TeeDeployment = published;

/** What `check_account` adds to its answer once the module is published. */
export const TeeCheckView = z.object({
  url: z.string().describe("POST this check here with an OutLayer payment key in X-Payment-Key: it runs inside a TEE and the answer is signed there"),
  input: z.object({ account: z.string(), network: z.enum(["testnet", "mainnet"]) }).describe('The body is {"input": <this>, "version_key": <version_key>}'),
  version_key: z.string().describe("Goes in the body next to input: OutLayer then runs exactly this build of the module, not whichever is active"),
  header: z.string().describe("Buys the signed answer with every reason; without it the call returns the verdict alone"),
  price_usd: z.string(),
  outlayer: z.enum(["testnet", "mainnet"]).describe("Which OutLayer runs it"),
  paid_in: z.string().describe("What the price is paid in. On OutLayer testnet a payment key holds test stablecoins: no real money moves"),
  key: z.string().describe("The ed25519 key the answer is signed with. Check the signature against this key, never against the key an answer names"),
  rules: z.string().describe("What the signed message names as module.rules: the rules this build checks by"),
  wasm_sha256: z.string().describe("The module OutLayer runs and attests, by its sha256"),
});
export type TeeCheckView = z.infer<typeof TeeCheckView>;

/** Millionths of a dollar as dollars: 10000 is "0.01". */
export function usd(micro: number): string {
  const frac = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  const whole = Math.floor(micro / 1_000_000);
  return frac ? `${whole}.${frac}` : String(whole);
}

/** The call that gets `account` checked in the TEE, or `null` while no version is published. */
export function teeCheckOf(d: TeeDeployment, account: string, network: Network): TeeCheckView | null {
  if (!d.key || !d.wasm_sha256 || !d.rules) return null;
  const mainnet = d.outlayer === "mainnet";
  return {
    url: `${d.api.replace(/\/$/, "")}/call/${d.project}`,
    input: { account, network },
    version_key: d.wasm_sha256,
    header: `X-Attached-Deposit: ${d.price_usd_micro}`,
    price_usd: usd(d.price_usd_micro),
    outlayer: mainnet ? "mainnet" : "testnet",
    paid_in: mainnet ? "stablecoins on OutLayer mainnet" : "test stablecoins on OutLayer testnet: no real money moves",
    key: d.key,
    rules: d.rules,
    wasm_sha256: d.wasm_sha256,
  };
}
