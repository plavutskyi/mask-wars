// Types for season-keys.mjs, which the race's tests import to check both derive the same keys.
export function base58(bytes: Uint8Array): string;
export function racePublicKey(seedHex: string, receiver: string): string;
export function safeAccount(season: string, n: number): string;
