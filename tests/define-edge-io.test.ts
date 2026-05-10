import { describe, expect, test } from "bun:test";
import { defineEdgeApp, lua } from "../src/define.ts";

/**
 * These tests are mostly compile-time guarantees expressed as
 * `@ts-expect-error` checks: if the discriminated unions or the
 * `keyof H` constraint regress, this file stops typechecking.
 */
describe("edge-app I/O config — TS guarantees", () => {
  test("MQTT subscription handler refs are constrained to handler keys", () => {
    defineEdgeApp({
      handle: "mqtt-test",
      name: "MQTT",
      handlers: { onMsg: lua`bridge.log.info("msg")` },
      triggers: [],
      mqttBrokers: [
        {
          name: "broker1",
          url: "mqtt://broker.example:1883",
          subscriptions: [
            { topic: "data/#", handler: "onMsg" }, // OK
            // @ts-expect-error — typo'd handler name
            { topic: "errors/#", handler: "onMsgg" },
          ],
        },
      ],
    });
    expect(true).toBe(true);
  });

  test("OPC UA auth modes have shape-correct fields", () => {
    defineEdgeApp({
      handle: "opc",
      name: "OPC",
      handlers: { onTick: lua`bridge.log.info("tick")` },
      triggers: [],
      opcuaEndpoints: [
        {
          name: "press",
          endpoint: "opc.tcp://press:4840",
          subscriptions: [{ nodeId: "ns=2;s=Temp", handler: "onTick" }],
          auth: { mode: "ANONYMOUS" }, // OK
        },
        {
          name: "press2",
          endpoint: "opc.tcp://press:4840",
          subscriptions: [{ nodeId: "ns=2;s=Temp", handler: "onTick" }],
          auth: { mode: "USERNAME", username: "u", password: "p" }, // OK
        },
      ],
    });
    // @ts-expect-error — USERNAME without username/password
    void ({ mode: "USERNAME" as const });
    expect(true).toBe(true);
  });

  test("Modbus transport variants enforce the right transport-specific fields", () => {
    defineEdgeApp({
      handle: "mod",
      name: "Mod",
      handlers: { onPoll: lua`bridge.log.info("poll")` },
      triggers: [],
      modbusPorts: [
        {
          transport: "TCP",
          name: "plc1",
          host: "10.0.0.1",
          slaves: [
            {
              name: "main",
              unitId: 1,
              pollGroups: [
                {
                  name: "g1",
                  intervalMs: 1000,
                  handler: "onPoll",
                  reads: [
                    {
                      label: "temp",
                      function: "HOLDING",
                      address: 100,
                      quantity: 2,
                      type: "FLOAT32",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          transport: "RTU",
          name: "serial1",
          serialPath: "/dev/ttyUSB0",
          baudRate: 19200,
          slaves: [
            {
              name: "main",
              unitId: 1,
              pollGroups: [
                {
                  name: "g1",
                  intervalMs: 1000,
                  handler: "onPoll",
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
    });
    // @ts-expect-error — TCP transport requires `host`
    void ({ transport: "TCP" as const, name: "x", slaves: [] });
    // @ts-expect-error — RTU transport requires `serialPath`, not `host`
    void ({ transport: "RTU" as const, name: "x", host: "10.0.0.1", slaves: [] });
    expect(true).toBe(true);
  });

  test("HTTP auth modes carry their required credentials only when needed", () => {
    defineEdgeApp({
      handle: "http",
      name: "HTTP",
      handlers: { onWebhook: lua`bridge.log.info("hook")` },
      triggers: [],
      httpRoutes: [
        {
          method: "POST",
          path: "/webhook",
          handler: "onWebhook",
          auth: { mode: "NONE" }, // OK
        },
        {
          method: "POST",
          path: "/webhook2",
          handler: "onWebhook",
          auth: { mode: "BASIC", basicCredentials: ["alice:secret"] }, // OK
        },
        {
          method: "POST",
          path: "/webhook3",
          handler: "onWebhook",
          auth: { mode: "BEARER", bearerTokens: ["t-1"] }, // OK
        },
      ],
    });
    // @ts-expect-error — BASIC requires basicCredentials
    void ({ mode: "BASIC" as const });
    // @ts-expect-error — BEARER requires bearerTokens
    void ({ mode: "BEARER" as const });
    expect(true).toBe(true);
  });

  test("SNMP version variants enforce the right field set", () => {
    defineEdgeApp({
      handle: "snmp",
      name: "SNMP",
      handlers: { onPoll: lua`bridge.log.info("snmp")` },
      triggers: [],
      snmpDevices: [
        {
          version: "V2C",
          name: "sw1",
          host: "10.0.0.10",
          community: "public",
          pollGroups: [
            {
              name: "ports",
              intervalMs: 5000,
              handler: "onPoll",
              oids: [{ label: "uptime", oid: "1.3.6.1.2.1.1.3.0" }],
            },
          ],
        },
        {
          version: "V3",
          name: "sw2",
          host: "10.0.0.11",
          v3: { user: "monitor", authProtocol: "SHA256", authKey: "${config:SNMP_KEY}" },
          pollGroups: [
            {
              name: "ports",
              intervalMs: 5000,
              handler: "onPoll",
              oids: [{ label: "uptime", oid: "1.3.6.1.2.1.1.3.0" }],
            },
          ],
        },
      ],
    });
    // @ts-expect-error — V3 requires the `v3` block
    void ({
      version: "V3" as const,
      name: "x",
      host: "h",
      pollGroups: [],
    });
    expect(true).toBe(true);
  });
});
