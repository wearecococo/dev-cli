import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_ENGINE_VERSION,
  MANIFEST_FILENAME,
  buildInitialManifest,
  serializeManifest,
  shortName,
} from "../manifest.ts";
import { MANIFEST_TS_FILENAME, type ManifestFormat } from "../loader.ts";
import { printManifestTs } from "../printer.ts";
import { timerHandlerPath } from "../sources.ts";
import { assertDevCliResolvable } from "../dev-cli-resolution.ts";
import type { EngineVersion } from "../graphql/operations.ts";

const STARTER_MAIN_LUA_V1 = `-- Entry script for this integration (engineVersion 1).
-- Subscriptions and timers declared in the manifest dispatch into the
-- handlers attached to the global \`exports\` table.

exports = {}

-- function exports.on_event(ctx, event)
--   -- handle a subscribed event
-- end

-- function exports.on_timer(ctx, timer)
--   -- handle a timer firing
-- end
`;

const STARTER_TIMER_V2 = `-- Heartbeat timer handler (engineVersion 2).
-- This file is materialised on disk so it can be edited like a normal Lua
-- file. The TS manifest references it via \`luaFile("./handlers/timers/heartbeat.lua")\`.

local name, config = ...

ctx.log.info("heartbeat tick")
`;

export type InitOptions = {
  version: string;
  engineVersion?: EngineVersion;
  format?: ManifestFormat;
};

export async function runInit(integrationId: string, opts: InitOptions): Promise<void> {
  if (!integrationId.includes(".")) {
    throw new Error(
      `integrationId should be reverse-domain (e.g. com.acme.foo), got: ${integrationId}`,
    );
  }

  const engineVersion = opts.engineVersion ?? DEFAULT_ENGINE_VERSION;
  const format: ManifestFormat = opts.format ?? "ts";
  if (engineVersion === 1 && format === "ts") {
    throw new Error(
      `manifest.ts is v2-only — v1 integrations must use manifest.yaml. ` +
        `Re-run with '--format yaml' to scaffold a v1 starter.`,
    );
  }

  // The TS manifest's `import { defineIntegration, ... } from
  // "@wearecococo/dev-cli/define"` line has to resolve when push/pull
  // dynamically import the file. Catch the missing-devDep case at init
  // time so the user gets a friendly install hint instead of a cryptic
  // "Cannot find module" error from Bun on the first push.
  if (format === "ts") {
    assertDevCliResolvable(process.cwd());
  }

  const folderName = shortName(integrationId);
  const target = resolve(process.cwd(), "integrations", folderName);

  if (existsSync(target)) {
    throw new Error(`Folder already exists: ${target}`);
  }

  mkdirSync(target, { recursive: true });

  const manifest = buildInitialManifest(integrationId, opts.version, engineVersion);
  const created: string[] = [];

  if (format === "ts") {
    // TS manifests are v2-only (guarded above). The printer emits
    // `source: luaFile(...)` whenever the wire manifest carries a
    // non-empty source string, so stage the source in the manifest just
    // long enough for the print step.
    const m = manifest as { timers?: Array<{ name: string; source?: string }> };
    if (m.timers && m.timers[0]) {
      m.timers[0].source = STARTER_TIMER_V2;
    }
    writeFileSync(join(target, MANIFEST_TS_FILENAME), printManifestTs(manifest));
    created.push(MANIFEST_TS_FILENAME);

    const timerPath = timerHandlerPath("heartbeat");
    mkdirSync(join(target, "handlers", "timers"), { recursive: true });
    writeFileSync(join(target, timerPath), STARTER_TIMER_V2);
    created.push(timerPath);
  } else {
    writeFileSync(join(target, MANIFEST_FILENAME), serializeManifest(manifest));
    created.push(MANIFEST_FILENAME);

    if (engineVersion === 1) {
      mkdirSync(join(target, "scripts"), { recursive: true });
      writeFileSync(join(target, "scripts", "main.lua"), STARTER_MAIN_LUA_V1);
      created.push("scripts/main.lua");
    } else {
      const timerPath = timerHandlerPath("heartbeat");
      mkdirSync(join(target, "handlers", "timers"), { recursive: true });
      writeFileSync(join(target, timerPath), STARTER_TIMER_V2);
      created.push(timerPath);
    }
  }

  console.log(
    `Created integrations/${folderName}/ (engineVersion ${engineVersion}, ${format})`,
  );
  for (const path of created) console.log(`  ${path}`);
}
