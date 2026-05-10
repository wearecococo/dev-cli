import { createClient } from "../graphql/client.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { runUpdate, type Syncer } from "../update.ts";
import { nodeTypeSyncer } from "../codegen/node-type-syncer.ts";

/**
 * The default syncer registry. Append new entries here when a future
 * phase ships another schema-driven artifact (trigger configs,
 * customAction config schemas, integration resource schemas, etc.).
 */
const DEFAULT_SYNCERS: Syncer[] = [nodeTypeSyncer];

export type UpdateCommandOptions = {
  check: boolean;
  only?: string;
};

export async function runUpdateCommand(
  opts: UpdateCommandOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const client = createClient(loadConfig(overrides));
  const summary = await runUpdate(DEFAULT_SYNCERS, client, process.cwd(), {
    check: opts.check,
    only: opts.only,
  });

  if (summary.skipped.length > 0) {
    console.log(`Skipped: ${summary.skipped.join(", ")}`);
  }

  if (opts.check) {
    if (summary.changed.length === 0) {
      console.log(
        `cococo update --check: ${summary.unchanged.length} file(s) up to date.`,
      );
      return;
    }
    console.error(
      `cococo update --check: ${summary.changed.length} file(s) would change:`,
    );
    for (const f of summary.changed) console.error(`  - ${f}`);
    console.error(`Run 'cococo update' to refresh.`);
    process.exit(1);
  }

  if (summary.changed.length === 0) {
    console.log(`Already up to date (${summary.unchanged.length} file(s)).`);
    return;
  }

  console.log(`Updated ${summary.changed.length} file(s):`);
  for (const f of summary.changed) console.log(`  + ${f}`);
  if (summary.unchanged.length > 0) {
    console.log(`(${summary.unchanged.length} file(s) already up to date.)`);
  }
}
