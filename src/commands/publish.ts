import { createClient } from "../graphql/client.ts";
import { publishDraft, validateDraft } from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { findDefinition, loadLocal } from "./_shared.ts";

export async function runPublish(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { manifest } = await loadLocal(folderArg);
  const client = createClient(loadConfig(overrides));

  const def = await findDefinition(client, manifest.id, manifest.version);
  if (!def) {
    throw new Error(
      `No draft found for ${manifest.id}@${manifest.version}. Run 'cococo push' first.`,
    );
  }
  if (def.status !== "DRAFT") {
    throw new Error(
      `${manifest.id}@${manifest.version} is already ${def.status}.`,
    );
  }

  const validation = await validateDraft(client, def.id);
  if (!validation.valid) {
    console.error(`${manifest.id}@${manifest.version}: validation failed, refusing to publish.`);
    for (const e of validation.errors) console.error(`  ${e.path}: ${e.message}`);
    process.exit(1);
  }

  const published = await publishDraft(client, def.id);
  console.log(`${published.integrationId}@${published.version}: ${published.status}`);
}
