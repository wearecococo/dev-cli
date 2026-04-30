import { readFileSync } from "node:fs";

export type FileDiff = {
  added: string[];
  changed: string[];
  unchanged: string[];
  deleted: string[];
};

/**
 * Diff a local file map (path → absolute path on disk) against a remote
 * file map (path → content). Files present locally but not remotely are
 * `added`; present remotely but not locally are `deleted`; both with
 * different content are `changed`.
 */
export function diffFiles(
  local: Map<string, string>,
  remote: Map<string, string>,
): FileDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];

  for (const [path, abs] of local) {
    const remoteContent = remote.get(path);
    if (remoteContent === undefined) {
      added.push(path);
    } else {
      const localContent = readFileSync(abs, "utf8");
      if (localContent === remoteContent) {
        unchanged.push(path);
      } else {
        changed.push(path);
      }
    }
  }

  for (const path of remote.keys()) {
    if (!local.has(path)) deleted.push(path);
  }

  added.sort();
  changed.sort();
  unchanged.sort();
  deleted.sort();
  return { added, changed, unchanged, deleted };
}

export function summarize(d: FileDiff): string {
  return `+${d.added.length} added, ~${d.changed.length} changed, -${d.deleted.length} deleted`;
}
