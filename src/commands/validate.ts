import { createClient } from "../graphql/client.ts";
import { validateDraft } from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { INTEGRATIONS_DIR, listAllArtifactFolders } from "../project.ts";
import { findDefinition, loadLocalIntegration } from "./_shared.ts";

export async function runValidate(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const result = await runValidateOnce(folderArg, overrides);
  printValidateResult(result);
  if (!result.valid) process.exit(1);
}

type ValidateResult =
  | { valid: true; key: string }
  | { valid: false; key: string; errors: { path: string; message: string }[] };

/**
 * Composable variant — performs one validation and returns the result
 * without printing or exiting. Used by the per-folder dispatcher and
 * by `runValidateAll`.
 */
async function runValidateOnce(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<ValidateResult> {
  const { manifest } = await loadLocalIntegration(folderArg);
  const client = createClient(loadConfig(overrides));

  const def = await findDefinition(client, manifest.id, manifest.version);
  const key = `${manifest.id}@${manifest.version}`;
  if (!def) {
    throw new Error(`No draft found for ${key}. Run 'cococo push' first.`);
  }
  if (def.status !== "DRAFT") {
    throw new Error(`${key} is ${def.status}, not a DRAFT. Nothing to validate.`);
  }
  const result = await validateDraft(client, def.id);
  return result.valid
    ? { valid: true, key }
    : { valid: false, key, errors: result.errors };
}

function printValidateResult(result: ValidateResult): void {
  if (result.valid) {
    console.log(`${result.key}: valid.`);
    return;
  }
  console.error(`${result.key}: invalid.`);
  for (const e of result.errors) console.error(`  ${e.path}: ${e.message}`);
}

/**
 * Validate every integration draft on the server. Custom apps and edge
 * apps don't have a separate validate step (push validates implicitly),
 * so this walks `integrations/` only and skips the other artifact dirs.
 *
 * Read-only check, so we continue past failures and aggregate; exit
 * non-zero if any artifact failed.
 */
export async function runValidateAll(overrides: ConfigOverrides): Promise<void> {
  const all = listAllArtifactFolders();
  const integrations = all.filter((f) => f.includes(`/${INTEGRATIONS_DIR}/`));
  if (integrations.length === 0) {
    console.log(
      `No integrations found under ${INTEGRATIONS_DIR}/. ` +
        `Custom apps and edge apps don't have a server validate step.`,
    );
    return;
  }

  let invalid = 0;
  let unprocessable = 0;
  for (const folder of integrations) {
    try {
      const result = await runValidateOnce(folder, overrides);
      printValidateResult(result);
      if (!result.valid) invalid++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${folder}: ${msg}`);
      unprocessable++;
    }
  }

  console.log(
    `\nSummary: ${integrations.length} integration(s), ` +
      `${invalid} invalid, ${unprocessable} unprocessable.`,
  );
  if (invalid > 0 || unprocessable > 0) process.exit(1);
}
