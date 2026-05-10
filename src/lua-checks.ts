import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFECYCLE_PATHS, isManifestSourcePath } from "./sources.ts";
import { MANIFEST_TS_FILENAME, type LoadedManifest } from "./loader.ts";
import type { ValidateLuaRole } from "./graphql/operations.ts";

/**
 * One Lua chunk we want the server to validate.
 *
 * Every chunk that lives in an integration folder — bundle scripts (`scripts/*.lua`,
 * `app/server.lua`), v2 manifest source files (`handlers/timers/<n>.lua`, etc.),
 * and inline `lua\`...\`` snippets in a TS manifest — produces one of these.
 * `scriptName` is the human-readable label that ends up in diagnostic headers;
 * `origin` is what we use to address the diagnostic back to a navigable
 * location.
 */
export type LuaCheck = {
  source: string;
  role: ValidateLuaRole;
  scriptName: string;
  origin: LuaCheckOrigin;
};

export type LuaCheckOrigin =
  | { kind: "file"; relativePath: string; absPath: string }
  | { kind: "manifest"; field: string; manifestPath: string };

/**
 * Build the full list of `LuaCheck`s for a folder. Dispatches on the
 * loaded manifest's kind — integrations, custom apps, and edge apps
 * each have their own source layouts and roles, but share the same
 * `LuaCheck` shape so the lint pipeline downstream is uniform.
 */
export function collectLuaChecks(args: {
  loaded: LoadedManifest;
  folderPath: string;
  walkedFiles: ReadonlyMap<string, string>;
}): LuaCheck[] {
  if (args.loaded.kind === "app") return collectAppLuaChecks(args);
  if (args.loaded.kind === "edge") return collectEdgeLuaChecks(args);
  // Workflows: skip Lua checks in Phase 1 — node configs are
  // server-validated as a whole via validateWorkflow, and we don't
  // yet know which node types contain Lua. The lint command
  // dispatches to a workflow-specific path that calls
  // validateWorkflow directly.
  if (args.loaded.kind === "workflow") return [];
  return collectIntegrationLuaChecks(args);
}

/**
 * Integration checks:
 *
 *  1. Every `.lua` file under the folder yields a check. Role is
 *     `CUSTOM_APP` for anything under `app/`, `INTEGRATION` everywhere
 *     else.
 *  2. For TS manifests, every `lua\`...\`` snippet on the manifest
 *     yields an additional check. (luaFile() refs are already covered
 *     by step 1 — they point at real files we walk.)
 *  3. YAML manifests don't carry inline source at lint time (push's
 *     `injectManifestSources` populates them later from the same
 *     meta-dir files we already walked), so step 2 is a no-op.
 */
function collectIntegrationLuaChecks(args: {
  loaded: LoadedManifest;
  folderPath: string;
  walkedFiles: ReadonlyMap<string, string>;
}): LuaCheck[] {
  const { loaded, folderPath, walkedFiles } = args;
  if (loaded.kind !== "integration") return [];
  const checks: LuaCheck[] = [];

  for (const [relPath, absPath] of walkedFiles) {
    if (!relPath.endsWith(".lua")) continue;
    const source = readFileSync(absPath, "utf8");
    checks.push({
      source,
      role: roleForPath(relPath),
      scriptName: scriptNameForFilePath(relPath),
      origin: { kind: "file", relativePath: relPath, absPath },
    });
  }

  if (loaded.format === "ts") {
    const manifestPath = join(folderPath, MANIFEST_TS_FILENAME);
    const m = loaded.manifest as Record<string, unknown>;
    for (const [path, origin] of loaded.manifestSourceOrigins) {
      if (origin.kind !== "tag") continue;
      const source = readSourceAtPath(m, path);
      if (!source) continue;
      checks.push({
        source,
        role: "INTEGRATION", // manifest sources are always integration-scoped
        scriptName: `manifest.ts:${path}`,
        origin: { kind: "manifest", field: path, manifestPath },
      });
    }
  }

  return checks;
}

/**
 * Custom-app checks: every walked `.lua` file runs under `CUSTOM_APP`,
 * plus a manifest-origin check if `serverApi` was inlined as a
 * `lua\`...\`` template literal (file-backed `serverApi` is already
 * covered by walking `server.lua`).
 */
function collectAppLuaChecks(args: {
  loaded: LoadedManifest;
  folderPath: string;
  walkedFiles: ReadonlyMap<string, string>;
}): LuaCheck[] {
  const { loaded, folderPath, walkedFiles } = args;
  if (loaded.kind !== "app") return [];
  const checks: LuaCheck[] = [];

  for (const [relPath, absPath] of walkedFiles) {
    if (!relPath.endsWith(".lua")) continue;
    const source = readFileSync(absPath, "utf8");
    checks.push({
      source,
      role: "CUSTOM_APP",
      scriptName: relPath,
      origin: { kind: "file", relativePath: relPath, absPath },
    });
  }

  if (loaded.serverApiOrigin?.kind === "tag" && loaded.app.server_api) {
    checks.push({
      source: loaded.app.server_api,
      role: "CUSTOM_APP",
      scriptName: "manifest.ts:serverApi",
      origin: {
        kind: "manifest",
        field: "serverApi",
        manifestPath: join(folderPath, MANIFEST_TS_FILENAME),
      },
    });
  }

  return checks;
}

/**
 * Edge-app checks. Every walked `.lua` file runs under `EDGE_APP`
 * (handlers and libraries live in conventional sub-dirs but the role
 * is uniform). Plus a manifest-origin check for any chunk inlined as
 * a `lua\`...\`` template literal — the loader's
 * `manifestSourceOrigins` map tells us which chunks those are.
 */
function collectEdgeLuaChecks(args: {
  loaded: LoadedManifest;
  folderPath: string;
  walkedFiles: ReadonlyMap<string, string>;
}): LuaCheck[] {
  const { loaded, folderPath, walkedFiles } = args;
  if (loaded.kind !== "edge") return [];
  const checks: LuaCheck[] = [];

  for (const [relPath, absPath] of walkedFiles) {
    if (!relPath.endsWith(".lua")) continue;
    const source = readFileSync(absPath, "utf8");
    checks.push({
      source,
      role: "EDGE_APP",
      scriptName: relPath,
      origin: { kind: "file", relativePath: relPath, absPath },
    });
  }

  // Inline tag-based chunks — the loader's wire shape carries the
  // resolved source content; we look up the path → origin map and
  // emit a manifest-origin check for any `kind: "tag"` entry.
  const manifestPath = join(folderPath, MANIFEST_TS_FILENAME);
  for (const [path, origin] of loaded.manifestSourceOrigins) {
    if (origin.kind !== "tag") continue;
    const source = readEdgeSourceAtPath(loaded.app, path);
    if (!source) continue;
    checks.push({
      source,
      role: "EDGE_APP",
      scriptName: `manifest.ts:${path}`,
      origin: { kind: "manifest", field: path, manifestPath },
    });
  }

  return checks;
}

function readEdgeSourceAtPath(
  app: { handlers: Array<{ name: string; source: string }>; libraries?: Array<{ name: string; source: string }>; on_message?: string },
  path: string,
): string | undefined {
  if (path === "onMessage") return stringOrUndef(app.on_message);
  const h = /^handlers\.(.+)$/.exec(path);
  if (h) {
    const found = app.handlers.find((x) => x.name === h[1]);
    return found ? found.source : undefined;
  }
  const l = /^libraries\.(.+)$/.exec(path);
  if (l && app.libraries) {
    const found = app.libraries.find((x) => x.name === l[1]);
    return found ? found.source : undefined;
  }
  return undefined;
}

/**
 * `app/**` is the embedded custom app — its server-side Lua runs in the
 * CUSTOM_APP role where `ctx.integration.*` is unavailable. Everything
 * else (timer / subscription / lifecycle / library handlers, top-level
 * `scripts/*.lua` helpers) runs in INTEGRATION.
 */
export function roleForPath(relPath: string): ValidateLuaRole {
  return relPath.startsWith("app/") ? "CUSTOM_APP" : "INTEGRATION";
}

/**
 * Map a file path to the human-readable script name shown in diagnostic
 * headers. Meta-dir paths get collapsed to dotted accessors so they match
 * the manifest field they bind to (e.g.
 * `handlers/timers/tick.lua` → `timers.tick`); other paths stay verbatim.
 */
export function scriptNameForFilePath(relPath: string): string {
  if (!isManifestSourcePath(relPath)) return relPath;

  for (const [field, lifecyclePath] of Object.entries(LIFECYCLE_PATHS)) {
    if (relPath === lifecyclePath) {
      return field.replace(/_source$/, "Source");
    }
  }
  if (relPath.startsWith("handlers/timers/") && relPath.endsWith(".lua")) {
    return `timers.${relPath.slice("handlers/timers/".length, -".lua".length)}.source`;
  }
  if (relPath.startsWith("handlers/subscriptions/") && relPath.endsWith(".lua")) {
    return `subscriptions.${relPath.slice("handlers/subscriptions/".length, -".lua".length)}.source`;
  }
  if (relPath.startsWith("libraries/") && relPath.endsWith(".lua")) {
    return `libraries.${relPath.slice("libraries/".length, -".lua".length)}`;
  }
  return relPath;
}

/**
 * Walk the wire manifest to read out the source string at a given
 * `ManifestSourcePath`. Mirrors the path-naming convention used by the
 * loader: `initSource`, `timers.<name-or-index>.source`,
 * `subscriptions.<topic-or-index>.source`, `libraries.<name>`.
 */
function readSourceAtPath(
  m: Record<string, unknown>,
  path: string,
): string | undefined {
  if (path === "initSource") return stringOrUndef(m.init_source);
  if (path === "shutdownSource") return stringOrUndef(m.shutdown_source);
  if (path === "upgradeSource") return stringOrUndef(m.upgrade_source);

  const timerMatch = /^timers\.(.+)\.source$/.exec(path);
  if (timerMatch && Array.isArray(m.timers)) {
    return findEntrySource(m.timers, "name", timerMatch[1]!);
  }
  const subMatch = /^subscriptions\.(.+)\.source$/.exec(path);
  if (subMatch && Array.isArray(m.subscriptions)) {
    return findEntrySource(m.subscriptions, "topic", subMatch[1]!);
  }
  const libMatch = /^libraries\.(.+)$/.exec(path);
  if (libMatch && m.libraries && typeof m.libraries === "object") {
    return stringOrUndef((m.libraries as Record<string, unknown>)[libMatch[1]!]);
  }
  return undefined;
}

function findEntrySource(
  entries: unknown[],
  keyName: string,
  keyValue: string,
): string | undefined {
  // Try matching by name/topic, then by `[<index>]` fallback for nameless entries.
  for (const e of entries) {
    if (e && typeof e === "object") {
      const obj = e as Record<string, unknown>;
      if (obj[keyName] === keyValue && typeof obj.source === "string") {
        return obj.source;
      }
    }
  }
  const idxMatch = /^\[(\d+)\]$/.exec(keyValue);
  if (idxMatch) {
    const i = parseInt(idxMatch[1]!, 10);
    const e = entries[i];
    if (e && typeof e === "object" && typeof (e as Record<string, unknown>).source === "string") {
      return (e as Record<string, unknown>).source as string;
    }
  }
  return undefined;
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
