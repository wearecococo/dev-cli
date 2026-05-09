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
import { assertDevCliResolvable } from "../src/dev-cli-resolution.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-resolve-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("assertDevCliResolvable", () => {
  test("passes inside the dev-cli repo itself (self-resolution)", () => {
    // When you run `cococo init` from inside this repo, package.json
    // declares `name: @wearecococo/dev-cli`, so resolution succeeds via
    // the package-name self-check.
    expect(() => assertDevCliResolvable(process.cwd())).not.toThrow();
  });

  test("passes when package.json declares the dep but install hasn't run", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "consumer-repo",
        devDependencies: {
          "@wearecococo/dev-cli": "github:wearecococo/dev-cli#main",
        },
      }),
    );
    expect(() => assertDevCliResolvable(root)).not.toThrow();
  });

  test("passes when the dep is in a parent package.json (monorepo subdir)", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "consumer-repo",
        dependencies: {
          "@wearecococo/dev-cli": "github:wearecococo/dev-cli#main",
        },
      }),
    );
    const subdir = join(root, "packages", "integrations");
    mkdirSync(subdir, { recursive: true });
    expect(() => assertDevCliResolvable(subdir)).not.toThrow();
  });

  test("throws with an install hint when no package.json declares the dep", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer-repo", devDependencies: {} }),
    );
    expect(() => assertDevCliResolvable(root)).toThrow(/bun add -d/);
  });

  test("tolerates a malformed package.json on the way up", () => {
    // Malformed package.json shouldn't crash the walk — keep looking.
    // Here the malformed file sits below a valid one that declares
    // the dep, and resolution should succeed via the parent.
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "consumer-repo",
        devDependencies: { "@wearecococo/dev-cli": "github:..." },
      }),
    );
    const subdir = join(root, "broken");
    mkdirSync(subdir);
    writeFileSync(join(subdir, "package.json"), "{ not json");
    expect(() => assertDevCliResolvable(subdir)).not.toThrow();
  });
});
