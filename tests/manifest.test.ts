import { describe, expect, test } from "bun:test";
import {
  buildInitialManifest,
  buildInitialManifestV1,
  buildInitialManifestV2,
  manifestEngineVersion,
  manifestFromGraphql,
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

  test("rejects an unsupported engine_version", () => {
    expect(() =>
      parseManifest(`id: com.acme.foo\nversion: 0.1.0\nengine_version: 7\n`),
    ).toThrow(/engine_version/i);
  });

  test("preserves nested snake_case fields (v1)", () => {
    const m = parseManifest(`
id: com.acme.foo
version: 0.1.0
engine_version: 1
sdk_version: "1.0"
runtime_mode: script_actor
entry_script: main.lua
timers:
  - name: tick
    every: 1m
subscriptions:
  - topic: jobs.created
`);
    expect((m as any).engine_version).toBe(1);
    expect((m as any).sdk_version).toBe("1.0");
    expect((m as any).entry_script).toBe("main.lua");
    expect((m as any).timers[0].name).toBe("tick");
    expect((m as any).subscriptions[0].topic).toBe("jobs.created");
  });

  test("preserves v2 inline source + libraries map", () => {
    const m = parseManifest(`
id: com.acme.foo
version: 0.1.0
engine_version: 2
init_source: |
  local config = ...
timers:
  - name: tick
    every: 1m
    source: |
      local name, config = ...
libraries:
  helper: "return {}"
`);
    expect((m as any).engine_version).toBe(2);
    expect((m as any).init_source).toContain("local config = ...");
    expect((m as any).timers[0].source).toContain("local name, config = ...");
    expect((m as any).libraries.helper).toBe("return {}");
  });
});

describe("serializeManifest / parseManifest roundtrip", () => {
  test("a v1 manifest survives serialize → parse", () => {
    const original = buildInitialManifestV1("com.acme.foo", "1.2.3");
    (original as any).description = "round-trip me";
    (original as any).timers = [{ name: "tick", every: "5m" }];
    const yaml = serializeManifest(original);
    const parsed = parseManifest(yaml);
    expect(parsed).toEqual(original);
  });

  test("a v2 manifest survives serialize → parse", () => {
    const original = buildInitialManifestV2("com.acme.foo", "1.2.3");
    (original as any).libraries = { helper: "return {}" };
    const yaml = serializeManifest(original);
    const parsed = parseManifest(yaml);
    expect(parsed).toEqual(original);
  });
});

describe("manifestToWire", () => {
  test("strips the local-only engine_version marker", () => {
    const m = buildInitialManifestV2("com.acme.foo", "0.1.0");
    const wire = JSON.parse(manifestToWire(m));
    expect(wire.engine_version).toBeUndefined();
    expect(wire.id).toBe("com.acme.foo");
    expect(wire.timers[0].name).toBe("heartbeat");
  });

  test("v2 libraries map travels as a nested JSON object on the wire", () => {
    const m = buildInitialManifestV2("com.acme.foo", "0.1.0");
    (m as any).libraries = { helper: "return 1" };
    const wire = JSON.parse(manifestToWire(m));
    expect(wire.libraries).toEqual({ helper: "return 1" });
  });
});

describe("manifestEngineVersion", () => {
  test("defaults to 1 when engine_version is absent (legacy YAML compat)", () => {
    // engine_version was added when v2 shipped — any manifest.yaml without
    // it pre-dates v2 and is therefore a v1 integration.
    expect(manifestEngineVersion({ id: "x", version: "1" } as any)).toBe(1);
  });

  test("respects an explicit engine_version: 1", () => {
    expect(
      manifestEngineVersion({ id: "x", version: "1", engine_version: 1 } as any),
    ).toBe(1);
  });

  test("respects an explicit engine_version: 2", () => {
    expect(
      manifestEngineVersion({ id: "x", version: "1", engine_version: 2 } as any),
    ).toBe(2);
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
  test("defaults to v2 with a heartbeat timer (handler materialised by init)", () => {
    const m = buildInitialManifest("com.acme.foo", "0.1.0") as any;
    expect(m.engine_version).toBe(2);
    expect(m.runtime_mode).toBe("script_actor");
    expect(m.entry_script).toBeUndefined();
    expect(m.timers[0].name).toBe("heartbeat");
    // Source lives on disk at handlers/timers/heartbeat.lua, not inline.
    expect(m.timers[0].source).toBeUndefined();
  });

  test("v1 keeps the entry-script + exports starter shape", () => {
    const m = buildInitialManifest("com.acme.foo", "0.1.0", 1) as any;
    expect(m.engine_version).toBe(1);
    expect(m.entry_script).toBe("main.lua");
    expect(m.subscriptions).toEqual([]);
    expect(m.timers).toEqual([]);
  });
});

describe("manifestFromGraphql", () => {
  test("v1 round-trip strips v2-only fields and sets engine_version", () => {
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
      libraries: '{"unused":"x"}', // v2-only — must not surface on a v1 manifest
      initSource: "ignored",
    } as any;
    const wire = manifestFromGraphql(camel, 1) as any;
    expect(wire.engine_version).toBe(1);
    expect(wire.entry_script).toBe("main.lua");
    expect(wire.libraries).toBeUndefined();
    expect(wire.init_source).toBeUndefined();
    expect(wire.description).toBeUndefined(); // null dropped
    expect(wire.timers).toEqual([{ name: "tick" }]);
  });

  test("v2 round-trip decodes the libraries JSON string and drops entryScript", () => {
    const camel = {
      id: "com.acme.foo",
      version: "0.1.0",
      sdkVersion: "1.0",
      runtimeMode: "script_actor",
      entryScript: null, // v2 — server may still send null
      resources: [],
      permissions: [],
      timers: [{ name: "tick", source: "local name, config = ..." }],
      initSource: "local config = ...",
      libraries: '{"helper":"return {}"}',
    } as any;
    const wire = manifestFromGraphql(camel, 2) as any;
    expect(wire.engine_version).toBe(2);
    expect(wire.entry_script).toBeUndefined();
    expect(wire.init_source).toBe("local config = ...");
    expect(wire.libraries).toEqual({ helper: "return {}" });
    expect(wire.timers[0].source).toContain("local name, config");
  });

  test("v2 with empty libraries surfaces an empty object", () => {
    const camel = {
      id: "x",
      version: "1",
      sdkVersion: "1",
      resources: [],
      permissions: [],
      libraries: "",
    } as any;
    const wire = manifestFromGraphql(camel, 2) as any;
    expect(wire.libraries).toEqual({});
  });
});
