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
import { runLogin } from "../src/commands/login.ts";

let workspace: string;
let originalCwd: string;
let originalHome: string;
let homeOverride: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "cococo-login-")));
  process.chdir(workspace);

  // Redirect ~/.cococo/device-id into a tmp dir so the test doesn't
  // touch real user state.
  originalHome = process.env.HOME ?? "";
  homeOverride = realpathSync(mkdtempSync(join(tmpdir(), "cococo-home-")));
  process.env.HOME = homeOverride;
  process.env.COCOCO_PASSWORD = "hunter2";
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(homeOverride, { recursive: true, force: true });
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  delete process.env.COCOCO_PASSWORD;
});

type FakeRoute = (req: { method: string; path: string; body: unknown }) =>
  | { status: number; body: unknown }
  | undefined;

async function withFakeServer<T>(
  route: FakeRoute,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      let body: unknown = undefined;
      if (req.method !== "GET") {
        try {
          body = await req.json();
        } catch {
          body = await req.text();
        }
      }
      const result = route({ method: req.method, path: url.pathname, body });
      if (!result) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    return await fn(`http://localhost:${server.port}`);
  } finally {
    server.stop(true);
  }
}

describe("runLogin", () => {
  test("happy path: posts credentials, verifies token, writes .env", async () => {
    let authCalled = false;
    let graphqlCalled = false;
    let receivedBody: Record<string, unknown> | undefined;

    await withFakeServer(
      (req) => {
        if (req.method === "POST" && req.path === "/auth/token") {
          authCalled = true;
          receivedBody = req.body as Record<string, unknown>;
          return { status: 200, body: { token: "tok_abc" } };
        }
        if (req.method === "POST" && req.path === "/graphql") {
          graphqlCalled = true;
          // The verify step uses the bearer token to fetch __typename.
          return { status: 200, body: { data: { __typename: "Query" } } };
        }
        return undefined;
      },
      async (baseUrl) => {
        await runLogin({ endpoint: baseUrl, username: "alice@acme.com" });
      },
    );

    expect(authCalled).toBe(true);
    expect(graphqlCalled).toBe(true);
    expect(receivedBody?.username).toBe("alice@acme.com");
    expect(typeof receivedBody?.deviceId).toBe("string");
    expect((receivedBody?.deviceId as string).length).toBeGreaterThan(0);

    const env = readFileSync(join(workspace, ".env"), "utf8");
    expect(env).toContain("COCOCO_TOKEN=tok_abc");
    expect(env).toContain("COCOCO_ENDPOINT=http://localhost:");
    expect(env.endsWith("/graphql\n") || env.includes("/graphql\n")).toBe(true);
  });

  test("device ID is created on first run and reused on subsequent runs", async () => {
    let firstDeviceId: string | undefined;
    let secondDeviceId: string | undefined;

    const route: FakeRoute = (req) => {
      if (req.method === "POST" && req.path === "/auth/token") {
        const body = req.body as Record<string, unknown>;
        if (firstDeviceId === undefined) firstDeviceId = body.deviceId as string;
        else secondDeviceId = body.deviceId as string;
        return { status: 200, body: { token: "tok" } };
      }
      if (req.method === "POST" && req.path === "/graphql") {
        return { status: 200, body: { data: { __typename: "Query" } } };
      }
      return undefined;
    };

    await withFakeServer(route, async (baseUrl) => {
      await runLogin({ endpoint: baseUrl, username: "a@b.com" });
      await runLogin({ endpoint: baseUrl, username: "a@b.com" });
    });

    expect(firstDeviceId).toBeTruthy();
    expect(secondDeviceId).toBe(firstDeviceId!);
    // Device ID file exists on disk under the redirected HOME.
    expect(existsSync(join(homeOverride, ".cococo/device-id"))).toBe(true);
  });

  test("auth endpoint failure surfaces with the server's error message", async () => {
    await expect(
      withFakeServer(
        (req) => {
          if (req.method === "POST" && req.path === "/auth/token") {
            return { status: 401, body: { error: "Invalid credentials" } };
          }
          return undefined;
        },
        async (baseUrl) => {
          await runLogin({ endpoint: baseUrl, username: "a@b.com" });
        },
      ),
    ).rejects.toThrow(/Invalid credentials/);

    // No .env should have been written.
    expect(existsSync(join(workspace, ".env"))).toBe(false);
  });

  test("token verify failure surfaces clearly and leaves .env untouched", async () => {
    await expect(
      withFakeServer(
        (req) => {
          if (req.method === "POST" && req.path === "/auth/token") {
            return { status: 200, body: { token: "bad-tok" } };
          }
          if (req.method === "POST" && req.path === "/graphql") {
            return { status: 200, body: { errors: [{ message: "unauthenticated" }] } };
          }
          return undefined;
        },
        async (baseUrl) => {
          await runLogin({ endpoint: baseUrl, username: "a@b.com" });
        },
      ),
    ).rejects.toThrow(/didn't validate/);

    expect(existsSync(join(workspace, ".env"))).toBe(false);
  });

  test("normalises various endpoint inputs to https://<host>/graphql", async () => {
    let receivedAuthHost: string | undefined;

    await withFakeServer(
      (req) => {
        if (req.method === "POST" && req.path === "/auth/token") {
          return { status: 200, body: { token: "tok" } };
        }
        if (req.method === "POST" && req.path === "/graphql") {
          return { status: 200, body: { data: { __typename: "Query" } } };
        }
        return undefined;
      },
      async (baseUrl) => {
        const port = new URL(baseUrl).port;
        // Endpoint passed with the /graphql suffix should still work.
        await runLogin({
          endpoint: `${baseUrl}/graphql`,
          username: "a@b.com",
        });
        receivedAuthHost = `localhost:${port}`;
      },
    );

    const env = readFileSync(join(workspace, ".env"), "utf8");
    expect(env).toContain(`COCOCO_ENDPOINT=http://${receivedAuthHost}/graphql`);
  });

  test("preserves unrelated keys in an existing .env", async () => {
    writeFileSync(
      join(workspace, ".env"),
      "PROJECT_NAME=acme\nCOCOCO_TOKEN=stale\nLOG_LEVEL=debug\n",
    );

    await withFakeServer(
      (req) => {
        if (req.method === "POST" && req.path === "/auth/token") {
          return { status: 200, body: { token: "fresh-tok" } };
        }
        if (req.method === "POST" && req.path === "/graphql") {
          return { status: 200, body: { data: { __typename: "Query" } } };
        }
        return undefined;
      },
      async (baseUrl) => {
        await runLogin({ endpoint: baseUrl, username: "a@b.com" });
      },
    );

    const env = readFileSync(join(workspace, ".env"), "utf8");
    expect(env).toContain("COCOCO_TOKEN=fresh-tok");
    expect(env).toContain("PROJECT_NAME=acme");
    expect(env).toContain("LOG_LEVEL=debug");
    expect(env).not.toContain("COCOCO_TOKEN=stale");
  });
});
