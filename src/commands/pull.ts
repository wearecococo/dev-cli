import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  findEdgeAppDraft,
  getCustomAppByHandle,
  getDefinition,
  getWorkflowByName,
  getWorkflowVersion,
  listDefinitions,
  listWorkflowTriggers,
  type WorkflowTriggerState,
  type WorkflowVersionState,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { bundleToFiles } from "../bundle.ts";
import {
  MANIFEST_FILENAME,
  manifestFromGraphql,
  serializeManifest,
  shortName,
} from "../manifest.ts";
import { MANIFEST_TS_FILENAME, type ManifestFormat } from "../loader.ts";
import {
  CUSTOM_APPS_DIR,
  EDGE_APPS_DIR,
  INTEGRATIONS_DIR,
  WORKFLOWS_DIR,
} from "../project.ts";
import {
  printAppManifestTs,
  printEdgeAppManifestTs,
  printManifestTs,
  printWorkflowManifestTs,
} from "../printer.ts";
import { extractManifestSources } from "../sources.ts";

export type PullStatusFilter = "draft" | "published" | "any";

export type PullOptions = {
  version?: string;
  force: boolean;
  format?: ManifestFormat;
  /** "integration" (default) | "app" | "edge" | "workflow". */
  type?: "integration" | "app" | "edge" | "workflow";
  /**
   * Status filter for integrations. Default: prefer DRAFT, fall back to
   * the latest ACTIVE. "draft" / "published" pin a single status; "any"
   * picks the highest version across all statuses.
   */
  status?: PullStatusFilter;
};

export async function runPull(
  idOrHandle: string,
  opts: PullOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const client = createClient(loadConfig(overrides));
  const type = opts.type ?? "integration";

  if (type === "app") {
    return runPullCustomApp(client, idOrHandle, opts);
  }
  if (type === "edge") {
    return runPullEdgeApp(client, idOrHandle, opts);
  }
  if (type === "workflow") {
    return runPullWorkflow(client, idOrHandle, opts);
  }

  const integrationId = idOrHandle;
  const format: ManifestFormat = opts.format ?? "ts";
  const statusFilter: PullStatusFilter = opts.status ?? "any";

  const all = await listDefinitions(client, { integrationId });
  if (all.length === 0) {
    throw new Error(`No definitions found for ${integrationId}.`);
  }

  const drafts = all.filter((d) => d.status === "DRAFT");
  const actives = all.filter((d) => d.status === "ACTIVE");
  const deprecateds = all.filter((d) => d.status === "DEPRECATED");

  let pool: typeof all;
  if (statusFilter === "draft") {
    pool = drafts;
    if (pool.length === 0) {
      throw new Error(`No DRAFT definition found for ${integrationId}.`);
    }
  } else if (statusFilter === "published") {
    pool = [...actives, ...deprecateds];
    if (pool.length === 0) {
      throw new Error(`No published (ACTIVE/DEPRECATED) definition found for ${integrationId}.`);
    }
  } else {
    // "any" — prefer DRAFT, then ACTIVE, then DEPRECATED. Falling back
    // lets `pull` work for integrations that have only ever been published.
    pool = drafts.length > 0 ? drafts : actives.length > 0 ? actives : deprecateds;
  }

  let chosen = pool[0]!;
  if (opts.version) {
    const match = pool.find((d) => d.version === opts.version);
    if (!match) {
      throw new Error(
        `No ${describeStatusFilter(statusFilter)} for ${integrationId}@${opts.version}. ` +
          `Available: ${pool.map((d) => `${d.version} (${d.status})`).join(", ")}`,
      );
    }
    chosen = match;
  } else if (pool.length > 1) {
    chosen = pool.slice().sort((a, b) => compareVersions(b.version, a.version))[0]!;
  }

  const full = await getDefinition(client, chosen.id);
  if (!full.bundle) throw new Error(`Definition ${chosen.id} returned without a bundle.`);

  const target = resolve(process.cwd(), INTEGRATIONS_DIR, shortName(integrationId));
  if (existsSync(target) && readdirSync(target).length > 0 && !opts.force) {
    throw new Error(`${target} already exists and is not empty. Use --force to overwrite.`);
  }
  mkdirSync(target, { recursive: true });

  const wireManifest = manifestFromGraphql(full.bundle.manifest, full.engineVersion);

  if (format === "ts" && full.engineVersion === 1) {
    throw new Error(
      `${integrationId}@${chosen.version} is engineVersion 1 on the server, ` +
        `and manifest.ts is v2-only. Re-run with '--format yaml' to pull this ` +
        `as a YAML manifest.`,
    );
  }

  // For TS: materialise every source to disk, and emit a manifest.ts that
  // references each via luaFile(). The wire manifest is left intact so the
  // printer can map each source field to its conventional handler path.
  // For YAML: extract sources, write the stripped manifest as manifest.yaml,
  // and write the source files alongside.
  if (format === "ts") {
    writeFileSync(join(target, MANIFEST_TS_FILENAME), printManifestTs(wireManifest));
    const { files: sourceFiles } = extractManifestSources(wireManifest);
    writeMaterialised(target, sourceFiles);
    const bundleFiles = bundleToFiles(full.bundle);
    writeMaterialised(target, bundleFiles);
    const total = bundleFiles.size + sourceFiles.size + 1;
    console.log(
      `Pulled ${integrationId}@${chosen.version} [${chosen.status}] into integrations/${shortName(
        integrationId,
      )}/ (${total} file(s); manifest.ts + ${sourceFiles.size} v2 source file(s))`,
    );
    return;
  }

  const { stripped, files: sourceFiles } = extractManifestSources(wireManifest);
  writeFileSync(join(target, MANIFEST_FILENAME), serializeManifest(stripped));
  const bundleFiles = bundleToFiles(full.bundle);
  writeMaterialised(target, bundleFiles);
  writeMaterialised(target, sourceFiles);
  const totalFiles = bundleFiles.size + sourceFiles.size + 1;
  console.log(
    `Pulled ${integrationId}@${chosen.version} [${chosen.status}] into ${INTEGRATIONS_DIR}/${shortName(
      integrationId,
    )}/ (${totalFiles} file(s); manifest.yaml + ${sourceFiles.size} v2 source file(s))`,
  );
}

function describeStatusFilter(s: PullStatusFilter): string {
  if (s === "draft") return "DRAFT";
  if (s === "published") return "ACTIVE/DEPRECATED";
  return "definition";
}

function writeMaterialised(target: string, files: Map<string, string>): void {
  for (const [path, content] of files) {
    const abs = join(target, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

async function runPullCustomApp(
  client: GraphQLClient,
  handle: string,
  opts: PullOptions,
): Promise<void> {
  if (opts.format === "yaml") {
    throw new Error(
      `Custom apps are TS-only — there's no YAML manifest format. Drop '--format yaml'.`,
    );
  }
  const remote = await getCustomAppByHandle(client, handle);
  if (!remote) {
    throw new Error(`No custom app found for handle '${handle}'.`);
  }

  const target = resolve(process.cwd(), CUSTOM_APPS_DIR, handle);
  if (existsSync(target) && readdirSync(target).length > 0 && !opts.force) {
    throw new Error(`${target} already exists and is not empty. Use --force to overwrite.`);
  }
  mkdirSync(target, { recursive: true });

  const hasServerApi = typeof remote.serverApi === "string" && remote.serverApi !== "";
  writeFileSync(join(target, "template.vue"), remote.template);
  writeFileSync(join(target, "script.js"), remote.script);
  if (hasServerApi) {
    writeFileSync(join(target, "server.lua"), remote.serverApi as string);
  }

  writeFileSync(
    join(target, MANIFEST_TS_FILENAME),
    printAppManifestTs({
      handle: remote.handle,
      name: remote.name,
      kind: remote.kind,
      icon: remote.icon,
      templatePath: "template.vue",
      scriptPath: "script.js",
      serverApiPath: hasServerApi ? "server.lua" : undefined,
      dataContainerSpec: remote.dataContainerSpec ?? undefined,
    }),
  );

  const fileCount = 1 + 1 + 1 + (hasServerApi ? 1 : 0);
  console.log(
    `Pulled custom app ${remote.handle} into ${CUSTOM_APPS_DIR}/${remote.handle}/ ` +
      `(${fileCount} file(s); publishedVersion: ${remote.publishedVersion ?? "(none)"})`,
  );
}

async function runPullEdgeApp(
  client: GraphQLClient,
  handle: string,
  opts: PullOptions,
): Promise<void> {
  if (opts.format === "yaml") {
    throw new Error(
      `Edge apps are TS-only — there's no YAML manifest format. Drop '--format yaml'.`,
    );
  }
  const remote = await findEdgeAppDraft(client, handle);
  if (!remote) {
    throw new Error(`No edge app found for handle '${handle}'.`);
  }

  const target = resolve(process.cwd(), EDGE_APPS_DIR, handle);
  if (existsSync(target) && readdirSync(target).length > 0 && !opts.force) {
    throw new Error(`${target} already exists and is not empty. Use --force to overwrite.`);
  }
  mkdirSync(target, { recursive: true });
  mkdirSync(join(target, "handlers"), { recursive: true });

  for (const h of remote.handlers) {
    writeFileSync(join(target, "handlers", `${h.name}.lua`), h.source);
  }
  if (remote.libraries.length > 0) {
    mkdirSync(join(target, "libraries"), { recursive: true });
    for (const l of remote.libraries) {
      writeFileSync(join(target, "libraries", `${l.name}.lua`), l.source);
    }
  }
  let onMessagePath: string | undefined;
  if (remote.onMessage && remote.onMessage !== "") {
    writeFileSync(join(target, "onMessage.lua"), remote.onMessage);
    onMessagePath = "onMessage.lua";
  }

  writeFileSync(
    join(target, MANIFEST_TS_FILENAME),
    printEdgeAppManifestTs({
      handle: remote.handle,
      name: remote.name,
      description: remote.description ?? undefined,
      logLevel: remote.logLevel ?? undefined,
      isActive: remote.isActive,
      handlers: remote.handlers.map((h) => ({
        name: h.name,
        path: `handlers/${h.name}.lua`,
      })),
      libraries: remote.libraries.length
        ? remote.libraries.map((l) => ({ name: l.name, path: `libraries/${l.name}.lua` }))
        : undefined,
      onMessagePath,
      configSchema: remote.configSchema,
      mqttBrokers: remote.mqttBrokers.length ? remote.mqttBrokers : undefined,
      opcuaEndpoints: remote.opcuaEndpoints.length ? remote.opcuaEndpoints : undefined,
      snmpDevices: remote.snmpDevices.length ? remote.snmpDevices : undefined,
      modbusPorts: remote.modbusPorts.length ? remote.modbusPorts : undefined,
      execCommands: remote.execCommands.length ? remote.execCommands : undefined,
      httpRoutes: remote.httpRoutes.length ? remote.httpRoutes : undefined,
      triggers: remote.triggers.map((t) => {
        if (t.kind === "CRON") {
          return { kind: "CRON", name: t.name, handler: t.handler, schedule: t.schedule ?? "" };
        }
        if (t.kind === "TAIL") {
          return { kind: "TAIL", name: t.name, handler: t.handler, path: t.path ?? "" };
        }
        return {
          kind: t.kind,
          name: t.name,
          handler: t.handler,
          path: t.path ?? "",
          ...(t.pattern ? { pattern: t.pattern } : {}),
        };
      }),
    }),
  );

  const fileCount = 1 + remote.handlers.length + remote.libraries.length + (onMessagePath ? 1 : 0);
  console.log(
    `Pulled edge app ${remote.handle} into ${EDGE_APPS_DIR}/${remote.handle}/ ` +
      `(${fileCount} file(s); ${remote.status} v${remote.version})`,
  );
}

async function runPullWorkflow(
  client: GraphQLClient,
  handle: string,
  opts: PullOptions,
): Promise<void> {
  const row = await getWorkflowByName(client, handle);
  if (!row) throw new Error(`No workflow found with handle '${handle}'.`);

  // Pull the active version (or whatever's pinned). Without an active
  // version, the workflow has been pushed but never published — we
  // refuse to pull because there's no canonical state to dump.
  const versionId = row.currentVersionId;
  if (!versionId) {
    throw new Error(
      `Workflow '${handle}' has no active version yet. Push and publish first, ` +
        `or pull a specific version via the dashboard.`,
    );
  }
  const version = await getWorkflowVersion(client, versionId);
  const triggers = await listWorkflowTriggers(client, row.id);

  const target = resolve(process.cwd(), WORKFLOWS_DIR, handle);
  if (existsSync(target) && readdirSync(target).length > 0 && !opts.force) {
    throw new Error(`${target} already exists and is not empty. Use --force to overwrite.`);
  }
  mkdirSync(target, { recursive: true });

  writeFileSync(
    join(target, MANIFEST_TS_FILENAME),
    printWorkflowManifestTs({
      handle,
      displayName: row.name === handle ? undefined : row.name,
      description: row.description ?? undefined,
      isActive: row.isActive,
      defaultNodeTimeoutSeconds: row.defaultNodeTimeoutSeconds ?? undefined,
      botUserEmail: undefined, // resolved on dump-equivalent only via id→email lookup; deferred
      version,
      triggers,
    }),
  );

  console.log(
    `Pulled workflow ${handle} into ${WORKFLOWS_DIR}/${handle}/ ` +
      `(active v${version.version}, ${triggers.length} trigger(s))`,
  );
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}
