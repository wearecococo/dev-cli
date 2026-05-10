import { describe, expect, test } from "bun:test";
import { defineDevices, defineNetworks } from "../src/define.ts";

/**
 * Compile-time guarantees expressed as `@ts-expect-error` checks: the
 * outbound/inbound protocol unions are discriminated on `kind`, so the
 * type system rejects field combinations that don't apply (e.g. `host`
 * on an HTTP outbound, `topic` on an HTTP inbound).
 */
describe("device protocol unions — TS guarantees", () => {
  test("network ref and identifier are required", () => {
    defineDevices([
      { identifier: "ok-1" },
      { identifier: "ok-2", network: "press-floor" },
    ]);
    // @ts-expect-error — identifier required
    void ({ network: "press-floor" } as Parameters<typeof defineDevices>[0][number]);
    expect(true).toBe(true);
  });

  test("HTTP outbound requires url; rejects SQL-only fields", () => {
    defineDevices([
      {
        identifier: "h1",
        outboundProtocols: [
          { kind: "HTTP", url: "https://x", authMode: "BASIC", username: "u", password: "p" },
        ],
      },
    ]);
    defineDevices([
      {
        identifier: "h2",
        outboundProtocols: [
          // @ts-expect-error — HTTP doesn't carry adapter/host
          { kind: "HTTP", url: "https://x", adapter: "POSTGRESQL", host: "h" },
        ],
      },
    ]);
    defineDevices([
      {
        identifier: "h3",
        // @ts-expect-error — HTTP requires url
        outboundProtocols: [{ kind: "HTTP", username: "u" }],
      },
    ]);
    expect(true).toBe(true);
  });

  test("SQL outbound requires adapter; rejects MQTT topic", () => {
    defineDevices([
      {
        identifier: "s1",
        outboundProtocols: [
          {
            kind: "SQL",
            adapter: "MSSQL",
            host: "db.local",
            port: 1433,
            databaseName: "production",
            username: "reader",
          },
        ],
      },
    ]);
    defineDevices([
      {
        identifier: "s2",
        outboundProtocols: [
          // @ts-expect-error — MQTT-only `topic` not allowed on SQL
          { kind: "SQL", adapter: "MYSQL", host: "h", topic: "events" },
        ],
      },
    ]);
    defineDevices([
      {
        identifier: "s3",
        // @ts-expect-error — SQL requires adapter
        outboundProtocols: [{ kind: "SQL", host: "h" }],
      },
    ]);
    expect(true).toBe(true);
  });

  test("MQTT outbound requires url + topic", () => {
    defineDevices([
      {
        identifier: "m1",
        outboundProtocols: [
          { kind: "MQTT", url: "mqtt://b:1883", topic: "data/#" },
        ],
      },
    ]);
    defineDevices([
      {
        identifier: "m2",
        // @ts-expect-error — MQTT requires url
        outboundProtocols: [{ kind: "MQTT", topic: "data/#" }],
      },
    ]);
    defineDevices([
      {
        identifier: "m3",
        // @ts-expect-error — MQTT requires topic
        outboundProtocols: [{ kind: "MQTT", url: "mqtt://b:1883" }],
      },
    ]);
    expect(true).toBe(true);
  });

  test("inbound MQTT requires topic; inbound HTTP requires webhookPath", () => {
    defineDevices([
      {
        identifier: "i1",
        inboundProtocols: [{ kind: "MQTT", topic: "press/01/#" }],
      },
      {
        identifier: "i2",
        inboundProtocols: [{ kind: "HTTP", webhookPath: "/hooks/i2" }],
      },
    ]);
    defineDevices([
      {
        identifier: "i3",
        // @ts-expect-error — MQTT inbound has no `webhookPath`
        inboundProtocols: [{ kind: "MQTT", webhookPath: "/wrong" }],
      },
    ]);
    defineDevices([
      {
        identifier: "i4",
        // @ts-expect-error — HTTP inbound requires webhookPath
        inboundProtocols: [{ kind: "HTTP" }],
      },
    ]);
    expect(true).toBe(true);
  });

  test("network spec accepts only name + description", () => {
    defineNetworks([
      { name: "n1" },
      { name: "n2", description: "Office" },
    ]);
    // @ts-expect-error — name is required
    defineNetworks([{ description: "anonymous" }]);
    // @ts-expect-error — id isn't part of the author surface (server-generated)
    defineNetworks([{ name: "n3", id: "net_xxx" }]);
    expect(true).toBe(true);
  });
});
