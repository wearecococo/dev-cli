import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap, runClaudeMd } from "../src/commands/bootstrap.ts";

let root: string;
const cwd = process.cwd();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-bootstrap-")));
  process.chdir(root);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

describe("runBootstrap", () => {
  test("creates the full workspace with default options", async () => {
    await runBootstrap(undefined, {});
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, ".env.example"))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);
    expect(existsSync(join(root, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);

    // All 11 ops stubs.
    for (const f of [
      "users.ts",
      "iam_policies.ts",
      "bindings.ts",
      "networks.ts",
      "devices.ts",
      "teams.ts",
      "custom_app_users.ts",
      "custom_app_teams.ts",
      "controllers.ts",
      "controller_tokens.ts",
      "edge_app_installations.ts",
    ]) {
      expect(existsSync(join(root, f))).toBe(true);
    }

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.devDependencies["@wearecococo/dev-cli"]).toBeDefined();

    // Stub files are valid TS — they import from @wearecococo/dev-cli/define
    // and call the corresponding defineX with an empty array.
    const usersStub = readFileSync(join(root, "users.ts"), "utf8");
    expect(usersStub).toContain("defineUsers");
    expect(usersStub).toContain("@wearecococo/dev-cli/define");
    expect(usersStub).toContain("// { email:");
  });

  test("--no-claude-md skips CLAUDE.md", async () => {
    await runBootstrap(undefined, { claudeMd: false });
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(root, "package.json"))).toBe(true);
  });

  test("preserves existing files without --force", async () => {
    writeFileSync(join(root, "package.json"), '{"name":"existing"}');
    await runBootstrap(undefined, {});
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("existing");
    // Other files still get created.
    expect(existsSync(join(root, "tsconfig.json"))).toBe(true);
  });

  test("--force overwrites existing files", async () => {
    writeFileSync(join(root, "package.json"), '{"name":"existing"}');
    await runBootstrap(undefined, { force: true });
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("cococo-workspace");
  });

  test("creates a sub-folder when given a folder arg", async () => {
    await runBootstrap("subdir", {});
    expect(existsSync(join(root, "subdir", "package.json"))).toBe(true);
    expect(existsSync(join(root, "subdir", "CLAUDE.md"))).toBe(true);
  });
});

describe("runClaudeMd", () => {
  test("writes CLAUDE.md to a fresh folder", async () => {
    await runClaudeMd(undefined, {});
    const body = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(body).toContain("Working with this repo");
    expect(body).toContain("cococo");
  });

  test("refuses to overwrite without --force", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "existing");
    let exitCode: number | undefined;
    const orig = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;
    try {
      await expect(runClaudeMd(undefined, {})).rejects.toThrow("exit");
      expect(exitCode).toBe(1);
    } finally {
      process.exit = orig;
    }
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("existing");
  });

  test("--force overwrites", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "existing");
    await runClaudeMd(undefined, { force: true });
    const body = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(body).toContain("Working with this repo");
  });
});
