import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAllArtifactFolders } from "../src/project.ts";

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
