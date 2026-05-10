import { readFileSync } from "node:fs";
import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  createDraft,
  findEdgeAppDraft,
  getCustomAppByHandle,
  getDefinition,
  updateDraftFile,
  updateDraftManifest,
  upsertCustomApp,
  upsertEdgeApp,
  type CustomAppState,
  type EdgeAppState,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { makeFolder, walkIntegrationFiles } from "../project.ts";
import {
  manifestEngineVersion,
  manifestFromGraphql,
  manifestToWire,
  type WireManifest,
} from "../manifest.ts";
import { bundleToFiles } from "../bundle.ts";
import { diffFiles, summarize, type FileDiff } from "../diff.ts";
import {
  extractManifestSources,
  injectManifestSources,
  partitionFiles,
} from "../sources.ts";
import type {
  LoadedCustomApp,
  LoadedEdgeApp,
  LoadedIntegration,
} from "../loader.ts";
import { findDefinition, loadLocal } from "./_shared.ts";
import { reportLintFindings, runLintFindings } from "./lint.ts";

export type PushOptions = {
  /** Treat warnings as failures during the pre-push lint pass. */
  strict?: boolean;
};

export async function runPush(
  folderArg: string | undefined,
  opts: PushOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const { folder, loaded } = await loadLocal(folderArg);
  const client = createClient(loadConfig(overrides));

  // Pre-push Lua validation runs the same way regardless of kind —
  // collectLuaChecks already dispatches by kind and assigns the right
  // role per chunk.
  await runPrePushLint(folder.path, opts, overrides);

  if (loaded.kind === "app") {
    await pushCustomApp(client, folder.path, loaded);
    return;
  }
  if (loaded.kind === "edge") {
    await pushEdgeApp(client, folder.path, loaded);
    return;
  }
  await pushIntegration(client, folder.path, loaded);
}

async function runPrePushLint(
  folderPath: string,
  opts: PushOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const findings = await runLintFindings(folderPath, { strict: opts.strict ?? false }, overrides);
  if (findings.length === 0) return;
  const errorCount = findings.reduce(
    (n, f) => n + f.diagnostics.filter((d) => d.severity === "ERROR").length,
    0,
  );
  const warningCount = findings.reduce(
    (n, f) => n + f.diagnostics.filter((d) => d.severity === "WARNING").length,
    0,
  );
  const fatal = errorCount > 0 || (opts.strict && warningCount > 0);
  if (fatal) {
    reportLintFindings(findings);
    throw new Error(
      `Lua validation failed (${errorCount} error(s), ${warningCount} warning(s)). ` +
        `Fix and re-run push.`,
    );
  }
  reportLintFindings(findings);
  console.error(
    `\n${warningCount} warning(s) — non-fatal. Run with --strict to fail the push on warnings.`,
  );
}

async function pushIntegration(
  client: GraphQLClient,
  folderPath: string,
  loaded: LoadedIntegration,
): Promise<void> {
  const { manifest, format, consumed } = loaded;
  const folder = makeFolder(folderPath);

  const local = walkIntegrationFiles(folder);
  // Always reserve the materialisation directories from bundle uploads.
  // YAML binds them by convention; TS binds them via explicit luaFile()
  // refs. Either way the server's `IntegrationBundle` doesn't know about
  // these paths, so they must not travel via `updateDraftFile`.
  const { bundle: localBundle, sources: localSources } = partitionFiles(local);

  // For TS manifests, also exclude any luaFile() target outside the meta
  // dirs — those have already been baked into the manifest payload.
  if (consumed.size > 0) {
    for (const [path, abs] of [...localBundle]) {
      if (consumed.has(abs)) localBundle.delete(path);
    }
  }

  const manifestForWire = buildWireManifest(manifest, format, localSources);

  let def = await findDefinition(client, manifest.id, manifest.version);
  if (def && def.status !== "DRAFT") {
    throw new Error(
      `${manifest.id}@${manifest.version} is ${def.status} (immutable). ` +
        `Bump 'version' in the manifest to push a new draft.`,
    );
  }

  const engineVersion = manifestEngineVersion(manifest);

  if (!def) {
    console.log(
      `Creating new draft for ${manifest.id}@${manifest.version} (engineVersion ${engineVersion})…`,
    );
    def = await createDraft(client, {
      integrationId: manifest.id,
      version: manifest.version,
      runtimeMode: (manifest.runtime_mode as "bundle" | "script_actor" | undefined) ?? "script_actor",
      engineVersion,
    });
  } else if (def.engineVersion !== engineVersion) {
    throw new Error(
      `${manifest.id}@${manifest.version} is engineVersion ${def.engineVersion} on the server, ` +
        `but the local manifest declares ${engineVersion}. Engine version is fixed at draft ` +
        `creation — bump 'version' in the manifest to start a fresh draft.`,
    );
  }
  const draftId = def.id;

  // Snapshot remote before we mutate, so the diff/summary reflects the
  // real state we're transitioning from.
  const before = await getDefinition(client, draftId);
  if (!before.bundle) throw new Error(`Draft ${draftId} returned without a bundle.`);
  const remoteBundle = bundleToFiles(before.bundle);
  const bundleDiff = diffFiles(localBundle, remoteBundle);

  const remoteWireManifest = manifestFromGraphql(
    before.bundle.manifest,
    before.engineVersion,
  );
  const remoteSources = extractManifestSources(remoteWireManifest).files;
  const sourceDiff = diffFiles(localSources, remoteSources);

  await updateDraftManifest(client, {
    id: draftId,
    manifest: manifestToWire(manifestForWire),
  });

  for (const path of [...bundleDiff.added, ...bundleDiff.changed]) {
    const abs = localBundle.get(path);
    if (!abs) continue;
    const content = readFileSync(abs, "utf8");
    await updateDraftFile(client, { id: draftId, path, content });
  }

  for (const path of bundleDiff.deleted) {
    await updateDraftFile(client, { id: draftId, path, content: null });
  }

  console.log(`${manifest.id}@${manifest.version} (draft ${draftId}, ${format})`);
  console.log(`  bundle:    ${summarize(bundleDiff)}`);
  if (engineVersion === 2) {
    console.log(`  manifest:  ${summarize(sourceDiff)}`);
    listChanges(sourceDiff);
  }
}

function buildWireManifest(
  manifest: WireManifest,
  format: "ts" | "yaml",
  localSources: Map<string, string>,
): WireManifest {
  if (format === "ts") {
    // The loader has already resolved every luaFile() reference and
    // inlined it into the manifest. Nothing more to inject.
    return manifest;
  }
  // YAML: bind handler/lifecycle/library files to manifest entries by
  // convention. injectManifestSources fails loudly on stray files,
  // duplicates, and v1-with-source-files.
  const sourceContent = new Map<string, string>();
  for (const [path, abs] of localSources) {
    sourceContent.set(path, readFileSync(abs, "utf8"));
  }
  return injectManifestSources(manifest, sourceContent);
}

function listChanges(d: FileDiff): void {
  for (const p of d.added) console.log(`    + ${p}`);
  for (const p of d.changed) console.log(`    ~ ${p}`);
  for (const p of d.deleted) console.log(`    - ${p}`);
}

async function pushCustomApp(
  client: GraphQLClient,
  folderPath: string,
  loaded: LoadedCustomApp,
): Promise<void> {
  const { app } = loaded;

  // Custom apps don't use semver / DRAFT-ACTIVE — there's a single
  // working copy keyed by handle. Fetch the existing one (if any) so
  // upsert can carry the id forward; otherwise upsert creates a fresh
  // app on the platform.
  const existing = await getCustomAppByHandle(client, app.handle);

  const result = await upsertCustomApp(client, {
    id: existing?.id,
    name: app.name,
    handle: app.handle,
    kind: app.kind,
    icon: app.icon,
    dataContainerSpec: app.data_container_spec,
    config: {
      template: app.template,
      script: app.script,
      ...(app.server_api !== undefined ? { serverApi: app.server_api } : {}),
    },
  });

  reportCustomAppPush(result, folderPath, existing);
}

function reportCustomAppPush(
  result: CustomAppState,
  folderPath: string,
  existing: CustomAppState | undefined,
): void {
  const verb = existing ? "Updated" : "Created";
  const published = result.publishedVersion != null
    ? ` (published v${result.publishedVersion})`
    : ` (no published version yet — run 'cococo publish' to snapshot + publish)`;
  console.log(`${verb} custom app ${result.handle} → ${result.id}${published}`);
  console.log(`  folder: ${folderPath}`);
}

async function pushEdgeApp(
  client: GraphQLClient,
  folderPath: string,
  loaded: LoadedEdgeApp,
): Promise<void> {
  const { app } = loaded;

  // Edge-app row keyed by handle. If a DRAFT already exists, we update
  // it; if only PUBLISHED/DEPRECATED rows exist, upsertEdgeApp without
  // an id creates a fresh DRAFT (the platform allows at most one DRAFT
  // per handle so a second push without bumping past the publish lands
  // back on the same row).
  const existing = await findEdgeAppDraft(client, app.handle);
  const draftId = existing?.status === "DRAFT" ? existing.id : undefined;

  const result = await upsertEdgeApp(client, {
    id: draftId,
    handle: app.handle,
    name: app.name,
    description: app.description,
    triggers: app.triggers,
    handlers: app.handlers,
    libraries: app.libraries,
    mqttBrokers: app.mqtt_brokers,
    opcuaEndpoints: app.opcua_endpoints,
    snmpDevices: app.snmp_devices,
    modbusPorts: app.modbus_ports,
    execCommands: app.exec_commands,
    httpRoutes: app.http_routes,
    onMessage: app.on_message,
    configSchema: app.config_schema,
    logLevel: app.log_level,
    isActive: app.is_active,
  });

  reportEdgeAppPush(result, folderPath, draftId !== undefined);
}

function reportEdgeAppPush(
  result: EdgeAppState,
  folderPath: string,
  hadExistingDraft: boolean,
): void {
  const verb = hadExistingDraft ? "Updated" : "Created";
  console.log(
    `${verb} edge app ${result.handle} (DRAFT v${result.version}) → ${result.id}`,
  );
  console.log(`  folder: ${folderPath}`);
  console.log(
    `  ${result.handlers.length} handler(s), ${result.triggers.length} trigger(s), ` +
      `${result.libraries.length} librar${result.libraries.length === 1 ? "y" : "ies"}`,
  );
}
