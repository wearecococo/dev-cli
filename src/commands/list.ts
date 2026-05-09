import { createClient } from "../graphql/client.ts";
import { listDefinitions } from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";

export async function runList(overrides: ConfigOverrides): Promise<void> {
  const client = createClient(loadConfig(overrides));

  const [drafts, active, deprecated] = await Promise.all([
    listDefinitions(client, { status: "DRAFT" }),
    listDefinitions(client, { status: "ACTIVE" }),
    listDefinitions(client, { status: "DEPRECATED" }),
  ]);

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
  for (const d of drafts) ensure(d.integrationId).drafts.push(tag(d.version, d.engineVersion));
  for (const d of active) ensure(d.integrationId).active.push(tag(d.version, d.engineVersion));
  for (const d of deprecated)
    ensure(d.integrationId).deprecated.push(tag(d.version, d.engineVersion));

  if (grouped.size === 0) {
    console.log("No integration definitions found.");
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

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
