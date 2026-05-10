import { describe, expect, test } from "bun:test";
import { defineNode, defineWorkflow, luaFile } from "../src/define.ts";

/**
 * Type-level test for `defineNode` and the inline-array form on
 * `defineWorkflow`. These tests pass when the file *compiles* — the
 * runtime assertions are mostly sanity checks. Real coverage comes
 * from the `@ts-expect-error` markers below: if the registry lookup
 * fails to narrow `config`, those lines compile and the test file
 * fails to compile.
 */

describe("defineNode — registry-driven config typing", () => {
  test("http_request narrows config to deviceId/method/path/etc.", () => {
    const node = defineNode({
      id: "fetch",
      name: "Fetch orders",
      type: "http_request",
      config: {
        deviceId: "dev_xyz",
        method: "GET",
        path: "/orders",
      },
    });
    expect(node.type).toBe("http_request");
    expect(node.config?.method).toBe("GET");
  });

  test("script accepts luaFile() in the inline branch (string | LuaFileMarker)", () => {
    const node = defineNode({
      id: "transform",
      name: "Transform",
      type: "script",
      config: { inline: luaFile("./transform.lua") },
    });
    expect(node.type).toBe("script");
  });

  test("script accepts a plain string in the inline branch", () => {
    const node = defineNode({
      id: "transform",
      name: "Transform",
      type: "script",
      config: { inline: "return 1" },
    });
    expect(node.type).toBe("script");
  });

  test("script accepts the scriptName branch (oneOf discriminator)", () => {
    const node = defineNode({
      id: "named",
      name: "Named",
      type: "script",
      config: { scriptName: "shared/parser" },
    });
    expect(node.type).toBe("script");
  });

  test("split has empty config (Record<string, never>)", () => {
    const node = defineNode({
      id: "fan",
      name: "Fan out",
      type: "split",
      config: {},
    });
    expect(node.type).toBe("split");
  });

  test("inline nodes: [...] form on defineWorkflow gets the same typing", () => {
    const wf = defineWorkflow({
      handle: "demo",
      nodes: [
        {
          id: "fetch",
          name: "Fetch",
          type: "http_request",
          config: { deviceId: "d1", method: "POST", body: "hello" },
        },
        {
          id: "x",
          name: "Transform",
          type: "transform",
          config: { mapping: { id: "$.input.id" } },
        },
      ],
      edges: [{ id: "e1", from: "fetch", to: "x" }],
    });
    expect(wf.nodes).toHaveLength(2);
  });

  test("unregistered node types still compile via the WorkflowNode fallback", () => {
    const wf = defineWorkflow({
      handle: "demo",
      nodes: [
        // `trigger` isn't in the registry; falls through to base WorkflowNode.
        { id: "start", name: "Start", type: "trigger", config: {} },
      ],
      edges: [],
    });
    expect(wf.nodes[0]!.type).toBe("trigger");
  });

  test("compile-time rejection: wrong enum value on http_request.method", () => {
    // @ts-expect-error — TRACE is not a valid HTTP method in the registry
    defineNode({ id: "x", name: "X", type: "http_request", config: { deviceId: "d", method: "TRACE" } });
    expect(true).toBe(true);
  });

  test("compile-time rejection: missing required field on http_request", () => {
    // @ts-expect-error — deviceId is required
    defineNode({ id: "x", name: "X", type: "http_request", config: { method: "GET" } });
    expect(true).toBe(true);
  });

  test("compile-time rejection: unknown extra key on a typed config", () => {
    // @ts-expect-error — `bogus` isn't a property of http_request config
    defineNode({ id: "x", name: "X", type: "http_request", config: { deviceId: "d", bogus: 1 } });
    expect(true).toBe(true);
  });
});
