/** A message short enough for the door stays on one line; a longer one breaks at the space nearest its middle. */
export function twoLines(text: string): string[] {
  if (text.length <= 12 || !text.includes(' ')) return [text];
  const mid = text.length / 2;
  let cut = -1;
  for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1)) if (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid)) cut = i;
  return [text.slice(0, cut), text.slice(cut + 1)];
}
