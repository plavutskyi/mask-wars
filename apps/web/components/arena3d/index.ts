// The arena engine: a 3D vault, three masks and the moments of a race, driven by props only.
// Usage: <Arena3D state="live" vault={{ amount: 3, unit: 'NEAR' }} masks={[...]} attempts={[4, 9, 2]} />
// The scene itself is a separate chunk, loaded when the arena is on screen.

export { Arena3D } from './Arena3D';
export { AUDIO } from './sound';
export type { ArenaAudioOut, ArenaMask, ArenaMaskLook, ArenaMoney, ArenaProps, ArenaQuality, ArenaState, MaskSlot, MoneyUnit } from './types';
