// Live attestation of the models the masks think with. Every check makes a fresh nonce; a result is kept for a few
// minutes so page views never flood NEAR AI, Intel's PCCS or NVIDIA. Server only: it reaches those services directly.
import { allChecks, outcomeOf, verifyModel, type Check, type CheckId, type ModelVerification, type Outcome } from '@maskwars/mind/attestation';
import { ATTESTED_MODELS } from '@maskwars/mind/models';

export type { ModelVerification, Outcome };

/** The models every mask plays with: the ones a person's mask may pick, then the arena's own red-teaming build. */
export const MODELS: readonly string[] = ATTESTED_MODELS;

/** A passing check is shown for five minutes; anything else is tried again after thirty seconds. */
export const FRESH_MS = 5 * 60_000;
export const RETRY_MS = 30_000;

type Verify = (model: string) => Promise<ModelVerification>;

/** One check per model at a time; callers in the meantime share it. */
export function createVerifier({
  verify,
  now = Date.now,
  freshMs = FRESH_MS,
  retryMs = RETRY_MS,
}: {
  verify: Verify;
  now?: () => number;
  freshMs?: number;
  retryMs?: number;
}): Verify {
  const entries = new Map<string, { at: number; value: Promise<ModelVerification>; outcome?: Outcome }>();
  return (model) => {
    const t = now();
    const hit = entries.get(model);
    if (hit && (hit.outcome === undefined || t - hit.at < (hit.outcome === 'pass' ? freshMs : retryMs))) return hit.value;
    const entry: { at: number; value: Promise<ModelVerification>; outcome?: Outcome } = { at: t, value: verify(model) };
    entries.set(model, entry);
    entry.value.then(
      (v) => {
        entry.outcome = v.outcome;
      },
      () => {
        if (entries.get(model) === entry) entries.delete(model);
      },
    );
    return entry.value;
  };
}

// A key is never needed. If the server has one, it lifts the shared keyless rate limit.
const apiKey = process.env.NEARAI_CLOUD_API_KEY || process.env.NEAR_AI_API_KEY;

export const verified = createVerifier({ verify: (model) => verifyModel(model, { timeoutMs: 20_000, ...(apiKey ? { apiKey } : {}) }) });

export function verifiedAll(): Promise<ModelVerification[]> {
  return Promise.all(MODELS.map((m) => verified(m)));
}

// View ---------------------------------------------------------------------------------------------------------------

export type RowOutcome = Outcome | 'pending';

export interface Row {
  readonly key: 'nonce' | 'intel' | 'gpu' | 'signer' | 'code' | 'gateway';
  readonly label: string;
  readonly text: string;
  readonly outcome: RowOutcome;
}

const NAMES: Record<string, string> = {
  'z-ai/glm-5.3-flash': 'GLM 5.3 Flash',
  'deepseek-ai/DeepSeek-V4.1-Flash-1017': 'DeepSeek V4.1 Flash',
  'Qwen/Qwen3.8-27B': 'Qwen 3.8 27B',
  'Qwen/Qwen3.8-27B-abliterated': 'Qwen 3.8 27B Abliterated',
};

export function modelName(id: string): string {
  return NAMES[id] ?? id.split('/').pop() ?? id;
}

/** NVIDIA reports the chip; people know the card. */
const CARDS: Record<string, string> = { GH100: 'H100', GB100: 'B200', GB102: 'B200' };

/** H100, or null before the GPUs answered. */
export function gpuCard(results: readonly ModelVerification[] | ModelVerification | undefined): string | null {
  const list = results === undefined ? [] : Array.isArray(results) ? results : [results as ModelVerification];
  const hw = list.flatMap((v) => v.nodes).find((n) => n.gpus?.hwmodel)?.gpus?.hwmodel;
  return hw ? (CARDS[hw] ?? hw) : null;
}

export function gpuCount(v: ModelVerification | undefined): number {
  return v?.nodes.reduce((sum, n) => sum + (n.gpus?.count ?? 0), 0) ?? 0;
}

const TCB_WORDS: Record<string, string> = { UpToDate: 'TCB up to date', SWHardeningNeeded: 'TCB needs SW hardening' };

/**
 * What was checked, as people read it: six rows, each the joint outcome of the checks behind it across every model.
 * A row that did not pass names the model and the reason.
 */
export function rows(results: readonly ModelVerification[] | undefined): Row[] {
  const all = results ?? [];
  const gpus = all.reduce((sum, v) => sum + gpuCount(v), 0);
  const card = gpuCard(all);
  const tcbs = [...new Set(all.flatMap((v) => v.nodes.map((n) => n.tcb)).filter((t): t is NonNullable<typeof t> => Boolean(t)))];

  const row = (key: Row['key'], label: string, pass: string, from: (v: ModelVerification) => readonly Check[]): Row => {
    if (!results) return { key, label, text: pass, outcome: 'pending' };
    // A model whose report never arrived has nothing to judge: its report check stands in for every row.
    const judged = all.map((v) => {
      const checks = from(v);
      return { v, checks: checks.length ? checks : v.checks };
    });
    const outcome = outcomeOf(judged.flatMap((j) => j.checks));
    if (outcome === 'pass') return { key, label, text: pass, outcome };
    const first = judged.find((j) => j.checks.some((c) => c.outcome === outcome));
    const detail = first?.checks.find((c) => c.outcome === outcome)?.detail;
    // A failure names the model and the evidence; evidence that never arrived says who did not answer.
    if (outcome === 'unavailable') return { key, label, text: notChecked(detail), outcome };
    return { key, label, text: `${first ? `${modelName(first.v.model)}: ` : ''}${detail ?? 'did not hold'}`, outcome };
  };
  const model = (...ids: CheckId[]) => (v: ModelVerification) => v.nodes.flatMap((n) => n.checks).filter((c) => ids.includes(c.id));

  return [
    row('nonce', 'Fresh nonce', 'New random nonce for every check, sealed in every quote', (v) =>
      [v.gateway, ...v.nodes].flatMap((t) => t?.checks ?? []).filter((c) => c.id === 'nonce'),
    ),
    row('intel', 'Intel TDX', `Quotes signed by Intel · ${tcbs.map((t) => TCB_WORDS[t] ?? `TCB ${t}`).join(', ') || 'TCB up to date'} · debug off`, model('quote', 'debug')),
    row(
      'gpu',
      'NVIDIA GPUs',
      results && gpus ? `${gpus} × ${card ?? 'GPU'} attested by NVIDIA · secure boot · debug off` : 'Every GPU attested by NVIDIA · secure boot · debug off',
      model('gpu'),
    ),
    row('signer', 'Signing keys', 'Born inside the enclave and bound to its quote', model('signer')),
    row('code', 'Measurements', 'Containers and boot log match what the quote measured', model('config', 'boot')),
    row('gateway', 'Gateway', 'The NEAR AI gateway in front passes the same checks', (v) => v.gateway?.checks ?? []),
  ];
}

/** The first reason a model did not pass, as evidence (`detail`) and in people words (`text`). */
export function reason(v: ModelVerification): { text: string; detail: string } | null {
  if (v.outcome === 'pass') return null;
  const c = allChecks(v).find((x) => x.outcome === v.outcome);
  const detail = c?.detail ?? c?.name ?? 'not checked';
  return { text: v.outcome === 'unavailable' ? notChecked(c?.detail) : detail, detail };
}

/** Who did not answer, without the network jargon. The exact error stays in the details and the JSON. */
export function notChecked(detail: string | undefined): string {
  const d = detail ?? '';
  if (d.startsWith('NEAR AI')) return 'Not checked: NEAR AI did not answer';
  if (d.includes('(403)')) return "Not checked: NVIDIA refused this server's network";
  if (d.startsWith('NVIDIA')) return 'Not checked: NVIDIA did not answer';
  if (d.startsWith('Intel')) return "Not checked: Intel's certificates did not load";
  if (d.startsWith('needs a verified quote')) return 'Not checked: waits for a verified quote';
  return 'Not checked this time';
}

/** The page's verdict: green only when every model passed every check. */
export function overall(results: readonly ModelVerification[] | undefined): RowOutcome {
  if (!results) return 'pending';
  return outcomeOf(results.flatMap((v) => allChecks(v)));
}

/** 23:04:12 UTC */
export function utcTime(iso: string): string {
  return `${iso.slice(11, 19)} UTC`;
}

/** just now, 1 min ago, 4 min ago */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  return `${Math.max(1, Math.round(s / 60))} min ago`;
}

/** 0x3b753b44…24fa0c */
export function short(hex: string, head = 10, tail = 6): string {
  return hex.length > head + tail + 1 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex;
}
