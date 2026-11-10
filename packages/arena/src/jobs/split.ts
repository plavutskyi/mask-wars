// The winner's reward, less the fee, split by the rule its crew fixed before it enlisted: the jobs contract's own
// `shares`, step for step, so a decided job shows exactly what settling it will pay.
import type { Role, Split } from "./types.ts";

const ROLES: readonly Role[] = ["scout", "striker", "verifier"];

/**
 * Each role's basis points go to the members of that role with a counted step (`paid`), equally; a role with none
 * gives its part to the others in proportion. What rounding leaves goes to the first paid striker. Members without a
 * counted step get nothing.
 */
export function shares(net: bigint, members: readonly { mask: string; role: Role }[], split: Split, paid: readonly boolean[]): [string, bigint][] {
  const count = (r: Role) => BigInt(members.filter((m, i) => paid[i] && m.role === r).length);
  const active = ROLES.filter((r) => count(r) > 0n).reduce((a, r) => a + BigInt(split[r]), 0n);
  const out: [string, bigint][] = members.map((m) => [m.mask, 0n]);
  if (active === 0n) return out;
  members.forEach((m, i) => {
    if (paid[i]) out[i]![1] = (net * BigInt(split[m.role])) / active / count(m.role);
  });
  const sent = out.reduce((a, [, v]) => a + v, 0n);
  const striker = members.findIndex((m, i) => paid[i] && m.role === "striker");
  if (striker >= 0) out[striker]![1] += net - sent;
  return out;
}
