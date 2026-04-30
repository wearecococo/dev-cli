import { describe, expect, test } from "bun:test";
import {
  buildInitialManifest,
  manifestToWire,
  parseManifest,
  serializeManifest,
  shortName,
} from "../src/manifest.ts";

describe("parseManifest", () => {
  test("parses a minimal valid manifest", () => {
    const m = parseManifest(`id: com.acme.foo\nversion: 0.1.0\n`);
    expect(m.id).toBe("com.acme.foo");
    expect(m.version).toBe("0.1.0");
  });

  test("rejects manifest without id", () => {
    expect(() => parseManifest(`version: 0.1.0\n`)).toThrow(/id.*required/i);
  });

  test("rejects manifest without version", () => {
    expect(() => parseManifest(`id: com.acme.foo\n`)).toThrow(/version.*required/i);
  });

  test("rejects scalar YAML root", () => {
    expect(() => parseManifest(`hello\n`)).toThrow(/object/i);
  });

  test("preserves nested snake_case fields", () => {
    const m = parseManifest(`
id: com.acme.foo
version: 0.1.0
sdk_version: "1.0"
runtime_mode: script_actor
entry_script: main.lua
timers:
  - name: tick
    every: 1m
subscriptions:
  - topic: jobs.created
`);
    expect((m as any).sdk_version).toBe("1.0");
    expect((m as any).entry_script).toBe("main.lua");
    expect((m as any).timers[0].name).toBe("tick");
    expect((m as any).subscriptions[0].topic).toBe("jobs.created");
  });
});

describe("serializeManifest / parseManifest roundtrip", () => {
  test("a manifest survives serialize → parse", () => {
    const original = buildInitialManifest("com.acme.foo", "1.2.3");
    (original as any).description = "round-trip me";
    (original as any).timers = [{ name: "tick", every: "5m" }];
    const yaml = serializeManifest(original);
    const parsed = parseManifest(yaml);
    expect(parsed).toEqual(original);
  });
});

describe("manifestToWire", () => {
  test("produces JSON the server can consume", () => {
    const m = buildInitialManifest("com.acme.foo", "0.1.0");
    const wire = manifestToWire(m);
    expect(JSON.parse(wire)).toEqual(m);
  });
});

describe("shortName", () => {
  test("returns last reverse-domain segment", () => {
    expect(shortName("com.acme.foo")).toBe("foo");
    expect(shortName("custom.icelink-bridge")).toBe("icelink-bridge");
  });

  test("returns the whole id if there's no dot", () => {
    expect(shortName("noDots")).toBe("noDots");
  });
});

describe("buildInitialManifest", () => {
  test("script_actor defaults are snake_case and use bare entry_script", () => {
    const m = buildInitialManifest("com.acme.foo", "0.1.0") as any;
    expect(m.runtime_mode).toBe("script_actor");
    expect(m.entry_script).toBe("main.lua");
    expect(m.sdk_version).toBe("1.0");
    expect(m.subscriptions).toEqual([]);
    expect(m.timers).toEqual([]);
  });
});

describe("manifestFromGraphql", () => {
  test("converts camelCase GraphQL response to snake_case wire shape", async () => {
    const { manifestFromGraphql } = await import("../src/manifest.ts");
    const camel = {
      id: "com.acme.foo",
      version: "0.1.0",
      sdkVersion: "1.0",
      runtimeMode: "script_actor",
      entryScript: "main.lua",
      resources: [],
      permissions: [],
      description: null,
      timers: [{ name: "tick" }],
    } as any;
    const wire = manifestFromGraphql(camel) as any;
    expect(wire.sdk_version).toBe("1.0");
    expect(wire.runtime_mode).toBe("script_actor");
    expect(wire.entry_script).toBe("main.lua");
    expect(wire.description).toBeUndefined(); // null dropped
    expect(wire.timers).toEqual([{ name: "tick" }]);
  });
});
