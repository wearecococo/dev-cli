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
import {
  CUSTOM_APPS_DIR,
  EDGE_APPS_DIR,
  INTEGRATIONS_DIR,
} from "../project.ts";
import {
  printAppManifestTs,
  printEdgeAppManifestTs,
  printManifestTs,
} from "../printer.ts";
import { timerHandlerPath } from "../sources.ts";
import { assertDevCliResolvable } from "../dev-cli-resolution.ts";
import type {
  CustomAppKind,
  EngineVersion,
} from "../graphql/operations.ts";

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
  /** "integration" (default) | "app" (custom app) | "edge" (edge app). */
  type?: "integration" | "app" | "edge";
  /** Custom-app only — defaults to PAGE. */
  appKind?: CustomAppKind;
};

export async function runInit(idOrHandle: string, opts: InitOptions): Promise<void> {
  const type = opts.type ?? "integration";
  if (type === "app") return runInitCustomApp(idOrHandle, opts);
  if (type === "edge") return runInitEdgeApp(idOrHandle, opts);
  return runInitIntegration(idOrHandle, opts);
}

async function runInitIntegration(integrationId: string, opts: InitOptions): Promise<void> {
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
  const target = resolve(process.cwd(), INTEGRATIONS_DIR, folderName);

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
    `Created ${INTEGRATIONS_DIR}/${folderName}/ (engineVersion ${engineVersion}, ${format})`,
  );
  for (const path of created) console.log(`  ${path}`);
}

const STARTER_APP_TEMPLATE = `<div class="p-6 space-y-3">
  <h1 class="text-2xl font-bold">{{ name }}</h1>
  <p class="opacity-70">Scaffold from cococo init.</p>
</div>
`;

const STARTER_APP_SCRIPT = `// Custom-app client script (engineVersion 2).
// Top-level returns are ignored; expose state via \`setupReturn = { ... }\`
// when the host iframe boots.

const name = ref("Hello");
const setupReturn = { name };
`;

const STARTER_APP_SERVER_LUA = `-- Optional Lua RPC handlers for the custom app (CUSTOM_APP role).
-- Populate the global \`exports\` table; the host dispatches calls as
-- \`exports.<method>(input)\`.

exports = {}

function exports.ping()
  return { ok = true }
end
`;

async function runInitCustomApp(handle: string, opts: InitOptions): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
    throw new Error(
      `Custom app handle should be a URL-safe slug (lowercase letters, digits, ` +
        `hyphens; must start with a letter or digit). Got: ${handle}`,
    );
  }
  if (opts.format === "yaml") {
    throw new Error(
      `Custom apps are TS-only — there's no YAML manifest format. ` +
        `Drop '--format yaml' and re-run.`,
    );
  }

  assertDevCliResolvable(process.cwd());

  const target = resolve(process.cwd(), CUSTOM_APPS_DIR, handle);
  if (existsSync(target)) {
    throw new Error(`Folder already exists: ${target}`);
  }
  mkdirSync(target, { recursive: true });

  const kind = opts.appKind ?? "PAGE";
  const name = humaniseHandle(handle);

  writeFileSync(join(target, "template.vue"), STARTER_APP_TEMPLATE);
  writeFileSync(join(target, "script.js"), STARTER_APP_SCRIPT);
  writeFileSync(join(target, "server.lua"), STARTER_APP_SERVER_LUA);

  writeFileSync(
    join(target, MANIFEST_TS_FILENAME),
    printAppManifestTs({
      handle,
      name,
      kind,
      templatePath: "template.vue",
      scriptPath: "script.js",
      serverApiPath: "server.lua",
    }),
  );

  console.log(
    `Created ${CUSTOM_APPS_DIR}/${handle}/ (custom app, kind=${kind})`,
  );
  console.log(`  ${MANIFEST_TS_FILENAME}`);
  console.log(`  template.vue`);
  console.log(`  script.js`);
  console.log(`  server.lua`);
}

function humaniseHandle(handle: string): string {
  return handle
    .split(/[-_]/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

const STARTER_EDGE_HEARTBEAT_LUA = `-- Edge-app heartbeat handler.
-- Runs in the EDGE_APP role on a controller; \`bridge.*\` APIs are
-- available, \`ctx.integration.*\` is not.

bridge.log.info("heartbeat from edge app")
`;

async function runInitEdgeApp(handle: string, opts: InitOptions): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(handle)) {
    throw new Error(
      `Edge app handle should be lowercase letters, digits, hyphens, or underscores. ` +
        `Got: ${handle}`,
    );
  }
  if (opts.format === "yaml") {
    throw new Error(
      `Edge apps are TS-only — there's no YAML manifest format. Drop '--format yaml'.`,
    );
  }

  assertDevCliResolvable(process.cwd());

  const target = resolve(process.cwd(), EDGE_APPS_DIR, handle);
  if (existsSync(target)) {
    throw new Error(`Folder already exists: ${target}`);
  }
  mkdirSync(target, { recursive: true });
  mkdirSync(join(target, "handlers"), { recursive: true });

  writeFileSync(join(target, "handlers", "heartbeat.lua"), STARTER_EDGE_HEARTBEAT_LUA);

  writeFileSync(
    join(target, MANIFEST_TS_FILENAME),
    printEdgeAppManifestTs({
      handle,
      name: humaniseHandle(handle),
      description: `Scaffold edge app for ${handle}.`,
      logLevel: "INFO",
      handlers: [{ name: "heartbeat", path: "handlers/heartbeat.lua" }],
      triggers: [
        {
          kind: "CRON",
          name: "tick",
          handler: "heartbeat",
          schedule: "*/5 * * * *",
        },
      ],
    }),
  );

  console.log(`Created ${EDGE_APPS_DIR}/${handle}/ (edge app)`);
  console.log(`  ${MANIFEST_TS_FILENAME}`);
  console.log(`  handlers/heartbeat.lua`);
}
