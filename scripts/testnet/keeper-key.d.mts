// Types for keeper-key.mjs, which the race's tests import to check it derives the keys the keeper signs with.
export function keeperPublicKey(seedHex: string, factory: string): string;
export function humanPublicKey(seedHex: string, mask: string, round: string, receiver: string): string;
