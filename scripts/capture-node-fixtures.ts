#!/usr/bin/env bun
/**
 * One-off fixture capture script. Hits the live server via the CLI's
 * existing GraphQL client, pulls `getWorkflowSchema`, extracts each
 * node-type config sub-schema, and writes it as a JSON fixture under
 * `tests/fixtures/node-schemas/<type>.json`. The full raw schema is
 * also written as `_workflow-schema.raw.json` for diffability.
 *
 * Re-run whenever the server's node-type registry changes:
 *   bun scripts/capture-node-fixtures.ts
 *
 * Reads COCOCO_ENDPOINT / COCOCO_TOKEN from env (.env auto-loaded).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../src/graphql/client.ts";
import { getWorkflowSchema } from "../src/graphql/operations.ts";
import { loadConfig } from "../src/config.ts";
import { extractNodeSchemas } from "../src/codegen/extract-node-schemas.ts";

const FIXTURE_DIR = "tests/fixtures/node-schemas";

async function main(): Promise<void> {
  const client = createClient(loadConfig());
  const raw = await getWorkflowSchema(client);
  const schemas = extractNodeSchemas(raw);

  mkdirSync(FIXTURE_DIR, { recursive: true });

  const parsed = JSON.parse(raw);
  writeFileSync(
    join(FIXTURE_DIR, "_workflow-schema.raw.json"),
    JSON.stringify(parsed, null, 2) + "\n",
  );

  const types = Object.keys(schemas).sort();
  for (const type of types) {
    writeFileSync(
      join(FIXTURE_DIR, `${type}.json`),
      JSON.stringify(schemas[type], null, 2) + "\n",
    );
  }

  console.log(`Wrote ${types.length} node-type fixtures to ${FIXTURE_DIR}/`);
  console.log(`  Raw: _workflow-schema.raw.json`);
  for (const type of types) console.log(`  ${type}.json`);
}

await main();
