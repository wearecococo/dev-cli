import type { WireManifest, WireManifestV2 } from "./manifest.ts";
import { manifestEngineVersion } from "./manifest.ts";

/**
 * v2 manifest sources are materialised on disk under these directories so
 * authors can edit them as real `.lua` files (with syntax highlighting and
 * the existing `cococo lint` pass) instead of YAML block scalars.
 *
 * Each path under one of these prefixes is a *manifest source file*: its
 * content is injected into the manifest payload at push time, and stripped
 * back out into a file at pull time. They are NOT uploaded as bundle files
 * via `updateDraftFile` — the server's `IntegrationBundle` doesn't know
 * about these paths.
 */
export const MANIFEST_SOURCE_DIRS = [
  "lifecycle/",
  "handlers/timers/",
  "handlers/subscriptions/",
  "libraries/",
] as const;

export const LIFECYCLE_PATHS = {
  init_source: "lifecycle/init.lua",
  shutdown_source: "lifecycle/shutdown.lua",
  upgrade_source: "lifecycle/upgrade.lua",
} as const;

export type ManifestSourceFiles = Map<string, string>;

export function isManifestSourcePath(path: string): boolean {
  return MANIFEST_SOURCE_DIRS.some((d) => path.startsWith(d));
}

/**
 * Split a flat path-keyed file map (e.g. from `walkIntegrationFiles`) into
 * the bundle-file slice (paths the server stores under `IntegrationBundle`)
 * and the manifest-source slice (paths whose content gets folded into the
 * manifest payload).
 */
export function partitionFiles<T>(
  files: Map<string, T>,
): { bundle: Map<string, T>; sources: Map<string, T> } {
  const bundle = new Map<string, T>();
  const sources = new Map<string, T>();
  for (const [path, value] of files) {
    if (isManifestSourcePath(path)) sources.set(path, value);
    else bundle.set(path, value);
  }
  return { bundle, sources };
}

export function timerHandlerPath(timerName: string): string {
  return `handlers/timers/${timerName}.lua`;
}

export function subscriptionHandlerPath(topic: string): string {
  return `handlers/subscriptions/${topic}.lua`;
}

export function libraryPath(name: string): string {
  return `libraries/${name}.lua`;
}

/**
 * Read manifest source content from disk and fold it into a v2 manifest.
 *
 * Rules:
 * - File on disk wins over an inline `source` value in the YAML — the YAML
 *   inline is treated as a fallback for users who don't want to break
 *   one-liners out into a file.
 * - A manifest source file with no matching manifest entry (e.g. a stray
 *   `handlers/timers/old-name.lua` after a rename) is a likely bug and
 *   raises here rather than silently uploading dead code.
 * - Duplicate timer names / subscription topics are rejected — the on-disk
 *   layout is keyed by name/topic so it can't represent collisions.
 *
 * v1 manifests don't use these dirs; this function refuses to inject when
 * given one, and the caller surfaces a clear error if any source files exist.
 */
export function injectManifestSources(
  manifest: WireManifest,
  sourceFiles: ReadonlyMap<string, string>,
): WireManifest {
  const engine = manifestEngineVersion(manifest);
  if (engine !== 2) {
    if (sourceFiles.size > 0) {
      const versionSrc =
        (manifest as Record<string, unknown>).engine_version === 1
          ? `engine_version is 1`
          : `manifest.yaml has no engine_version key (defaulting to v1 for backwards compatibility)`;
      throw new Error(
        `Found ${sourceFiles.size} file(s) under ${MANIFEST_SOURCE_DIRS.join(", ")} ` +
          `but ${versionSrc}. These directories are v2-only — remove them ` +
          `or set 'engine_version: 2' in manifest.yaml.`,
      );
    }
    return manifest;
  }

  const m = cloneV2(manifest as WireManifestV2);
  const consumed = new Set<string>();

  // Lifecycle hooks.
  for (const [field, path] of Object.entries(LIFECYCLE_PATHS) as Array<
    [keyof typeof LIFECYCLE_PATHS, string]
  >) {
    const fileContent = sourceFiles.get(path);
    if (fileContent !== undefined) {
      m[field] = fileContent;
      consumed.add(path);
    }
  }

  // Timers — keyed by `name`.
  if (Array.isArray(m.timers)) {
    const seen = new Set<string>();
    for (const timer of m.timers as Array<Record<string, unknown>>) {
      const name = String(timer.name ?? "");
      if (!name) continue;
      if (seen.has(name)) {
        throw new Error(
          `Duplicate timer name '${name}' in manifest.timers. The materialised ` +
            `layout requires unique timer names so handler files can be looked up.`,
        );
      }
      seen.add(name);
      const path = timerHandlerPath(name);
      const fileContent = sourceFiles.get(path);
      if (fileContent !== undefined) {
        timer.source = fileContent;
        consumed.add(path);
      }
    }
  }

  // Subscriptions — keyed by `topic`.
  if (Array.isArray(m.subscriptions)) {
    const seen = new Set<string>();
    for (const sub of m.subscriptions as Array<Record<string, unknown>>) {
      const topic = String(sub.topic ?? "");
      if (!topic) continue;
      if (seen.has(topic)) {
        throw new Error(
          `Duplicate subscription topic '${topic}' in manifest.subscriptions. ` +
            `The materialised layout requires unique topics so handler files can ` +
            `be looked up — collapse them into one entry, or keep the source ` +
            `inline on each entry instead of using handler files.`,
        );
      }
      seen.add(topic);
      const path = subscriptionHandlerPath(topic);
      const fileContent = sourceFiles.get(path);
      if (fileContent !== undefined) {
        sub.source = fileContent;
        consumed.add(path);
      }
    }
  }

  // Libraries — every file in libraries/ becomes an entry, regardless of
  // what's already in the YAML map. Disk is authoritative for libraries.
  const libraries: Record<string, string> = {
    ...((m.libraries as Record<string, string> | undefined) ?? {}),
  };
  for (const [path, content] of sourceFiles) {
    if (!path.startsWith("libraries/") || !path.endsWith(".lua")) continue;
    const name = path.slice("libraries/".length, -".lua".length);
    libraries[name] = content;
    consumed.add(path);
  }
  if (Object.keys(libraries).length > 0) {
    m.libraries = libraries;
  }

  // Anything in source-files that wasn't matched is a stray.
  const strays: string[] = [];
  for (const path of sourceFiles.keys()) {
    if (!consumed.has(path)) strays.push(path);
  }
  if (strays.length > 0) {
    strays.sort();
    throw new Error(
      `Stray manifest source file(s) with no matching manifest entry:\n` +
        strays.map((p) => `  - ${p}`).join("\n") +
        `\nRename / delete the file, or add the corresponding entry to manifest.yaml.`,
    );
  }

  return m;
}

/**
 * Inverse of `injectManifestSources`: pull every inline `source` (and the
 * libraries map) out of a v2 manifest into a flat `path → content` map, and
 * return a stripped manifest where those fields are gone. Used by `pull` to
 * write each source as its own file on disk.
 *
 * v1 manifests are returned untouched with an empty file map.
 */
export function extractManifestSources(
  manifest: WireManifest,
): { stripped: WireManifest; files: Map<string, string> } {
  const files = new Map<string, string>();
  if (manifestEngineVersion(manifest) !== 2) {
    return { stripped: manifest, files };
  }

  const m = cloneV2(manifest as WireManifestV2);

  for (const [field, path] of Object.entries(LIFECYCLE_PATHS) as Array<
    [keyof typeof LIFECYCLE_PATHS, string]
  >) {
    const value = m[field];
    if (typeof value === "string" && value.length > 0) {
      files.set(path, ensureTrailingNewline(value));
      delete m[field];
    }
  }

  if (Array.isArray(m.timers)) {
    for (const timer of m.timers as Array<Record<string, unknown>>) {
      const name = String(timer.name ?? "");
      const source = timer.source;
      if (typeof source === "string" && source.length > 0 && name) {
        files.set(timerHandlerPath(name), ensureTrailingNewline(source));
        delete timer.source;
      }
    }
  }

  if (Array.isArray(m.subscriptions)) {
    for (const sub of m.subscriptions as Array<Record<string, unknown>>) {
      const topic = String(sub.topic ?? "");
      const source = sub.source;
      if (typeof source === "string" && source.length > 0 && topic) {
        files.set(subscriptionHandlerPath(topic), ensureTrailingNewline(source));
        delete sub.source;
      }
    }
  }

  if (m.libraries && typeof m.libraries === "object") {
    for (const [name, content] of Object.entries(
      m.libraries as Record<string, string>,
    )) {
      if (typeof content === "string" && content.length > 0) {
        files.set(libraryPath(name), ensureTrailingNewline(content));
      }
    }
    delete m.libraries;
  }

  return { stripped: m, files };
}

function cloneV2(m: WireManifestV2): WireManifestV2 {
  // Structured-clone preserves nested arrays/objects so we can mutate without
  // surprising the caller. Lua sources are plain strings — no Date/Map weirdness.
  return JSON.parse(JSON.stringify(m)) as WireManifestV2;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
