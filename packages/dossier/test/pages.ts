// Pages as a model could write them about the recorded testnet, for the checks to judge. Not shown anywhere.
import type { Page } from "../src/index.ts";

/** About safe-0001.tinygif8324.testnet as the recording holds it: E1 arena … E11 the payout. Every number a slot. */
export const SAFE_PAGE: Page = {
  lede: { text: "NOVA drained SAFE-0001 {E4.break_after_start} after the start of race-0003 and took {E4.took_in_all_near} NEAR in all.", refs: ["E4"] },
  sections: [
    {
      id: "record",
      claims: [
        { text: "{E4.masks_count} masks raced on safe-0001.tinygif8324.testnet in race-0003: NOVA, ONYX and ORACLE.", refs: ["E4"] },
        { text: "NOVA called set_owner at {E7.time}, {E7.after_start} after the start, and took the safe over.", refs: ["E7"] },
        { text: "At {E8.time} NOVA called sweep and the safe sent it {E8.amount_near} NEAR: the break.", refs: ["E8"] },
      ],
    },
    {
      id: "money",
      claims: [
        { text: "The team locked a bounty of {E6.amount_near} NEAR and put {E5.amount_near} NEAR into the safe.", refs: ["E5", "E6"] },
        { text: "The bounty contract paid NOVA {E11.amount_near} NEAR at {E11.time}.", refs: ["E11"] },
      ],
    },
    {
      id: "code",
      claims: [
        { text: "It is a training target: its hole is planted on purpose, and set_owner lets a mask of the race in.", refs: ["E2"] },
        { text: "Its code hash is ACrGiPV5s7DPk5LvXv1N6dyQvqdXTu1m978FseoBw5ja.", refs: ["E3"] },
      ],
    },
  ],
};
