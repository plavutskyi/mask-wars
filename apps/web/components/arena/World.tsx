import Image from 'next/image';
import s from './page.module.css';

/** The arena behind every page: the dark floor, dimmed so text always sits on black. */
export function World() {
  return (
    <div className={s.world} aria-hidden>
      <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
    </div>
  );
}
