import { describe, expect, test } from "bun:test";
import {
  buildClaudeAddArgs,
  deriveSwaggerName,
  slugify,
} from "../src/commands/mcp-add.ts";
import type { SwaggerSpec } from "../src/mcp/swagger-server.ts";

describe("slugify", () => {
  test("lowercases and dasherizes", () => {
    expect(slugify("Acme Pet Store API")).toBe("acme-pet-store-api");
  });

  test("collapses non-alphanumeric runs and trims edges", () => {
    expect(slugify("  Foo / Bar — v2!  ")).toBe("foo-bar-v2");
  });

  test("clamps length to 60 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long)).toHaveLength(60);
  });
});

describe("deriveSwaggerName", () => {
  test("uses the spec title when present", () => {
    const spec: SwaggerSpec = { openapi: "3.0.0", info: { title: "Petstore API" } };
    expect(deriveSwaggerName(spec, "/tmp/anything.json")).toBe("petstore-api");
  });

  test("falls back to the filename stem when title is missing", () => {
    const spec: SwaggerSpec = { openapi: "3.0.0", info: {} };
    expect(deriveSwaggerName(spec, "/tmp/My-Cool_API.yaml")).toBe("my-cool-api");
  });

  test("handles empty title by falling back", () => {
    const spec: SwaggerSpec = { openapi: "3.0.0", info: { title: "   " } };
    expect(deriveSwaggerName(spec, "/tmp/billing.json")).toBe("billing");
  });

  test("ultimate fallback if everything is unslugifiable", () => {
    const spec: SwaggerSpec = { openapi: "3.0.0" };
    expect(deriveSwaggerName(spec, "/tmp/!!!.json")).toBe("swagger");
  });
});

describe("buildClaudeAddArgs", () => {
  test("emits stdio transport, name, and the bunx command after --", () => {
    expect(
      buildClaudeAddArgs({ name: "petstore", specPath: "/abs/path/swagger.json" }),
    ).toEqual([
      "mcp",
      "add",
      "--transport",
      "stdio",
      "petstore",
      "--",
      "bunx",
      "cococo",
      "mcp",
      "swagger",
      "/abs/path/swagger.json",
    ]);
  });

  test("includes scope flag when provided", () => {
    expect(
      buildClaudeAddArgs({
        name: "petstore",
        scope: "project",
        specPath: "/abs/swagger.json",
      }),
    ).toEqual([
      "mcp",
      "add",
      "--transport",
      "stdio",
      "--scope",
      "project",
      "petstore",
      "--",
      "bunx",
      "cococo",
      "mcp",
      "swagger",
      "/abs/swagger.json",
    ]);
  });

  test("omits scope flag when not provided", () => {
    const args = buildClaudeAddArgs({ name: "x", specPath: "/p" });
    expect(args).not.toContain("--scope");
  });
});
