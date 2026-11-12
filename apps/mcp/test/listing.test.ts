// What a registry, a directory or an agent reads before it calls anything: every tool's title, annotations and lead
// sentence, the size of tools/list, and server.json and glama.json, which must say what the server itself says.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { SERVER_DESCRIPTION, SERVER_TITLE, SERVER_VERSION, TESTNET, TOOL_NAMES, serverIcons } from "../src/index.ts";
import { trimSchema } from "../src/listing.ts";
import { ENDPOINT, setup, text } from "./helpers.ts";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function tools() {
  const client = await setup().connect();
  clients.push(client);
  return { client, tools: (await client.listTools()).tools };
}

/** tools/list may grow only on purpose: it is what every agent loads before its first call. */
const LIST_BUDGET = 116_000;

describe("every tool, as a directory reads it", () => {
  it("has a human title, a lead sentence and every annotation a directory checks: read-only, not destructive, whether it reaches the world", async () => {
    const { tools: listed } = await tools();
    expect(listed.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const tool of listed) {
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
      expect(tool.title, tool.name).toMatch(/^\S.{2,58}$/);
      expect(tool.annotations?.title ?? tool.title, tool.name).toBeTruthy();
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations!.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations!.destructiveHint, tool.name).toBe(false);
      expect(tool.annotations!.idempotentHint, tool.name).toBe(true);
      expect(typeof tool.annotations!.openWorldHint, tool.name).toBe("boolean");
      // One sentence first that says what the agent gets, then the details.
      const lead = (tool.description ?? "").split(/(?<=[a-z0-9)`])\. (?=[A-Z`])/)[0]!;
      expect(lead.length, `${tool.name}: ${lead}`).toBeGreaterThan(40);
      expect(lead.length, `${tool.name}: ${lead}`).toBeLessThanOrEqual(300);
    }
    // Only the rules come from this server's own file; every other tool reads the chain or the site.
    expect(listed.filter((t) => t.annotations!.openWorldHint === false).map((t) => t.name)).toEqual(["get_rules"]);
  });

  it("lists lean: no dialect URL and no safe-integer bounds, the whole list within its budget", async () => {
    const { tools: listed } = await tools();
    const body = JSON.stringify({ tools: listed });
    expect(body.length).toBeLessThanOrEqual(LIST_BUDGET);
    expect(body).not.toContain('"$schema"');
    expect(body).not.toContain(String(Number.MAX_SAFE_INTEGER));
    // An integer stays an integer, and a bound of its own stays.
    const races = listed.find((t) => t.name === "list_races")!;
    expect(races.inputSchema.properties?.["limit"]).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
    expect(races.inputSchema.additionalProperties).toBe(false);
  });

  it("still checks every call by the schema as declared: a float, an unknown field or a number out of range is refused", async () => {
    const { client } = await tools();
    for (const args of [{ limit: 2.5 }, { limit: 0 }, { limit: 9_007_199_254_740_993 }, { phase: "won" }, { extra: true }]) {
      const res = await client.callTool({ name: "list_races", arguments: args });
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(text(res), JSON.stringify(args)).toMatch(/invalid|unrecognized|expected|too (big|small)/i);
    }
  });

  it("trims only the dialect and the safe-integer bounds", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        n: { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
        m: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        x: { type: "number", minimum: -Number.MAX_SAFE_INTEGER },
        list: { type: "array", items: { anyOf: [{ type: "integer", maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] } },
      },
      required: ["n"],
      additionalProperties: false,
    };
    expect(trimSchema(schema)).toEqual({
      type: "object",
      properties: {
        n: { type: "integer" },
        m: { type: "integer", minimum: 0 },
        x: { type: "number", minimum: -Number.MAX_SAFE_INTEGER },
        list: { type: "array", items: { anyOf: [{ type: "integer" }, { type: "null" }] } },
      },
      required: ["n"],
      additionalProperties: false,
    });
  });
});

describe("the registry files say what the server says", () => {
  const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as Record<string, unknown>;

  it("server.json: the same title, line, version, site and icons, and the endpoint agents connect to", async () => {
    const { client } = await tools();
    const info = client.getServerVersion()!;
    const server = read("server.json");
    expect(info).toMatchObject({ title: SERVER_TITLE, version: SERVER_VERSION, description: SERVER_DESCRIPTION, websiteUrl: TESTNET.site });
    expect(server).toMatchObject({
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: "io.github.plavutskyi/mask-wars",
      title: info.title,
      description: info.description,
      version: info.version,
      websiteUrl: info.websiteUrl,
      repository: { url: "https://github.com/plavutskyi/mask-wars", source: "github", subfolder: "apps/mcp" },
      remotes: [{ type: "streamable-http", url: ENDPOINT }],
    });
    expect(server["icons"]).toEqual(serverIcons(TESTNET.site));
    expect(info.icons).toEqual(serverIcons(TESTNET.site));
    expect(SERVER_DESCRIPTION.length).toBeLessThanOrEqual(100);
    expect(server).not.toHaveProperty("packages");
  });

  it("glama.json: the owner's GitHub account maintains the listing", () => {
    expect(read("glama.json")).toEqual({ $schema: "https://glama.ai/mcp/schemas/server.json", maintainers: ["plavutskyi"] });
  });
});
