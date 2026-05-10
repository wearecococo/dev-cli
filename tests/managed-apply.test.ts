import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManagedApply } from "../src/commands/managed-apply.ts";
import type { StateFile } from "../src/state/types.ts";

let root: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-managed-")));
  process.chdir(root);
  mkdirSync(join(root, ".cococo"));
  // Reasonable lock timeout for tests so a stuck lock doesn't hang
  // the suite.
  process.env.COCOCO_LOCK_TIMEOUT_MS = "60000";
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  delete process.env.COCOCO_ENDPOINT;
  delete process.env.COCOCO_TOKEN;
  delete process.env.COCOCO_LOCK_TIMEOUT_MS;
});

const STATE_PATH = ".cococo/state.json";

function writeState(state: StateFile): void {
  writeFileSync(join(root, STATE_PATH), JSON.stringify(state, null, 2));
}

function readState(): StateFile {
  return JSON.parse(readFileSync(join(root, STATE_PATH), "utf8")) as StateFile;
}

/**
 * Build a fake GraphQL endpoint by spinning up a tiny HTTP listener
 * the real client can talk to over loopback. This mirrors the existing
 * `tests/ops.test.ts` pattern: instead of mocking GraphQLClient we
 * point the client at a local server and assert on captured calls.
 */
type CapturedCall = { query: string; variables: Record<string, unknown> };

async function withFakeServer(
  handler: (call: CapturedCall) => Record<string, unknown>,
  test: () => Promise<void>,
): Promise<CapturedCall[]> {
  const captured: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
      captured.push({ query: body.query, variables: body.variables ?? {} });
      const data = handler({ query: body.query, variables: body.variables ?? {} });
      return new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  process.env.COCOCO_ENDPOINT = `http://localhost:${server.port}/graphql`;
  process.env.COCOCO_TOKEN = "test";
  try {
    await test();
  } finally {
    server.stop();
  }
  return captured;
}

describe("runManagedApply — basic flows", () => {
  test("empty state + empty ops + empty server → no-op", async () => {
    writeState({ schemaVersion: 1, lastAppliedAt: null, resources: [] });

    const calls = await withFakeServer(
      () => ({}),
      async () => {
        await runManagedApply({ yes: true, allowDestroy: false }, {});
      },
    );
    expect(calls.length).toBe(0);
    // State is untouched (no changes to apply).
    const after = readState();
    expect(after.resources).toEqual([]);
    expect(after.lastAppliedAt).toBeNull();
  });

  test("plan with deletes refuses to run without --allow-destroy", async () => {
    writeState({
      schemaVersion: 1,
      lastAppliedAt: "2026-05-10T00:00:00Z",
      resources: [
        {
          identity: { kind: "user", email: "dave@acme.com" },
          lastAppliedSpec: { email: "dave@acme.com", name: "Dave", kind: "HUMAN" },
          lastAppliedAt: "2026-05-10T00:00:00Z",
        },
      ],
    });

    // No users.ts means dave has been removed → would be a delete.
    const orig = process.exit;
    let exitedWith: number | undefined;
    process.exit = ((code: number) => {
      exitedWith = code;
      throw new Error("__exit__");
    }) as never;

    try {
      await withFakeServer(
        () => ({
          // listUsers (used by ResolverCtx) returns empty.
          listUsers: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
          // getUserByEmail used by per-identity fetch
          listUsers_by_email: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        async () => {
          try {
            await runManagedApply({ yes: true, allowDestroy: false }, {});
          } catch (err) {
            if (!(err instanceof Error) || err.message !== "__exit__") throw err;
          }
        },
      );
    } finally {
      process.exit = orig;
    }
    expect(exitedWith).toBe(1);
  });
});
