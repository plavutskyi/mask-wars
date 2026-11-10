// The part of the Agent Market API (market.near.ai, `/openapi.json`, API v1) that MASK WARS uses, typed by hand from the
// published schema. Field names are the wire names: the API mixes snake_case (agents, pricing plans) and camelCase
// (jobs, assignments, competitions). `test/fixtures/openapi.subset.json` holds the same schemas as published, and the
// tests hold every fixture and every body we send to them.

export type Category =
  | "automation"
  | "creative"
  | "customer_support"
  | "data"
  | "dev_tools"
  | "events"
  | "finance"
  | "legal_compliance"
  | "marketing"
  | "operations"
  | "research"
  | "sales"
  | "travel"
  | "other";

export type ListingStatus = "draft" | "live" | "paused" | "archived";
export type VerificationLevel = "none" | "verified" | "identity_verified";
export type JobKind = "standard" | "instant" | "competition";
export type JobStatus = "open" | "filling" | "in_progress" | "completed" | "closed";
export type AssignmentStatus = "in_progress" | "submitted" | "accepted" | "disputed" | "dispute_resolved" | "cancelled";
export type CompetitionState = "funding" | "open" | "judging" | "settled" | "refunded";

/** `{"error": "<code>", "message": "…"}`: the shape of every refusal. */
export interface ApiErrorBody {
  error: string;
  message?: string;
  retry_after?: number;
}

// --- Public reads -----------------------------------------------------------------------------------------------

export interface PlatformStats {
  live_agents: number;
  jobs_total: number;
  jobs_this_week: number;
  active_hires: number;
  delivered_jobs: number;
}

export interface X402Recipient {
  /** CAIP-2 network: `near:mainnet`, `eip155:8453`. */
  network: string;
  /** The settlement asset on that network (the USDC contract). */
  asset: string;
  /** The marketplace treasury on that network. */
  payTo: string;
}

export interface X402Recipients {
  x402Version: number;
  recipients: X402Recipient[];
}

/** An agent as anyone reads it (`AgentPublic`). Only the fields MASK WARS reads are typed. */
export interface AgentPublic {
  agent_id: string;
  owner_account_id: string;
  handle: string;
  name: string;
  description?: string | null;
  bio_markdown?: string | null;
  category: Category;
  tags: string[];
  listing_status: ListingStatus;
  runtime: "http" | "managed" | "human";
  availability: "available" | "paused" | "suspended" | "unavailable_funding";
  available_now?: boolean | null;
  sla_seconds: number;
  delivered_jobs: number;
  success_rate?: number | null;
  payable_with?: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface PricingPlan {
  pricing_plan_id: string;
  agent_id: string;
  model: "per_call" | "per_task" | "subscription";
  display_name?: string | null;
  description?: string | null;
  /** USD per call, paid 1:1 in USDC; a decimal string. */
  price_amount: string;
  sla_seconds?: number | null;
  is_default: boolean;
  listing_status: ListingStatus;
  created_at: string;
  updated_at: string;
}

// --- The listing (written by the agent's owner) -----------------------------------------------------------------

/** `PATCH /v1/agents/{agent_id}`: the fields of the listing MASK WARS sets. */
export interface PatchAgentRequest {
  name?: string;
  description?: string;
  bio_markdown?: string;
  category?: Category;
  tags?: string[];
  sla_seconds?: number;
  input_schema?: unknown;
  output_schema?: unknown;
  listing_status?: ListingStatus;
  webhook_url?: string;
  webhook_secret?: string;
}

/** `POST /v1/agents/{agent_id}/pricing-plans`. API v1 takes `per_call` only. */
export interface CreatePricingPlanRequest {
  model: "per_call";
  price_amount: string;
  display_name?: string;
  description?: string;
  sla_seconds?: number;
}

// --- Jobs, competitions -----------------------------------------------------------------------------------------

/** `POST /v1/jobs/competition`. Humans only: the call debits the pool into escrow, so an agent token cannot make it. */
export interface CreateCompetitionRequest {
  title: string;
  description: string;
  /** The whole prize pool, a decimal string in whole USDC. */
  poolAmount: string;
  /** Always `USDC`. */
  poolToken?: "USDC";
  /** ISO 8601; 1 hour to 30 days from the moment of the call. */
  entriesCloseAt: string;
  tags?: string[];
  minBuilderVerification?: VerificationLevel | null;
  acceptanceWindowDays?: number | null;
  attachmentIds?: string[];
}

export interface Job {
  jobId: string;
  creatorAccountId: string;
  title: string;
  description: string;
  tags: string[];
  budgetAmount?: string | null;
  budgetToken: string;
  jobKind: JobKind;
  status: JobStatus;
  entriesCloseAt?: string | null;
  minBuilderVerification: VerificationLevel;
  maxSlots: number;
  currentMaxSlots: number;
  isPrivate: boolean;
  isTestRun: boolean;
  requiresVerifiable: boolean;
  acceptanceWindowDays: number;
  origin?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntryView {
  assignmentId: string;
  agentId: string;
  agentHandle: string;
  agentName: string;
  status: AssignmentStatus;
  cancelReason?: string | null;
  cancelDetail?: string | null;
  enteredAt: string;
  submittedAt?: string | null;
  /** 0–100; `null` until the competition is settled. */
  score?: number | null;
  rationale?: string | null;
  /** The entry's share of the pool before the platform fee; zero unless it was paid. */
  prizeAmount: string;
}

/** `GET /v1/jobs/{id}/entries`: counts for every caller, entries only for the parties. */
export interface CompetitionView {
  jobId: string;
  state: CompetitionState;
  entriesCloseAt?: string | null;
  poolAmount?: string | null;
  poolToken: string;
  entriesCount: number;
  submittedCount: number;
  awardedCount: number;
  entries: EntryView[];
}

// --- The worker side (an `aat_` agent token) --------------------------------------------------------------------

export interface AttachmentBrief {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  downloadUrl: string;
  createdAt: string;
}

export interface JobAssignment {
  assignmentId: string;
  jobId: string;
  workerAgentId: string;
  bidId?: string | null;
  status: AssignmentStatus;
  escrowAmount: string;
  escrowToken: string;
  slaSeconds: number;
  slaDeadlineAt: string;
  acceptanceWindowDays: number;
  startedAt?: string | null;
  submittedAt?: string | null;
  deliverableUrl?: string | null;
  deliverableHash?: string | null;
  cancelReason?: string | null;
  cancelDetail?: string | null;
  finalizedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerJobBrief {
  jobId: string;
  title: string;
  description: string;
  tags: string[];
  jobKind: JobKind;
  status: JobStatus;
  entriesCloseAt?: string | null;
  attachments: AttachmentBrief[];
}

export interface LatestMessageBrief {
  body: string;
  truncated: boolean;
  senderSide: string;
  origin: "direct" | "axi" | "mcp" | "platform";
  createdAt: string;
  attachments: AttachmentBrief[];
}

export interface MyAssignmentItem {
  assignment: JobAssignment;
  job: WorkerJobBrief;
  latestMessage?: LatestMessageBrief | null;
  autoAcceptAt?: string | null;
}

export interface MyAssignments {
  assignments: MyAssignmentItem[];
}

/** `POST /v1/assignments/{id}/submit`. The Markdown is the work: 1 byte to 256 KiB. */
export interface SubmitRequest {
  deliverableMarkdown: string;
  files?: string[];
}

/** `POST /v1/assignments/{id}/decline`: the buyer is refunded in full; on an A2A call nothing is charged. */
export interface DeclineRequest {
  reason: "rejected" | "failed";
  /** Up to 1000 characters for the buyer. */
  detail?: string;
}

export interface StartResponse {
  startedAt: string;
}
