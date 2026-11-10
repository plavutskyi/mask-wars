// Типи Agent API. Узято з OpenAPI https://api.agentsonintents.com/openapi.json
// через згенеровані типи @near-intents-agent-api/sdk 0.7.3 (MIT). Лише ті ендпоінти, якими користуємось.

export type Status =
  | "PENDING_SIGNATURE"
  | "QUEUED"
  | "PENDING_APPROVAL"
  | "PENDING_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED"
  | "UNCERTAIN"
  | "NEEDS_REVIEW";

/** Кінцеві для грошей: далі опитувати нема чого. UNCERTAIN сюди не входить. */
export const TERMINAL: readonly Status[] = ["SUCCESS", "REFUNDED", "FAILED", "NEEDS_REVIEW"];

export type ExecutionType = "swap" | "withdraw" | "transfer" | "shield" | "unshield" | "deposit";

export interface ExecutionDetails {
  action: string;
  request?: {
    origin_asset?: string;
    destination_asset?: string;
    asset?: string;
    amount?: string;
    min_amount_out?: string;
    chain?: string;
    recipient?: string;
    memo?: string;
    confidential?: boolean;
  };
  near_account_id?: string;
  provider_request_id?: string | null;
  provider_status?: string;
  confidential?: boolean;
  chain?: string;
  execute_after?: string;
  delay_ms?: number;
  approval_id?: string | null;
  intent_hash?: string | null;
  tx_hash?: string | null;
  destination_tx_hash?: string | null;
  amount_out?: string | null;
  expected_amount_out?: string;
  deposit_address?: string | null;
  memo?: string | null;
  min_amount?: string | null;
  min_amount_out?: string | null;
  requested_min_amount_out?: string;
  requested_asset?: string;
  delivered?: string | null;
  expires_at?: string | null;
  refund_to?: string | null;
  deposit_seen_at?: string;
  refund_tx_hash?: string | null;
  failure_reason?: string | null;
  reason?: string;
  [key: string]: unknown;
}

export interface StatusResponse {
  correlation_id: string;
  agent_id: string | null;
  status: Status;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  dispatch_committed_at: string | null;
  grant: { id: string; label: string } | null;
  type: ExecutionType;
  details: ExecutionDetails;
}

export type OwnerWallet =
  | { type: "near"; account_id: string; public_key: string }
  | { type: "evm"; address: string; chain_id: number; public_key: string }
  | { type: "passkey"; credential_id: string; public_key: string; rp_id: string; origin: string };

export type AgentStatus = "PENDING" | "ACTIVE" | "ARCHIVED" | "DELETED" | "ABANDONED";

export interface WalletView {
  wallet_id: string;
  near_account_id: string;
  evm_account_id: string | null;
  solana_account_id: string | null;
}

export interface AgentView {
  id: string;
  name: string;
  external_user_id: string | null;
  status: AgentStatus;
  archived: boolean;
  deleted: boolean;
  owner: OwnerWallet | null;
  owner_account: { account_id: string; public_key: string; authority: "wallet" } | null;
  wallet: WalletView | null;
  created_at: string;
  cooldowns: { policy_change_available_at: string | null; unfreeze_available_at: string | null };
}

export interface AgentPage {
  data: AgentView[];
  next_cursor: string | null;
}

export interface BalanceEntry {
  asset_id: string;
  symbol: string | null;
  decimals: number | null;
  blockchain: string | null;
  price: number | null;
  price_updated_at: string | null;
  price_expires_at: string | null;
  balance_raw: string;
  balance: string | null;
  available_raw: string;
  available: string | null;
}

export type BalanceSource = "public" | "confidential";

export interface BalancesView {
  near_account_id: string;
  source: BalanceSource;
  balances: BalanceEntry[];
}

export interface TokenView {
  asset_id: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  price: number | null;
  price_updated_at: string | null;
  price_expires_at: string | null;
}

export interface BudgetWindow {
  limit_usd: string | null;
  spent_usd: string | null;
  remaining_usd: string | null;
  resets_at: string | null;
}

export interface BudgetView {
  daily: BudgetWindow;
  weekly: BudgetWindow;
  monthly: BudgetWindow;
}

export type WarningCode =
  | "policy_action_denied"
  | "policy_destination_denied"
  | "unsupported_token"
  | "invalid_address"
  | "insufficient_balance"
  | "policy_asset_denied"
  | "policy_transaction_limit_exceeded"
  | "policy_schedule_denied"
  | "spend_price_unavailable"
  | "spend_budget_exceeded"
  | "policy_limit_exceeded"
  | "policy_action_limit_exceeded"
  | "policy_usage_unavailable"
  | "high_fee"
  | "asset_delivered_as_is";

export interface QuoteResponse {
  dry: true;
  type: "swap" | "withdraw";
  /** Відповідь 1Click. Поля інформаційні, форму не закладати. */
  quote: { [key: string]: unknown };
  spend: { amount_usd: string | null; budget: BudgetView };
  owner_approval: boolean;
  fee: { amount_usd: string; percent: string } | null;
  warnings: { code: WarningCode; detail: string; available_at?: string; available_amount?: string }[];
}

export interface SwapRequest {
  origin_asset: string;
  destination_asset: string;
  amount: string;
  min_amount_out?: string;
  confidential?: boolean;
  dry?: boolean;
}

export interface TransferRequest {
  asset: string;
  amount: string;
  recipient: string;
  confidential?: boolean;
}

export interface WithdrawRequest {
  asset: string;
  amount: string;
  chain: string;
  recipient: string;
  memo?: string;
  confidential?: boolean;
  async?: boolean;
  dry?: boolean;
}

export interface DepositRequest {
  origin_asset: string;
  destination_asset?: string;
  amount?: string;
  confidential?: boolean;
}

export interface OperationProof {
  agent_id: string;
  correlation_id: string;
  origin: string;
  checkpoint: string | null;
  consistency: { from_size: string; hashes: string[] } | null;
  notary: { [key: string]: unknown } | null;
  events: {
    action: string;
    created_at: string;
    status: "PROVEN" | "PENDING" | "UNLOGGED";
    proof: string | null;
    evidence: string | null;
  }[];
}

export type ErrorLayer = "request" | "auth" | "grant" | "policy" | "budget" | "balance" | "provider" | "api";

export interface ErrorDocument {
  errors: {
    status: string;
    code: string;
    layer: ErrorLayer;
    title: string;
    detail?: string;
    source?: { pointer: string };
    meta?: { retryable: boolean; available_at?: string; min_amount?: string; available_amount?: string };
  }[];
  meta: { request_id?: string };
}
