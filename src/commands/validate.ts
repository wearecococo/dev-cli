import { createClient } from "../graphql/client.ts";
import { validateDraft } from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { findDefinition, loadLocalIntegration } from "./_shared.ts";

export async function runValidate(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { manifest } = await loadLocalIntegration(folderArg);
  const client = createClient(loadConfig(overrides));

  const def = await findDefinition(client, manifest.id, manifest.version);
  if (!def) {
    throw new Error(
      `No draft found for ${manifest.id}@${manifest.version}. Run 'cococo push' first.`,
    );
  }
  if (def.status !== "DRAFT") {
    throw new Error(
      `${manifest.id}@${manifest.version} is ${def.status}, not a DRAFT. Nothing to validate.`,
    );
  }

  const result = await validateDraft(client, def.id);
  if (result.valid) {
    console.log(`${manifest.id}@${manifest.version}: valid.`);
    return;
  }
  console.error(`${manifest.id}@${manifest.version}: invalid.`);
  for (const e of result.errors) {
    console.error(`  ${e.path}: ${e.message}`);
  }
  process.exit(1);
}
