import { describe, expect, test } from "bun:test";
import {
  extractManifestSources,
  injectManifestSources,
  isManifestSourcePath,
  partitionFiles,
} from "../src/sources.ts";
import type { WireManifest } from "../src/manifest.ts";

function v2(over: Record<string, unknown> = {}): WireManifest {
  return {
    id: "com.acme.foo",
    version: "0.1.0",
    engine_version: 2,
    sdk_version: "1.0",
    runtime_mode: "script_actor",
    resources: [],
    permissions: [],
    subscriptions: [],
    timers: [],
    ...over,
  } as WireManifest;
}

describe("isManifestSourcePath / partitionFiles", () => {
  test("classifies materialised dirs as sources, everything else as bundle", () => {
    const local = new Map<string, string>([
      ["scripts/util.lua", "/abs/scripts/util.lua"],
      ["handlers/timers/tick.lua", "/abs/handlers/timers/tick.lua"],
      ["handlers/subscriptions/job.updated.lua", "/abs/h/s.lua"],
      ["lifecycle/init.lua", "/abs/lifecycle/init.lua"],
      ["libraries/helpers.lua", "/abs/libraries/helpers.lua"],
      ["config_schema.json", "/abs/config_schema.json"],
      ["app/index.html", "/abs/app/index.html"],
    ]);
    const { bundle, sources } = partitionFiles(local);
    expect([...bundle.keys()].sort()).toEqual([
      "app/index.html",
      "config_schema.json",
      "scripts/util.lua",
    ]);
    expect([...sources.keys()].sort()).toEqual([
      "handlers/subscriptions/job.updated.lua",
      "handlers/timers/tick.lua",
      "libraries/helpers.lua",
      "lifecycle/init.lua",
    ]);
    expect(isManifestSourcePath("scripts/util.lua")).toBe(false);
    expect(isManifestSourcePath("lifecycle/init.lua")).toBe(true);
  });
});

describe("injectManifestSources", () => {
  test("injects lifecycle, timers, subscriptions, libraries into a v2 manifest", () => {
    const manifest = v2({
      timers: [{ name: "tick", every: "1m" }],
      subscriptions: [{ topic: "job.updated" }],
    });
    const injected = injectManifestSources(
      manifest,
      new Map([
        ["lifecycle/init.lua", "local config = ...\n"],
        ["lifecycle/upgrade.lua", "return {}\n"],
        ["handlers/timers/tick.lua", "-- tick handler\n"],
        ["handlers/subscriptions/job.updated.lua", "-- subscription handler\n"],
        ["libraries/utils.lua", "return { x = 1 }\n"],
      ]),
    ) as any;

    expect(injected.init_source).toBe("local config = ...\n");
    expect(injected.upgrade_source).toBe("return {}\n");
    expect(injected.shutdown_source).toBeUndefined();
    expect(injected.timers[0].source).toBe("-- tick handler\n");
    expect(injected.subscriptions[0].source).toBe("-- subscription handler\n");
    expect(injected.libraries).toEqual({ utils: "return { x = 1 }\n" });
  });

  test("file content wins over an inline source already present in the manifest", () => {
    const manifest = v2({
      timers: [{ name: "tick", every: "1m", source: "-- inline (older)\n" }],
    });
    const injected = injectManifestSources(
      manifest,
      new Map([["handlers/timers/tick.lua", "-- file (newer)\n"]]),
    ) as any;
    expect(injected.timers[0].source).toBe("-- file (newer)\n");
  });

  test("inline source is preserved when no file shadows it", () => {
    const manifest = v2({
      timers: [{ name: "tick", every: "1m", source: "-- inline only\n" }],
    });
    const injected = injectManifestSources(manifest, new Map()) as any;
    expect(injected.timers[0].source).toBe("-- inline only\n");
  });

  test("stray source file with no matching manifest entry is rejected", () => {
    const manifest = v2({ timers: [{ name: "tick", every: "1m" }] });
    expect(() =>
      injectManifestSources(
        manifest,
        new Map([["handlers/timers/old-name.lua", "-- ghost\n"]]),
      ),
    ).toThrow(/stray manifest source file/i);
  });

  test("duplicate timer names are rejected", () => {
    const manifest = v2({
      timers: [
        { name: "tick", every: "1m" },
        { name: "tick", every: "5m" },
      ],
    });
    expect(() =>
      injectManifestSources(
        manifest,
        new Map([["handlers/timers/tick.lua", "-- handler\n"]]),
      ),
    ).toThrow(/duplicate timer name/i);
  });

  test("duplicate subscription topics are rejected", () => {
    const manifest = v2({
      subscriptions: [{ topic: "job.updated" }, { topic: "job.updated" }],
    });
    expect(() =>
      injectManifestSources(
        manifest,
        new Map([["handlers/subscriptions/job.updated.lua", "-- handler\n"]]),
      ),
    ).toThrow(/duplicate subscription topic/i);
  });

  test("v1 manifest with manifest source files raises", () => {
    const v1 = {
      id: "com.acme.foo",
      version: "0.1.0",
      engine_version: 1,
      sdk_version: "1.0",
      runtime_mode: "script_actor",
      entry_script: "main.lua",
      resources: [],
      permissions: [],
    } as unknown as WireManifest;
    expect(() =>
      injectManifestSources(
        v1,
        new Map([["lifecycle/init.lua", "-- nope\n"]]),
      ),
    ).toThrow(/v2-only|engine_version is 1/i);
  });

  test("v1 manifest with no source files passes through untouched", () => {
    const v1 = {
      id: "com.acme.foo",
      version: "0.1.0",
      engine_version: 1,
      sdk_version: "1.0",
      runtime_mode: "script_actor",
      entry_script: "main.lua",
      resources: [],
      permissions: [],
    } as unknown as WireManifest;
    expect(injectManifestSources(v1, new Map())).toEqual(v1);
  });
});

describe("extractManifestSources", () => {
  test("strips inline source / libraries from a v2 manifest into a flat file map", () => {
    const manifest = v2({
      init_source: "local config = ...\n",
      shutdown_source: "ctx.log.info('bye')",
      timers: [
        { name: "tick", every: "1m", source: "-- tick\n" },
        { name: "tock", every: "5m" }, // no source
      ],
      subscriptions: [
        { topic: "job.updated", source: "-- on update\n" },
      ],
      libraries: { utils: "return {}\n" },
    });

    const { stripped, files } = extractManifestSources(manifest);

    expect(files.get("lifecycle/init.lua")).toBe("local config = ...\n");
    expect(files.get("lifecycle/shutdown.lua")).toBe("ctx.log.info('bye')\n"); // newline appended
    expect(files.has("lifecycle/upgrade.lua")).toBe(false);
    expect(files.get("handlers/timers/tick.lua")).toBe("-- tick\n");
    expect(files.has("handlers/timers/tock.lua")).toBe(false); // empty/missing source not materialised
    expect(files.get("handlers/subscriptions/job.updated.lua")).toBe("-- on update\n");
    expect(files.get("libraries/utils.lua")).toBe("return {}\n");

    const s = stripped as any;
    expect(s.init_source).toBeUndefined();
    expect(s.shutdown_source).toBeUndefined();
    expect(s.libraries).toBeUndefined();
    expect(s.timers[0].source).toBeUndefined();
    expect(s.timers[0].name).toBe("tick"); // entry preserved
    expect(s.subscriptions[0].source).toBeUndefined();
  });

  test("v1 manifest passes through untouched with empty file map", () => {
    const v1 = {
      id: "x",
      version: "1",
      engine_version: 1,
      sdk_version: "1",
      runtime_mode: "script_actor",
      entry_script: "main.lua",
      resources: [],
      permissions: [],
    } as unknown as WireManifest;
    const { stripped, files } = extractManifestSources(v1);
    expect(stripped).toEqual(v1);
    expect(files.size).toBe(0);
  });
});

describe("inject ↔ extract round-trip", () => {
  test("extract → inject reproduces the original manifest", () => {
    const original = v2({
      init_source: "local config = ...\n",
      timers: [{ name: "tick", every: "1m", source: "-- tick\n" }],
      subscriptions: [{ topic: "job.updated", source: "-- on update\n" }],
      libraries: { utils: "return {}\n" },
    });
    const { stripped, files } = extractManifestSources(original);
    const reinjected = injectManifestSources(stripped, files);
    expect(reinjected).toEqual(original);
  });
});
