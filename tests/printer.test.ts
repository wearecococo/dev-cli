import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { printManifestTs } from "../src/printer.ts";
import { loadManifest } from "../src/loader.ts";
import type { WireManifest } from "../src/manifest.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-printer-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("printManifestTs", () => {
  test("emits a manifest.ts that loads back to an equivalent wire shape", async () => {
    const wire: WireManifest = {
      id: "com.acme.foo",
      version: "0.1.0",
      engine_version: 2,
      sdk_version: "1.0",
      runtime_mode: "script_actor",
      description: "round-trip me",
      resources: [
        { id: "erp_api", type: "protocol/http", description: "ERP REST" },
      ],
      permissions: [],
      init_source: "local config = ...\nctx.log.info('init')\n",
      subscriptions: [
        { topic: "jobs.created", source: "-- on created\n" },
      ],
      timers: [
        { name: "tick", every: "1m", source: "-- tick\n" },
      ],
      libraries: { utils: "return {}\n" } as any,
    };

    // Write the printed manifest.ts plus the materialised .lua files the
    // generated luaFile() refs point at.
    const printed = printManifestTs(wire);
    // Replace the package import spec with a direct pointer to src/define.ts
    // so the test's tempdir doesn't need a node_modules.
    const rewritten = printed.replace(
      /"@wearecococo\/dev-cli\/define"/g,
      JSON.stringify(absDefineImportSpec()),
    );

    writeFile(join(root, "manifest.ts"), rewritten);
    writeFile(join(root, "lifecycle/init.lua"), wire.init_source as string);
    writeFile(join(root, "handlers/timers/tick.lua"), (wire.timers as any)[0].source);
    writeFile(
      join(root, "handlers/subscriptions/jobs.created.lua"),
      (wire.subscriptions as any)[0].source,
    );
    writeFile(join(root, "libraries/utils.lua"), (wire.libraries as any).utils);

    const loaded = await loadManifest(root);
    const m = loaded.manifest as any;

    expect(loaded.format).toBe("ts");
    expect(m.id).toBe("com.acme.foo");
    expect(m.version).toBe("0.1.0");
    expect(m.engine_version).toBe(2);
    expect(m.sdk_version).toBe("1.0");
    expect(m.runtime_mode).toBe("script_actor");
    expect(m.description).toBe("round-trip me");
    expect(m.resources[0]).toEqual({
      id: "erp_api",
      type: "protocol/http",
      description: "ERP REST",
    });
    expect(m.init_source).toBe("local config = ...\nctx.log.info('init')\n");
    expect(m.subscriptions[0]).toEqual({
      topic: "jobs.created",
      source: "-- on created\n",
    });
    expect(m.timers[0]).toEqual({
      name: "tick",
      every: "1m",
      source: "-- tick\n",
    });
    expect(m.libraries).toEqual({ utils: "return {}\n" });
  });

  test("rejects v1 manifests — manifest.ts is v2-only", () => {
    const wire: WireManifest = {
      id: "com.acme.foo",
      version: "0.1.0",
      engine_version: 1,
      sdk_version: "1.0",
      runtime_mode: "script_actor",
      entry_script: "main.lua",
      resources: [],
      permissions: [],
    };
    expect(() => printManifestTs(wire)).toThrow(/v2-only|--format yaml/i);
  });
});

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function absDefineImportSpec(): string {
  return new URL("../src/define.ts", import.meta.url).pathname;
}
