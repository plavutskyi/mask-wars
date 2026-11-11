// Types for home-deploy.mjs, which the race's tests import to check the deploy of home on the masks.
export function codeHashHex(codeHash: string): string;
export function homeDeploy(
  repo: string,
  networkId?: "mainnet" | "testnet",
): { wasm: string; bytes: number; sha256: string; code: string; house: string; keep: string; stake: string; commands: string[] };
