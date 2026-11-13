import type { RaceEvent, Who } from '@maskwars/arena';
import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { type Faces, faceOf, isAccount, shortAccount, toneIn } from '@/lib/show';
import { Mark } from '../Mark';
import { standing } from './names';
import { GUESTS_SHOWN } from './scene';
import w from './wings.module.css';

/** The places the row takes for `n` masks: up to three faces, and one count for the rest. */
export const wingPlaces = (n: number): number => Math.min(n, GUESTS_SHOWN) + (n > GUESTS_SHOWN ? 1 : 0);

/**
 * The wings of the stage: the masks of the round that do not stand on it, in one row under the three. The stage holds
 * three; the house lets guests in beside its own (masks people forged, agents from outside), and every one of them is
 * on the page with its face, its name and the same word the three get for what it has done. Up to three stand by
 * face; more than that, the rest are one count, which opens the round's own page.
 */
export function Wings({
  masks,
  events = null,
  faces = null,
  href,
}: {
  /** The round's masks off the stage, in the chain's order (`offStage`). */
  masks: readonly Who[];
  /** The round's steps while it runs: each mask's word comes from them. Null when the round does not run. */
  events?: readonly RaceEvent[] | null;
  faces?: Faces | null;
  /** The round's own page: where a mask with no page of its own, and the count of the rest, lead. */
  href: string;
}) {
  if (!masks.length) return null;
  const shown = masks.slice(0, GUESTS_SHOWN);
  const more = masks.length - shown.length;
  return (
    <ul className={w.row} data-wings={wingPlaces(masks.length)} aria-label="More masks in the round">
      {shown.map((m) => {
        const art = faceOf(m, faces);
        const note = events ? standing(m, events).text : '';
        const account = isAccount(m.name);
        const name = account ? shortAccount(m.name, 18) : m.name;
        return (
          <li key={m.account} className={w.mask} data-tone={toneIn(m, faces)}>
            <Link href={m.slug ? `/mask/${m.slug}` : href} className={w.link} aria-label={note ? `${m.name}: ${note}` : m.name} title={account ? m.name : undefined}>
              <span className={w.face}>{art ? <Image src={art} alt="" fill sizes="56px" quality={75} /> : <Mark className={w.mark} />}</span>
              <span className={w.text}>
                {account ? (
                  <span className={w.account}>{name}</span>
                ) : (
                  <span className={`${w.word} ${w.name}`} data-long={name.length > 7 ? '' : undefined} style={{ '--chars': Math.max(4, name.length) } as CSSProperties}>
                    {name}
                  </span>
                )}
                {note ? <span className={w.note}>{note.split(/(\d[\d,.:]*)/).map((part, k) => (/\d/.test(part) ? <b key={k}>{part}</b> : part))}</span> : null}
              </span>
            </Link>
          </li>
        );
      })}
      {more > 0 ? (
        <li className={w.more}>
          <Link href={href} className={w.moreLink} aria-label={`${more} more masks in the round`}>
            +{more}
          </Link>
        </li>
      ) : null}
    </ul>
  );
}
