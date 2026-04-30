import { createClient } from "../graphql/client.ts";
import { getDefinition } from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { walkIntegrationFiles } from "../project.ts";
import { bundleToFiles } from "../bundle.ts";
import { diffFiles, summarize } from "../diff.ts";
import { findDefinition, loadLocal } from "./_shared.ts";

export async function runStatus(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { folder, manifest } = loadLocal(folderArg);
  const client = createClient(loadConfig(overrides));

  const local = walkIntegrationFiles(folder);

  const def = await findDefinition(client, manifest.id, manifest.version);
  if (!def) {
    console.log(`${manifest.id}@${manifest.version}: no remote draft.`);
    console.log(`  ${local.size} local file(s) would be uploaded by 'cococo push'.`);
    return;
  }

  if (def.status !== "DRAFT") {
    console.log(`${manifest.id}@${manifest.version}: status ${def.status} (immutable).`);
    return;
  }

  const full = await getDefinition(client, def.id);
  if (!full.bundle) {
    throw new Error(`Definition ${def.id} returned without a bundle.`);
  }
  const remote = bundleToFiles(full.bundle);

  const d = diffFiles(local, remote);
  console.log(`${manifest.id}@${manifest.version} (draft ${def.id})`);
  console.log(`  ${summarize(d)}`);
  for (const p of d.added) console.log(`  + ${p}`);
  for (const p of d.changed) console.log(`  ~ ${p}`);
  for (const p of d.deleted) console.log(`  - ${p}`);
}
