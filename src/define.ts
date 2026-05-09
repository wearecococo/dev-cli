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

export type LuaFileMarker = {
  readonly [LUA_FILE_MARKER]: true;
  readonly path: string;
};

export function isLuaFileMarker(x: unknown): x is LuaFileMarker {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as LuaFileMarker)[LUA_FILE_MARKER] === true
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
 * Identity helper that pins the spec to `IntegrationV2` for better
 * in-editor errors. Returns the value unchanged so it can be
 * default-exported from `manifest.ts`.
 */
export function defineIntegration<T extends IntegrationV2>(spec: T): T {
  return spec;
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
