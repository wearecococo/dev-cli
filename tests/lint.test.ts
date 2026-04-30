import { describe, expect, test } from "bun:test";
import { findLuaFiles } from "../src/commands/lint.ts";

describe("findLuaFiles", () => {
  test("keeps .lua files only", () => {
    const all = new Map<string, string>([
      ["scripts/main.lua", "/abs/scripts/main.lua"],
      ["scripts/util.lua", "/abs/scripts/util.lua"],
      ["app/index.html", "/abs/app/index.html"],
      ["app/script.js", "/abs/app/script.js"],
      ["app/server.lua", "/abs/app/server.lua"],
      ["config_schema.json", "/abs/config_schema.json"],
    ]);
    const lua = findLuaFiles(all);
    expect(Array.from(lua.keys()).sort()).toEqual([
      "app/server.lua",
      "scripts/main.lua",
      "scripts/util.lua",
    ]);
  });

  test("empty in, empty out", () => {
    expect(findLuaFiles(new Map()).size).toBe(0);
  });

  test("ignores .lua suffix in directory names", () => {
    const all = new Map<string, string>([
      ["lua-stuff/notes.txt", "/abs/lua-stuff/notes.txt"],
    ]);
    expect(findLuaFiles(all).size).toBe(0);
  });
});
