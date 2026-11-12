// What tools/list says about each tool's input and output. The SDK lists a schema by asking it for its JSON Schema
// (`~standard.jsonSchema`) and checks every call and every answer with the schema's own `~standard.validate`. Zod's
// JSON Schema repeats two things that tell a client nothing: the dialect URL on every schema (2020-12 is MCP's default)
// and the safe-integer bounds on every integer (±9007199254740991, the most a JSON number holds exactly anyway).
// `listed` keeps the schema and its validation as they are and drops only those two from what is listed, so tools/list
// is smaller and every call and answer is checked exactly as before.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

type JsonSchema = Record<string, unknown>;
type Std = { validate: unknown; vendor: string; version: number; jsonSchema?: { input: (o?: unknown) => JsonSchema; output: (o?: unknown) => JsonSchema } };

/** The JSON Schema without the dialect URL and the integer bounds every JSON number has anyway. */
export function trimSchema(schema: JsonSchema): JsonSchema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: JsonSchema = {};
    const integer = (node as JsonSchema)["type"] === "integer";
    for (const [key, value] of Object.entries(node as JsonSchema)) {
      if (integer && key === "minimum" && value === -MAX_SAFE) continue;
      if (integer && key === "maximum" && value === MAX_SAFE) continue;
      out[key] = walk(value);
    }
    return out;
  };
  const { $schema: _dialect, ...rest } = schema;
  return walk(rest) as JsonSchema;
}

/** The same schema, validated by itself, listed without what `trimSchema` drops. A schema with no JSON Schema of its own is returned as is. */
export function listed<T extends object | undefined>(schema: T): T {
  if (!schema) return schema;
  const std = (schema as unknown as { "~standard"?: Std })["~standard"];
  const json = std?.jsonSchema;
  if (!std || !json) return schema;
  const lean: Std = { ...std, jsonSchema: { input: (o) => trimSchema(json.input(o)), output: (o) => trimSchema(json.output(o)) } };
  return Object.create(schema, { "~standard": { value: lean } }) as T;
}

/** A tool's config with both of its schemas listed lean. */
export function leanTool<C extends { inputSchema?: object; outputSchema?: object }>(config: C): C {
  const out = { ...config };
  if (out.inputSchema) out.inputSchema = listed(out.inputSchema);
  if (out.outputSchema) out.outputSchema = listed(out.outputSchema);
  return out;
}
