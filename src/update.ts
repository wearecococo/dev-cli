/**
 * Workspace-side codegen runner. Owns the `Syncer` registry, the
 * normal/`--check`/`--only` flows, and the digest sidecar. Pure logic
 * — the CLI command in `commands/update.ts` constructs the syncers
 * and calls `runUpdate`. Adding a new schema-driven syncer (trigger
 * configs, custom node configs, etc.) is a one-import wiring change.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GraphQLClient } from "./graphql/client.ts";

export type GeneratedFile = {
  /** Path relative to the workspace root, e.g. `.cococo/generated/node-types.d.ts`. */
  path: string;
  content: string;
};

export interface Syncer<TFetched = unknown> {
  readonly name: string;
  /** One-line description shown in `--help` and in the run summary. */
  readonly description: string;
  /** Hit the server. */
  fetch(client: GraphQLClient): Promise<TFetched>;
  /** Pure: turn fetched material into output files. */
  generate(input: TFetched, digest: string): GeneratedFile[];
  /**
   * Pure: deterministic content hash of the fetched material. Used
   * for drift detection and goes into the file header so a reader
   * can verify which snapshot generated the output.
   */
  digest(input: TFetched): string;
}

export type UpdateOptions = {
  check: boolean;
  only?: string;
};

export type UpdateSummary = {
  ranSyncers: string[];
  changed: string[];
  unchanged: string[];
  skipped: string[];
};

const DIGEST_FILE = ".cococo/schema-version.json";

type DigestSidecar = {
  generatedAt: string;
  syncers: Record<string, string>;
};

export async function runUpdate(
  syncers: Syncer[],
  client: GraphQLClient,
  workspaceRoot: string,
  opts: UpdateOptions,
): Promise<UpdateSummary> {
  const filtered = opts.only
    ? syncers.filter((s) => s.name === opts.only)
    : syncers;
  if (filtered.length === 0 && opts.only) {
    throw new Error(
      `Unknown syncer '${opts.only}'. Available: ${syncers.map((s) => s.name).join(", ")}.`,
    );
  }

  const summary: UpdateSummary = {
    ranSyncers: filtered.map((s) => s.name),
    changed: [],
    unchanged: [],
    skipped: syncers.filter((s) => !filtered.includes(s)).map((s) => s.name),
  };

  const sidecar = readSidecar(workspaceRoot);

  for (const syncer of filtered) {
    const fetched = await syncer.fetch(client);
    const digest = syncer.digest(fetched);
    const files = syncer.generate(fetched, digest);

    for (const file of files) {
      const absPath = resolve(workspaceRoot, file.path);
      const existing = existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
      if (existing === file.content) {
        summary.unchanged.push(file.path);
        continue;
      }
      summary.changed.push(file.path);
      if (!opts.check) {
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, file.content);
      }
    }

    sidecar.syncers[syncer.name] = digest;
  }

  if (!opts.check && summary.changed.length > 0) {
    sidecar.generatedAt = new Date().toISOString();
    writeSidecar(workspaceRoot, sidecar);
  }

  return summary;
}

function readSidecar(workspaceRoot: string): DigestSidecar {
  const path = resolve(workspaceRoot, DIGEST_FILE);
  if (!existsSync(path)) {
    return { generatedAt: "", syncers: {} };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DigestSidecar;
  } catch {
    return { generatedAt: "", syncers: {} };
  }
}

function writeSidecar(workspaceRoot: string, sidecar: DigestSidecar): void {
  const path = resolve(workspaceRoot, DIGEST_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sidecar, null, 2) + "\n");
}

/**
 * Deterministic SHA-256 of any JSON-serialisable value. Keys in
 * objects are sorted before hashing so two structurally-equal inputs
 * always produce the same digest.
 */
export function stableDigest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/**
 * Stable-stringify any JSON-serialisable value: object keys are sorted
 * recursively so two structurally-equal inputs always produce the
 * same string. Useful anywhere structural equality matters (digests,
 * snapshot comparisons, diff equality checks).
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}
