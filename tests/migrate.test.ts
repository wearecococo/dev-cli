import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpMinor, prepareV2Skeleton } from "../src/commands/migrate.ts";

let root: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-migrate-")));
  process.chdir(root);
  // assertDevCliResolvable walks up looking for a package.json that
  // declares @wearecococo/dev-cli — give the test root a minimal one
  // so migrate's pre-flight passes.
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "consumer-repo",
      devDependencies: { "@wearecococo/dev-cli": "github:..." },
    }),
  );
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("bumpMinor", () => {
  test("0.1.0 → 0.2.0", () => {
    expect(bumpMinor("0.1.0")).toBe("0.2.0");
  });

  test("1.4.7 → 1.5.0 (resets patch)", () => {
    expect(bumpMinor("1.4.7")).toBe("1.5.0");
  });

  test("strips pre-release / build metadata", () => {
    expect(bumpMinor("1.2.3-alpha.4+build")).toBe("1.3.0");
  });

  test("rejects unparseable versions", () => {
    expect(() => bumpMinor("v1")).toThrow(/unparseable/i);
    expect(() => bumpMinor("not.a.version")).toThrow(/unparseable/i);
  });
});

describe("prepareV2Skeleton — pre-flight", () => {
  function scaffold(yaml: string, mainLua: string | null = "exports = {}\n"): string {
    const folder = join(root, "integrations", "demo");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "manifest.yaml"), yaml);
    if (mainLua !== null) {
      mkdirSync(join(folder, "scripts"));
      writeFileSync(join(folder, "scripts", "main.lua"), mainLua);
    }
    return folder;
  }

  test("refuses if scripts/main.lua is missing", () => {
    scaffold(
      `id: com.acme.demo\nversion: 0.1.0\nengine_version: 1\nentry_script: main.lua\n`,
      null,
    );
    expect(() => prepareV2Skeleton("demo")).toThrow(/scripts\/main\.lua/i);
  });

  test("refuses if engine_version is already 2", () => {
    scaffold(`id: com.acme.demo\nversion: 0.1.0\nengine_version: 2\n`);
    expect(() => prepareV2Skeleton("demo")).toThrow(/already migrated/i);
  });

  test("refuses if the _v2 sibling already exists", () => {
    scaffold(
      `id: com.acme.demo\nversion: 0.1.0\nengine_version: 1\nentry_script: main.lua\n`,
    );
    mkdirSync(join(root, "integrations", "demo_v2"));
    writeFileSync(join(root, "integrations", "demo_v2", ".keep"), "");
    expect(() => prepareV2Skeleton("demo")).toThrow(/already exists/i);
  });

  test("treats a YAML manifest with no engine_version as v1 (legacy)", () => {
    // engine_version was added when v2 shipped, so any manifest.yaml
    // without it is a pre-v2 (= v1) integration. The pre-flight should
    // proceed past the engine-version check.
    scaffold(
      `id: com.acme.demo\nversion: 0.1.0\nentry_script: main.lua\nresources: []\npermissions: []\ntimers: []\nsubscriptions: []\n`,
    );
    const result = prepareV2Skeleton("demo");
    expect(result.targetPath).toBe(join(root, "integrations", "demo_v2"));
    expect(result.oldVersion).toBe("0.1.0");
    expect(result.newVersion).toBe("0.2.0");
  });
});

describe("prepareV2Skeleton — output", () => {
  test("forks into <folder>_v2 with bumped version + materialised handlers", () => {
    const folder = join(root, "integrations", "demo");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "manifest.yaml"),
      `id: com.acme.demo
version: 0.1.0
engine_version: 1
sdk_version: "1.0"
runtime_mode: script_actor
entry_script: main.lua
resources: []
permissions: []
timers:
  - name: tick
    every: 1m
subscriptions:
  - topic: jobs.created
`,
    );
    mkdirSync(join(folder, "scripts"));
    writeFileSync(
      join(folder, "scripts", "main.lua"),
      `exports = {}\nfunction exports.on_timer(ctx, t) end\n`,
    );
    // A non-main script should be carried over verbatim.
    writeFileSync(join(folder, "scripts", "util.lua"), `return { x = 1 }\n`);
    // A bundle file outside scripts/ should travel too.
    writeFileSync(join(folder, "config_schema.json"), `{"type":"object"}`);

    const result = prepareV2Skeleton("demo");
    const target = result.targetPath;

    expect(target).toBe(join(root, "integrations", "demo_v2"));
    expect(existsSync(target)).toBe(true);
    expect(result.oldVersion).toBe("0.1.0");
    expect(result.newVersion).toBe("0.2.0");
    expect(result.placeholderCount).toBe(2); // tick + jobs.created

    // manifest.ts exists, references the bumped version, points at the
    // expected handler files via luaFile().
    const ts = readFileSync(join(target, "manifest.ts"), "utf8");
    expect(ts).toContain('version: "0.2.0"');
    expect(ts).toContain("engineVersion: 2");
    expect(ts).toContain('luaFile("./handlers/timers/tick.lua")');
    expect(ts).toContain('luaFile("./handlers/subscriptions/jobs.created.lua")');

    // Placeholder handler files materialised with valid Lua.
    expect(
      readFileSync(join(target, "handlers/timers/tick.lua"), "utf8"),
    ).toContain("local name, config = ...");
    expect(
      readFileSync(
        join(target, "handlers/subscriptions/jobs.created.lua"),
        "utf8",
      ),
    ).toContain("local event, config = ...");

    // Other bundle artefacts copied across.
    expect(readFileSync(join(target, "scripts/util.lua"), "utf8")).toBe(
      "return { x = 1 }\n",
    );
    expect(readFileSync(join(target, "config_schema.json"), "utf8")).toBe(
      `{"type":"object"}`,
    );

    // scripts/main.lua and the v1 manifest are NOT carried over — they
    // get rewritten by the migration.
    expect(existsSync(join(target, "scripts/main.lua"))).toBe(false);
    expect(existsSync(join(target, "manifest.yaml"))).toBe(false);

    // Original folder is untouched.
    expect(existsSync(join(folder, "manifest.yaml"))).toBe(true);
    expect(existsSync(join(folder, "scripts/main.lua"))).toBe(true);

    // Prompt is non-empty and includes the v1 main.lua content + the
    // expected handler paths.
    expect(result.prompt).toContain("function exports.on_timer");
    expect(result.prompt).toContain("handlers/timers/tick.lua");
    expect(result.prompt).toContain("handlers/subscriptions/jobs.created.lua");
  });
});
