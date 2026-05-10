import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  deprecateDefinition,
  deprecateEdgeApp,
  listEdgeApps,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import type { LoadedEdgeApp } from "../loader.ts";
import { findDefinition, loadLocal } from "./_shared.ts";

export async function runDeprecate(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { loaded } = await loadLocal(folderArg);
  const client = createClient(loadConfig(overrides));

  if (loaded.kind === "app") {
    throw new Error(
      "Custom apps don't have a deprecate concept — they have a single working " +
        "copy and immutable version snapshots. Use 'restoreCustomAppVersion' to " +
        "roll back, or delete the app outright.",
    );
  }
  if (loaded.kind === "edge") {
    await deprecateEdge(client, loaded);
    return;
  }
  await deprecateIntegration(client, loaded.manifest.id, loaded.manifest.version);
}

async function deprecateIntegration(
  client: GraphQLClient,
  integrationId: string,
  version: string,
): Promise<void> {
  const def = await findDefinition(client, integrationId, version);
  if (!def) {
    throw new Error(`No definition found for ${integrationId}@${version}.`);
  }
  if (def.status === "DEPRECATED") {
    console.log(`${integrationId}@${version}: already DEPRECATED.`);
    return;
  }
  if (def.status === "DRAFT") {
    throw new Error(
      `${integrationId}@${version} is DRAFT — drafts can't be deprecated. ` +
        `Either publish it first or delete the local folder to abandon.`,
    );
  }
  const result = await deprecateDefinition(client, def.id);
  console.log(`${result.integrationId}@${result.version}: ${result.status}`);
}

/**
 * Deprecate the PUBLISHED row for this handle. The platform allows at
 * most one PUBLISHED row per handle, so we can resolve unambiguously
 * from the local manifest's handle. Idempotent on already-DEPRECATED
 * (the server treats redundant calls as no-ops).
 */
async function deprecateEdge(
  client: GraphQLClient,
  loaded: LoadedEdgeApp,
): Promise<void> {
  const handle = loaded.app.handle;
  const rows = await listEdgeApps(client, { handle });
  if (rows.length === 0) {
    throw new Error(`No edge app found for handle '${handle}'.`);
  }
  const published = rows.find((r) => r.status === "PUBLISHED");
  if (!published) {
    const states = rows.map((r) => `v${r.version}=${r.status}`).join(", ");
    throw new Error(
      `No PUBLISHED row for edge app '${handle}' (have: ${states}). ` +
        `Only PUBLISHED rows can be deprecated — DRAFTs should be deleted, ` +
        `and DEPRECATED rows are already retired.`,
    );
  }
  const result = await deprecateEdgeApp(client, published.id);
  console.log(
    `${result.handle}: v${result.version} → ${result.status} (${result.id}). ` +
      `Existing installations stay pinned and keep working until upgraded.`,
  );
}
