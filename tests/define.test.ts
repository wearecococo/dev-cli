import { describe, expect, test } from "bun:test";
import { defineIntegration, isLuaFileMarker, lua, luaFile } from "../src/define.ts";

describe("lua template tag", () => {
  test("dedents the common leading indent", () => {
    const s = lua`
      local config = ...
      ctx.log.info("hi")
    `;
    expect(s).toBe(`local config = ...\nctx.log.info("hi")\n`);
  });

  test("interpolates values and dedents the result", () => {
    const topic = "jobs.created";
    const s = lua`
      local event, config = ...
      assert(event.topic == "${topic}")
    `;
    expect(s).toBe(`local event, config = ...\nassert(event.topic == "jobs.created")\n`);
  });

  test("preserves blank lines between statements", () => {
    const s = lua`
      local x = 1

      return x
    `;
    expect(s).toBe(`local x = 1\n\nreturn x\n`);
  });

  test("leaves zero-indent input unchanged", () => {
    const s = lua`local x = 1\nreturn x\n`;
    // No leading newline, no common indent — strip nothing.
    expect(s).toBe(`local x = 1\nreturn x\n`);
  });
});

describe("luaFile sentinel", () => {
  test("returns a marker carrying the requested path", () => {
    const ref = luaFile("./handlers/timers/tick.lua");
    expect(isLuaFileMarker(ref)).toBe(true);
    if (isLuaFileMarker(ref)) {
      expect(ref.path).toBe("./handlers/timers/tick.lua");
    }
  });

  test("plain strings are not luaFile markers", () => {
    expect(isLuaFileMarker("ctx.log.info('hi')")).toBe(false);
    expect(isLuaFileMarker(null)).toBe(false);
    expect(isLuaFileMarker({ path: "./x.lua" })).toBe(false);
  });
});

describe("defineIntegration", () => {
  test("returns the value unchanged (identity helper for type pinning)", () => {
    const spec = defineIntegration({
      id: "com.acme.foo",
      version: "0.1.0",
      sdkVersion: "1.0",
      runtimeMode: "script_actor",
      resources: [],
      permissions: [],
      timers: [
        { name: "heartbeat", every: "1m", source: lua`ctx.log.info("hi")` },
      ],
    });
    expect(spec.id).toBe("com.acme.foo");
    expect(spec.timers?.[0]?.name).toBe("heartbeat");
  });
});
