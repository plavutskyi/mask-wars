// How wide a mask's name stands on its page, so the page can size it to one line: ONYX is wider than NOVA, and WRAITH
// wider than ORACLE, letter for letter. Counting letters is not enough.

/**
 * Advance of each character a name can hold, in 1/1000 em: Hubot Sans 800 at width 125, the cut `.word` sets
 * (packages/brand/fonts/hubot-sans-800-wdth125.ttf; title.test.ts holds this table to the file).
 */
export const ADVANCE: Readonly<Record<string, number>> = {
  A: 986, B: 871, C: 939, D: 919, E: 806, F: 789, G: 963, H: 966, I: 760, J: 526, K: 927, L: 756, M: 1148,
  N: 955, O: 976, P: 842, Q: 976, R: 907, S: 832, T: 858, U: 913, V: 991, W: 1274, X: 1007, Y: 931, Z: 832,
  0: 814, 1: 497, 2: 726, 3: 723, 4: 789, 5: 735, 6: 769, 7: 735, 8: 756, 9: 769,
  '.': 277, '-': 420, _: 417, ' ': 194,
};

/** A character outside the table takes the widest letter: the name may come out a little smaller, never too wide. */
const WIDEST = 1274;

/** `.word` sets its letters 0.01em apart. */
const TRACKING = 10;

/** The width of a name in em as its page draws it: upper case, wide cut, one line. `ORACLE` is 5.43. */
export function titleEm(name: string): number {
  let units = 0;
  for (const ch of name.toUpperCase()) units += (ADVANCE[ch] ?? WIDEST) + TRACKING;
  return units / 1000;
}
