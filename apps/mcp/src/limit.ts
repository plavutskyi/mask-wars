// Limits per caller, kept in the memory of one server instance. They do not replace a shared store, but they stop one
// caller from turning a public endpoint into a flood of RPC calls on the instance it lands on.

export interface Limiter {
  /** `null` when the call may go ahead, otherwise how many seconds until the caller's window opens again. */
  take(key: string, now?: number): number | null;
  /** Calls one caller may make per window, to tell a caller who hit the limit. */
  readonly perCaller?: number;
}

/** A fixed window: `perWindow` calls per `windowMs` for each key, at most `maxKeys` keys remembered. */
export function createLimiter({ perWindow, windowMs, maxKeys = 10_000 }: { perWindow: number; windowMs: number; maxKeys?: number }): Limiter {
  const windows = new Map<string, { start: number; used: number }>();
  return {
    take(key, now = Date.now()) {
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        if (!w && windows.size >= maxKeys) {
          for (const [k, old] of windows) if (now - old.start >= windowMs) windows.delete(k);
          if (windows.size >= maxKeys) windows.delete(windows.keys().next().value as string);
        }
        w = { start: now, used: 0 };
        windows.set(key, w);
      }
      if (w.used >= perWindow) return Math.max(1, Math.ceil((w.start + windowMs - now) / 1000));
      w.used += 1;
      return null;
    },
  };
}

/** One budget for a caller and one for the whole instance; the caller's is spent first. */
export interface Budget {
  perCaller: number;
  perInstance: number;
  windowMs: number;
}

export function createBudget({ perCaller, perInstance, windowMs }: Budget): Limiter {
  const caller = createLimiter({ perWindow: perCaller, windowMs });
  const instance = createLimiter({ perWindow: perInstance, windowMs });
  return { take: (key, now) => caller.take(key, now) ?? instance.take("all", now), perCaller };
}

/** The caller's address as Vercel reports it. Callers without one share a single window. */
export function callerOf(req: Request | undefined): string {
  if (!req) return "local";
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
