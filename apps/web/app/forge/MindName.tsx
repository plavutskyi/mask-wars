import s from './forge.module.css';

/**
 * A model's name on its tile. Every model stands in the same face at the same size: a long name takes another line,
 * broken between its words, and never a narrower face than its neighbours (a narrowed one reads as a font that did not
 * load). On a desk the last word goes under the rest; on a phone every word has its own line.
 */
export function MindName({ name }: { name: string }) {
  const words = name.trim().split(/\s+/);
  const tail = words.pop() ?? '';
  return (
    <span className={`${s.word} ${s.mind}`}>
      {words.length ? (
        <span className={s.mindHead}>
          {words.map((w, i) => (
            <span key={i}>{w} </span>
          ))}
        </span>
      ) : null}
      <span className={s.mindTail}>{tail}</span>
    </span>
  );
}
