import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createClient } from "../graphql/client.ts";
import { getDefinition, listDefinitions } from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { bundleToFiles } from "../bundle.ts";
import {
  MANIFEST_FILENAME,
  manifestFromGraphql,
  serializeManifest,
  shortName,
} from "../manifest.ts";

export type PullOptions = {
  version?: string;
  force: boolean;
};

export async function runPull(
  integrationId: string,
  opts: PullOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const client = createClient(loadConfig(overrides));

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

  const target = resolve(process.cwd(), "integrations", shortName(integrationId));
  if (existsSync(target) && readdirSync(target).length > 0 && !opts.force) {
    throw new Error(`${target} already exists and is not empty. Use --force to overwrite.`);
  }
  mkdirSync(target, { recursive: true });

  writeFileSync(
    join(target, MANIFEST_FILENAME),
    serializeManifest(manifestFromGraphql(full.bundle.manifest)),
  );

  const files = bundleToFiles(full.bundle);
  for (const [path, content] of files) {
    const abs = join(target, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  console.log(
    `Pulled ${integrationId}@${chosen.version} into integrations/${shortName(integrationId)}/ (${files.size} file(s))`,
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
