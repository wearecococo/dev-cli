import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeOps } from "../src/commands/dump.ts";
import { loadOps } from "../src/ops.ts";

let root: string;
const DEFINE_PATH = new URL("../src/define.ts", import.meta.url).pathname;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-dump-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("serializeOps", () => {
  test("writes a parseable users.ts with bare-identifier keys", () => {
    const body = serializeOps("defineUsers", [
      { email: "alice@acme.com", name: "Alice", kind: "HUMAN" },
      { email: "bot@acme.com", kind: "BOT", externalId: "svc_001" },
    ]);
    expect(body).toContain('import { defineUsers } from "@wearecococo/dev-cli/define";');
    expect(body).toContain("defineUsers([");
    expect(body).toContain("email:");
    expect(body).not.toContain('"email":'); // bare-identifier keys
    expect(body).not.toMatch(/aren't returned/i); // no banner without placeholders
  });

  test("emits placeholder banner when ${config:...} is present", () => {
    const body = serializeOps("defineDevices", [
      {
        identifier: "press-01",
        outboundProtocols: [
          {
            kind: "HTTP",
            url: "https://x",
            username: "ops",
            password: "${config:DEVICE_PRESS_01_HTTP_PASSWORD}",
          },
        ],
      },
    ]);
    expect(body).toMatch(/aren't returned/i);
    expect(body).toContain("${config:DEVICE_PRESS_01_HTTP_PASSWORD}");
  });

  test("empty array still produces a valid file body", () => {
    const body = serializeOps("defineNetworks", []);
    expect(body).toContain("defineNetworks([])");
  });

  test("round-trips through the ops loader for users", async () => {
    const body = rewireImport(
      serializeOps("defineUsers", [
        { email: "alice@acme.com", name: "Alice", kind: "HUMAN" },
        { email: "bob@acme.com", name: "Bob", kind: "HUMAN", externalId: "emp_002" },
      ]),
    );
    writeFileSync(join(root, "users.ts"), body);
    const ops = await loadOps(root);
    expect(ops.users).toEqual([
      { email: "alice@acme.com", name: "Alice", kind: "HUMAN" },
      { email: "bob@acme.com", name: "Bob", kind: "HUMAN", externalId: "emp_002" },
    ]);
  });

  test("round-trips a complex policy with nested statements", async () => {
    const body = rewireImport(
      serializeOps("defineIAMPolicies", [
        {
          handle: "press-operator",
          name: "Press Operator",
          description: "Run jobs on the press floor",
          statements: [
            { effect: "ALLOW", actions: ["job:read", "job:transition"], resources: ["*"] },
            { effect: "DENY", actions: ["user:delete"], resources: ["*"] },
          ],
        },
      ]),
    );
    writeFileSync(join(root, "iam_policies.ts"), body);
    const ops = await loadOps(root);
    expect(ops.policies).toHaveLength(1);
    expect(ops.policies[0]?.handle).toBe("press-operator");
    expect(ops.policies[0]?.statements).toHaveLength(2);
    expect(ops.policies[0]?.statements[1]?.effect).toBe("DENY");
  });

  test("round-trips a device with mixed discriminated protocols", async () => {
    const body = rewireImport(
      serializeOps("defineDevices", [
        {
          identifier: "press-01",
          network: "press-floor",
          manufacturer: "Heidelberg",
          outboundProtocols: [
            {
              kind: "HTTP",
              url: "https://press-01.local/api",
              authMode: "BASIC",
              username: "ops",
              password: "${config:DEVICE_PRESS_01_HTTP_PASSWORD}",
            },
            {
              kind: "SQL",
              adapter: "POSTGRESQL",
              host: "press-01.local",
              port: 5432,
              databaseName: "metrics",
              username: "reader",
            },
          ],
          inboundProtocols: [
            { kind: "MQTT", topic: "press/01/telemetry" },
            { kind: "HTTP", webhookPath: "/hooks/press-01" },
          ],
        },
      ]),
    );
    writeFileSync(join(root, "devices.ts"), body);
    const ops = await loadOps(root);
    expect(ops.devices).toHaveLength(1);
    const d = ops.devices[0]!;
    expect(d.outboundProtocols).toHaveLength(2);
    const http = d.outboundProtocols![0]!;
    if (http.kind !== "HTTP") throw new Error("expected HTTP");
    expect(http.password).toContain("config:");
    const sql = d.outboundProtocols![1]!;
    if (sql.kind !== "SQL") throw new Error("expected SQL");
    expect(sql.adapter).toBe("POSTGRESQL");
    expect(sql.port).toBe(5432);
    expect(d.inboundProtocols).toHaveLength(2);
  });

  test("round-trips an edge-app installation with variables", async () => {
    const body = rewireImport(
      serializeOps("defineEdgeAppInstallations", [
        {
          controller: "press-01",
          app: "door-monitor",
          version: 3,
          variables: { LOG_PATH: "/var/log/door", THRESHOLD: 42, STRICT: true },
          botUser: "bot@acme.com",
        },
      ]),
    );
    writeFileSync(join(root, "edge_app_installations.ts"), body);
    const ops = await loadOps(root);
    expect(ops.edgeAppInstallations).toHaveLength(1);
    const i = ops.edgeAppInstallations[0]!;
    expect(i.controller).toBe("press-01");
    expect(i.version).toBe(3);
    expect(i.variables).toEqual({ LOG_PATH: "/var/log/door", THRESHOLD: 42, STRICT: true });
  });

  test("round-trips a controller with inline policy", async () => {
    const body = rewireImport(
      serializeOps("defineControllers", [
        {
          handle: "press-01",
          network: "press-floor",
          host: "192.168.1.10",
          port: 8443,
          policy: {
            allowedIoPaths: ["/var/log/door", "/tmp/cococo"],
            allowedExecBinaries: ["/usr/bin/ping"],
          },
        },
      ]),
    );
    writeFileSync(join(root, "controllers.ts"), body);
    const ops = await loadOps(root);
    expect(ops.controllers).toHaveLength(1);
    expect(ops.controllers[0]?.policy?.allowedIoPaths).toEqual([
      "/var/log/door",
      "/tmp/cococo",
    ]);
  });
});

/**
 * Swap the package import for the absolute path to define.ts so the
 * temp-dir loader can resolve without a node_modules. Mirrors the
 * pattern used in the other ops/loader tests.
 */
function rewireImport(body: string): string {
  return body.replace(
    `from "@wearecococo/dev-cli/define"`,
    `from "${DEFINE_PATH}"`,
  );
}
