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

type FakeResponse =
  | { data: Record<string, unknown> }
  | { errors: { message: string }[] };

async function withFakeServer(
  handler: (call: CapturedCall) => Record<string, unknown> | FakeResponse,
  test: () => Promise<void>,
): Promise<CapturedCall[]> {
  const captured: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
      captured.push({ query: body.query, variables: body.variables ?? {} });
      const result = handler({ query: body.query, variables: body.variables ?? {} });
      // Either a plain data record (wrapped into { data: ... }) or a
      // pre-shaped { data | errors } envelope.
      const envelope =
        "errors" in result || "data" in result ? result : { data: result };
      return new Response(JSON.stringify(envelope), {
        status: 200,
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

  test("happy path: empty state + declared user → create lands, state populated, re-apply is a noop", async () => {
    writeState({ schemaVersion: 1, lastAppliedAt: null, resources: [] });
    writeFileSync(
      join(root, "users.ts"),
      `import { defineUsers } from "${new URL("../src/define.ts", import.meta.url).pathname}";
export default defineUsers([
  { email: "alice@acme.com", name: "Alice", kind: "HUMAN" },
]);
`,
    );

    let serverUser: { id: string; email: string; name: string; kind: string } | null = null;
    await withFakeServer(
      (call) => {
        // listUsers — drives both the resolver-ctx prefetch and
        // per-identity lookups via getUserByEmail's listUsers query.
        if (call.query.includes("listUsers")) {
          return {
            listUsers: {
              edges: serverUser ? [{ node: serverUser }] : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (call.query.includes("upsertUser")) {
          const email = (call.variables as { input: { email: string } }).input.email;
          serverUser = { id: "usr_1", email, name: "Alice", kind: "HUMAN" };
          return { upsertUser: { user: serverUser, errors: [] } };
        }
        return {};
      },
      async () => {
        // First apply: alice doesn't exist on the server, gets created.
        await runManagedApply({ yes: true, allowDestroy: false }, {});
      },
    );

    const after = readState();
    expect(after.resources).toHaveLength(1);
    expect((after.resources[0]!.identity as { email: string }).email).toBe("alice@acme.com");
    expect(after.lastAppliedAt).not.toBeNull();

    // Second apply: state matches server, plan should be a noop, no upserts.
    let upsertCount = 0;
    await withFakeServer(
      (call) => {
        if (call.query.includes("listUsers")) {
          return {
            listUsers: {
              edges: serverUser ? [{ node: serverUser }] : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (call.query.includes("upsertUser")) {
          upsertCount++;
          return { upsertUser: { user: serverUser, errors: [] } };
        }
        return {};
      },
      async () => {
        await runManagedApply({ yes: true, allowDestroy: false }, {});
      },
    );
    expect(upsertCount).toBe(0);
  });

  test("partial-state save: failure mid-apply persists completed actions before re-throwing", async () => {
    // Start with empty state. Declare two users — the second mutation
    // throws. After the failure, state should record the first user as
    // applied; the second is left out so the next apply retries it.
    writeState({ schemaVersion: 1, lastAppliedAt: null, resources: [] });

    // Two users in users.ts; second one's email will trigger a server error.
    writeFileSync(
      join(root, "users.ts"),
      `import { defineUsers } from "${new URL("../src/define.ts", import.meta.url).pathname}";
export default defineUsers([
  { email: "alice@acme.com", name: "Alice", kind: "HUMAN" },
  { email: "boom@acme.com", name: "Boom", kind: "HUMAN" },
]);
`,
    );

    let upsertCount = 0;
    await withFakeServer(
      (call) => {
        // listUsers (resolver-ctx prefetch) — empty.
        if (call.query.includes("listUsers")) {
          return { listUsers: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        }
        if (call.query.includes("upsertUser")) {
          upsertCount++;
          if (upsertCount === 2) {
            // Server-side error on the second upsert (returned as a
            // GraphQL error envelope, not an HTTP-level throw — the
            // client raises GraphQLRequestError from this).
            return { errors: [{ message: "upstream blew up on user #2" }] };
          }
          const email = (call.variables as { input: { email: string } }).input.email;
          return {
            upsertUser: {
              user: { id: `usr_${upsertCount}`, email, name: "Alice", kind: "HUMAN" },
              errors: [],
            },
          };
        }
        return {};
      },
      async () => {
        let threw = false;
        try {
          await runManagedApply({ yes: true, allowDestroy: false }, {});
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
      },
    );

    // State should now contain alice (succeeded) but not boom (failed).
    const after = readState();
    expect(after.resources).toHaveLength(1);
    expect((after.resources[0]!.identity as { email: string }).email).toBe(
      "alice@acme.com",
    );
    // generatedAt should have been updated to reflect the partial save.
    expect(after.lastAppliedAt).not.toBeNull();
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
