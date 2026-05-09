import { createClient } from "../graphql/client.ts";
import {
  listCustomApps,
  listDefinitions,
  listEdgeApps,
  type EdgeAppState,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";

export async function runList(overrides: ConfigOverrides): Promise<void> {
  const client = createClient(loadConfig(overrides));

  const [drafts, active, deprecated, apps, edgeDraft, edgePub] = await Promise.all([
    listDefinitions(client, { status: "DRAFT" }),
    listDefinitions(client, { status: "ACTIVE" }),
    listDefinitions(client, { status: "DEPRECATED" }),
    listCustomApps(client),
    listEdgeApps(client, { status: "DRAFT" }),
    listEdgeApps(client, { status: "PUBLISHED" }),
  ]);

  printIntegrations({ drafts, active, deprecated });
  console.log("");
  printCustomApps(apps);
  console.log("");
  printEdgeApps([...edgeDraft, ...edgePub]);
}

function printIntegrations(input: {
  drafts: Array<{ integrationId: string; version: string; engineVersion: number }>;
  active: Array<{ integrationId: string; version: string; engineVersion: number }>;
  deprecated: Array<{ integrationId: string; version: string; engineVersion: number }>;
}): void {
  const grouped = new Map<
    string,
    { drafts: string[]; active: string[]; deprecated: string[] }
  >();
  const ensure = (id: string) => {
    let row = grouped.get(id);
    if (!row) {
      row = { drafts: [], active: [], deprecated: [] };
      grouped.set(id, row);
    }
    return row;
  };
  const tag = (version: string, engineVersion: number) => `${version} (v${engineVersion})`;
  for (const d of input.drafts) ensure(d.integrationId).drafts.push(tag(d.version, d.engineVersion));
  for (const d of input.active) ensure(d.integrationId).active.push(tag(d.version, d.engineVersion));
  for (const d of input.deprecated)
    ensure(d.integrationId).deprecated.push(tag(d.version, d.engineVersion));

  if (grouped.size === 0) {
    console.log("Integrations: none.");
    return;
  }

  const ids = Array.from(grouped.keys()).sort();
  const idWidth = Math.max(14, ...ids.map((s) => s.length));
  const colWidth = 18;
  const header = `${pad("INTEGRATION", idWidth)}  ${pad("DRAFT", colWidth)}  ${pad(
    "ACTIVE",
    colWidth,
  )}  DEPRECATED`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const id of ids) {
    const row = grouped.get(id)!;
    console.log(
      `${pad(id, idWidth)}  ${pad(row.drafts.join(",") || "-", colWidth)}  ${pad(
        row.active.join(",") || "-",
        colWidth,
      )}  ${row.deprecated.join(",") || "-"}`,
    );
  }
}

function printCustomApps(
  apps: Array<{
    handle: string;
    name: string;
    kind: string;
    publishedVersion?: number | null;
    engineVersion: number;
  }>,
): void {
  if (apps.length === 0) {
    console.log("Custom apps: none.");
    return;
  }

  const sorted = apps.slice().sort((a, b) => a.handle.localeCompare(b.handle));
  const handleWidth = Math.max(14, ...sorted.map((a) => a.handle.length));
  const nameWidth = Math.max(10, ...sorted.map((a) => a.name.length));
  const header = `${pad("CUSTOM APP", handleWidth)}  ${pad(
    "NAME",
    nameWidth,
  )}  ${pad("KIND", 10)}  PUBLISHED`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const app of sorted) {
    const published =
      app.publishedVersion != null ? `v${app.publishedVersion}` : "(none)";
    console.log(
      `${pad(app.handle, handleWidth)}  ${pad(app.name, nameWidth)}  ${pad(
        app.kind,
        10,
      )}  ${published}`,
    );
  }
}

function printEdgeApps(apps: EdgeAppState[]): void {
  if (apps.length === 0) {
    console.log("Edge apps: none.");
    return;
  }

  // Group by handle so DRAFT and PUBLISHED versions for the same handle
  // collapse to one row.
  const byHandle = new Map<string, { draft?: EdgeAppState; published?: EdgeAppState }>();
  for (const a of apps) {
    const row = byHandle.get(a.handle) ?? {};
    if (a.status === "DRAFT") row.draft = a;
    else if (a.status === "PUBLISHED") row.published = a;
    byHandle.set(a.handle, row);
  }

  const handles = Array.from(byHandle.keys()).sort();
  const handleWidth = Math.max(14, ...handles.map((h) => h.length));
  const nameWidth = Math.max(
    10,
    ...apps.map((a) => a.name.length),
  );
  const header = `${pad("EDGE APP", handleWidth)}  ${pad("NAME", nameWidth)}  ${pad(
    "DRAFT",
    8,
  )}  PUBLISHED`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const handle of handles) {
    const row = byHandle.get(handle)!;
    const name = (row.draft ?? row.published)!.name;
    const draftCell = row.draft ? `v${row.draft.version}` : "-";
    const publishedCell = row.published ? `v${row.published.version}` : "-";
    console.log(
      `${pad(handle, handleWidth)}  ${pad(name, nameWidth)}  ${pad(draftCell, 8)}  ${publishedCell}`,
    );
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
