import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MANIFEST_FILENAME,
  buildInitialManifest,
  serializeManifest,
  shortName,
} from "../manifest.ts";

const STARTER_MAIN_LUA = `-- Entry script for this integration.
-- Subscriptions and timers declared in manifest.yaml dispatch into the
-- handlers attached to the global \`exports\` table.

exports = {}

-- function exports.on_event(ctx, event)
--   -- handle a subscribed event
-- end

-- function exports.on_timer(ctx, timer)
--   -- handle a timer firing
-- end
`;

export type InitOptions = {
  version: string;
};

export async function runInit(integrationId: string, opts: InitOptions): Promise<void> {
  if (!integrationId.includes(".")) {
    throw new Error(
      `integrationId should be reverse-domain (e.g. com.acme.foo), got: ${integrationId}`,
    );
  }

  const folderName = shortName(integrationId);
  const target = resolve(process.cwd(), "integrations", folderName);

  if (existsSync(target)) {
    throw new Error(`Folder already exists: ${target}`);
  }

  mkdirSync(join(target, "scripts"), { recursive: true });

  const manifest = buildInitialManifest(integrationId, opts.version);
  writeFileSync(join(target, MANIFEST_FILENAME), serializeManifest(manifest));
  writeFileSync(join(target, "scripts", "main.lua"), STARTER_MAIN_LUA);

  console.log(`Created integrations/${folderName}/`);
  console.log(`  ${MANIFEST_FILENAME}`);
  console.log(`  scripts/main.lua`);
}
