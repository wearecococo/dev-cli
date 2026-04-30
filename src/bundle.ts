import type { IntegrationBundle } from "./graphql/operations.ts";

/**
 * Decode the file maps embedded in an IntegrationBundle into a flat
 * `path → content` map suitable for diffing against local files.
 *
 * Server-side, the bundle keeps files in category-specific JSON maps keyed
 * by *bare filename* (no directory prefix):
 *  - bundle.scripts        → { "main.lua": "...", "util.lua": "..." }
 *  - bundle.workflows      → { "foo.yaml": "..." }
 *  - bundle.customAppFiles → { "index.html": "...", "server.lua": "..." }
 *
 * The wire format on `updateDraftFile` (and on disk) is the prefixed form
 * (`scripts/main.lua`, `workflows/foo.yaml`, `app/index.html`), so we
 * re-prefix here to keep local↔remote paths aligned.
 *
 * configSchema and policy are top-level strings, not maps, so they're
 * surfaced as fixed paths.
 */
export function bundleToFiles(bundle: IntegrationBundle): Map<string, string> {
  const out = new Map<string, string>();

  const categories: Array<[string, string]> = [
    [bundle.scripts, "scripts"],
    [bundle.workflows, "workflows"],
    [bundle.customAppFiles, "app"],
  ];
  for (const [raw, prefix] of categories) {
    if (!raw) continue;
    for (const [name, content] of parseFileMap(raw)) {
      out.set(`${prefix}/${name}`, content);
    }
  }

  if (bundle.configSchema != null && bundle.configSchema !== "") {
    out.set("config_schema.json", bundle.configSchema);
  }
  if (bundle.policy != null && bundle.policy !== "") {
    out.set("policy.yaml", bundle.policy);
  }

  return out;
}

function parseFileMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string") out.set(k, v);
  }
  return out;
}
