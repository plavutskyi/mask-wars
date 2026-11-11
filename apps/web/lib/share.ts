// The claim a share card is drawn from: a person's pick on a round, and their run of calls, signed by this server. The
// card adds how the round ended from the chain; a link someone edits by hand draws the round alone, never a claim.
import { type Choice, whoOk } from './pick';
import { seal, unseal } from './picks';

export interface Claim {
  readonly race: string;
  readonly choice: Choice;
  /** Rounds called right in a row, when the table holds this round; null when it does not yet. */
  readonly streak: number | null;
}

export function shareToken(c: Claim): string {
  return seal(Buffer.from(JSON.stringify([c.race, c.choice, c.streak])).toString('base64url'));
}

export function readShare(token: string | null | undefined): Claim | null {
  if (!token || token.length > 400) return null;
  const raw = unseal(token);
  if (!raw) return null;
  try {
    const [race, choice, streak] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown[];
    if (typeof race !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(race)) return null;
    if (typeof choice !== 'string' || !(choice === 'held' || whoOk(`a${choice}`))) return null;
    if (streak !== null && (typeof streak !== 'number' || !Number.isInteger(streak) || streak < 0)) return null;
    return { race, choice, streak: streak as number | null };
  } catch {
    return null;
  }
}
