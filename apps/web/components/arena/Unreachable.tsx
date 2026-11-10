import Link from 'next/link';
import { Header } from './Header';
import { World } from './World';
import s from './page.module.css';

/** The chain did not answer and nothing was read before: say so plainly, offer the way back. */
export function Unreachable() {
  return (
    <main className={s.page}>
      <World />
      <Header />
      <section className={s.empty}>
        <h1 className={`${s.word} ${s.title}`}>The chain is not answering</h1>
        <p className={s.sub}>Try again in a minute.</p>
        <Link href="/" className={`${s.btn} ${s.word}`}>
          To the race
        </Link>
      </section>
    </main>
  );
}
