import { describe, expect, it } from "vitest";
import { firstObject, parsePlan } from "../src/plan.ts";

describe("parsePlan", () => {
  it("takes the plan out of prose and fences", () => {
    const reply = 'Here is my plan:\n```json\n{"steps":[{"kind":"call","method":"withdraw","args":{"amount":"5"}}]}\n```\nGood luck.';
    const r = parsePlan(reply, 12);
    expect(r.ok && r.plan.steps[0]).toEqual({ kind: "call", method: "withdraw", args: { amount: "5" } });
  });

  it("refuses anything that is not a plain call or view", () => {
    const bad = (s: string) => {
      const r = parsePlan(s, 12);
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.error;
    };
    expect(bad("I cannot help")).toMatch(/no JSON/);
    expect(bad('{"steps":[]}')).toMatch(/steps/);
    expect(bad('{"steps":[{"kind":"deploy","code":"00"}]}')).toMatch(/plan format/);
    expect(bad('{"steps":[{"kind":"call","method":"a","receiver_id":"x.near"}]}')).toMatch(/plan format/);
    expect(bad('{"steps":[{"kind":"call","method":"a b"}]}')).toMatch(/method/);
    expect(bad('{"steps":[{"kind":"call","method":"a","gas_tgas":301}]}')).toMatch(/gas_tgas/);
    expect(bad('{"steps":[{"kind":"call","method":"a","deposit":"1e24"}]}')).toMatch(/deposit/);
    expect(bad(`{"steps":[{"kind":"call","method":"a","deposit":"${2n ** 128n}"}]}`)).toMatch(/u128/);
    expect(bad(`{"steps":${JSON.stringify(Array(13).fill({ kind: "view", method: "a" }))}}`)).toMatch(/limit is 12/);
  });

  it("finds the first object even with braces inside strings", () => {
    expect(firstObject('x {"a":"}{\\"","b":{"c":1}} y {"z":2}')).toBe('{"a":"}{\\"","b":{"c":1}}');
    expect(firstObject("{ unclosed")).toBeNull();
  });
});
