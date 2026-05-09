/**
 * Author-facing API for `manifest.ts`.
 *
 * A `manifest.ts` file in an integration folder exports a default
 * `defineIntegration({...})` value. The `lua` tag and `luaFile()` helper
 * are the two ways to attach Lua bodies to manifest fields:
 *
 *   - `lua` is a tagged template literal. The result is a branded
 *     `LuaSource` string with leading whitespace stripped, suitable for
 *     short inline hooks.
 *   - `luaFile("./relative/path.lua")` returns a sentinel that the loader
 *     resolves to file content at the time the manifest is normalised.
 *     Use this for anything longer than a one-liner so the body lives in
 *     a `.lua` file with proper tooling.
 *
 * The shape of the value is hand-typed (no codegen) and kept aligned with
 * the platform's `IntegrationManifest` GraphQL type by code review +
 * integration tests, not by tooling.
 *
 * **`manifest.ts` is v2 only.** The TS author surface was added at the
 * same time as engineVersion 2; a v2-only TS API is the simplest model.
 * Legacy v1 integrations stay on `manifest.yaml` (with
 * `engine_version: 1`).
 */

declare const luaSourceBrand: unique symbol;
/**
 * A `string` known to contain Lua source. Produced by `lua` and `luaFile`;
 * not constructible from a plain string. The brand is purely a TypeScript
 * device — at runtime it's still `typeof === "string"` (for `lua` results)
 * or the `LuaFileMarker` object (for `luaFile`, replaced by the loader
 * before the value reaches the wire).
 */
export type LuaSource = string & { [luaSourceBrand]: true };

const LUA_FILE_MARKER = Symbol.for("@wearecococo/dev-cli/luaFile");
const FILE_MARKER = Symbol.for("@wearecococo/dev-cli/file");

export type LuaFileMarker = {
  readonly [LUA_FILE_MARKER]: true;
  readonly path: string;
};

/**
 * Generic file reference for non-Lua content (Vue templates, JS scripts,
 * any text file the loader should inline). Distinct from `LuaFileMarker`
 * so the type system can keep `serverApi: luaFile(...)` separate from
 * `template: file(...)` — the lint pipeline only validates LuaSource
 * fields, and `template` is HTML.
 */
export type FileMarker = {
  readonly [FILE_MARKER]: true;
  readonly path: string;
};

export function isLuaFileMarker(x: unknown): x is LuaFileMarker {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as LuaFileMarker)[LUA_FILE_MARKER] === true
  );
}

export function isFileMarker(x: unknown): x is FileMarker {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as FileMarker)[FILE_MARKER] === true
  );
}

/**
 * Tagged template that returns a `LuaSource`. Strips a common leading
 * indent so callers can write
 *
 *   lua`
 *     local config = ...
 *     ctx.log.info("hi")
 *   `
 *
 * and have the actual Lua string be unindented. A leading newline (from
 * the template's first character being `\n`) is dropped.
 */
export function lua(strings: TemplateStringsArray, ...values: unknown[]): LuaSource {
  let raw = "";
  for (let i = 0; i < strings.length; i++) {
    raw += strings[i];
    if (i < values.length) raw += String(values[i]);
  }
  return dedent(raw) as LuaSource;
}

/**
 * Reference a Lua file on disk relative to the manifest.ts that contains
 * the call. The actual read happens when the loader normalises the
 * manifest (it knows the manifest.ts directory). The returned value is
 * declared as `LuaSource` for assignment ergonomics, but at runtime it's
 * a sentinel object that the loader replaces with the file's content.
 */
export function luaFile(path: string): LuaSource {
  const marker: LuaFileMarker = { [LUA_FILE_MARKER]: true, path };
  return marker as unknown as LuaSource;
}

/**
 * Reference an arbitrary text file on disk relative to the manifest.ts
 * that contains the call. Used by custom-app manifests for the
 * `template` (Vue HTML) and `script` (JS) slots — anything that isn't
 * Lua. The returned value is declared as `string` for assignment
 * ergonomics, but at runtime it's a sentinel object that the loader
 * replaces with the file's content.
 */
export function file(path: string): string {
  const marker: FileMarker = { [FILE_MARKER]: true, path };
  return marker as unknown as string;
}

// ──────────────────────────────────────────────────────────────────────
// Manifest shape — discriminated on engineVersion. v1 requires
// entryScript and forbids v2-only fields; v2 forbids entryScript and
// makes engineVersion optional (defaults to 2 when omitted).
// ──────────────────────────────────────────────────────────────────────

export type RuntimeMode = "script_actor" | "bundle";

export type ResourceSpec = {
  id: string;
  type: string;
  description?: string;
  optional?: boolean;
};

export type DataContainerSchemaSpec = {
  name: string;
  schema: string;
  description?: string;
  taggableTypes?: string[];
  maxPerInstance?: number;
};

export type ActionSpec = {
  name: string;
  label: string;
  description?: string;
  scriptName: string;
  configSchema?: string;
  icon?: string;
};

type IntegrationCommon = {
  id: string;
  version: string;
  sdkVersion: string;
  description?: string;
  runtimeMode?: RuntimeMode;
  resources?: ResourceSpec[];
  permissions?: string[];
  dataContainerSchemas?: DataContainerSchemaSpec[];
  actions?: ActionSpec[];
  /** Per-script Lua execution timeout in ms. Defaults to 5000, capped at 60000. */
  timeoutMs?: number;
};

export type IntegrationV2 = IntegrationCommon & {
  /**
   * Engine version. Optional and pinned to `2` — `manifest.ts` is v2-only.
   * Legacy v1 integrations stay on `manifest.yaml`.
   */
  engineVersion?: 2;
  initSource?: LuaSource;
  shutdownSource?: LuaSource;
  upgradeSource?: LuaSource;
  subscriptions?: Array<{
    topic: string;
    filter?: string;
    source?: LuaSource;
  }>;
  timers?: Array<{
    name: string;
    every?: string;
    cron?: string;
    jitter?: string;
    source?: LuaSource;
  }>;
  libraries?: Record<string, LuaSource>;
};

export type IntegrationDefinition = IntegrationV2;

/**
 * Hidden Symbol-keyed tag stamped onto the result of `defineIntegration` /
 * `defineCustomApp`. The loader reads it to discriminate which kind of
 * manifest it's looking at without resorting to structural sniffing.
 *
 * Symbol-keyed so it survives `Object.assign` / spread but is invisible
 * to `JSON.stringify` (the wire payload is unaffected) and `Object.keys`
 * (`Object.entries`-based clones drop it cleanly — that's by design;
 * the loader reads the tag once before any cloning happens).
 */
const KIND_TAG = Symbol.for("@wearecococo/dev-cli/kind");

export type ManifestKind = "integration" | "app";

export type Tagged<T, K extends ManifestKind> = T & {
  readonly [KIND_TAG]: K;
};

export function manifestKind(value: unknown): ManifestKind | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const k = (value as Record<symbol, unknown>)[KIND_TAG];
  return k === "integration" || k === "app" ? k : undefined;
}

/**
 * Identity helper that pins the spec to `IntegrationV2` for better
 * in-editor errors. Returns the value with a hidden kind tag attached.
 */
export function defineIntegration<T extends IntegrationV2>(spec: T): Tagged<T, "integration"> {
  return Object.assign({}, spec, { [KIND_TAG]: "integration" as const });
}

// ──────────────────────────────────────────────────────────────────────
// Custom apps. Authored as `custom_apps/<handle>/manifest.ts`. The
// platform stores three "source slots" — Vue template, client script,
// optional Lua RPC — plus a small handful of metadata fields. There's
// no semver / DRAFT / ACTIVE machinery; push mutates a working copy,
// publish snapshots + flips the published-version pointer.
// ──────────────────────────────────────────────────────────────────────

export type CustomAppKind = "PAGE" | "DASHBOARD" | "KIOSK" | "JOB_VIEW";

/**
 * Author-facing custom-app spec. `template` and `script` accept either
 * an inline string (for one-liners), a `file(...)` reference (for the
 * normal case where the body lives on disk), or a tagged template you
 * built yourself. `serverApi` is optional and Lua-typed — it accepts
 * `lua\`...\``, `luaFile(...)`, or omitted entirely.
 */
export type CustomAppV2 = {
  /** URL-safe slug, unique per tenant. */
  handle: string;
  /** Human-readable display name. */
  name: string;
  /** Where in the UI the app appears (PAGE / DASHBOARD / KIOSK / JOB_VIEW). */
  kind: CustomAppKind;
  /** Material icon identifier; defaults server-side to `"app_badging"`. */
  icon?: string;
  /** Engine version. Optional and pinned to `2` — manifest.ts is v2-only. */
  engineVersion?: 2;
  /** Vue template HTML rendered in the app iframe. */
  template: string;
  /** Client-side JavaScript / TypeScript executed when the app mounts. */
  script: string;
  /** Optional Lua RPC handlers attached to the global `exports` table. */
  serverApi?: LuaSource;
  /** Optional JSON Schema for custom data container validation. */
  dataContainerSpec?: Record<string, unknown>;
};

export type CustomAppDefinition = CustomAppV2;

export function defineCustomApp<T extends CustomAppV2>(spec: T): Tagged<T, "app"> {
  return Object.assign({}, spec, { [KIND_TAG]: "app" as const });
}

// ──────────────────────────────────────────────────────────────────────

function dedent(s: string): string {
  // Drop a single leading newline (common for `lua\n  ...`).
  const body = s.startsWith("\n") ? s.slice(1) : s;
  const lines = body.split("\n");

  // The trailing line is conventionally just the indent of the closing
  // backtick (or empty). Drop it and replace with a final newline — the
  // author wants their Lua to end with a newline, not with stray indent.
  let trailingNewline = false;
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
    trailingNewline = true;
  }

  // Find the smallest indent across non-blank body lines.
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = line.match(/^[ \t]*/);
    const indent = m ? m[0].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  const indentToStrip = Number.isFinite(minIndent) ? minIndent : 0;

  const stripped =
    indentToStrip > 0
      ? lines.map((l) => (l.length >= indentToStrip ? l.slice(indentToStrip) : l))
      : lines;
  return stripped.join("\n") + (trailingNewline ? "\n" : "");
}
