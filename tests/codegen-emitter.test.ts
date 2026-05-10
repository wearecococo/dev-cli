import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { emitNodeTypes } from "../src/codegen/schema-emitter.ts";
import { extractNodeSchemas } from "../src/codegen/extract-node-schemas.ts";
import type { NodeSchemaMap } from "../src/codegen/extract-node-schemas.ts";

const FIXTURE_DIR = "tests/fixtures/node-schemas";

function loadFixture(type: string): Record<string, unknown> {
  const raw = readFileSync(join(FIXTURE_DIR, `${type}.json`), "utf8");
  return JSON.parse(raw);
}

function emit(schemas: NodeSchemaMap): string {
  return emitNodeTypes(schemas, { digest: "test" });
}

describe("emitNodeTypes — per-pattern coverage", () => {
  test("empty config (split) → Record<string, never>", () => {
    const out = emit({ split: loadFixture("split") });
    expect(out).toContain(`split: Record<string, never>;`);
  });

  test("simple flat (http_request) — required vs optional, enum, plain string", () => {
    const out = emit({ http_request: loadFixture("http_request") });
    // deviceId is required (no `?`), enum method, optional path/body etc.
    expect(out).toMatch(/deviceId: string;/);
    expect(out).toMatch(/method\?: "GET" \| "POST" \| "PUT" \| "DELETE" \| "PATCH";/);
    expect(out).toMatch(/path\?: string;/);
    expect(out).toMatch(/body\?: string;/);
    expect(out).toMatch(/headers\?: Record<string, unknown>;/);
  });

  test("oneOf script-style → union with each branch having a different required key", () => {
    const out = emit({ script: loadFixture("script") });
    // Three branches: scriptId required / scriptName required / inline required
    // (with the others optional in each).
    expect(out).toMatch(/scriptId: string;/);
    expect(out).toMatch(/scriptName: string;/);
    expect(out).toMatch(/inline: string \| LuaFileMarker;/);
    // `timeout` is never in any required list — always optional.
    expect(out).toMatch(/timeout\?: number;/);
    // The branches join with ` | `.
    expect(out).toContain(" | {");
    // LuaFileMarker import emitted.
    expect(out).toContain(`import type { LuaFileMarker } from "@wearecococo/dev-cli/define";`);
  });

  test("oneOf join-style → strategy enum narrowed per branch, keys required only in keyed branch", () => {
    const out = emit({ join: loadFixture("join") });
    // Each branch narrows strategy to a single literal.
    expect(out).toContain(`strategy: "merge"`);
    expect(out).toContain(`strategy: "array"`);
    expect(out).toContain(`strategy: "keyed"`);
  });

  test("array-of-object (switch.cases) → Array<{...}>", () => {
    const out = emit({ switch: loadFixture("switch") });
    expect(out).toContain(`cases: Array<{`);
    expect(out).toMatch(/name: string;/);
    expect(out).toMatch(/expression: Record<string, unknown>;/);
    expect(out).toMatch(/default\?: string;/);
  });

  test("array-of-string (csv_parse.columns) → string[]/Array<string>", () => {
    const out = emit({ csv_parse: loadFixture("csv_parse") });
    expect(out).toMatch(/columns\?: Array<string>;/);
  });

  test("x-enum (task.priority) → plain string (advisory only, not enforced)", () => {
    const out = emit({ task: loadFixture("task") });
    // priority should be `string`, not a literal union — server doesn't enforce.
    expect(out).toMatch(/priority\?: string;/);
    expect(out).not.toMatch(/priority\?: "low" \| "normal"/);
  });

  test("type: object with no properties (condition.expression) → Record<string, unknown>", () => {
    const out = emit({ condition: loadFixture("condition") });
    expect(out).toMatch(/expression: Record<string, unknown>;/);
  });

  test("LuaFileMarker import only emitted when at least one schema uses a lua field", () => {
    // split has no lua field; http_request has none either.
    const noLua = emit({
      split: loadFixture("split"),
      http_request: loadFixture("http_request"),
    });
    expect(noLua).not.toContain(`LuaFileMarker`);
  });

  test("file header carries the schema digest", () => {
    const out = emitNodeTypes({ split: loadFixture("split") }, { digest: "abc123" });
    expect(out).toMatch(/^\/\/ AUTO-GENERATED/);
    expect(out).toContain("Schema digest: abc123");
  });
});

describe("emitNodeTypes — full registry against live fixtures", () => {
  test("emits a registry covering every captured node type", () => {
    const types = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
      .map((f) => f.replace(/\.json$/, ""));

    const schemas: NodeSchemaMap = {};
    for (const t of types) schemas[t] = loadFixture(t);

    const out = emit(schemas);

    // Module augmentation header.
    expect(out).toContain(`declare module "@wearecococo/dev-cli/define"`);
    expect(out).toContain(`interface NodeTypeRegistry`);

    // Every type appears as a registry key.
    for (const t of types) {
      expect(out).toContain(`${t}: `);
    }

    // Sanity: no `unknown` leaks except in the explicit Record<string, unknown> cases.
    expect(out).not.toMatch(/: unknown[;,\n]/);
  });
});

describe("extractNodeSchemas → emitNodeTypes integration", () => {
  test("the raw workflow schema → emitter produces a non-trivial registry", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "_workflow-schema.raw.json"), "utf8");
    const schemas = extractNodeSchemas(raw);
    expect(Object.keys(schemas).length).toBeGreaterThan(20);
    const out = emit(schemas);
    expect(out).toContain(`script: `);
    expect(out).toContain(`http_request: `);
    expect(out).toContain(`split: Record<string, never>;`);
  });
});
