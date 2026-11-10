// A race read from the chain, as the 3D arena plays it. Pure: every number is the one the rest of the site shows.
//
// sealing → idle    the vault and its sum in the dark, the masks waiting; under each, whether it has sealed
// racing  → live    the masks are out; every call a mask makes on the safe is one strike on the lock
// broken  → paid    the first time it is shown the break plays again: the vault, the crack, the money to the winner
//                   (breach, when the payout is still on its way or went to someone outside the race)
// held    → held    the bolts slam home; the door says so, the bounty's way back waits behind «i»
// empty   → idle    a closed vault, no sum: no race yet, or the chain is not answering

import type { Race, Who } from '@maskwars/arena';
import { MASKS } from '@maskwars/arena/config';
import { duration, near } from '@maskwars/arena/format';
import { toneOf } from '../../lib/show';
import type { ArenaMask, ArenaMoney, ArenaState, MaskSlot } from '../arena3d/types';
import { stageName, standing } from './names';

export interface Scene {
  /** The state the arena rests in. */
  rest: ArenaState;
  /** The states the arena walks through the first time it shows this race, ending in `rest`. */
  intro: readonly ArenaState[];
  /** Left, middle, right: warm eyes in the Ember corner, NOVA in the Violet one. */
  masks: readonly [ArenaMask, ArenaMask, ArenaMask];
  attempts: readonly [number, number, number];
  /** What each mask on the stage is doing, while the round runs: “Sealed #1”, “3 tries”, “Plan shown”. */
  notes: readonly [string, string, string] | null;
  winner: MaskSlot | null;
  vault: ArenaMoney | null;
  payout: ArenaMoney | null;
  /** The line under the sum in each state. */
  lines: Readonly<Partial<Record<ArenaState, string>>>;
  /** With no sum on the vault, what its door says in a state: “Vault held”, “No race yet”. */
  headlines: Readonly<Partial<Record<ArenaState, string>>>;
  /** The round's name is an account (another team's safe): it reads as one, never as a name of ours. */
  account: boolean;
}

/** NEAR from yoctoNEAR, written exactly as `near()` writes it everywhere else on the site. */
export function money(yocto: string): ArenaMoney {
  const text = near(yocto);
  return { amount: Number(text.replace(/,/g, '')), unit: 'NEAR', text };
}

const CORNER = { ember: 0, ice: 1, violet: 2 } as const;

/** The three masks on the stage, ordered by corner: Ember left, Ice middle, Violet right; same corner keeps chain order. */
function cast(list: readonly Who[]): Who[] {
  return list
    .map((who, i) => ({ who, i }))
    .sort((a, b) => CORNER[toneOf(a.who)] - CORNER[toneOf(b.who)] || a.i - b.i)
    .map((x) => x.who);
}

const asMask = (who: Who): ArenaMask => ({ id: who.slug ?? who.account, name: who.name });

/** Calls a mask made on the safe in this race: every move and the drain. */
export function tries(race: Race, who: Who): number {
  return race.events.filter((e) => e.who?.account === who.account && (e.kind === 'move' || e.kind === 'drain')).length;
}

/**
 * The masks on the stage, left to right, the same in the flat arena and the 3D one. A bigger field keeps the winner
 * and the masks that tried hardest; a field of one or two stands as it is. With no race, the arena's own masks wait.
 */
export function stageCast(race: Race | null): Who[] {
  if (!race) return cast(MASKS.map((m) => ({ account: m.account, slug: m.slug, name: m.name, mask: true, model: m.model })));
  if (race.masks.length <= 3) return cast(race.masks);
  return cast(
    [...race.masks]
      .map((who, i) => ({ who, i, n: who.account === race.winner?.account ? Infinity : tries(race, who) }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .slice(0, 3)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.who),
  );
}

export function sceneOf(race: Race | null, error = false): Scene | null {
  if (!race) {
    const masks = stageCast(null);
    return {
      rest: 'idle',
      intro: ['idle'],
      masks: masks.map(asMask) as unknown as Scene['masks'],
      attempts: [0, 0, 0],
      notes: null,
      winner: null,
      vault: null,
      payout: null,
      lines: {},
      headlines: { idle: error ? 'The chain is not answering' : 'No race yet' },
      account: false,
    };
  }

  // Three on the stage; fewer than three stay flat.
  if (race.masks.length < 3) return null;
  const masks = stageCast(race);
  const slot = race.winner ? masks.findIndex((m) => m.account === race.winner!.account) : -1;
  const winner = slot >= 0 ? (slot as MaskSlot) : null;
  const attempts = masks.map((m) => tries(race, m)) as unknown as Scene['attempts'];
  const { text: target, account } = stageName(race);
  const running = race.phase === 'sealing' || race.phase === 'racing';
  const notes = running ? (masks.map((m) => standing(m, race.events).text) as unknown as NonNullable<Scene['notes']>) : null;
  const base = { masks: masks.map(asMask) as unknown as Scene['masks'], attempts, notes, winner, account, headlines: {} };

  switch (race.phase) {
    case 'sealing':
      return { ...base, rest: 'idle', intro: ['idle'], vault: money(race.prize), payout: null, lines: { idle: target } };
    case 'racing':
      return { ...base, rest: 'live', intro: ['live'], vault: money(race.prize), payout: null, lines: { live: target } };
    case 'held':
      return {
        ...base,
        rest: 'held',
        intro: ['idle', 'held'],
        // A held vault is shut on its sum: the door says what happened, the bounty's way back is behind «i».
        vault: null,
        payout: null,
        lines: { idle: target, held: 'Nobody got through' },
        headlines: { held: 'Vault held' },
      };
    case 'broken': {
      const took = race.takes ?? race.payout?.amount ?? race.bounty;
      const broke = race.breakMs !== null ? `Broken in ${duration(race.breakMs)}` : 'Broken';
      // The payout lands on a mask only when the contract has paid it and the winner is on the stage.
      const paid = race.payout !== null && winner !== null;
      return {
        ...base,
        rest: paid ? 'paid' : 'breach',
        intro: paid ? ['idle', 'breach', 'paid'] : ['idle', 'breach'],
        vault: money(took),
        payout: paid ? money(took) : null,
        lines: { idle: target, breach: broke, paid: broke },
      };
    }
  }
}
