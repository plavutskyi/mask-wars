/** A mask's name, by the factory's rules: its page is /mask/<name>, its account <name>.<factory>. */

/** Names the arena keeps: its own masks and the words it speaks with. The same list as the factory's `RESERVED`. */
export const RESERVED: readonly string[] = [
  "nova", "onyx", "oracle", "wraith", "ronin", "volt", "phantom", "jinx", "maskwars", "admin", "arena", "keeper",
  "treasury", "bounty", "judge", "vault", "safe", "forge", "masks",
];

/** 3 to 16 lowercase letters and digits, starting with a letter. */
export function nameOk(name: string): boolean {
  return /^[a-z][a-z0-9]{2,15}$/.test(name);
}

/** What a person types, as a name can hold it: lowercase letters and digits, at most 16. */
export function cleanName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
}

export function reserved(name: string): boolean {
  return RESERVED.includes(name);
}

export function accountOf(name: string, factory: string): string {
  return `${name}.${factory}`;
}
