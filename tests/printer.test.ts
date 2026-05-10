import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { printManifestTs, printEdgeAppManifestTs } from "../src/printer.ts";
import { expectEdge, loadManifest } from "../src/loader.ts";
import type { WireManifest } from "../src/manifest.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-printer-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("printManifestTs", () => {
  test("emits a manifest.ts that loads back to an equivalent wire shape", async () => {
    const wire: WireManifest = {
      id: "com.acme.foo",
      version: "0.1.0",
      engine_version: 2,
      sdk_version: "1.0",
      runtime_mode: "script_actor",
      description: "round-trip me",
      resources: [
        { id: "erp_api", type: "protocol/http", description: "ERP REST" },
      ],
      permissions: [],
      init_source: "local config = ...\nctx.log.info('init')\n",
      subscriptions: [
        { topic: "jobs.created", source: "-- on created\n" },
      ],
      timers: [
        { name: "tick", every: "1m", source: "-- tick\n" },
      ],
      libraries: { utils: "return {}\n" } as any,
    };

    // Write the printed manifest.ts plus the materialised .lua files the
    // generated luaFile() refs point at.
    const printed = printManifestTs(wire);
    // Replace the package import spec with a direct pointer to src/define.ts
    // so the test's tempdir doesn't need a node_modules.
    const rewritten = printed.replace(
      /"@wearecococo\/dev-cli\/define"/g,
      JSON.stringify(absDefineImportSpec()),
    );

    writeFile(join(root, "manifest.ts"), rewritten);
    writeFile(join(root, "lifecycle/init.lua"), wire.init_source as string);
    writeFile(join(root, "handlers/timers/tick.lua"), (wire.timers as any)[0].source);
    writeFile(
      join(root, "handlers/subscriptions/jobs.created.lua"),
      (wire.subscriptions as any)[0].source,
    );
    writeFile(join(root, "libraries/utils.lua"), (wire.libraries as any).utils);

    const loaded = await loadManifest(root);
    const m = loaded.manifest as any;

    expect(loaded.format).toBe("ts");
    expect(m.id).toBe("com.acme.foo");
    expect(m.version).toBe("0.1.0");
    expect(m.engine_version).toBe(2);
    expect(m.sdk_version).toBe("1.0");
    expect(m.runtime_mode).toBe("script_actor");
    expect(m.description).toBe("round-trip me");
    expect(m.resources[0]).toEqual({
      id: "erp_api",
      type: "protocol/http",
      description: "ERP REST",
    });
    expect(m.init_source).toBe("local config = ...\nctx.log.info('init')\n");
    expect(m.subscriptions[0]).toEqual({
      topic: "jobs.created",
      source: "-- on created\n",
    });
    expect(m.timers[0]).toEqual({
      name: "tick",
      every: "1m",
      source: "-- tick\n",
    });
    expect(m.libraries).toEqual({ utils: "return {}\n" });
  });

  test("rejects v1 manifests — manifest.ts is v2-only", () => {
    const wire: WireManifest = {
      id: "com.acme.foo",
      version: "0.1.0",
      engine_version: 1,
      sdk_version: "1.0",
      runtime_mode: "script_actor",
      entry_script: "main.lua",
      resources: [],
      permissions: [],
    };
    expect(() => printManifestTs(wire)).toThrow(/v2-only|--format yaml/i);
  });
});

describe("printEdgeAppManifestTs — I/O config", () => {
  test("emits I/O blocks with ${config:...} placeholders for write-only secrets", async () => {
    const printed = printEdgeAppManifestTs({
      handle: "io-shop",
      name: "IO Shop",
      handlers: [{ name: "onMsg", path: "handlers/onMsg.lua" }],
      triggers: [],
      mqttBrokers: [
        {
          name: "broker1",
          url: "mqtt://b:1883",
          username: "alice",
          // password omitted by server — printer fills placeholder
          subscriptions: [{ topic: "data/#", handler: "onMsg" }],
        },
      ],
      opcuaEndpoints: [
        {
          name: "press",
          endpoint: "opc.tcp://press:4840",
          subscriptions: [{ nodeId: "ns=2;s=Temp", handler: "onMsg" }],
          auth: { mode: "USERNAME", username: "u" }, // password missing
        },
      ],
      snmpDevices: [
        {
          name: "sw1",
          host: "10.0.0.10",
          version: "V3",
          v3: {
            user: "monitor",
            authProtocol: "SHA256",
            privProtocol: "AES128",
            // authKey + privKey both omitted by server
          },
          pollGroups: [
            {
              name: "uptime",
              intervalMs: 5000,
              handler: "onMsg",
              oids: [{ label: "uptime", oid: "1.3.6.1.2.1.1.3.0" }],
            },
          ],
        },
      ],
      modbusPorts: [
        {
          name: "plc1",
          transport: "TCP",
          host: "10.0.0.1",
          slaves: [
            {
              name: "main",
              unitId: 1,
              pollGroups: [
                {
                  name: "g1",
                  intervalMs: 1000,
                  handler: "onMsg",
                  reads: [
                    {
                      label: "x",
                      function: "INPUT",
                      address: 0,
                      quantity: 1,
                      type: "UINT16",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      execCommands: [
        { name: "ping", path: "/usr/bin/ping", args: ["-c", "1"], timeoutMs: 5000 },
      ],
      httpRoutes: [
        {
          method: "POST",
          path: "/webhook",
          handler: "onMsg",
          auth: { mode: "BEARER" }, // bearerTokens missing
        },
      ],
    });

    // Placeholders for the secrets the server doesn't return.
    expect(printed).toContain("${config:IO_SHOP_MQTT_BROKER1_PASSWORD}");
    expect(printed).toContain("${config:IO_SHOP_OPCUA_PRESS_PASSWORD}");
    expect(printed).toContain("${config:IO_SHOP_SNMP_SW1_AUTH_KEY}");
    expect(printed).toContain("${config:IO_SHOP_SNMP_SW1_PRIV_KEY}");
    expect(printed).toContain("${config:IO_SHOP_HTTP_POST_WEBHOOK_BEARER}");
    // Banner explains the placeholders.
    expect(printed).toMatch(/secrets.*aren't returned/i);

    // Round-trip: write it next to a stub handler and load it back.
    mkdirSync(join(root, "handlers"));
    writeFileSync(join(root, "handlers/onMsg.lua"), 'bridge.log.info("msg")\n');
    const rewired = printed.replace(
      `from "@wearecococo/dev-cli/define"`,
      `from "${absDefineImportSpec()}"`,
    );
    writeFileSync(join(root, "manifest.ts"), rewired);

    const loaded = await loadManifest(root);
    const edge = expectEdge(loaded);
    expect(edge.app.mqtt_brokers?.[0]?.password).toContain("config:");
    expect(edge.app.opcua_endpoints?.[0]?.auth?.password).toContain("config:");
    expect(edge.app.snmp_devices?.[0]?.v3?.authKey).toContain("config:");
    expect(edge.app.http_routes?.[0]?.auth.bearerTokens?.[0]).toContain("config:");
    expect(edge.app.modbus_ports?.[0]?.transport).toBe("TCP");
    expect(edge.app.exec_commands?.[0]?.path).toBe("/usr/bin/ping");
  });

  test("omits the placeholder banner when no secrets are missing", () => {
    const printed = printEdgeAppManifestTs({
      handle: "plain",
      name: "Plain",
      handlers: [{ name: "onMsg", path: "handlers/onMsg.lua" }],
      triggers: [],
      mqttBrokers: [
        {
          name: "anon",
          url: "mqtt://b:1883",
          // no username → no placeholder needed
          subscriptions: [{ topic: "x", handler: "onMsg" }],
        },
      ],
    });
    expect(printed).not.toMatch(/aren't returned/i);
    expect(printed).not.toContain("${config:");
  });
});

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function absDefineImportSpec(): string {
  return new URL("../src/define.ts", import.meta.url).pathname;
}
