import { loadConfig, type ConfigOverrides } from "../config.ts";
import { createClient } from "../graphql/client.ts";
import {
  getControllerByHandle,
  listEdgeAppInstallations,
} from "../graphql/operations.ts";
import { subscribe } from "../graphql/subscriptions.ts";

export type LogsKind = "integration" | "workflow" | "edge-app";

export type LogsOptions = {
  json: boolean;
  noColor: boolean;
};

const C = {
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};

/**
 * `cococo logs <kind> <target>` — attach to a server-side log stream
 * and print every event as a line to stdout. Streams until SIGINT.
 *
 *  integration <instance-id>     execution log stream (contextType=INTEGRATION_INSTANCE)
 *  workflow    <execution-id>    execution log stream (contextType=WORKFLOW_EXECUTION)
 *  edge-app    <ctrl>/<app>      edge-app event stream (kind=LOG entries)
 *  edge-app    <installation-id> ↑ same, raw installation ID also accepted
 */
export async function runLogs(
  kind: LogsKind,
  target: string,
  opts: LogsOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const config = loadConfig(overrides);

  if (kind === "edge-app") {
    const installationId = await resolveEdgeAppInstallation(config, overrides, target);
    await streamEdgeAppLogs(config, installationId, opts);
    return;
  }
  if (kind === "integration") {
    await streamExecutionLogs(config, "INTEGRATION_INSTANCE", target, opts);
    return;
  }
  if (kind === "workflow") {
    await streamExecutionLogs(config, "WORKFLOW_EXECUTION", target, opts);
    return;
  }
}

async function resolveEdgeAppInstallation(
  config: ReturnType<typeof loadConfig>,
  overrides: ConfigOverrides,
  target: string,
): Promise<string> {
  // Two shapes: `<controller-handle>/<app-handle>` or a raw installation ID.
  if (!target.includes("/")) {
    return target;
  }
  const [ctrlHandle, appHandle] = target.split("/", 2) as [string, string];
  const client = createClient(config);
  void overrides;
  const ctrl = await getControllerByHandle(client, ctrlHandle);
  if (!ctrl) throw new Error(`Controller '${ctrlHandle}' not found.`);
  const installs = await listEdgeAppInstallations(client, { controllerId: ctrl.id });
  const match = installs.find((i) => i.edgeApp?.handle === appHandle);
  if (!match) {
    throw new Error(
      `No installation of edge app '${appHandle}' on controller '${ctrlHandle}'.`,
    );
  }
  return match.id;
}

async function streamExecutionLogs(
  config: ReturnType<typeof loadConfig>,
  contextType: "INTEGRATION_INSTANCE" | "WORKFLOW_EXECUTION",
  contextId: string,
  opts: LogsOptions,
): Promise<void> {
  type Payload = {
    executionLogStream: {
      id: string;
      level: "DEBUG" | "INFO" | "WARN" | "WARNING" | "ERROR";
      message: string;
      metadata: string | null;
      createdAt: string;
    };
  };

  const query = `
    subscription Logs($contextType: ExecutionLogContextType!, $contextId: String!) {
      executionLogStream(contextType: $contextType, contextId: $contextId) {
        id level message metadata createdAt
      }
    }
  `;

  await runStream<Payload>({
    config,
    query,
    variables: { contextType, contextId },
    label: contextType === "INTEGRATION_INSTANCE" ? `integration/${contextId}` : `workflow/${contextId}`,
    opts,
    format: (data) => {
      const e = data.executionLogStream;
      if (opts.json) {
        return JSON.stringify({
          time: e.createdAt,
          level: e.level,
          message: e.message,
          metadata: e.metadata ? safeParse(e.metadata) : undefined,
        });
      }
      return formatLine(e.createdAt, e.level, e.message, e.metadata, opts.noColor);
    },
  });
}

async function streamEdgeAppLogs(
  config: ReturnType<typeof loadConfig>,
  installationId: string,
  opts: LogsOptions,
): Promise<void> {
  type Payload = {
    edgeAppLogStream: {
      id: string;
      edgeAppHandle: string;
      kind: "EVENT" | "LOG" | "GRAPHQL";
      level: string | null;
      payload: unknown;
      emittedAt: string;
    };
  };

  const query = `
    subscription EdgeLogs($installationId: EdgeAppInstallationID!) {
      edgeAppLogStream(installationId: $installationId) {
        id edgeAppHandle kind level payload emittedAt
      }
    }
  `;

  await runStream<Payload>({
    config,
    query,
    variables: { installationId },
    label: `edge-app/${installationId}`,
    opts,
    format: (data) => {
      const e = data.edgeAppLogStream;
      const message = extractEdgeMessage(e.payload);
      if (opts.json) {
        return JSON.stringify({
          time: e.emittedAt,
          level: e.level ?? "INFO",
          app: e.edgeAppHandle,
          message,
          payload: e.payload,
        });
      }
      return formatLine(e.emittedAt, e.level ?? "INFO", `[${e.edgeAppHandle}] ${message}`, null, opts.noColor);
    },
  });
}

type StreamArgs<T> = {
  config: ReturnType<typeof loadConfig>;
  query: string;
  variables: Record<string, unknown>;
  label: string;
  opts: LogsOptions;
  format: (data: T) => string;
};

async function runStream<T>(args: StreamArgs<T>): Promise<void> {
  const { config, query, variables, label, format } = args;
  process.stderr.write(`Streaming logs from ${label} — Ctrl-C to stop.\n`);

  const handle = subscribe<T>(config, {
    query,
    variables,
    onNext: (data) => {
      try {
        process.stdout.write(format(data) + "\n");
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        process.stderr.write(`(failed to format event: ${m})\n`);
      }
    },
    onError: (err) => {
      process.stderr.write(`\nerror: ${err.message}\n`);
      process.exitCode = 1;
    },
    onComplete: () => {
      process.stderr.write(`\nServer closed the stream.\n`);
    },
  });

  const onSigint = (): void => {
    process.stderr.write(`\nCancelled.\n`);
    handle.unsubscribe();
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigint);

  await handle.done;
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigint);
}

function formatLine(
  iso: string,
  level: string,
  message: string,
  metadata: string | null,
  noColor: boolean,
): string {
  const time = iso.slice(11, 19); // HH:MM:SS portion of ISO timestamp
  const lvl = level.padEnd(5);
  const prefix = noColor ? `${time} ${lvl} ` : `${C.gray}${time}${C.reset} ${colorLevel(lvl)} `;
  if (metadata) {
    return `${prefix}${message} ${noColor ? metadata : C.gray + metadata + C.reset}`;
  }
  return `${prefix}${message}`;
}

function colorLevel(level: string): string {
  const trimmed = level.trim();
  if (trimmed === "ERROR") return C.red + level + C.reset;
  if (trimmed === "WARN" || trimmed === "WARNING") return C.yellow + level + C.reset;
  if (trimmed === "INFO") return C.green + level + C.reset;
  if (trimmed === "DEBUG") return C.cyan + level + C.reset;
  return level;
}

/**
 * Edge-app payloads carry the full bridge envelope; LOG events have
 * a `message` field somewhere inside. Pull a human-readable string
 * out, falling back to a JSON dump.
 */
function extractEdgeMessage(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (obj.data && typeof obj.data === "object") {
      const d = obj.data as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
    }
  }
  return JSON.stringify(payload);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
