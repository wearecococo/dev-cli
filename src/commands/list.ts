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
  for (const d of drafts) ensure(d.integrationId).drafts.push(d.version);
  for (const d of active) ensure(d.integrationId).active.push(d.version);
  for (const d of deprecated) ensure(d.integrationId).deprecated.push(d.version);

  if (grouped.size === 0) {
    console.log("No integration definitions found.");
    return;
  }

  const ids = Array.from(grouped.keys()).sort();
  const idWidth = Math.max(14, ...ids.map((s) => s.length));
  const header = `${pad("INTEGRATION", idWidth)}  ${pad("DRAFT", 12)}  ${pad("ACTIVE", 12)}  DEPRECATED`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const id of ids) {
    const row = grouped.get(id)!;
    console.log(
      `${pad(id, idWidth)}  ${pad(row.drafts.join(",") || "-", 12)}  ${pad(
        row.active.join(",") || "-",
        12,
      )}  ${row.deprecated.join(",") || "-"}`,
    );
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
