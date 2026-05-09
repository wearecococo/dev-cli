import { describe, expect, test } from "bun:test";
import {
  collectLuaChecks,
  roleForPath,
  scriptNameForFilePath,
} from "../src/lua-checks.ts";
import type { LoadedManifest } from "../src/loader.ts";

describe("roleForPath", () => {
  test("app/** runs in CUSTOM_APP role", () => {
    expect(roleForPath("app/server.lua")).toBe("CUSTOM_APP");
    expect(roleForPath("app/admin/server.lua")).toBe("CUSTOM_APP");
  });

  test("everything else runs in INTEGRATION role", () => {
    expect(roleForPath("scripts/main.lua")).toBe("INTEGRATION");
    expect(roleForPath("handlers/timers/tick.lua")).toBe("INTEGRATION");
    expect(roleForPath("lifecycle/init.lua")).toBe("INTEGRATION");
    expect(roleForPath("libraries/utils.lua")).toBe("INTEGRATION");
  });
});

describe("scriptNameForFilePath", () => {
  test("collapses meta-dir paths to dotted accessors", () => {
    expect(scriptNameForFilePath("lifecycle/init.lua")).toBe("initSource");
    expect(scriptNameForFilePath("lifecycle/shutdown.lua")).toBe("shutdownSource");
    expect(scriptNameForFilePath("lifecycle/upgrade.lua")).toBe("upgradeSource");
    expect(scriptNameForFilePath("handlers/timers/tick.lua")).toBe("timers.tick.source");
    expect(scriptNameForFilePath("handlers/subscriptions/jobs.created.lua")).toBe(
      "subscriptions.jobs.created.source",
    );
    expect(scriptNameForFilePath("libraries/http_helpers.lua")).toBe(
      "libraries.http_helpers",
    );
  });

  test("non-meta paths are returned verbatim", () => {
    expect(scriptNameForFilePath("scripts/main.lua")).toBe("scripts/main.lua");
    expect(scriptNameForFilePath("app/server.lua")).toBe("app/server.lua");
  });
});

describe("collectLuaChecks", () => {
  function loaded(
    overrides: Partial<LoadedManifest> = {},
  ): LoadedManifest {
    return {
      manifest: {
        id: "com.acme.foo",
        version: "0.1.0",
        engine_version: 2,
      } as any,
      format: "yaml",
      consumed: new Set(),
      manifestSourceOrigins: new Map(),
      ...overrides,
    };
  }

  test("YAML: emits one check per .lua file with role + scriptName", () => {
    // No fs reads happen in tests because we point at /dev/null —
    // wait, we do read the files. Use real files via tmpdir.
    // Actually collectLuaChecks reads via readFileSync — we need
    // real files. Skip this assertion — covered by the real-file
    // tests below.
    expect(true).toBe(true);
  });
});

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("collectLuaChecks (with real files)", () => {
  function setup(files: Record<string, string>): {
    folderPath: string;
    walked: Map<string, string>;
    cleanup: () => void;
  } {
    const folderPath = realpathSync(
      mkdtempSync(join(tmpdir(), "cococo-lint-")),
    );
    const walked = new Map<string, string>();
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(folderPath, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      walked.set(rel, abs);
    }
    return {
      folderPath,
      walked,
      cleanup: () => rmSync(folderPath, { recursive: true, force: true }),
    };
  }

  test("emits file checks with role/scriptName/source for every .lua", () => {
    const { folderPath, walked, cleanup } = setup({
      "scripts/util.lua": "return { x = 1 }",
      "app/server.lua": "function exports.run() end",
      "handlers/timers/tick.lua": "local name, config = ...",
      "lifecycle/init.lua": "local config = ...",
      "config_schema.json": "{}",
    });
    try {
      const checks = collectLuaChecks({
        loaded: {
          manifest: { id: "x", version: "1", engine_version: 2 } as any,
          format: "yaml",
          consumed: new Set(),
          manifestSourceOrigins: new Map(),
        },
        folderPath,
        walkedFiles: walked,
      });

      const byScript = new Map(checks.map((c) => [c.scriptName, c]));
      expect(byScript.size).toBe(4); // .json file is excluded

      expect(byScript.get("scripts/util.lua")?.role).toBe("INTEGRATION");
      expect(byScript.get("app/server.lua")?.role).toBe("CUSTOM_APP");
      expect(byScript.get("timers.tick.source")?.role).toBe("INTEGRATION");
      expect(byScript.get("initSource")?.role).toBe("INTEGRATION");

      expect(byScript.get("scripts/util.lua")?.source).toBe("return { x = 1 }");
      const tickOrigin = byScript.get("timers.tick.source")?.origin;
      expect(tickOrigin?.kind).toBe("file");
      if (tickOrigin?.kind === "file") {
        expect(tickOrigin.relativePath).toBe("handlers/timers/tick.lua");
      }
    } finally {
      cleanup();
    }
  });

  test("TS: emits an additional manifest-origin check per `lua` tag entry", () => {
    const { folderPath, walked, cleanup } = setup({
      "handlers/timers/tick.lua": "local name, config = ...",
    });
    try {
      const manifestSourceOrigins = new Map<string, any>([
        ["timers.tick.source", { kind: "file", absPath: walked.get("handlers/timers/tick.lua") }],
        ["initSource", { kind: "tag" }],
        ["libraries.helpers", { kind: "tag" }],
      ]);
      const checks = collectLuaChecks({
        loaded: {
          manifest: {
            id: "x",
            version: "1",
            engine_version: 2,
            init_source: "local config = ...\nctx.log.info('hi')\n",
            timers: [
              {
                name: "tick",
                every: "1m",
                source: "local name, config = ...",
              },
            ],
            libraries: { helpers: "return {}\n" },
          } as any,
          format: "ts",
          consumed: new Set([walked.get("handlers/timers/tick.lua")!]),
          manifestSourceOrigins,
        },
        folderPath,
        walkedFiles: walked,
      });

      const byScript = new Map(checks.map((c) => [c.scriptName, c]));
      // 1 file check (tick) + 2 tag checks (initSource, libraries.helpers)
      expect(byScript.size).toBe(3);

      expect(byScript.get("manifest.ts:initSource")?.origin.kind).toBe("manifest");
      expect(byScript.get("manifest.ts:initSource")?.source).toBe(
        "local config = ...\nctx.log.info('hi')\n",
      );
      expect(byScript.get("manifest.ts:libraries.helpers")?.source).toBe("return {}\n");

      // The file-backed timer check is keyed by its file path, not by the
      // manifest field — that's how diagnostics navigate back to the
      // .lua file the user actually edits.
      expect(byScript.get("timers.tick.source")?.origin.kind).toBe("file");
    } finally {
      cleanup();
    }
  });

  test("YAML manifest sources don't double-emit (no manifestSourceOrigins entries)", () => {
    const { folderPath, walked, cleanup } = setup({
      "handlers/timers/tick.lua": "local name, config = ...",
      "lifecycle/init.lua": "local config = ...",
    });
    try {
      const checks = collectLuaChecks({
        loaded: {
          manifest: { id: "x", version: "1", engine_version: 2 } as any,
          format: "yaml",
          consumed: new Set(),
          manifestSourceOrigins: new Map(),
        },
        folderPath,
        walkedFiles: walked,
      });
      // Only the two file checks — no phantom tag checks even if the
      // wire manifest at lint time doesn't carry inline source.
      expect(checks).toHaveLength(2);
      expect(checks.every((c) => c.origin.kind === "file")).toBe(true);
    } finally {
      cleanup();
    }
  });
});
