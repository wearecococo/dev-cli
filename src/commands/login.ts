import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { prompt, promptPassword } from "../prompt.ts";
import { createClient } from "../graphql/client.ts";

export type LoginOptions = {
  endpoint?: string;
  username?: string;
};

/**
 * `cococo login` — exchange username + password for a bearer token
 * against the tenant's `/auth/token` endpoint, then write (or merge
 * into) the local `.env` file so subsequent commands authenticate
 * automatically.
 *
 * Three inputs:
 *  - endpoint  → prompted (or `--endpoint`). Accepted forms:
 *                  test9.cococo.app
 *                  https://test9.cococo.app
 *                  https://test9.cococo.app/graphql
 *                Normalised to `https://<host>/graphql` for COCOCO_ENDPOINT
 *                and `https://<host>/auth/token` for the POST.
 *  - username  → prompted (or `--username`).
 *  - password  → always prompted (masked); never accepted via flag so
 *                it doesn't end up in shell history.
 *
 * A stable per-machine device identifier is generated on first run
 * at `~/.cococo/device-id` and reused across logins, so the server
 * can recognise repeated logins from the same workstation.
 */
export async function runLogin(opts: LoginOptions): Promise<void> {
  const rawEndpoint = opts.endpoint?.trim() || (await prompt("Server URL (e.g. https://test9.cococo.app)"));
  if (!rawEndpoint) throw new Error("Server URL is required.");
  const { graphqlUrl, authUrl } = normaliseEndpoint(rawEndpoint);

  const username = opts.username?.trim() || (await prompt("Username"));
  if (!username) throw new Error("Username is required.");
  // Password can come from the `COCOCO_PASSWORD` env var (CI / tests /
  // scripts) — otherwise prompted interactively with masking. Never
  // accepted via a CLI flag because that would land in shell history.
  const password = process.env.COCOCO_PASSWORD || (await promptPassword("Password"));
  if (!password) throw new Error("Password is required.");

  const deviceId = getOrCreateDeviceId();

  const token = await postAuthToken(authUrl, { username, password, deviceId });

  // Verify the token works before persisting — a friendlier UX than
  // "login succeeded" followed by every subsequent command failing.
  await verifyToken(graphqlUrl, token);

  const envPath = resolve(process.cwd(), ".env");
  writeEnvFile(envPath, {
    COCOCO_ENDPOINT: graphqlUrl,
    COCOCO_TOKEN: token,
  });

  console.log(`Login successful.`);
  console.log(`  endpoint: ${graphqlUrl}`);
  console.log(`  wrote:    ${envPath}`);
}

/**
 * Accept a user-provided endpoint in any of the common shapes and
 * return both the GraphQL URL (for `.env`) and the `/auth/token` URL
 * (for the login POST).
 */
function normaliseEndpoint(raw: string): { graphqlUrl: string; authUrl: string } {
  let url = raw.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("ws://") && !url.startsWith("wss://")) {
    url = `https://${url}`;
  }
  url = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`Invalid server URL '${raw}': ${err instanceof Error ? err.message : String(err)}`);
  }
  // Strip /graphql / trailing slash so we can re-derive both paths.
  const base = `${parsed.protocol}//${parsed.host}`;
  return {
    graphqlUrl: `${base}/graphql`,
    authUrl: `${base}/auth/token`,
  };
}

async function postAuthToken(
  authUrl: string,
  body: { username: string; password: string; deviceId: string },
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach ${authUrl} (${m}). Check the server URL and your network.`);
  }
  if (!response.ok) {
    // Try to surface a readable error message; auth endpoints usually
    // return JSON with `error` / `message` / `detail` fields.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as Record<string, unknown>;
      const msg = body.error ?? body.message ?? body.detail;
      if (typeof msg === "string" && msg.length > 0) detail = msg;
    } catch {
      // not JSON; fall back to status text
    }
    throw new Error(`Login failed: ${detail}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(
      `Auth endpoint returned a non-JSON response (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  const token = extractToken(payload);
  if (!token) {
    throw new Error(
      `Auth endpoint returned an unexpected payload shape — could not find a token. ` +
        `Got: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }
  return token;
}

/**
 * Pull a bearer token out of an /auth/token response payload. Servers
 * vary in shape — tolerate the common ones.
 */
function extractToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  for (const key of ["token", "accessToken", "access_token", "authToken", "auth_token"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Sanity-check the token with a tiny GraphQL probe before writing
 * the .env — avoids the embarrassing "login succeeded but every
 * command after fails" mode.
 */
async function verifyToken(graphqlUrl: string, token: string): Promise<void> {
  const client = createClient({ endpoint: graphqlUrl, token });
  try {
    await client.request<{ __typename: string }>("{ __typename }");
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Token returned from /auth/token didn't validate against ${graphqlUrl}: ${m}`,
    );
  }
}

const DEVICE_ID_PATH = ".cococo/device-id";

/**
 * Per-machine device identifier. Created once on first login, reused
 * forever after — the server uses it to track tokens per workstation.
 * Lives under the user's home dir, not the workspace, since it's
 * intrinsic to the machine.
 */
function getOrCreateDeviceId(): string {
  // Prefer `$HOME` over `os.homedir()` — `homedir()` reads from the
  // user database and ignores HOME-env overrides, which means tests
  // (and any sandboxed runs) can't redirect the path. Falling back
  // to `homedir()` keeps the production case working when HOME is
  // unset (e.g. on Windows under certain shells).
  const home = process.env.HOME || homedir();
  const path = resolve(home, DEVICE_ID_PATH);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) return existing;
  }
  // Hostname suffix makes the identifier diagnosable in logs without
  // exposing the full UUID; UUID provides uniqueness.
  const id = `${sanitiseHostname(hostname())}-${randomUUID()}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, id + "\n");
  return id;
}

function sanitiseHostname(name: string): string {
  return name.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 32) || "cococo-cli";
}

/**
 * Merge new values into the workspace .env, preserving any keys
 * already present (so user-set vars like LOG_LEVEL or PROJECT_NAME
 * aren't clobbered). Comments and blank lines are dropped — we
 * favour a clean file over preserving incidental whitespace.
 */
function writeEnvFile(path: string, vars: Record<string, string>): void {
  const existing: Record<string, string> = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m) existing[m[1]!] = m[2]!;
    }
  }
  const merged: Record<string, string> = { ...existing, ...vars };
  // Stable ordering: COCOCO_* first (so they're easy to find), then
  // any other user keys alphabetised.
  const keys = Object.keys(merged).sort((a, b) => {
    const aPri = a.startsWith("COCOCO_") ? 0 : 1;
    const bPri = b.startsWith("COCOCO_") ? 0 : 1;
    if (aPri !== bPri) return aPri - bPri;
    return a.localeCompare(b);
  });
  const out = keys.map((k) => `${k}=${merged[k]}`).join("\n") + "\n";
  writeFileSync(path, out);
}
