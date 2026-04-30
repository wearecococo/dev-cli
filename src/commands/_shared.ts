import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILENAME, parseManifest, type WireManifest } from "../manifest.ts";
import { resolveIntegrationFolder, type IntegrationFolder } from "../project.ts";
import {
  listDefinitions,
  type IntegrationDefinition,
} from "../graphql/operations.ts";
import type { GraphQLClient } from "../graphql/client.ts";

export type LoadedIntegration = {
  folder: IntegrationFolder;
  manifest: WireManifest;
};

export function loadLocal(folderArg: string | undefined): LoadedIntegration {
  const folder = resolveIntegrationFolder(folderArg);
  const manifestText = readFileSync(join(folder.path, MANIFEST_FILENAME), "utf8");
  const manifest = parseManifest(manifestText);
  return { folder, manifest };
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
