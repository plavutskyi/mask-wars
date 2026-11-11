import { accountUrl } from '@maskwars/arena/config';
import { nearText } from '@maskwars/forge';
import Link from 'next/link';
import { type Person, shareText } from '@/lib/person';
import { CopyOwner } from './CopyOwner';
import { Info, type InfoRow } from './Info';
import p from './person.module.css';

/** Confidential copying on the mask page. One main action: "Copy · 1 NEAR". For an author's mask it shows, as numbers,
 * what a copy keeps of its wins, what the author takes and how many copies there are; for a copy it names, in one quiet
 * line, the author it plays and the share it owes. How it works, the copies and their accounts sit behind the «i»; the
 * author's own control (open to copies, the share, stop, collect) behind one quiet button. */
export function CopyPanel({ person: { mask: m, copy, minFuel } }: { person: Person }) {
  const NAME = m.name.toUpperCase();

  // This mask is a copy: one quiet line naming its author.
  if (copy.copyOf) {
    const author = copy.copyOf.name.toUpperCase();
    return (
      <p className={p.copyOf}>
        <span className={p.copyOfWord}>Plays </span>
        <Link href={`/mask/${copy.copyOf.name}`} className={p.copyOfName}>
          {author}’s
        </Link>
        <span className={p.copyOfWord}> mind in a TEE · its author earns {shareText(copy.copyOf.bps)} of the wins</span>
      </p>
    );
  }

  // A mask with no sealed strategy has nothing to lend.
  if (!copy.lends) return null;

  const owner = (
    <CopyOwner
      name={m.name}
      owner={m.owner}
      copyable={copy.copyable}
      authorBps={copy.authorBps}
      copies={copy.copies.length}
      due={copy.due.toString()}
      waiting={copy.waiting}
    />
  );

  // Not open to copies, and none made: only the owner's way to open it, quietly. One tree for every state, so the
  // owner's control keeps its place, and what it just told the owner, when the page reads the chain again.
  const closed = !copy.copyable && copy.copies.length === 0;
  const share = shareText(copy.authorBps);
  const keep = shareText(10_000 - copy.authorBps);
  const price = `${nearText(minFuel)} NEAR`;
  const n = copy.copies.length;
  const facts: InfoRow[] = [
    ...(copy.copyable
      ? [
          { label: 'To copy', value: `from ${price}: your copy’s own fuel, for its mind. None of it goes to ${NAME}` },
          { label: 'Of each win', value: `${keep} to you, ${share} to ${NAME}’s owner, paid by your copy’s own code` },
        ]
      : []),
    { label: 'The strategy', value: `Sealed. Your copy’s mind opens it only inside a TEE; nobody reads it, you included` },
    { label: 'Copies', value: String(n) },
    { label: `${NAME} earned on copies`, value: `${nearText(copy.earned)} NEAR` },
    ...(copy.due > 0n ? [{ label: 'Waiting on copies', value: `${nearText(copy.due)} NEAR` }] : []),
    ...copy.copies.map((c): InfoRow => ({ label: `Copy · ${c.name.toUpperCase()} · ${shareText(c.bps)}`, value: c.account, href: accountUrl(c.account) })),
  ];

  if (closed) {
    return (
      <section className={p.copy} data-closed="" aria-labelledby="copy">
        <div className={p.copyText}>
          <p id="copy" className={p.copyTitle}>
            Copy {NAME}
          </p>
          <p className={p.copyNote}>Closed: its owner has not opened it to copies.</p>
        </div>
        {owner}
      </section>
    );
  }

  return (
    <section className={p.copy} aria-labelledby="copy">
      <div className={p.copyText}>
        <p id="copy" className={p.copyTitle}>
          Copy {NAME}
          <Info rows={facts} label="Copying, on chain" align="start" />
        </p>
        <dl className={p.copyNums}>
          {copy.copyable ? (
            <>
              <div>
                <dt>You keep</dt>
                <dd data-tone="money">{keep}</dd>
              </div>
              <div>
                <dt>{NAME} takes</dt>
                <dd>{share}</dd>
              </div>
            </>
          ) : null}
          <div>
            <dt>Copies</dt>
            <dd>{n}</dd>
          </div>
          {copy.earned > 0n ? (
            <div>
              <dt>{NAME} earned</dt>
              <dd>
                {nearText(copy.earned)}
                <span className={p.copyUnit}>NEAR</span>
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      {copy.copyable ? (
        <Link href={`/forge?copy=${m.name}`} className={p.copyBtn} aria-label={`Copy ${NAME} for ${price}: ${share} of its wins go to ${NAME}’s owner`}>
          Copy
          <span className={p.copyPrice}>{price}</span>
        </Link>
      ) : (
        <span className={p.copyClosed}>Closed to new copies</span>
      )}
      {owner}
    </section>
  );
}
