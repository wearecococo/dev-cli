import { createClient } from "../graphql/client.ts";
import { getDefinition } from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { walkIntegrationFiles } from "../project.ts";
import { bundleToFiles } from "../bundle.ts";
import { diffFiles, summarize, type FileDiff } from "../diff.ts";
import { manifestEngineVersion, manifestFromGraphql } from "../manifest.ts";
import { extractManifestSources, partitionFiles } from "../sources.ts";
import { findDefinition, loadLocal } from "./_shared.ts";

export async function runStatus(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { folder, manifest, format, consumed } = await loadLocal(folderArg);
  const client = createClient(loadConfig(overrides));

  const local = walkIntegrationFiles(folder);
  const { bundle: localBundle, sources: localSources } = partitionFiles(local);
  // TS folders may reference Lua files outside the meta-dirs via luaFile();
  // those have been baked into the manifest payload and should not be
  // counted as bundle files for diffing.
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

function printDiff(d: FileDiff, indent = "  "): void {
  for (const p of d.added) console.log(`${indent}+ ${p}`);
  for (const p of d.changed) console.log(`${indent}~ ${p}`);
  for (const p of d.deleted) console.log(`${indent}- ${p}`);
}
