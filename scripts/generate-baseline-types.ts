#!/usr/bin/env bun
/**
 * Maintainer-only: regenerate `src/generated/node-types.d.ts` from the
 * checked-in fixture under `tests/fixtures/node-schemas/`. The fixture
 * is the source of truth for the shipped baseline; refresh it via
 * `bun scripts/capture-node-fixtures.ts` (which hits the live server)
 * and then re-run this script to bake the result into the package.
 *
 * Usage:
 *   bun run codegen
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractNodeSchemas } from "../src/codegen/extract-node-schemas.ts";
import { emitNodeTypes } from "../src/codegen/schema-emitter.ts";

const RAW_FIXTURE = "tests/fixtures/node-schemas/_workflow-schema.raw.json";
const OUTPUT = "src/generated/node-types.d.ts";

function digest(schemas: Record<string, unknown>): string {
  // Deterministic: sort keys before hashing.
  const sorted = Object.keys(schemas)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = schemas[k];
      return acc;
    }, {});
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

const raw = readFileSync(RAW_FIXTURE, "utf8");
const schemas = extractNodeSchemas(raw);
const hex = digest(schemas);
const content = emitNodeTypes(schemas, { digest: hex });

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, content);

console.log(`Wrote ${OUTPUT}`);
console.log(`  ${Object.keys(schemas).length} node types`);
console.log(`  digest: ${hex.slice(0, 16)}…`);
