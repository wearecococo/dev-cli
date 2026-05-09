import { parse, stringify } from "yaml";
import type {
  EngineVersion,
  IntegrationManifest,
  IntegrationManifestV1,
  IntegrationManifestV2,
} from "./graphql/operations.ts";

export const MANIFEST_FILENAME = "manifest.yaml";

/**
 * Engine version for *new* integrations (used by `init` and new drafts).
 * v2 is the current platform default.
 *
 * NOTE: this is **not** the default for parsing an existing manifest. A
 * `manifest.yaml` that pre-dates v2 won't carry an `engine_version` key —
 * those must be treated as v1 to round-trip correctly. See
 * `manifestEngineVersion` below.
 */
export const DEFAULT_ENGINE_VERSION: EngineVersion = 2;

/**
 * On-disk and on-wire format. The cococo server expects snake_case keys when
 * the manifest is sent as a JSON-encoded string to `updateDraftManifest`. We
 * keep YAML in the same shape so users can author manifests that match the
 * platform docs verbatim.
 *
 * `engine_version` is a CLI-only field: it is written by `init`/`pull` so the
 * folder round-trips correctly, and stripped by `manifestToWire` before the
 * payload is sent to `updateDraftManifest` (which validates against
 * `IntegrationManifest` and would reject the unknown key).
 */
type WireManifestCommon = {
  id: string;
  version: string;
  /** Local-only marker; stripped on the wire. Defaults to v2 when absent. */
  engine_version?: EngineVersion;
} & Record<string, unknown>;

export type WireManifestV1 = WireManifestCommon & {
  engine_version?: 1;
  entry_script?: string;
};

export type WireManifestV2 = WireManifestCommon & {
  engine_version?: 2;
  init_source?: string;
  shutdown_source?: string;
  upgrade_source?: string;
  /** Nested map on disk; serialised as a JSON object on the wire. */
  libraries?: Record<string, string>;
};

export type WireManifest = WireManifestV1 | WireManifestV2;

/**
 * Resolve the engine version of a parsed manifest.
 *
 * When the manifest carries an explicit `engine_version`, return it. When
 * absent, default to **v1** — the engine_version key was added by this
 * CLI when v2 shipped, so any manifest.yaml without it pre-dates v2 and
 * is therefore a legacy v1 integration.
 *
 * The TS loader stamps `engine_version` from the discriminated union
 * unconditionally, so this fallback only fires for hand-authored YAML.
 */
export function manifestEngineVersion(m: WireManifest): EngineVersion {
  return m.engine_version ?? 1;
}

export function parseManifest(text: string): WireManifest {
  const obj = parse(text);
  if (!obj || typeof obj !== "object") {
    throw new Error("manifest.yaml must parse to an object.");
  }
  const m = obj as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id) {
    throw new Error("manifest.yaml: 'id' is required (e.g. com.acme.my-integration).");
  }
  if (typeof m.version !== "string" || !m.version) {
    throw new Error("manifest.yaml: 'version' is required (e.g. 0.1.0).");
  }
  if (m.engine_version !== undefined && m.engine_version !== 1 && m.engine_version !== 2) {
    throw new Error(
      `manifest.yaml: 'engine_version' must be 1 or 2 (got ${JSON.stringify(m.engine_version)}).`,
    );
  }
  return m as WireManifest;
}

export function serializeManifest(m: WireManifest): string {
  return stringify(m, { lineWidth: 0 });
}

/**
 * Convert a parsed manifest into the JSON payload accepted by
 * `updateDraftManifest`. Strips the local-only `engine_version` marker and
 * any keys whose values are `undefined`.
 */
export function manifestToWire(m: WireManifest): string {
  const { engine_version, ...rest } = m;
  void engine_version;
  return JSON.stringify(rest);
}

export function shortName(integrationId: string): string {
  const parts = integrationId.split(".");
  const last = parts[parts.length - 1] ?? integrationId;
  return last;
}

export function buildInitialManifest(
  integrationId: string,
  version: string,
  engineVersion: EngineVersion = DEFAULT_ENGINE_VERSION,
): WireManifest {
  if (engineVersion === 1) return buildInitialManifestV1(integrationId, version);
  return buildInitialManifestV2(integrationId, version);
}

export function buildInitialManifestV1(
  integrationId: string,
  version: string,
): WireManifestV1 {
  return {
    id: integrationId,
    version,
    engine_version: 1,
    sdk_version: "1.0",
    runtime_mode: "script_actor",
    entry_script: "main.lua",
    resources: [],
    permissions: [],
    subscriptions: [],
    timers: [],
  };
}

export function buildInitialManifestV2(
  integrationId: string,
  version: string,
): WireManifestV2 {
  // Inline `source` is intentionally omitted: the v2 starter materialises
  // the heartbeat handler at handlers/timers/heartbeat.lua, and `cococo push`
  // looks up handler files by timer name.
  return {
    id: integrationId,
    version,
    engine_version: 2,
    sdk_version: "1.0",
    runtime_mode: "script_actor",
    description: "",
    resources: [],
    permissions: [],
    subscriptions: [],
    timers: [{ name: "heartbeat", every: "1m" }],
  };
}

/**
 * Convert the camelCase `IntegrationManifest` returned by GraphQL into the
 * snake_case wire/YAML shape. Unknown keys pass through with their key
 * camel→snake-cased; null/undefined values are dropped to keep the YAML
 * compact. The caller supplies the `engineVersion` (carried on
 * IntegrationDefinition, not the manifest itself); it is written through as
 * the local-only `engine_version` marker so round-trips are stable.
 */
export function manifestFromGraphql(
  m: IntegrationManifest,
  engineVersion: EngineVersion,
): WireManifest {
  const out: Record<string, unknown> = { engine_version: engineVersion };
  for (const [key, value] of Object.entries(m)) {
    if (value === null || value === undefined) continue;
    if (engineVersion === 2 && key === "libraries" && typeof value === "string") {
      // GraphQL ships v2 libraries as a JSON-encoded string; expose as a
      // nested map on disk for ergonomic editing.
      out.libraries = decodeLibraries(value);
      continue;
    }
    if (engineVersion === 2 && key === "entryScript") {
      // Ignored at v2 — don't pollute the v2 YAML.
      continue;
    }
    if (engineVersion === 1 && isV2OnlyKey(key)) {
      continue;
    }
    out[camelToSnake(key)] = value;
  }
  return out as WireManifest;
}

function isV2OnlyKey(key: string): boolean {
  return (
    key === "initSource" ||
    key === "shutdownSource" ||
    key === "upgradeSource" ||
    key === "libraries"
  );
}

function decodeLibraries(raw: string): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// Re-exported for callers that need to refer to the engine-versioned manifest
// shapes directly without reaching into the GraphQL module.
export type { IntegrationManifestV1, IntegrationManifestV2 };

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
