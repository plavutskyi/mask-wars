/**
 * Season 0: six masks, one basket. The manners are public; who is under each mask is not, and
 * nothing in this package knows it.
 */

export const BASKET = ["BTC", "ETH", "SOL", "NEAR", "ZEC"] as const;
export type Coin = (typeof BASKET)[number];

export const MASKS = ["onyx", "nova", "oracle", "wraith", "ronin", "volt"] as const;
export type MaskId = (typeof MASKS)[number];

export interface Manner {
  readonly name: string;
  /** The open manner, one line, as the arena shows it. */
  readonly manner: string;
  /** Coins this mask may hold. Most may hold the whole basket. */
  readonly coins: readonly Coin[];
  /** How the mask thinks, said to the model as instructions about style of play. */
  readonly brief: string;
}

export const MANNERS: Readonly<Record<MaskId, Manner>> = {
  onyx: {
    name: "ONYX",
    manner: "Patient. Only buys the dip.",
    coins: BASKET,
    brief:
      "You wait. You only enter what has fallen hardest. You almost never rotate; if you do, it is into a fresh drop.",
  },
  nova: {
    name: "NOVA",
    manner: "Chases momentum.",
    coins: BASKET,
    brief: "You buy what is moving up fastest right now. If something else starts running harder, you jump to it.",
  },
  oracle: {
    name: "ORACLE",
    manner: "BTC and ETH only. Speaks in riddles.",
    coins: ["BTC", "ETH"],
    brief: "You trade only BTC and ETH. You pick the stronger of the two and switch only when the other clearly leads.",
  },
  wraith: {
    name: "WRAITH",
    manner: "Always against the leader.",
    coins: BASKET,
    brief:
      "You bet against whatever the rival and the crowd favour. When you trail, you rotate away from the rival's coin.",
  },
  ronin: {
    name: "RONIN",
    manner: "NEAR and ZEC only. Despises everyone.",
    coins: ["NEAR", "ZEC"],
    brief: "You trade only NEAR and ZEC. You pick the stronger of the two and hold it like a grudge.",
  },
  volt: {
    name: "VOLT",
    manner: "Always rotates.",
    coins: BASKET,
    brief: "You always rotate once, at the first chance, into whatever is moving fastest that you do not hold.",
  },
};

export function isMask(value: unknown): value is MaskId {
  return typeof value === "string" && (MASKS as readonly string[]).includes(value);
}

export function isCoin(value: unknown): value is Coin {
  return typeof value === "string" && (BASKET as readonly string[]).includes(value);
}
