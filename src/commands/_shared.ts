import { loadManifest, type ManifestFormat } from "../loader.ts";
import { resolveIntegrationFolder, type IntegrationFolder } from "../project.ts";
import {
  listDefinitions,
  type IntegrationDefinition,
} from "../graphql/operations.ts";
import type { GraphQLClient } from "../graphql/client.ts";
import type { WireManifest } from "../manifest.ts";

export type LoadedIntegration = {
  folder: IntegrationFolder;
  manifest: WireManifest;
  format: ManifestFormat;
  /**
   * Absolute paths consumed by `luaFile()` references on a TS manifest —
   * push must NOT also upload these as bundle files. Empty for YAML.
   */
  consumed: Set<string>;
};

export async function loadLocal(folderArg: string | undefined): Promise<LoadedIntegration> {
  const folder = resolveIntegrationFolder(folderArg);
  const loaded = await loadManifest(folder.path);
  return {
    folder,
    manifest: loaded.manifest,
    format: loaded.format,
    consumed: loaded.consumed,
  };
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
