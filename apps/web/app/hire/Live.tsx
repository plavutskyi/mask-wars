'use client';

import { HireButton } from '@maskwars/hire/react';

/** The real button, opening the real checkout from this site: the job and the dollars named, the rest asked there. */
export function Live({ origin }: { origin: string }) {
  return <HireButton job="Attack my contract before launch" usd={250} origin={origin} />;
}
