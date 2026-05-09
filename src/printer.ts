import {
  LIFECYCLE_PATHS,
  libraryPath,
  subscriptionHandlerPath,
  timerHandlerPath,
} from "./sources.ts";
import type { WireManifest } from "./manifest.ts";

/**
 * Render a `WireManifest` as a `manifest.ts` source file.
 *
 * `manifest.ts` is v2-only — calling this with a v1 manifest is a bug,
 * since pull-of-v1 always writes `manifest.yaml` instead.
 *
 * Pull always materialises every Lua body to a separate file and
 * references it via `luaFile("./...")` — the printer never emits inline
 * `lua\`...\`` bodies. Authors who want inline one-liners write them by
 * hand; the round-trip rule is "pull's output is a valid input for push,"
 * not "pull preserves the author's exact source layout."
 */
export function printManifestTs(manifest: WireManifest): string {
  if ((manifest as Record<string, unknown>).engine_version === 1) {
    throw new Error(
      `printManifestTs called with a v1 manifest. v1 integrations must ` +
        `be written as manifest.yaml — pull with --format yaml instead.`,
    );
  }
  const lines = [
    `import { defineIntegration, luaFile } from "@wearecococo/dev-cli/define";`,
    "",
    `export default defineIntegration(${printObject(toAuthorShape(manifest), 0)});`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Convert a snake_case v2 `WireManifest` into the camelCase author
 * surface the printer emits. Source fields become `luaFile()` references;
 * every `LuaFileRef` survives the print step verbatim.
 */
function toAuthorShape(manifest: WireManifest): Record<string, unknown> {
  const m = manifest as Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: m.id,
    version: m.version,
    engineVersion: 2,
    sdkVersion: m.sdk_version,
  };
  copy(out, "description", m.description);
  copy(out, "runtimeMode", m.runtime_mode);
  copy(out, "resources", m.resources);
  copy(out, "permissions", m.permissions);
  copy(out, "dataContainerSchemas", m.data_container_schemas);
  copy(out, "actions", m.actions);
  copy(out, "timeoutMs", m.timeout_ms);

  // Replace every materialised source with a `luaFile()` reference.
  if (typeof m.init_source === "string" && m.init_source !== "") {
    out.initSource = luaFileRef(LIFECYCLE_PATHS.init_source);
  }
  if (typeof m.shutdown_source === "string" && m.shutdown_source !== "") {
    out.shutdownSource = luaFileRef(LIFECYCLE_PATHS.shutdown_source);
  }
  if (typeof m.upgrade_source === "string" && m.upgrade_source !== "") {
    out.upgradeSource = luaFileRef(LIFECYCLE_PATHS.upgrade_source);
  }

  if (Array.isArray(m.timers)) {
    out.timers = m.timers.map((t) => {
      const timer = { ...(t as Record<string, unknown>) };
      const name = String(timer.name ?? "");
      if (typeof timer.source === "string" && timer.source !== "" && name) {
        timer.source = luaFileRef(timerHandlerPath(name));
      } else if (timer.source === "" || timer.source == null) {
        delete timer.source;
      }
      return timer;
    });
  }
  if (Array.isArray(m.subscriptions)) {
    out.subscriptions = m.subscriptions.map((s) => {
      const sub = { ...(s as Record<string, unknown>) };
      const topic = String(sub.topic ?? "");
      if (typeof sub.source === "string" && sub.source !== "" && topic) {
        sub.source = luaFileRef(subscriptionHandlerPath(topic));
      } else if (sub.source === "" || sub.source == null) {
        delete sub.source;
      }
      return sub;
    });
  }
  if (m.libraries && typeof m.libraries === "object" && !Array.isArray(m.libraries)) {
    const libsIn = m.libraries as Record<string, string>;
    const libsOut: Record<string, unknown> = {};
    for (const [name, content] of Object.entries(libsIn)) {
      if (typeof content === "string" && content.length > 0) {
        libsOut[name] = luaFileRef(libraryPath(name));
      }
    }
    if (Object.keys(libsOut).length > 0) out.libraries = libsOut;
  }

  return out;
}

function copy(out: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) out[key] = value;
}

// ──────────────────────────────────────────────────────────────────────
// Tiny TS-literal printer. Handles the value shapes that defineIntegration
// arguments contain: strings, numbers, booleans, nulls, arrays, plain
// objects, and the `LuaFileRef` sentinel below.
// ──────────────────────────────────────────────────────────────────────

const LUA_FILE_REF = Symbol("luaFileRef");
type LuaFileRef = { [LUA_FILE_REF]: true; path: string };

function luaFileRef(path: string): LuaFileRef {
  return { [LUA_FILE_REF]: true, path: `./${path}` };
}

function isLuaFileRef(x: unknown): x is LuaFileRef {
  return typeof x === "object" && x !== null && (x as LuaFileRef)[LUA_FILE_REF] === true;
}

function printValue(value: unknown, indent: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isLuaFileRef(value)) return `luaFile(${JSON.stringify(value.path)})`;
  if (Array.isArray(value)) return printArray(value, indent);
  if (typeof value === "object") return printObject(value as Record<string, unknown>, indent);
  return JSON.stringify(value);
}

function printArray(arr: unknown[], indent: number): string {
  if (arr.length === 0) return "[]";
  const inner = " ".repeat((indent + 1) * 2);
  const closing = " ".repeat(indent * 2);
  const items = arr.map((v) => `${inner}${printValue(v, indent + 1)}`);
  return `[\n${items.join(",\n")},\n${closing}]`;
}

function printObject(obj: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  const inner = " ".repeat((indent + 1) * 2);
  const closing = " ".repeat(indent * 2);
  const lines = entries.map(([k, v]) => `${inner}${formatKey(k)}: ${printValue(v, indent + 1)}`);
  return `{\n${lines.join(",\n")},\n${closing}}`;
}

const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function formatKey(k: string): string {
  return SAFE_KEY.test(k) ? k : JSON.stringify(k);
}
