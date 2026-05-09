import {
  expectIntegration,
  loadManifest,
  type LoadedManifest,
  type LoadedIntegration as LoadedIntegrationCore,
} from "../loader.ts";
import { resolveIntegrationFolder, type IntegrationFolder } from "../project.ts";
import {
  listDefinitions,
  type IntegrationDefinition,
} from "../graphql/operations.ts";
import type { GraphQLClient } from "../graphql/client.ts";

export type LoadedAtFolder = {
  folder: IntegrationFolder;
  loaded: LoadedManifest;
};

/**
 * Resolve a folder argument and load whatever manifest sits there. The
 * returned `loaded` is a discriminated union — caller narrows to either
 * an integration or a custom app via `expectIntegration` /
 * `expectIntegrationAt` / `expectAppAt`.
 */
export async function loadLocal(folderArg: string | undefined): Promise<LoadedAtFolder> {
  const folder = resolveIntegrationFolder(folderArg);
  const loaded = await loadManifest(folder.path);
  return { folder, loaded };
}

/**
 * Convenience for commands that only handle integrations: load + narrow
 * + flatten into one call. Throws with a clear error if the folder
 * contains a custom app.
 */
export async function loadLocalIntegration(
  folderArg: string | undefined,
): Promise<{ folder: IntegrationFolder } & LoadedIntegrationCore> {
  const { folder, loaded } = await loadLocal(folderArg);
  return { folder, ...expectIntegration(loaded) };
}

export async function findDefinition(
  client: GraphQLClient,
  integrationId: string,
  version: string,
): Promise<IntegrationDefinition | undefined> {
  const matches = await listDefinitions(client, { integrationId, version });
  if (matches.length === 0) return undefined;
  const draft = matches.find((m) => m.status === "DRAFT");
  return draft ?? matches[0];
}
