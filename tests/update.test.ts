import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdate, stableDigest, type Syncer } from "../src/update.ts";
import type { GraphQLClient } from "../src/graphql/client.ts";

const fakeClient = {
  request: async () => ({}),
} as unknown as GraphQLClient;

let workspace: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "cococo-update-")));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function makeSyncer(name: string, output: string, content: string): Syncer<{ payload: string }> {
  return {
    name,
    description: `test ${name}`,
    fetch: async () => ({ payload: content }),
    generate: (input, digest) => [
      {
        path: output,
        content: `// digest=${digest}\n${input.payload}\n`,
      },
    ],
    digest: (input) => stableDigest(input),
  };
}

describe("runUpdate — write/check/only flows", () => {
  test("writes generated files and the digest sidecar in the normal path", async () => {
    const syncer = makeSyncer("node-types", ".cococo/generated/node-types.d.ts", "hello");
    const summary = await runUpdate([syncer], fakeClient, workspace, {
      check: false,
    });
    expect(summary.changed).toEqual([".cococo/generated/node-types.d.ts"]);
    expect(summary.unchanged).toEqual([]);

    const written = readFileSync(
      join(workspace, ".cococo/generated/node-types.d.ts"),
      "utf8",
    );
    expect(written).toContain("hello");
    expect(written).toMatch(/^\/\/ digest=[a-f0-9]{64}/);

    const sidecar = JSON.parse(
      readFileSync(join(workspace, ".cococo/schema-version.json"), "utf8"),
    );
    expect(sidecar.syncers["node-types"]).toMatch(/^[a-f0-9]{64}$/);
    expect(sidecar.generatedAt).toBeTruthy();
  });

  test("re-running with no input change marks files unchanged + leaves disk untouched", async () => {
    const syncer = makeSyncer("node-types", ".cococo/generated/node-types.d.ts", "hello");
    await runUpdate([syncer], fakeClient, workspace, { check: false });

    const sidecarBefore = readFileSync(
      join(workspace, ".cococo/schema-version.json"),
      "utf8",
    );

    const summary = await runUpdate([syncer], fakeClient, workspace, {
      check: false,
    });
    expect(summary.changed).toEqual([]);
    expect(summary.unchanged).toEqual([".cococo/generated/node-types.d.ts"]);

    const sidecarAfter = readFileSync(
      join(workspace, ".cococo/schema-version.json"),
      "utf8",
    );
    // generatedAt is only updated when something actually changed.
    expect(sidecarAfter).toBe(sidecarBefore);
  });

  test("--check returns the diff but writes nothing", async () => {
    const syncer = makeSyncer("node-types", ".cococo/generated/node-types.d.ts", "hello");
    const summary = await runUpdate([syncer], fakeClient, workspace, {
      check: true,
    });
    expect(summary.changed).toEqual([".cococo/generated/node-types.d.ts"]);

    expect(existsSync(join(workspace, ".cococo/generated/node-types.d.ts"))).toBe(false);
    expect(existsSync(join(workspace, ".cococo/schema-version.json"))).toBe(false);
  });

  test("--check returns clean when files match", async () => {
    const syncer = makeSyncer("node-types", ".cococo/generated/node-types.d.ts", "hello");
    await runUpdate([syncer], fakeClient, workspace, { check: false });
    const summary = await runUpdate([syncer], fakeClient, workspace, {
      check: true,
    });
    expect(summary.changed).toEqual([]);
    expect(summary.unchanged).toEqual([".cococo/generated/node-types.d.ts"]);
  });

  test("--only filters which syncers run", async () => {
    const a = makeSyncer("a", ".cococo/a.txt", "a-content");
    const b = makeSyncer("b", ".cococo/b.txt", "b-content");
    const summary = await runUpdate([a, b], fakeClient, workspace, {
      check: false,
      only: "a",
    });
    expect(summary.ranSyncers).toEqual(["a"]);
    expect(summary.skipped).toEqual(["b"]);
    expect(existsSync(join(workspace, ".cococo/a.txt"))).toBe(true);
    expect(existsSync(join(workspace, ".cococo/b.txt"))).toBe(false);
  });

  test("--only with an unknown name throws", async () => {
    const syncer = makeSyncer("node-types", ".cococo/x", "y");
    await expect(
      runUpdate([syncer], fakeClient, workspace, { check: false, only: "bogus" }),
    ).rejects.toThrow(/Unknown syncer/);
  });
});

describe("stableDigest", () => {
  test("hash is order-independent for object keys", () => {
    expect(stableDigest({ a: 1, b: 2 })).toBe(stableDigest({ b: 2, a: 1 }));
  });

  test("nested objects sort recursively", () => {
    expect(stableDigest({ outer: { a: 1, b: 2 } })).toBe(
      stableDigest({ outer: { b: 2, a: 1 } }),
    );
  });

  test("array order is preserved (not sorted)", () => {
    expect(stableDigest([1, 2, 3])).not.toBe(stableDigest([3, 2, 1]));
  });
});
