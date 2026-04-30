import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIntegrationFolder, walkIntegrationFiles } from "../src/project.ts";

let root: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-project-")));
  process.chdir(root);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

function scaffold(rel: string): string {
  const abs = join(root, rel);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, "manifest.yaml"), `id: com.acme.x\nversion: 0.1.0\n`);
  return abs;
}

describe("resolveIntegrationFolder", () => {
  test("bare name resolves to ./integrations/<name>", () => {
    const abs = scaffold("integrations/foo");
    const f = resolveIntegrationFolder("foo");
    expect(f.path).toBe(abs);
  });

  test("relative path resolves verbatim if it has manifest.yaml", () => {
    const abs = scaffold("custom-location");
    const f = resolveIntegrationFolder("./custom-location");
    expect(f.path).toBe(abs);
  });

  test("no arg falls back to cwd if cwd has manifest.yaml", () => {
    writeFileSync(join(root, "manifest.yaml"), `id: com.acme.x\nversion: 0.1.0\n`);
    const f = resolveIntegrationFolder(undefined);
    expect(f.path).toBe(root);
  });

  test("missing manifest.yaml throws with the paths it tried", () => {
    expect(() => resolveIntegrationFolder("nope")).toThrow(/integrations\/nope/);
  });
});

describe("walkIntegrationFiles", () => {
  test("includes nested files, excludes manifest.yaml + dotfiles + node_modules", () => {
    const abs = scaffold("integrations/foo");
    mkdirSync(join(abs, "scripts"));
    writeFileSync(join(abs, "scripts/main.lua"), "return {}");
    writeFileSync(join(abs, "scripts/util.lua"), "-- util");
    mkdirSync(join(abs, "workflows"));
    writeFileSync(join(abs, "workflows/foo.yaml"), "name: foo");
    writeFileSync(join(abs, ".env"), "SECRET=1");
    mkdirSync(join(abs, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(abs, "node_modules/pkg/index.js"), "// noise");

    const files = walkIntegrationFiles(resolveIntegrationFolder("foo"));
    const paths = Array.from(files.keys()).sort();
    expect(paths).toEqual([
      "scripts/main.lua",
      "scripts/util.lua",
      "workflows/foo.yaml",
    ]);
  });
});
