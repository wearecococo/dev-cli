import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MANIFEST_FILENAME } from "./manifest.ts";

export type IntegrationFolder = {
  /** Absolute path to the integration folder. */
  path: string;
  /** POSIX-style path used as the file key on the server. */
  posixRelative: (abs: string) => string;
};

/**
 * Resolve a folder argument from the user's cwd to an integration folder.
 * - Bare name `foo`        → ./integrations/foo
 * - Path containing manifest.yaml → use as-is
 * - Empty arg              → cwd if it has manifest.yaml
 */
export function resolveIntegrationFolder(arg: string | undefined): IntegrationFolder {
  const cwd = process.cwd();

  const candidates: string[] = [];
  if (!arg) {
    candidates.push(cwd);
  } else if (arg.includes("/") || arg.startsWith(".") || arg.startsWith("~")) {
    candidates.push(resolve(cwd, arg));
  } else {
    candidates.push(resolve(cwd, "integrations", arg));
    candidates.push(resolve(cwd, arg));
  }

  for (const c of candidates) {
    if (existsSync(join(c, MANIFEST_FILENAME))) {
      return makeFolder(c);
    }
  }

  const tried = candidates.join(", ");
  throw new Error(
    `Could not find ${MANIFEST_FILENAME}. Tried: ${tried}. ` +
      `Run from your monorepo root or pass a folder path.`,
  );
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
      if (rel === MANIFEST_FILENAME) continue;
      out.set(rel, abs);
    }
  }
}
