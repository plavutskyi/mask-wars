/** Every refusal of the core is a `CoreError` with a stable `code`, so the engine and the API can branch on it. */

export type CoreErrorCode =
  | "illegal_transition"
  | "too_early"
  | "too_late"
  | "bad_id"
  | "bad_amount"
  | "bad_outcome"
  | "bad_move"
  | "bad_salt"
  | "duplicate_op_id"
  | "book_closed"
  | "already_sealed"
  | "not_sealed"
  | "already_revealed"
  | "seal_mismatch"
  | "rotate_used"
  | "already_decided"
  | "no_decision_now"
  | "unknown_mask";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = "CoreError";
    this.code = code;
  }
}

/** A step the fight's state machine does not allow from where it is. */
export class IllegalTransitionError extends CoreError {
  readonly from: string;
  readonly action: string;
  constructor(from: string, action: string) {
    super("illegal_transition", `${action} is not allowed in ${from}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.action = action;
  }
}
