import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  getCustomAppByHandle,
  getDefinition,
  type CustomAppState,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { walkIntegrationFiles } from "../project.ts";
import { bundleToFiles } from "../bundle.ts";
import { diffFiles, summarize, type FileDiff } from "../diff.ts";
import { manifestEngineVersion, manifestFromGraphql } from "../manifest.ts";
import { extractManifestSources, partitionFiles } from "../sources.ts";
import type { LoadedCustomApp, LoadedIntegration } from "../loader.ts";
import { findDefinition, loadLocal } from "./_shared.ts";

export async function runStatus(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { folder, loaded } = await loadLocal(folderArg);
  const client = createClient(loadConfig(overrides));

  if (loaded.kind === "app") {
    await statusCustomApp(client, loaded);
    return;
  }
  await statusIntegration(client, folder, loaded);
}

async function statusIntegration(
  client: GraphQLClient,
  folder: { path: string; posixRelative: (abs: string) => string },
  loaded: LoadedIntegration,
): Promise<void> {
  const { manifest, format, consumed } = loaded;

  const local = walkIntegrationFiles(folder);
  const { bundle: localBundle, sources: localSources } = partitionFiles(local);
  if (consumed.size > 0) {
    for (const [path, abs] of [...localBundle]) {
      if (consumed.has(abs)) localBundle.delete(path);
    }
  }

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

  const remoteBundle = bundleToFiles(full.bundle);
  const bundleDiff = diffFiles(localBundle, remoteBundle);

  console.log(`${manifest.id}@${manifest.version} (draft ${def.id}, ${format})`);
  console.log(`  bundle:    ${summarize(bundleDiff)}`);
  printDiff(bundleDiff);

  if (manifestEngineVersion(manifest) === 2) {
    const remoteWire = manifestFromGraphql(full.bundle.manifest, full.engineVersion);
    const remoteSources = extractManifestSources(remoteWire).files;
    const sourceDiff = diffFiles(localSources, remoteSources);
    console.log(`  manifest:  ${summarize(sourceDiff)}`);
    printDiff(sourceDiff, "    ");
  }
}

async function statusCustomApp(
  client: GraphQLClient,
  loaded: LoadedCustomApp,
): Promise<void> {
  const { app } = loaded;
  const remote = await getCustomAppByHandle(client, app.handle);
  if (!remote) {
    console.log(`custom app ${app.handle}: no remote working copy yet.`);
    console.log(`  Run 'cococo push' to create it.`);
    return;
  }
  printAppDiff(app, remote);
}

function printAppDiff(
  local: { template: string; script: string; server_api?: string },
  remote: CustomAppState,
): void {
  const slots: Array<["template" | "script" | "serverApi", string, string | null]> = [
    ["template", local.template, remote.template],
    ["script", local.script, remote.script],
    ["serverApi", local.server_api ?? "", remote.serverApi ?? null],
  ];
  console.log(`custom app ${remote.handle} → ${remote.id}`);
  console.log(
    `  publishedVersion: ${remote.publishedVersion ?? "(none)"}`,
  );
  for (const [name, localValue, remoteValue] of slots) {
    if (name === "serverApi" && !localValue && !remoteValue) continue;
    const same = localValue === (remoteValue ?? "");
    console.log(`  ${pad(name, 10)} ${same ? "unchanged" : "changed"}`);
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function printDiff(d: FileDiff, indent = "  "): void {
  for (const p of d.added) console.log(`${indent}+ ${p}`);
  for (const p of d.changed) console.log(`${indent}~ ${p}`);
  for (const p of d.deleted) console.log(`${indent}- ${p}`);
}
