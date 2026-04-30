import { parse, stringify } from "yaml";
import type { IntegrationManifest } from "./graphql/operations.ts";

export const MANIFEST_FILENAME = "manifest.yaml";

/**
 * On-disk and on-wire format. The cococo server expects snake_case keys when
 * the manifest is sent as a JSON-encoded string to `updateDraftManifest`. We
 * keep YAML in the same shape so users can author manifests that match the
 * platform docs verbatim.
 */
export type WireManifest = {
  id: string;
  version: string;
} & Record<string, unknown>;

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
  return m as WireManifest;
}

export function serializeManifest(m: WireManifest): string {
  return stringify(m, { lineWidth: 0 });
}

export function manifestToWire(m: WireManifest): string {
  return JSON.stringify(m);
}

export function shortName(integrationId: string): string {
  const parts = integrationId.split(".");
  const last = parts[parts.length - 1] ?? integrationId;
  return last;
}

export function buildInitialManifest(
  integrationId: string,
  version: string,
): WireManifest {
  return {
    id: integrationId,
    version,
    sdk_version: "1.0",
    runtime_mode: "script_actor",
    entry_script: "main.lua",
    resources: [],
    permissions: [],
    subscriptions: [],
    timers: [],
  };
}

/**
 * Convert the camelCase `IntegrationManifest` returned by GraphQL into the
 * snake_case wire/YAML shape. Unknown keys pass through with their key
 * camel→snake-cased; null/undefined values are dropped to keep the YAML
 * compact.
 */
export function manifestFromGraphql(m: IntegrationManifest): WireManifest {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(m)) {
    if (value === null || value === undefined) continue;
    out[camelToSnake(key)] = value;
  }
  return out as WireManifest;
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
