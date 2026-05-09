import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  getCustomAppByHandle,
  getDefinition,
  listDefinitions,
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
  INTEGRATIONS_DIR,
} from "../project.ts";
import { printAppManifestTs, printManifestTs } from "../printer.ts";
import { extractManifestSources } from "../sources.ts";

export type PullOptions = {
  version?: string;
  force: boolean;
  format?: ManifestFormat;
  /** "integration" (default) targets a remote draft; "app" targets a custom app's working copy. */
  type?: "integration" | "app";
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

  const integrationId = idOrHandle;
  const format: ManifestFormat = opts.format ?? "ts";

  const drafts = await listDefinitions(client, { integrationId, status: "DRAFT" });
  if (drafts.length === 0) {
    throw new Error(`No DRAFT definition found for ${integrationId}.`);
  }

  let chosen = drafts[0]!;
  if (opts.version) {
    const match = drafts.find((d) => d.version === opts.version);
    if (!match) {
      throw new Error(
        `No DRAFT for ${integrationId}@${opts.version}. Available: ${drafts
          .map((d) => d.version)
          .join(", ")}`,
      );
    }
    chosen = match;
  } else if (drafts.length > 1) {
    chosen = drafts.slice().sort((a, b) => compareVersions(b.version, a.version))[0]!;
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
      `Pulled ${integrationId}@${chosen.version} into integrations/${shortName(
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
    `Pulled ${integrationId}@${chosen.version} into ${INTEGRATIONS_DIR}/${shortName(
      integrationId,
    )}/ (${totalFiles} file(s); manifest.yaml + ${sourceFiles.size} v2 source file(s))`,
  );
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
