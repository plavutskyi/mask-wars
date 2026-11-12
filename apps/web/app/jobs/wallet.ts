import { NET } from '@maskwars/network';
import { connect, disconnect, type Signer } from '../forge/wallet';

export type { Signer };

declare global {
  interface Window {
    /** A test build's own signer (NEXT_PUBLIC_JOBS_TEST=1), for walking "Post a job" end to end with no real wallet. */
    __jobsSigner?: Signer;
  }
}

/**
 * The person's NEAR wallet, through NEAR Connect: the one the forge connects too, so a person signed in there is
 * signed in here. Only a build made with NEXT_PUBLIC_JOBS_TEST=1 reads the test hook; next.config.ts stops such a
 * build in production.
 */
export async function signIn(): Promise<Signer> {
  if (process.env.NEXT_PUBLIC_JOBS_TEST === '1' && window.__jobsSigner) return window.__jobsSigner;
  return connect(NET.rpc);
}

/** Signs the person out of the connected wallet, so the next `signIn` lets them pick another account. */
export async function signOut(): Promise<void> {
  if (process.env.NEXT_PUBLIC_JOBS_TEST === '1' && window.__jobsSigner) return;
  await disconnect(NET.rpc);
}
