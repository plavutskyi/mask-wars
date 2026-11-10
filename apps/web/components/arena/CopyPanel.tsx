import { accountUrl } from '@maskwars/arena/config';
import { nearText } from '@maskwars/forge';
import Link from 'next/link';
import { type Person, shareText } from '@/lib/person';
import { CopyOwner } from './CopyOwner';
import { Info, type InfoRow } from './Info';
import p from './person.module.css';

/** Confidential copying on the mask page. One main action: "Copy this mind". For an author's mask it invites a copy
 * and shows how many copies there are and what the author earned on them; for a copy it names, in one quiet line, the
 * author it plays and the share it owes. The author's own control (open to copies, the share, stop, collect) sits
 * behind one quiet button, and the technical detail behind the "i". */
export function CopyPanel({ person: { mask: m, copy } }: { person: Person }) {
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
  const n = copy.copies.length;
  const facts: InfoRow[] = [
    ...(copy.copyable ? [{ label: 'Share of each new copy’s wins', value: share }] : []),
    { label: 'Copies', value: String(n) },
    { label: 'Earned on copies', value: `${nearText(copy.earned)} NEAR` },
    ...(copy.due > 0n ? [{ label: 'Waiting on copies', value: `${nearText(copy.due)} NEAR` }] : []),
    ...copy.copies.map((c): InfoRow => ({ label: `Copy · ${c.name.toUpperCase()} · ${shareText(c.bps)}`, value: c.account, href: accountUrl(c.account) })),
  ];

  return (
    <section className={p.copy} data-closed={closed ? '' : undefined} aria-labelledby="copy">
      <div className={p.copyText}>
        <p id="copy" className={p.copyTitle}>
          Copy this mind
        </p>
        <p className={p.copyNote}>
          {closed
            ? `Closed for now: ${NAME}’s owner has not opened it to copies.`
            : copy.copyable
              ? `Forge your own mask that plays ${NAME}’s sealed strategy inside a TEE — you never see the line, and neither does anyone else. ${NAME}’s owner earns ${share} of what your copy wins; you keep the rest.`
              : `${NAME}’s owner closed it to new copies. The copies made keep playing it inside a TEE.`}
        </p>
        {n > 0 ? (
          <p className={p.copyStat}>
            {n === 1 ? '1 copy' : `${n} copies`} · {NAME} earned {nearText(copy.earned)} NEAR on them
          </p>
        ) : null}
        {closed ? null : <Info rows={facts} label="Copying, on chain" align="start" />}
      </div>
      {closed ? null : copy.copyable ? (
        <Link href={`/forge?copy=${m.name}`} className={p.copyBtn}>
          Copy this mind
        </Link>
      ) : (
        <span className={p.copyClosed}>Closed to new copies</span>
      )}
      {owner}
    </section>
  );
}
