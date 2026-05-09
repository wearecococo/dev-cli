import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../src/loader.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-loader-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadManifest", () => {
  test("loads a TS manifest, resolves luaFile() refs, normalises to snake_case", async () => {
    mkdirSync(join(root, "handlers", "timers"), { recursive: true });
    writeFileSync(
      join(root, "handlers", "timers", "tick.lua"),
      `local name, config = ...\nctx.log.info("tick")\n`,
    );
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineIntegration, lua, luaFile } from "${absDefineImportSpec()}";

export default defineIntegration({
  id: "com.acme.foo",
  version: "0.1.0",
  engineVersion: 2,
  sdkVersion: "1.0",
  runtimeMode: "script_actor",
  resources: [],
  permissions: [],
  initSource: lua\`
    local config = ...
    ctx.log.info("starting")
  \`,
  timers: [
    { name: "tick", every: "1m", source: luaFile("./handlers/timers/tick.lua") },
  ],
});
`,
    );

    const loaded = await loadManifest(root);
    expect(loaded.format).toBe("ts");
    const m = loaded.manifest as any;
    expect(m.id).toBe("com.acme.foo");
    expect(m.engine_version).toBe(2);
    expect(m.sdk_version).toBe("1.0");
    expect(m.runtime_mode).toBe("script_actor");
    expect(m.init_source).toBe(`local config = ...\nctx.log.info("starting")\n`);
    expect(m.timers[0].source).toBe(`local name, config = ...\nctx.log.info("tick")\n`);
    expect(loaded.consumed.size).toBe(1);
    expect([...loaded.consumed][0]).toContain("handlers/timers/tick.lua");
  });

  test("falls back to manifest.yaml when no manifest.ts is present", async () => {
    writeFileSync(
      join(root, "manifest.yaml"),
      `id: com.acme.foo\nversion: 0.1.0\nengine_version: 1\nentry_script: main.lua\n`,
    );
    const loaded = await loadManifest(root);
    expect(loaded.format).toBe("yaml");
    expect((loaded.manifest as any).engine_version).toBe(1);
    expect(loaded.consumed.size).toBe(0);
  });

  test("refuses when both manifest.ts and manifest.yaml exist", async () => {
    writeFileSync(join(root, "manifest.ts"), `export default {};`);
    writeFileSync(join(root, "manifest.yaml"), `id: x\nversion: 1\n`);
    await expect(loadManifest(root)).rejects.toThrow(/both manifest.ts and manifest.yaml/i);
  });

  test("surfaces a clear error when luaFile() references a missing file", async () => {
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineIntegration, luaFile } from "${absDefineImportSpec()}";

export default defineIntegration({
  id: "com.acme.foo",
  version: "0.1.0",
  engineVersion: 2,
  sdkVersion: "1.0",
  runtimeMode: "script_actor",
  resources: [],
  permissions: [],
  timers: [
    { name: "tick", every: "1m", source: luaFile("./handlers/timers/missing.lua") },
  ],
});
`,
    );
    await expect(loadManifest(root)).rejects.toThrow(/luaFile.*could not be read/i);
  });

  test("rejects a TS manifest that declares engineVersion: 1", async () => {
    // The TS author surface only types V2; a v1 spec can only get through
    // by `as any` / casting. The loader catches it at runtime so the
    // failure mode is a clear error rather than a malformed wire payload.
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineIntegration } from "${absDefineImportSpec()}";

export default defineIntegration({
  id: "com.acme.foo",
  version: "0.1.0",
  engineVersion: 1,
  sdkVersion: "1.0",
  runtimeMode: "script_actor",
  resources: [],
  permissions: [],
} as any);
`,
    );
    await expect(loadManifest(root)).rejects.toThrow(/manifest\.ts is v2-only/i);
  });
});

/**
 * The test files are written into a tempdir that has no node_modules and
 * isn't part of the package's import graph, so `@wearecococo/dev-cli/define`
 * doesn't resolve from there. Use an absolute path to src/define.ts so
 * `import()` resolves regardless of where the tempdir sits.
 */
function absDefineImportSpec(): string {
  return new URL("../src/define.ts", import.meta.url).pathname;
}
