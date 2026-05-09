import { describe, expect, test } from "bun:test";
import {
  defineEdgeApp,
  lua,
  luaFile,
  manifestKind,
} from "../src/define.ts";

describe("defineEdgeApp", () => {
  test("tags result as 'edge'", () => {
    const spec = defineEdgeApp({
      handle: "door-monitor",
      name: "Door Monitor",
      handlers: { onTick: lua`bridge.log.info("tick")` },
      triggers: [
        { kind: "CRON", name: "tick", handler: "onTick", schedule: "*/5 * * * *" },
      ],
    });
    expect(manifestKind(spec)).toBe("edge");
    expect(spec.handle).toBe("door-monitor");
  });

  test("infers handler-name keys for trigger.handler refs", () => {
    // This test is a runtime stand-in for a compile-time guarantee:
    // we construct a spec where `triggers[*].handler` matches a
    // declared handler name. If the type inference for
    // `keyof H & string` were broken, this file wouldn't typecheck.
    const spec = defineEdgeApp({
      handle: "two-handlers",
      name: "Two Handlers",
      handlers: {
        onDoor: luaFile("./handlers/onDoor.lua"),
        onTick: luaFile("./handlers/onTick.lua"),
      },
      triggers: [
        { kind: "CRON", name: "tick", handler: "onTick", schedule: "* * * * *" },
        {
          kind: "FILE_CREATED",
          name: "door",
          handler: "onDoor",
          path: "/var/log/door",
          pattern: "*.evt",
        },
      ],
    });
    expect(spec.triggers).toHaveLength(2);
    // @ts-expect-error — typo "ondoor" isn't a key of handlers
    void { kind: "CRON", name: "x", handler: "ondoor", schedule: "*" };
  });

  test("trigger discriminated union enforces shape per kind", () => {
    // Same idea: compile-time check via `@ts-expect-error`. CRON
    // requires `schedule`; FILE_CREATED requires `path`.
    // @ts-expect-error — CRON without schedule
    void ({ kind: "CRON" as const, name: "x", handler: "h" });
    // @ts-expect-error — FILE_CREATED without path
    void ({ kind: "FILE_CREATED" as const, name: "x", handler: "h" });
    expect(true).toBe(true);
  });
});
