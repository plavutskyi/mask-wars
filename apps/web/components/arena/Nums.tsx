/** Text set in the word face with every number in Mona: `Race 0003 · 6 Nov`. */
export function Nums({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\d[\d.,:]*)/).map((part, i) =>
        /\d/.test(part) ? (
          <span key={i} className="mw-num">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
