import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listAllArtifactFolders,
  makeFolder,
  walkIntegrationFiles,
} from "../src/project.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-walk-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listAllArtifactFolders", () => {
  test("returns folders from all three artifact dirs in deterministic order", () => {
    mkdirSync(join(root, "integrations", "orders"), { recursive: true });
    writeFileSync(join(root, "integrations", "orders", "manifest.ts"), "");
    mkdirSync(join(root, "integrations", "billing"), { recursive: true });
    writeFileSync(join(root, "integrations", "billing", "manifest.ts"), "");
    mkdirSync(join(root, "custom_apps", "job-board"), { recursive: true });
    writeFileSync(join(root, "custom_apps", "job-board", "manifest.ts"), "");
    mkdirSync(join(root, "edge_apps", "door-monitor"), { recursive: true });
    writeFileSync(join(root, "edge_apps", "door-monitor", "manifest.ts"), "");

    const folders = listAllArtifactFolders(root);
    // Order: integrations (alpha) → custom_apps (alpha) → edge_apps (alpha)
    expect(folders).toEqual([
      join(root, "integrations", "billing"),
      join(root, "integrations", "orders"),
      join(root, "custom_apps", "job-board"),
      join(root, "edge_apps", "door-monitor"),
    ]);
  });

  test("skips folders without a manifest", () => {
    mkdirSync(join(root, "integrations", "scaffold-only"), { recursive: true });
    // No manifest file
    mkdirSync(join(root, "integrations", "real"), { recursive: true });
    writeFileSync(join(root, "integrations", "real", "manifest.ts"), "");

    expect(listAllArtifactFolders(root)).toEqual([join(root, "integrations", "real")]);
  });

  test("treats yaml manifests as artifact folders too (legacy v1)", () => {
    mkdirSync(join(root, "integrations", "legacy"), { recursive: true });
    writeFileSync(join(root, "integrations", "legacy", "manifest.yaml"), "id: x\n");

    expect(listAllArtifactFolders(root)).toEqual([join(root, "integrations", "legacy")]);
  });

  test("empty repo returns empty list", () => {
    expect(listAllArtifactFolders(root)).toEqual([]);
  });

  test("missing artifact dirs are silently skipped", () => {
    // Only edge_apps exists.
    mkdirSync(join(root, "edge_apps", "x"), { recursive: true });
    writeFileSync(join(root, "edge_apps", "x", "manifest.ts"), "");

    expect(listAllArtifactFolders(root)).toEqual([join(root, "edge_apps", "x")]);
  });
});

describe("walkIntegrationFiles — _-prefixed support entries", () => {
  test("skips _-prefixed files at the artifact root", () => {
    const folder = join(root, "integrations", "foo");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "manifest.ts"), "");
    writeFileSync(join(folder, "_swagger.json"), '{ "openapi": "3.0.0" }');
    writeFileSync(join(folder, "scripts.lua"), "-- code");

    const walked = walkIntegrationFiles(makeFolder(folder));
    const paths = [...walked.keys()];
    expect(paths).toContain("scripts.lua");
    expect(paths).not.toContain("_swagger.json");
  });

  test("skips _-prefixed directories and everything inside", () => {
    const folder = join(root, "integrations", "foo");
    mkdirSync(join(folder, "_assets"), { recursive: true });
    mkdirSync(join(folder, "_design-notes", "drafts"), { recursive: true });
    writeFileSync(join(folder, "manifest.ts"), "");
    writeFileSync(join(folder, "_assets", "swagger.json"), "{}");
    writeFileSync(join(folder, "_assets", "icon.svg"), "<svg/>");
    writeFileSync(join(folder, "_design-notes", "drafts", "v2.md"), "# v2");
    writeFileSync(join(folder, "real.lua"), "-- code");

    const walked = walkIntegrationFiles(makeFolder(folder));
    const paths = [...walked.keys()];
    expect(paths).toEqual(["real.lua"]);
  });

  test("dotfiles, _-prefixed, and node_modules are all skipped together", () => {
    const folder = join(root, "integrations", "foo");
    mkdirSync(join(folder, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(folder, ".cache"), { recursive: true });
    mkdirSync(join(folder, "_assets"), { recursive: true });
    writeFileSync(join(folder, "manifest.ts"), "");
    writeFileSync(join(folder, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(folder, ".cache", "x.tmp"), "");
    writeFileSync(join(folder, "_assets", "doc.md"), "# doc");
    writeFileSync(join(folder, "handler.lua"), "-- code");

    const walked = walkIntegrationFiles(makeFolder(folder));
    expect([...walked.keys()]).toEqual(["handler.lua"]);
  });

  test("regular files starting with letters/digits are not affected", () => {
    const folder = join(root, "integrations", "foo");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "manifest.ts"), "");
    writeFileSync(join(folder, "1readme.md"), "");
    writeFileSync(join(folder, "a.lua"), "");
    writeFileSync(join(folder, "z-other.json"), "");

    const walked = walkIntegrationFiles(makeFolder(folder));
    expect([...walked.keys()].sort()).toEqual(["1readme.md", "a.lua", "z-other.json"]);
  });
});
