import { listAllArtifactFolders } from "../project.ts";
import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  createCustomAppVersion,
  findEdgeAppDraft,
  getCustomAppByHandle,
  publishCustomApp,
  publishDraft,
  publishEdgeAppDraft,
  upsertCustomApp,
  validateDraft,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import type { LoadedCustomApp, LoadedEdgeApp } from "../loader.ts";
import { findDefinition, loadLocal } from "./_shared.ts";

/**
 * Publish every artifact under `integrations/`, `custom_apps/`,
 * `edge_apps/`. Stops on first failure — same reasoning as `push --all`.
 * Note: integrations are skipped if their version is already PUBLISHED
 * (the per-folder `runPublish` already errors on that, and we propagate).
 */
export async function runPublishAll(overrides: ConfigOverrides): Promise<void> {
  const folders = listAllArtifactFolders();
  if (folders.length === 0) {
    console.log("No artifact folders found under integrations/, custom_apps/, or edge_apps/.");
    return;
  }
  console.log(`Publishing ${folders.length} artifact(s)…`);
  let succeeded = 0;
  for (const folder of folders) {
    try {
      await runPublish(folder, overrides);
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nFailed publishing ${folder}: ${msg}`);
      console.error(`Stopped after ${succeeded} of ${folders.length} succeeded.`);
      throw err;
    }
  }
  console.log(`\nPublished ${succeeded} artifact(s).`);
}

export async function runPublish(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { loaded } = await loadLocal(folderArg);
  const client = createClient(loadConfig(overrides));

  if (loaded.kind === "app") {
    await publishApp(client, loaded);
    return;
  }
  if (loaded.kind === "edge") {
    await publishEdge(client, loaded);
    return;
  }
  await publishIntegration(client, loaded.manifest.id, loaded.manifest.version);
}

async function publishIntegration(
  client: GraphQLClient,
  integrationId: string,
  version: string,
): Promise<void> {
  const def = await findDefinition(client, integrationId, version);
  if (!def) {
    throw new Error(
      `No draft found for ${integrationId}@${version}. Run 'cococo push' first.`,
    );
  }
  if (def.status !== "DRAFT") {
    throw new Error(`${integrationId}@${version} is already ${def.status}.`);
  }

  const validation = await validateDraft(client, def.id);
  if (!validation.valid) {
    console.error(`${integrationId}@${version}: validation failed, refusing to publish.`);
    for (const e of validation.errors) console.error(`  ${e.path}: ${e.message}`);
    process.exit(1);
  }

  const published = await publishDraft(client, def.id);
  console.log(`${published.integrationId}@${published.version}: ${published.status}`);
}

/**
 * Publish a custom app: snapshot the current working copy as an
 * immutable `CustomAppVersion`, then flip `publishedVersion` to that
 * snapshot. Push isn't a prerequisite — we re-upsert the working copy
 * here too so a "publish from a clean local checkout" works without
 * the user having to remember a separate push step.
 */
async function publishApp(client: GraphQLClient, loaded: LoadedCustomApp): Promise<void> {
  const { app } = loaded;
  const existing = await getCustomAppByHandle(client, app.handle);

  // Mirror the local working copy to the server so the snapshot we're
  // about to take reflects what's on disk. (Most users will have just
  // run push, but doing it again here makes publish self-contained.)
  const upserted = await upsertCustomApp(client, {
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

  const snapshot = await createCustomAppVersion(client, {
    customAppId: upserted.id,
    config: {
      template: app.template,
      script: app.script,
      ...(app.server_api !== undefined ? { serverApi: app.server_api } : {}),
    },
  });

  const published = await publishCustomApp(client, {
    id: upserted.id,
    version: snapshot.version,
  });
  console.log(
    `${published.handle}: published v${published.publishedVersion ?? snapshot.version} (${published.id})`,
  );
}

/**
 * Publish an edge-app draft. The platform expects a DRAFT row to exist —
 * `publishEdgeAppDraft` flips it to PUBLISHED and auto-deprecates the
 * prior PUBLISHED. We don't re-upsert here (unlike custom apps): edge
 * apps have a real DRAFT/PUBLISHED lifecycle, so the user is expected
 * to have run `push` first.
 */
async function publishEdge(client: GraphQLClient, loaded: LoadedEdgeApp): Promise<void> {
  const draft = await findEdgeAppDraft(client, loaded.app.handle);
  if (!draft || draft.status !== "DRAFT") {
    throw new Error(
      `No DRAFT found for edge app '${loaded.app.handle}'. Run 'cococo push' first ` +
        `to create or update the draft, then publish.`,
    );
  }
  const published = await publishEdgeAppDraft(client, draft.id);
  console.log(
    `${published.handle}: published v${published.version} (${published.id}). ` +
      `Prior PUBLISHED auto-deprecated.`,
  );
}
