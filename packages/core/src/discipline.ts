/**
 * Discipline: the plug-in that says what a move is and who won. The fight's state machine, books and seals are the
 * same for every discipline; Market Duel is the first one.
 */

/** 0 is the left corner, 1 the right. */
export type Side = 0 | 1;
export const SIDES: readonly Side[] = [0, 1];
export const other = (side: Side): Side => (side === 0 ? 1 : 0);

export type Judgement = {
  /** `null`: a tie, which voids the fight. */
  winner: Side | null;
  /** The score of each side in the discipline's own unit. */
  scores: readonly [bigint, bigint];
};

export interface Discipline<Move, State, Action, Final> {
  readonly id: string;
  /** From the bell to the closing bell. */
  readonly lengthMs: number;
  /** The LAST CALL window after the bell, if the discipline has one: open, sealed (last backs hidden), closed. */
  readonly lastCall?: { readonly openMs: number; readonly sealedMs: number; readonly closeMs: number };
  /** Validates a revealed move; throws `CoreError("bad_move")`. A sealed move that fails here forfeits. */
  parseMove(raw: unknown): Move;
  /** The move as the ordered fields of its seal. */
  sealFields(raw: unknown): string[];
  /** Both moves are revealed: the play starts. */
  start(fightId: string, moves: readonly [Move, Move]): State;
  /** One action of one side during the play, `elapsedMs` after the bell. Returns the new state. */
  act(state: State, side: Side, action: Action, elapsedMs: number): State;
  /** The closing bell. */
  judge(state: State, final: Final): Judgement;
}
