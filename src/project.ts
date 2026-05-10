import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MANIFEST_FILENAME } from "./manifest.ts";
import { MANIFEST_TS_FILENAME } from "./loader.ts";

const MANIFEST_FILENAMES = [MANIFEST_TS_FILENAME, MANIFEST_FILENAME];

function hasManifest(folder: string): boolean {
  return MANIFEST_FILENAMES.some((f) => existsSync(join(folder, f)));
}

export type IntegrationFolder = {
  /** Absolute path to the integration folder. */
  path: string;
  /** POSIX-style path used as the file key on the server. */
  posixRelative: (abs: string) => string;
};

export const INTEGRATIONS_DIR = "integrations";
export const CUSTOM_APPS_DIR = "custom_apps";
export const EDGE_APPS_DIR = "edge_apps";

/**
 * Resolve a folder argument from the user's cwd to a manifest folder.
 *
 * Bare names (no separators) get tried under both first-class
 * directories — `integrations/<arg>` and `custom_apps/<arg>` — so the
 * user can type `cococo push job-board` or `cococo push my-erp` without
 * spelling out which kind of thing it is. Path-shaped args (`./...`,
 * `custom_apps/job-board`) are taken verbatim.
 */
export function resolveIntegrationFolder(arg: string | undefined): IntegrationFolder {
  const cwd = process.cwd();

  const candidates: string[] = [];
  if (!arg) {
    candidates.push(cwd);
  } else if (arg.includes("/") || arg.startsWith(".") || arg.startsWith("~")) {
    candidates.push(resolve(cwd, arg));
  } else {
    candidates.push(resolve(cwd, INTEGRATIONS_DIR, arg));
    candidates.push(resolve(cwd, CUSTOM_APPS_DIR, arg));
    candidates.push(resolve(cwd, EDGE_APPS_DIR, arg));
    candidates.push(resolve(cwd, arg));
  }

  for (const c of candidates) {
    if (hasManifest(c)) return makeFolder(c);
  }

  const tried = candidates.join(", ");
  throw new Error(
    `Could not find ${MANIFEST_TS_FILENAME} or ${MANIFEST_FILENAME}. Tried: ${tried}. ` +
      `Run from your monorepo root or pass a folder path.`,
  );
}

/**
 * Enumerate every artifact folder under `integrations/`, `custom_apps/`,
 * and `edge_apps/` at the repo root. Each entry is a folder that has a
 * `manifest.ts` or `manifest.yaml`. Returned in deterministic order
 * (kind first, then alphabetical within kind) so iteration is
 * reproducible.
 */
export function listAllArtifactFolders(repoRoot?: string): string[] {
  const root = repoRoot ?? process.cwd();
  const out: string[] = [];
  for (const dir of [INTEGRATIONS_DIR, CUSTOM_APPS_DIR, EDGE_APPS_DIR]) {
    const abs = resolve(root, dir);
    if (!existsSync(abs)) continue;
    const entries = readdirSync(abs).sort();
    for (const e of entries) {
      const full = resolve(abs, e);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (hasManifest(full)) out.push(full);
    }
  }
  return out;
}

export function makeFolder(absPath: string): IntegrationFolder {
  return {
    path: absPath,
    posixRelative: (abs: string) => relative(absPath, abs).split("\\").join("/"),
  };
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".cococo"]);

/**
 * Walk all files under the integration folder, excluding the manifest itself,
 * dotfiles/dotdirs, and SKIP_DIRS. Returns POSIX-relative paths.
 */
export function walkIntegrationFiles(folder: IntegrationFolder): Map<string, string> {
  const out = new Map<string, string>();
  walk(folder.path, folder, out);
  return out;
}

function walk(dir: string, folder: IntegrationFolder, out: Map<string, string>): void {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(abs, folder, out);
    } else if (st.isFile()) {
      const rel = folder.posixRelative(abs);
      if (MANIFEST_FILENAMES.includes(rel)) continue;
      out.set(rel, abs);
    }
  }
}
