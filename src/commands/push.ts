import { readFileSync } from "node:fs";
import { createClient } from "../graphql/client.ts";
import {
  createDraft,
  getDefinition,
  updateDraftFile,
  updateDraftManifest,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { walkIntegrationFiles } from "../project.ts";
import { manifestToWire } from "../manifest.ts";
import { bundleToFiles } from "../bundle.ts";
import { diffFiles, summarize } from "../diff.ts";
import { findDefinition, loadLocal } from "./_shared.ts";
import { findLuaFiles, lintLuaFiles, reportLintFindings } from "./lint.ts";

export async function runPush(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { folder, manifest } = loadLocal(folderArg);
  const client = createClient(loadConfig(overrides));

  const local = walkIntegrationFiles(folder);

  // Lint Lua files before doing any server-side work — cheap to do locally
  // (server validates each script in parallel) and avoids partial uploads.
  const luaFiles = findLuaFiles(local);
  if (luaFiles.size > 0) {
    const findings = await lintLuaFiles(client, luaFiles);
    if (findings.length > 0) {
      reportLintFindings(findings);
      throw new Error(
        `${findings.length} Lua file(s) failed validation. Fix them and re-run push.`,
      );
    }
  }

  let def = await findDefinition(client, manifest.id, manifest.version);
  if (def && def.status !== "DRAFT") {
    throw new Error(
      `${manifest.id}@${manifest.version} is ${def.status} (immutable). ` +
        `Bump 'version' in manifest.yaml to push a new draft.`,
    );
  }

  if (!def) {
    console.log(`Creating new draft for ${manifest.id}@${manifest.version}…`);
    def = await createDraft(client, {
      integrationId: manifest.id,
      version: manifest.version,
      runtimeMode: (manifest.runtime_mode as "bundle" | "script_actor" | undefined) ?? "script_actor",
    });
  }
  const draftId = def.id;

  // Snapshot remote before we mutate, so the diff/summary reflects the real
  // state we're transitioning from.
  const before = await getDefinition(client, draftId);
  if (!before.bundle) throw new Error(`Draft ${draftId} returned without a bundle.`);
  const remote = bundleToFiles(before.bundle);
  const d = diffFiles(local, remote);

  // Manifest: send the full parsed object so removals propagate even though
  // the server uses merge semantics for top-level keys.
  await updateDraftManifest(client, { id: draftId, manifest: manifestToWire(manifest) });

  // Upload added + changed.
  for (const path of [...d.added, ...d.changed]) {
    const abs = local.get(path);
    if (!abs) continue;
    const content = readFileSync(abs, "utf8");
    await updateDraftFile(client, { id: draftId, path, content });
  }

  // Delete remote orphans.
  for (const path of d.deleted) {
    await updateDraftFile(client, { id: draftId, path, content: null });
  }

  console.log(`${manifest.id}@${manifest.version} (draft ${draftId})`);
  console.log(`  ${summarize(d)}`);
}
