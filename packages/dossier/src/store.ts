// Where written pages live: one file per account and set of facts, the attestation inside it. A page read back from a
// store passes the same gate again before it is shown, so a store can lose a page but never slip one in.

import { z } from "zod";
import { type VerifyOptions, verifyWritten } from "./write.ts";
import type { WrittenPage } from "./types.ts";

export interface PageStore {
  get(account: string, evidenceHash: string): Promise<WrittenPage | null>;
  put(page: WrittenPage): Promise<void>;
}

/** `dossier/mainnet/safe-0001.maskwars.near/<sha256>.json` */
export function pagePath(network: string, account: string, evidenceHash: string): string {
  return `dossier/${network}/${account}/${evidenceHash}.json`;
}

const claim = z.object({ text: z.string(), refs: z.array(z.string()) });
const shape = z.object({
  version: z.literal(1),
  account: z.string(),
  network: z.enum(["testnet", "mainnet"]),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  evidence: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      fact: z.string(),
      data: z.record(z.string(), z.unknown()),
      numbers: z.array(z.string()),
      names: z.array(z.string()),
      at: z.number().nullable(),
      tx: z.string().nullable(),
      href: z.string().nullable(),
      race: z.string().nullable(),
    }),
  ),
  page: z.object({ lede: claim, sections: z.array(z.object({ id: z.enum(["record", "money", "code"]), claims: z.array(claim) })) }),
  model: z.string(),
  provider: z.string(),
  writtenAt: z.string(),
  attestation: z.object({
    request: z.string().nullable(),
    requestHash: z.string(),
    response: z.string().nullable(),
    responseHash: z.string(),
    signature: z
      .object({ text: z.string(), signature: z.string(), signingAddress: z.string(), signingAlgo: z.string(), kind: z.enum(["provider_tee", "gateway"]) })
      .nullable(),
    signatureVerified: z.boolean(),
    tee: z
      .object({ model: z.string(), outcome: z.enum(["pass", "fail", "unavailable"]), checkedAt: z.string(), nonce: z.string(), signers: z.array(z.string()) })
      .nullable(),
  }),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), costUsd: z.number() }),
});

/**
 * A stored page, only if it is whole and still passes every check, signature included. Pass the live facts' hash in
 * `expect`: the stored facts must then be the live facts exactly, links and numbers included.
 */
export function readWritten(json: unknown, expect?: { account: string; evidenceHash: string }, o: VerifyOptions = {}): WrittenPage | null {
  const parsed = shape.safeParse(json);
  if (!parsed.success) return null;
  const page = parsed.data as unknown as WrittenPage;
  if (expect && (page.account !== expect.account || page.evidenceHash !== expect.evidenceHash)) return null;
  return verifyWritten(page, o).ok ? page : null;
}

/** Pages in memory: one server's pages, until it restarts. */
export class MemoryStore implements PageStore {
  readonly #pages = new Map<string, WrittenPage>();
  readonly #max: number;

  constructor(max = 500) {
    this.#max = max;
  }

  async get(account: string, evidenceHash: string): Promise<WrittenPage | null> {
    return this.#pages.get(`${account}/${evidenceHash}`) ?? null;
  }

  async put(page: WrittenPage): Promise<void> {
    if (this.#pages.size >= this.#max) this.#pages.delete(this.#pages.keys().next().value as string);
    this.#pages.set(`${page.account}/${page.evidenceHash}`, page);
  }
}
