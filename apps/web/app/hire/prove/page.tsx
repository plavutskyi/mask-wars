import type { Metadata } from 'next';
import { Prove } from './Prove';

// The window a payer proves their vault in, opened by the hire checkout: a page of maskwars.xyz on its own, address
// bar and all, never inside another site. Its policy is the vault page's (proxy.ts): no one may frame it.
export const metadata: Metadata = {
  title: 'Open your vault · MASK WARS',
  robots: { index: false, follow: false },
};

// Its scripts carry a nonce made per request; the passkey's domain is fixed for good (PASSKEY_RP_ID).
export const dynamic = 'force-dynamic';

export default function ProvePage() {
  return <Prove rpId={process.env.PASSKEY_RP_ID || 'maskwars.xyz'} />;
}
