// Hire the swarm: the button any NEAR app embeds to hire MASK WARS masks for a job, paid from any wallet on any
// network through NEAR Intents. The money logic is `@maskwars/pay`'s; this package adds the job, the read-back of a
// hire quote, the proof that the payer holds the vault, the checkout's messages to its host page, and the element
// itself (`@maskwars/hire/element`, and `@maskwars/hire/react` for React).
export * from "./events.ts";
export * from "./job.ts";
export * from "./money.ts";
export * from "./proof.ts";
