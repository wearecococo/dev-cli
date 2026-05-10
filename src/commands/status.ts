import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  findEdgeAppDraft,
  getCustomAppByHandle,
  getDefinition,
  type CustomAppState,
  type EdgeAppState,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { walkIntegrationFiles } from "../project.ts";
import { bundleToFiles } from "../bundle.ts";
import { diffFiles, summarize, type FileDiff } from "../diff.ts";
import { manifestEngineVersion, manifestFromGraphql } from "../manifest.ts";
import { extractManifestSources, partitionFiles } from "../sources.ts";
import type {
  LoadedCustomApp,
  LoadedEdgeApp,
  LoadedIntegration,
} from "../loader.ts";
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
  if (loaded.kind === "edge") {
    await statusEdgeApp(client, loaded);
    return;
  }
  if (loaded.kind === "workflow") {
    console.log(
      `${loaded.workflow.handle}: workflow status diff is not yet implemented. ` +
        `Use 'cococo lint' to validate the definition or 'cococo push' to snapshot a new version.`,
    );
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

async function statusEdgeApp(
  client: GraphQLClient,
  loaded: LoadedEdgeApp,
): Promise<void> {
  const { app } = loaded;
  const remote = await findEdgeAppDraft(client, app.handle);
  if (!remote) {
    console.log(`edge app ${app.handle}: no remote row yet.`);
    console.log(`  Run 'cococo push' to create the first DRAFT.`);
    return;
  }
  if (remote.status !== "DRAFT") {
    console.log(`edge app ${app.handle}: latest is ${remote.status} v${remote.version}.`);
    console.log(`  'cococo push' will create a fresh DRAFT (a new monotonic version).`);
    return;
  }
  printEdgeAppDiff(app, remote);
}

function printEdgeAppDiff(
  local: { handlers: Array<{ name: string; source: string }>; triggers: Array<{ name: string; handler: string }>; libraries?: Array<{ name: string; source: string }>; on_message?: string },
  remote: EdgeAppState,
): void {
  console.log(`edge app ${remote.handle} → ${remote.id} (DRAFT v${remote.version})`);

  const localHandlers = new Map(local.handlers.map((h) => [h.name, h.source]));
  const remoteHandlers = new Map(remote.handlers.map((h) => [h.name, h.source]));
  const localLibs = new Map((local.libraries ?? []).map((l) => [l.name, l.source]));
  const remoteLibs = new Map(remote.libraries.map((l) => [l.name, l.source]));

  diffMap("handlers", localHandlers, remoteHandlers);
  diffMap("libraries", localLibs, remoteLibs);

  const localOnMsg = local.on_message ?? "";
  const remoteOnMsg = remote.onMessage ?? "";
  if (localOnMsg !== remoteOnMsg) {
    console.log(`  onMessage: changed`);
  }

  const localTrigs = local.triggers.map((t) => `${t.name}→${t.handler}`).sort().join(",");
  const remoteTrigs = remote.triggers
    .map((t) => `${t.name}→${t.handler}`)
    .sort()
    .join(",");
  if (localTrigs !== remoteTrigs) {
    console.log(`  triggers: changed`);
  }
}

function diffMap(
  label: string,
  local: Map<string, string>,
  remote: Map<string, string>,
): void {
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [name, source] of local) {
    if (!remote.has(name)) added.push(name);
    else if (remote.get(name) !== source) changed.push(name);
  }
  for (const name of remote.keys()) {
    if (!local.has(name)) deleted.push(name);
  }
  if (added.length === 0 && changed.length === 0 && deleted.length === 0) {
    console.log(`  ${label}: unchanged (${local.size})`);
    return;
  }
  console.log(
    `  ${label}: +${added.length} ~${changed.length} -${deleted.length}`,
  );
  for (const n of added) console.log(`    + ${n}`);
  for (const n of changed) console.log(`    ~ ${n}`);
  for (const n of deleted) console.log(`    - ${n}`);
}

function printDiff(d: FileDiff, indent = "  "): void {
  for (const p of d.added) console.log(`${indent}+ ${p}`);
  for (const p of d.changed) console.log(`${indent}~ ${p}`);
  for (const p of d.deleted) console.log(`${indent}- ${p}`);
}
