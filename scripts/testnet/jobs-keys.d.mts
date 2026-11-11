// Types for jobs-keys.mjs, which the race's tests and its sandbox run import: the keys it puts on chain are the ones the
// `Jobs` workflow derives from the same seeds.
export const BOND_RECORD: bigint;
export function nearOf(yocto: bigint | string): string;
export function jobKeys(
  secrets: Record<string, { seed?: string }>,
  jobs: string,
  crews: string,
  masks: string[],
): Record<string, { jobs: string; crews: string }>;
export function bondOf(view: { id: string; phase: string; terms: { kind: string; bond: string } } | null): {
  job: string;
  kind: string;
  phase: string;
  bond: string;
  deposit: string;
};
