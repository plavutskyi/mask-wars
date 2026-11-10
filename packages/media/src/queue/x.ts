/**
 * The X port. This package never posts for real: the only implementations are `off` (the default) and an in-memory
 * fake for tests and rehearsals. Which one runs is the flag `MEDIA_X` (`off` | `fake`).
 */

export type XPostInput = { text: string; replyTo?: string; media?: string | null };

export interface XClient {
  /** False when posting is switched off: the queue then leaves every draft where it is. */
  readonly enabled: boolean;
  post(p: XPostInput): Promise<{ id: string }>;
}

export class XOffError extends Error {
  constructor() {
    super("X posting is off (MEDIA_X=off)");
  }
}

export const offXClient: XClient = {
  enabled: false,
  async post() {
    throw new XOffError();
  },
};

/** Keeps what would have gone out; can be told to fail the next calls. */
export class FakeXClient implements XClient {
  readonly enabled = true;
  readonly sent: (XPostInput & { id: string })[] = [];
  failNext = 0;
  private n = 0;

  async post(p: XPostInput): Promise<{ id: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("fake X: 503");
    }
    const id = String(1_900_000_000_000_000_000n + BigInt(++this.n));
    this.sent.push({ ...p, id });
    return { id };
  }
}

export type XMode = "off" | "fake";

export function xClientFromEnv(env: Record<string, string | undefined> = process.env): XClient {
  const mode = (env.MEDIA_X ?? "off").trim().toLowerCase();
  if (mode === "off" || mode === "") return offXClient;
  if (mode === "fake") return new FakeXClient();
  throw new Error(`MEDIA_X=${mode}: this build posts nowhere; use off or fake`);
}
