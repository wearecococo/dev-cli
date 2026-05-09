import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  MANIFEST_FILENAME,
  parseManifest,
  type WireManifest,
  type WireManifestV2,
} from "./manifest.ts";
import {
  isFileMarker,
  isLuaFileMarker,
  luaFile,
  manifestKind,
  type CustomAppKind,
  type CustomAppV2,
  type IntegrationDefinition,
  type IntegrationV2,
  type ManifestKind,
} from "./define.ts";

export const MANIFEST_TS_FILENAME = "manifest.ts";

export type ManifestFormat = "ts" | "yaml";

/**
 * For a given Lua source on the manifest, where did its content come from?
 *
 * - `file`: the source was a `luaFile()` reference. The content was read
 *   from disk; `absPath` points at the file. Used by push to exclude the
 *   file from bundle uploads (it's already in the manifest payload), and
 *   by lint to address diagnostics back to the file.
 * - `tag`: the source was a `lua\`...\`` template literal in the
 *   `manifest.ts` itself. There's no file to read — diagnostics get
 *   addressed back to the manifest field.
 */
export type LuaSourceOrigin =
  | { kind: "file"; absPath: string }
  | { kind: "tag" };

/**
 * Stable manifest-path strings used as keys in `manifestSourceOrigins`:
 *
 *   - `initSource` / `shutdownSource` / `upgradeSource`
 *   - `timers.<name>.source` / `timers.[<index>].source` (when a timer
 *     has no `name`)
 *   - `subscriptions.<topic>.source` / `subscriptions.[<index>].source`
 *   - `libraries.<name>`
 */
export type ManifestSourcePath = string;

/**
 * Discriminated union covering both top-level entity kinds the CLI
 * authors locally: integrations (under `integrations/`) and custom apps
 * (under `custom_apps/`). The discriminator matches the
 * `manifestKind()` tag stamped onto the result of `defineIntegration` /
 * `defineCustomApp`.
 */
export type LoadedManifest = LoadedIntegration | LoadedCustomApp;

export type LoadedIntegration = {
  kind: "integration";
  manifest: WireManifest;
  format: ManifestFormat;
  /**
   * Absolute paths consumed by `luaFile()` references in a TS manifest.
   * Push uses this to exclude these files from the bundle-upload set —
   * their content is already baked into the manifest payload.
   *
   * Empty for YAML loads (where source files are bound by convention
   * via `injectManifestSources`).
   */
  consumed: Set<string>;
  /**
   * Provenance of every Lua source on the resolved manifest, keyed by a
   * stable `ManifestSourcePath`. Empty for YAML loads (whose source
   * fields are populated by `injectManifestSources` at push time, not at
   * load time, so there's nothing to track here).
   */
  manifestSourceOrigins: Map<ManifestSourcePath, LuaSourceOrigin>;
};

/**
 * Resolved custom-app manifest. `template` and `script` are inlined
 * strings (HTML / JS); `serverApi` is an inlined Lua string when
 * present. `serverApiOrigin` carries the same provenance that
 * integrations track for each source field, so the lint pipeline can
 * address diagnostics back to the right location.
 */
export type LoadedCustomApp = {
  kind: "app";
  app: CustomAppWire;
  format: "ts";
  consumed: Set<string>;
  serverApiOrigin?: LuaSourceOrigin;
};

/** Snake-cased shape that maps directly onto `UpsertCustomAppInput`. */
export type CustomAppWire = {
  handle: string;
  name: string;
  kind: CustomAppKind;
  icon?: string;
  engine_version: 2;
  template: string;
  script: string;
  server_api?: string;
  /** JSON-encoded — GraphQL takes `dataContainerSpec` as a String. */
  data_container_spec?: string;
};

export async function loadManifest(folderPath: string): Promise<LoadedManifest> {
  const tsPath = resolve(folderPath, MANIFEST_TS_FILENAME);
  const yamlPath = resolve(folderPath, MANIFEST_FILENAME);

  const hasTs = existsSync(tsPath);
  const hasYaml = existsSync(yamlPath);
  if (hasTs && hasYaml) {
    throw new Error(
      `${folderPath} has both ${MANIFEST_TS_FILENAME} and ${MANIFEST_FILENAME}; ` +
        `keep one. The TS manifest is the canonical format — delete ${MANIFEST_FILENAME} ` +
        `if you've migrated.`,
    );
  }
  if (hasTs) return loadTsManifest(tsPath);
  if (hasYaml) {
    return {
      kind: "integration",
      manifest: parseManifest(readFileSync(yamlPath, "utf8")),
      format: "yaml",
      consumed: new Set(),
      manifestSourceOrigins: new Map(),
    };
  }
  throw new Error(
    `Could not find ${MANIFEST_TS_FILENAME} or ${MANIFEST_FILENAME} in ${folderPath}.`,
  );
}

/**
 * Narrow `LoadedManifest` to an integration, throwing when given an app.
 * Use from commands that only operate on integrations
 * (validate/publish/migrate/etc.) so the type system stops complaining.
 */
export function expectIntegration(loaded: LoadedManifest): LoadedIntegration {
  if (loaded.kind !== "integration") {
    throw new Error(
      `Expected an integration manifest at this path, got a custom app. ` +
        `Custom apps live under custom_apps/<handle>/ — use 'cococo push custom_apps/<handle>' ` +
        `(or the equivalent app subcommand).`,
    );
  }
  return loaded;
}

/**
 * Narrow `LoadedManifest` to a custom app, throwing when given an
 * integration. Used by app-specific commands.
 */
export function expectApp(loaded: LoadedManifest): LoadedCustomApp {
  if (loaded.kind !== "app") {
    throw new Error(
      `Expected a custom-app manifest at this path, got an integration.`,
    );
  }
  return loaded;
}

async function loadTsManifest(absPath: string): Promise<LoadedManifest> {
  const mod = await importTs(absPath);
  const spec = (mod as { default?: unknown }).default;
  if (!spec || typeof spec !== "object") {
    throw new Error(
      `${absPath}: must default-export the result of defineIntegration({...}) or defineCustomApp({...}).`,
    );
  }
  const kind = manifestKind(spec) as ManifestKind | undefined;
  if (kind === "app") return loadTsCustomApp(spec as CustomAppV2, absPath);
  // Treat untagged exports as integrations for backwards compatibility
  // with hand-authored manifests, and matching the historical behaviour
  // before the kind tag existed.
  return loadTsIntegration(spec as IntegrationDefinition, absPath);
}

function loadTsIntegration(
  spec: IntegrationDefinition,
  absPath: string,
): LoadedManifest {
  const manifestDir = dirname(absPath);
  const consumed = new Set<string>();
  const manifestSourceOrigins = new Map<ManifestSourcePath, LuaSourceOrigin>();
  const resolvedSpec = resolveManifestSources(
    spec,
    manifestDir,
    consumed,
    manifestSourceOrigins,
  );
  const manifest = toWireManifest(resolvedSpec);
  return {
    kind: "integration",
    manifest,
    format: "ts",
    consumed,
    manifestSourceOrigins,
  };
}

function loadTsCustomApp(spec: CustomAppV2, absPath: string): LoadedManifest {
  if ((spec as { engineVersion?: number }).engineVersion === 1) {
    throw new Error(
      `manifest.ts is v2-only — got engineVersion: 1 on a custom app. ` +
        `v1 custom apps aren't authored through this CLI.`,
    );
  }
  const manifestDir = dirname(absPath);
  const consumed = new Set<string>();
  let serverApiOrigin: LuaSourceOrigin | undefined;

  const template = resolveContentSlot(spec.template, manifestDir, consumed, "template");
  const script = resolveContentSlot(spec.script, manifestDir, consumed, "script");
  let server_api: string | undefined;
  if (spec.serverApi !== undefined && spec.serverApi !== null) {
    if (isLuaFileMarker(spec.serverApi)) {
      const abs = absoluteFor(spec.serverApi.path, manifestDir);
      server_api = readSourceFile(abs, `luaFile("${spec.serverApi.path}")`);
      consumed.add(abs);
      serverApiOrigin = { kind: "file", absPath: abs };
    } else if (typeof spec.serverApi === "string" && spec.serverApi !== "") {
      server_api = spec.serverApi;
      serverApiOrigin = { kind: "tag" };
    }
  }

  const app: CustomAppWire = {
    handle: spec.handle,
    name: spec.name,
    kind: spec.kind,
    engine_version: 2,
    template,
    script,
  };
  if (typeof spec.icon === "string" && spec.icon !== "") app.icon = spec.icon;
  if (server_api !== undefined) app.server_api = server_api;
  if (spec.dataContainerSpec !== undefined && spec.dataContainerSpec !== null) {
    app.data_container_spec = JSON.stringify(spec.dataContainerSpec);
  }

  return { kind: "app", app, format: "ts", consumed, serverApiOrigin };
}

/**
 * Resolve a `template` / `script` slot. Accepts an inline string or a
 * `file(...)` marker; refuses anything else (including `luaFile()`,
 * since those slots aren't Lua).
 */
function resolveContentSlot(
  value: unknown,
  manifestDir: string,
  consumed: Set<string>,
  slotName: string,
): string {
  if (isFileMarker(value)) {
    const abs = absoluteFor(value.path, manifestDir);
    const content = readSourceFile(abs, `file("${value.path}")`);
    consumed.add(abs);
    return content;
  }
  if (typeof value === "string") return value;
  if (isLuaFileMarker(value)) {
    throw new Error(
      `Custom app '${slotName}' must be a string or file(...) — got luaFile(). ` +
        `serverApi is the only Lua slot on a custom app.`,
    );
  }
  throw new Error(`Custom app '${slotName}' is required and must be a string or file(...).`);
}

function absoluteFor(p: string, manifestDir: string): string {
  return isAbsolute(p) ? p : resolve(manifestDir, p);
}

function readSourceFile(abs: string, refLabel: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${refLabel} could not be read: ${reason}`);
  }
}

async function importTs(absPath: string): Promise<unknown> {
  // Bun resolves absolute paths for both .ts and .js files via dynamic
  // import. A cache-busting query string forces a re-evaluation when the
  // CLI is invoked multiple times in the same process (rare, but tests
  // do it).
  const url = `${absPath}?t=${Date.now()}`;
  return await import(url);
}

/**
 * Walk the v2 spec at every position that's allowed to hold a Lua source
 * (`initSource` / `shutdownSource` / `upgradeSource`, `timers[*].source`,
 * `subscriptions[*].source`, `libraries[*]`). For each:
 *
 *  - If the value is a `LuaFileMarker`: read the referenced file, replace
 *    the marker with its content, record the file as consumed, and tag
 *    the manifest path with `kind: "file"` provenance.
 *  - If the value is a non-empty string: record `kind: "tag"` provenance.
 *    No file to read — the content is already inline (a `lua\`...\`` tag
 *    or a literal string written by the author).
 *  - Empty / null / undefined: skip — the field is absent on this
 *    manifest.
 *
 * Schema-aware rather than a generic deep walk so that the
 * `ManifestSourcePath` keys we record match exactly what the lint /
 * diagnostic surface uses, and so that anomalous `luaFile()` placements
 * elsewhere on the manifest are silently ignored (the type system
 * already forbids them).
 */
function resolveManifestSources(
  spec: IntegrationDefinition,
  manifestDir: string,
  consumed: Set<string>,
  origins: Map<ManifestSourcePath, LuaSourceOrigin>,
): IntegrationDefinition {
  const cloned = clone(spec) as IntegrationV2;

  resolveSourceField(cloned, "initSource", "initSource", manifestDir, consumed, origins);
  resolveSourceField(cloned, "shutdownSource", "shutdownSource", manifestDir, consumed, origins);
  resolveSourceField(cloned, "upgradeSource", "upgradeSource", manifestDir, consumed, origins);

  if (Array.isArray(cloned.timers)) {
    cloned.timers.forEach((t, i) => {
      const obj = t as Record<string, unknown>;
      const key = typeof obj.name === "string" && obj.name ? obj.name : `[${i}]`;
      resolveSourceField(obj, "source", `timers.${key}.source`, manifestDir, consumed, origins);
    });
  }
  if (Array.isArray(cloned.subscriptions)) {
    cloned.subscriptions.forEach((s, i) => {
      const obj = s as Record<string, unknown>;
      const key = typeof obj.topic === "string" && obj.topic ? obj.topic : `[${i}]`;
      resolveSourceField(obj, "source", `subscriptions.${key}.source`, manifestDir, consumed, origins);
    });
  }
  if (cloned.libraries && typeof cloned.libraries === "object" && !Array.isArray(cloned.libraries)) {
    const libs = cloned.libraries as Record<string, unknown>;
    for (const name of Object.keys(libs)) {
      resolveSourceField(libs, name, `libraries.${name}`, manifestDir, consumed, origins);
    }
  }

  return cloned;
}

function resolveSourceField(
  obj: Record<string, unknown>,
  key: string,
  manifestPath: ManifestSourcePath,
  manifestDir: string,
  consumed: Set<string>,
  origins: Map<ManifestSourcePath, LuaSourceOrigin>,
): void {
  const v = obj[key];
  if (v == null) return;
  if (isLuaFileMarker(v)) {
    const abs = isAbsolute(v.path) ? v.path : resolve(manifestDir, v.path);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`luaFile("${v.path}") could not be read: ${reason}`);
    }
    obj[key] = content;
    consumed.add(abs);
    origins.set(manifestPath, { kind: "file", absPath: abs });
    return;
  }
  if (typeof v === "string" && v !== "") {
    origins.set(manifestPath, { kind: "tag" });
  }
}

/**
 * Convert the camelCase author surface into the snake_case `WireManifest`
 * the rest of the pipeline operates on. `manifest.ts` is v2-only — the
 * loader rejects any spec carrying `engineVersion: 1` since that's a
 * runtime mismatch with the TS API contract. Legacy v1 integrations live
 * in `manifest.yaml`.
 */
function toWireManifest(spec: IntegrationDefinition): WireManifest {
  if ((spec as { engineVersion?: number }).engineVersion === 1) {
    throw new Error(
      `manifest.ts is v2-only — got engineVersion: 1. ` +
        `Move v1 integrations to manifest.yaml (with engine_version: 1).`,
    );
  }
  return toWireV2(spec as IntegrationV2);
}

function toWireV2(spec: IntegrationV2): WireManifestV2 {
  const out: Record<string, unknown> = {
    id: spec.id,
    version: spec.version,
    engine_version: 2,
    sdk_version: spec.sdkVersion,
    runtime_mode: spec.runtimeMode ?? "script_actor",
    resources: spec.resources ?? [],
    permissions: spec.permissions ?? [],
    subscriptions: spec.subscriptions ?? [],
    timers: spec.timers ?? [],
  };
  copyOptional(out, "description", spec.description);
  copyOptional(out, "timeout_ms", spec.timeoutMs);
  copyOptional(out, "data_container_schemas", spec.dataContainerSchemas);
  copyOptional(out, "actions", spec.actions);
  copyOptional(out, "init_source", spec.initSource);
  copyOptional(out, "shutdown_source", spec.shutdownSource);
  copyOptional(out, "upgrade_source", spec.upgradeSource);
  copyOptional(out, "libraries", spec.libraries);
  return dropUndefined(out) as WireManifestV2;
}

function copyOptional(out: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) out[key] = value;
}

function dropUndefined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) delete o[k];
  }
  return o;
}

/**
 * Deep-clone aware of `LuaFileMarker` sentinels so the walker can mutate
 * the cloned tree without disturbing the user's `defineIntegration` value.
 * `JSON.parse(JSON.stringify(...))` would silently drop the marker (its
 * key is a Symbol), which is exactly the bug we don't want.
 */
function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => clone(v)) as unknown as T;
  }
  if (isLuaFileMarker(value)) {
    return luaFile(value.path) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = clone(v);
    }
    return out as T;
  }
  return value;
}
