// NEAR account ids: 2 to 64 characters, lowercase parts split by `.`, `-` or `_` inside a part.
const NAMED = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function accountOk(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && NAMED.test(id);
}

/** An implicit account: a NEAR one (64 hex characters of a public key) or an Ethereum-style one (`0x` + 40 hex). */
export function isImplicit(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id);
}

/** A mainnet name such as `alice.near`. */
export function isMainnetName(id: string): boolean {
  return id.endsWith(".near");
}

/** A testnet name such as `alice.testnet`. There is no `testnet` account on mainnet, so none of these exist there. */
export function isTestnetName(id: string): boolean {
  return id === "testnet" || id.endsWith(".testnet");
}

/** `child` is a direct sub-account of `parent` (`vault.house.near` of `house.near`): only `parent` can make it. */
export function isSubAccountOf(child: string, parent: string): boolean {
  if (!child.endsWith(`.${parent}`)) return false;
  const name = child.slice(0, child.length - parent.length - 1);
  return name.length > 0 && !name.includes(".");
}
