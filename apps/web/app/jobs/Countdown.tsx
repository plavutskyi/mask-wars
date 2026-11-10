'use client';

import { useEffect, useState } from 'react';
import { left } from './show';

/**
 * Time left to a job's window. The deadline is the chain's; the server says how long is left to it by its own clock at
 * the moment it answers, and the device counts down from there. So the count never restarts from an old reading, and a
 * device whose own clock is off still shows the right time.
 */
export function Countdown({ ms, className }: { ms: number; className?: string | undefined }) {
  const [rest, setRest] = useState(ms);
  useEffect(() => {
    const end = Date.now() + ms;
    setRest(end - Date.now());
    const id = window.setInterval(() => setRest(end - Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ms]);
  return (
    <span className={className} suppressHydrationWarning>
      {left(rest)}
    </span>
  );
}
