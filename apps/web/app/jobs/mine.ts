// The jobs this device posted, so their pages offer their client the way to take one back. A note in the browser only:
// the chain decides, and only the job's own client can take it back.
const MINE = 'maskwars.jobs.mine';
const MOST = 20;

function read(): string[] {
  try {
    const kept = JSON.parse(localStorage.getItem(MINE) ?? '[]') as unknown;
    return Array.isArray(kept) ? kept.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Notes a job this device posted; the newest twenty are kept. */
export function mine(id: string) {
  try {
    localStorage.setItem(MINE, JSON.stringify([id, ...read().filter((x) => x !== id)].slice(0, MOST)));
  } catch {
    /* private mode: the job's page offers no take-back on this device */
  }
}

/** This device posted the job. */
export const isMine = (id: string) => read().includes(id);
