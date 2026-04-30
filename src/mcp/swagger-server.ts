import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type Json = unknown;
type JsonObject = Record<string, Json>;

export type SwaggerSpec = JsonObject & {
  swagger?: string;
  openapi?: string;
  info?: { title?: string; description?: string; version?: string };
  servers?: Array<{ url: string; description?: string }>;
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths?: Record<string, JsonObject>;
  components?: { schemas?: Record<string, JsonObject> };
  definitions?: Record<string, JsonObject>;
  tags?: Array<{ name: string; description?: string }>;
};

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

type OperationSummary = {
  operationId?: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
};

function isObject(v: Json): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isOpenApi3(spec: SwaggerSpec): boolean {
  return typeof spec.openapi === "string" && spec.openapi.startsWith("3.");
}

function schemasContainer(spec: SwaggerSpec): Record<string, JsonObject> {
  if (isOpenApi3(spec)) return spec.components?.schemas ?? {};
  return spec.definitions ?? {};
}

function schemaRefPrefix(spec: SwaggerSpec): string {
  return isOpenApi3(spec) ? "#/components/schemas/" : "#/definitions/";
}

function resolvePointer(spec: SwaggerSpec, ref: string): Json | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: Json = spec;
  for (const part of parts) {
    if (!isObject(node)) return undefined;
    node = node[part];
    if (node === undefined) return undefined;
  }
  return node;
}

function deref(spec: SwaggerSpec, value: Json, seen: Set<string>): Json {
  if (Array.isArray(value)) {
    return value.map((v) => deref(spec, v, seen));
  }
  if (!isObject(value)) return value;
  const ref = value["$ref"];
  if (typeof ref === "string") {
    if (seen.has(ref)) {
      return { $ref: ref, $cycle: true };
    }
    const target = resolvePointer(spec, ref);
    if (target === undefined) return { $ref: ref, $unresolved: true };
    const next = new Set(seen);
    next.add(ref);
    return deref(spec, target, next);
  }
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = deref(spec, v, seen);
  }
  return out;
}

function listOperationsRaw(spec: SwaggerSpec): OperationSummary[] {
  const out: OperationSummary[] = [];
  const paths = spec.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      out.push({
        operationId: typeof op.operationId === "string" ? op.operationId : undefined,
        method,
        path,
        summary: typeof op.summary === "string" ? op.summary : undefined,
        description: typeof op.description === "string" ? op.description : undefined,
        tags: Array.isArray(op.tags)
          ? (op.tags.filter((t) => typeof t === "string") as string[])
          : undefined,
        deprecated: op.deprecated === true ? true : undefined,
      });
    }
  }
  return out;
}

function findOperation(
  spec: SwaggerSpec,
  args: { operationId?: string; method?: string; path?: string },
): { method: HttpMethod; path: string; op: JsonObject } | undefined {
  const paths = spec.paths ?? {};
  const wantId = args.operationId;
  const wantMethod = args.method?.toLowerCase();
  const wantPath = args.path;
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      if (wantId && op.operationId === wantId) {
        return { method, path, op };
      }
      if (!wantId && wantMethod === method && wantPath === path) {
        return { method, path, op };
      }
    }
  }
  return undefined;
}

function summarizeInfo(spec: SwaggerSpec): JsonObject {
  const info = spec.info ?? {};
  let servers: Array<{ url: string; description?: string }> = [];
  if (Array.isArray(spec.servers)) {
    servers = spec.servers
      .filter((s): s is { url: string; description?: string } =>
        isObject(s) && typeof s.url === "string",
      );
  } else if (spec.host) {
    const schemes = spec.schemes ?? ["https"];
    const basePath = spec.basePath ?? "";
    servers = schemes.map((scheme) => ({ url: `${scheme}://${spec.host}${basePath}` }));
  }
  return {
    title: info.title,
    version: info.version,
    description: info.description,
    specVersion: spec.openapi ?? spec.swagger,
    servers,
    operationCount: listOperationsRaw(spec).length,
    schemaCount: Object.keys(schemasContainer(spec)).length,
  };
}

function asJsonText(value: Json): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function asError(message: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function buildServer(spec: SwaggerSpec, sourcePath: string): McpServer {
  const title = spec.info?.title ?? "OpenAPI";
  const server = new McpServer(
    { name: "cococo-swagger", version: "0.1.0" },
    {
      instructions:
        `Read-only MCP server exposing the ${title} API spec loaded from ${sourcePath}. ` +
        `Use these tools to discover operations and schemas before writing integration code; ` +
        `no requests are made against the live API.`,
    },
  );

  server.registerTool(
    "get_info",
    {
      title: "Get API info",
      description:
        "Return the spec's title, description, version, server URLs, and totals. " +
        "Call this first to orient yourself.",
      inputSchema: {},
    },
    async () => asJsonText(summarizeInfo(spec)),
  );

  server.registerTool(
    "list_operations",
    {
      title: "List operations",
      description:
        "List all operations as {operationId, method, path, summary, tags}. " +
        "Optional `tag` filter narrows by OpenAPI tag.",
      inputSchema: {
        tag: z.string().optional().describe("Only include operations with this tag"),
      },
    },
    async ({ tag }) => {
      let ops = listOperationsRaw(spec);
      if (tag) ops = ops.filter((o) => o.tags?.includes(tag));
      return asJsonText(ops);
    },
  );

  server.registerTool(
    "search_operations",
    {
      title: "Search operations",
      description:
        "Case-insensitive substring search across operationId, summary, description, path, and tags.",
      inputSchema: {
        query: z.string().min(1).describe("Search string"),
        limit: z.number().int().positive().max(200).optional().describe("Max results (default 50)"),
      },
    },
    async ({ query, limit }) => {
      const q = query.toLowerCase();
      const ops = listOperationsRaw(spec);
      const matched = ops.filter((o) => {
        const hay = [
          o.operationId,
          o.summary,
          o.description,
          o.path,
          ...(o.tags ?? []),
        ]
          .filter((s): s is string => typeof s === "string")
          .join(" \n ")
          .toLowerCase();
        return hay.includes(q);
      });
      return asJsonText(matched.slice(0, limit ?? 50));
    },
  );

  server.registerTool(
    "get_operation",
    {
      title: "Get operation details",
      description:
        "Return one operation with all $refs resolved (parameters, requestBody, responses). " +
        "Provide either `operationId`, or both `method` and `path`.",
      inputSchema: {
        operationId: z.string().optional(),
        method: z.string().optional().describe("HTTP method, e.g. 'get'"),
        path: z.string().optional().describe("Path template, e.g. '/users/{id}'"),
      },
    },
    async ({ operationId, method, path }) => {
      if (!operationId && !(method && path)) {
        return asError("Provide either operationId, or both method and path.");
      }
      const found = findOperation(spec, { operationId, method, path });
      if (!found) return asError("Operation not found.");
      const dereffed = deref(spec, found.op, new Set());
      return asJsonText({
        method: found.method,
        path: found.path,
        ...(isObject(dereffed) ? dereffed : { value: dereffed }),
      });
    },
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description:
        "List tags declared in the spec plus any tags referenced by operations, with operation counts.",
      inputSchema: {},
    },
    async () => {
      const declared = new Map<string, string | undefined>();
      for (const t of spec.tags ?? []) {
        if (isObject(t) && typeof t.name === "string") {
          declared.set(t.name, typeof t.description === "string" ? t.description : undefined);
        }
      }
      const counts = new Map<string, number>();
      for (const op of listOperationsRaw(spec)) {
        for (const t of op.tags ?? []) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      const names = new Set<string>([...declared.keys(), ...counts.keys()]);
      const result = Array.from(names)
        .sort()
        .map((name) => ({
          name,
          description: declared.get(name),
          operationCount: counts.get(name) ?? 0,
        }));
      return asJsonText(result);
    },
  );

  server.registerTool(
    "get_schema",
    {
      title: "Get schema",
      description:
        "Return a named component schema with $refs resolved (cycle-safe). " +
        "Pass the bare name (e.g. 'User'), not the full $ref path.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => {
      const schemas = schemasContainer(spec);
      const target = schemas[name];
      if (!target) {
        const known = Object.keys(schemas).slice(0, 50);
        return asError(
          `Schema '${name}' not found. ${known.length} known schemas; first: ${known.join(", ")}`,
        );
      }
      const ref = `${schemaRefPrefix(spec)}${name}`;
      const dereffed = deref(spec, target, new Set([ref]));
      return asJsonText(dereffed);
    },
  );

  return server;
}

export async function startStdio(spec: SwaggerSpec, sourcePath: string): Promise<void> {
  const server = buildServer(spec, sourcePath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
