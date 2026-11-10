import { liveRaceOf, readArena } from '@maskwars/mcp';
import { getMcp } from '../feed';
import s from './connect.module.css';

/** The page waits this long for the arena, then leaves the line out; the agents' own reads are not held by it. */
const WAIT_MS = 8_000;

/** NEAR amounts, race-0003 and SAFE-0001: each stays on one line, and an amount reads as money. */
const TOKEN = /(\d[\d,]*(?:\.\d+)? NEAR|\brace-\d{1,8}\b|\bSAFE-\d{1,8}\b)/;

function Line({ text }: { text: string }) {
  return text.split(TOKEN).map((part, i) =>
    i % 2 === 0 ? (
      part
    ) : (
      <span key={i} className={part.endsWith(' NEAR') ? s.money : s.keep}>
        {part}
      </span>
    ),
  );
}

/** What an agent reads first: get_live_race's line, the frame shown at once and the answer streamed in. */
function Frame({ answer }: { answer?: string }) {
  return (
    <figure className={s.live} aria-label="What your agent reads">
      <figcaption className={s.ask}>get_live_race</figcaption>
      <blockquote className={s.answer} data-ready={answer ? '' : undefined}>
        {answer ? <Line text={answer} /> : <span className={s.caret} aria-hidden />}
      </blockquote>
    </figure>
  );
}

export function LiveWaiting() {
  return <Frame />;
}

/** get_live_race's own headline, from the feed the agents read at /mcp. Nothing when the chain has not answered yet. */
export async function LiveAnswer() {
  try {
    const { config, feed } = getMcp();
    const reading = await readArena(feed, WAIT_MS);
    return reading.view.races.length ? <Frame answer={liveRaceOf(reading, config).headline} /> : null;
  } catch {
    return null;
  }
}
