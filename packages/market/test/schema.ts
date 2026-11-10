// Holds a value to a schema from the Agent Market OpenAPI document (3.1, JSON Schema 2020-12), as recorded in
// `fixtures/openapi.subset.json`. Covers what that document uses: $ref, type (and type lists), enum, const, required,
// properties, items, oneOf / anyOf / allOf, uuid and date-time formats, minimum / maximum. `strict` also refuses
// properties the schema does not name: a typo in a body we send would otherwise be dropped silently.
import { readFileSync } from "node:fs";

type Schema = Record<string, unknown>;

const doc = JSON.parse(readFileSync(new URL("./fixtures/openapi.subset.json", import.meta.url), "utf8")) as {
  version: string;
  schemas: Record<string, Schema>;
};

export const API_VERSION = doc.version;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function check(schema: Schema, value: unknown, path: string, strict: boolean, out: string[]): void {
  if (typeof schema["$ref"] === "string") {
    const name = schema["$ref"].split("/").at(-1) ?? "";
    const target = doc.schemas[name];
    if (!target) {
      out.push(`${path}: unknown schema ${name}`);
      return;
    }
    check(target, value, path, strict, out);
    return;
  }
  for (const sub of (schema["allOf"] as Schema[] | undefined) ?? []) check(sub, value, path, strict && !schema["allOf"], out);
  for (const key of ["oneOf", "anyOf"] as const) {
    const options = schema[key] as Schema[] | undefined;
    if (!options) continue;
    const passing = options.filter((o) => {
      const e: string[] = [];
      check(o, value, path, strict, e);
      return e.length === 0;
    }).length;
    if (key === "oneOf" ? passing !== 1 : passing < 1) out.push(`${path}: matches ${passing} of ${key}`);
  }
  if ("const" in schema && schema["const"] !== value) out.push(`${path}: not ${JSON.stringify(schema["const"])}`);
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema["enum"])}`);

  const t = schema["type"];
  const actual = typeOf(value);
  if (t !== undefined) {
    const allowed = Array.isArray(t) ? (t as string[]) : [t as string];
    const ok = allowed.includes(actual) || (actual === "integer" && allowed.includes("number"));
    if (!ok) {
      out.push(`${path}: ${actual}, expected ${allowed.join("|")}`);
      return;
    }
  }
  if (typeof value === "string") {
    if (schema["format"] === "uuid" && !UUID.test(value)) out.push(`${path}: not a uuid`);
    if (schema["format"] === "date-time" && !DATE_TIME.test(value)) out.push(`${path}: not a date-time`);
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) out.push(`${path}: below ${schema["minimum"]}`);
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) out.push(`${path}: above ${schema["maximum"]}`);
  }
  if (Array.isArray(value) && schema["items"]) value.forEach((v, i) => check(schema["items"] as Schema, v, `${path}[${i}]`, strict, out));
  if (actual === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const props = (schema["properties"] as Record<string, Schema> | undefined) ?? {};
    for (const r of (schema["required"] as string[] | undefined) ?? []) if (!(r in obj)) out.push(`${path}.${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) check(props[k], v, `${path}.${k}`, strict, out);
      else if (strict && schema["properties"] && !schema["allOf"]) out.push(`${path}.${k}: not in the schema`);
    }
  }
}

/** Every way `value` breaks the named schema; empty when it conforms. */
export function violations(name: string, value: unknown, options: { strict?: boolean } = {}): string[] {
  const schema = doc.schemas[name];
  if (!schema) return [`no schema ${name} in the recording`];
  const out: string[] = [];
  check(schema, value, name, options.strict ?? false, out);
  return out;
}
