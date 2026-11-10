'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** While a race runs, its page reads the chain again every few seconds. */
export function Refresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => router.refresh(), everyMs);
    return () => window.clearInterval(id);
  }, [router, everyMs]);
  return null;
}
