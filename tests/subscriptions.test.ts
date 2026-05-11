import { afterEach, describe, expect, test } from "bun:test";
import { subscribe } from "../src/graphql/subscriptions.ts";
import type { Config } from "../src/config.ts";

/**
 * Tests for the graphql-transport-ws client. Stand up a Bun WS server
 * that responds to ConnectionInit with ConnectionAck, accepts a
 * Subscribe frame, sends a few Next frames, then either Complete or
 * Error. Asserts the client dispatches callbacks correctly and the
 * unsubscribe handle closes the socket on demand.
 */

type ServerLog = { received: string[]; sent: string[] };

/**
 * Start a transient WS server and return { url, log, stop }. The
 * handler controls what frames the server sends in response to each
 * client frame.
 */
function withWsServer(
  handler: (ws: ServerWebSocket, msg: string, log: ServerLog) => void,
): { url: string; log: ServerLog; stop: () => void } {
  const log: ServerLog = { received: [], sent: [] };
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/graphql") {
        const upgraded = srv.upgrade(req);
        if (upgraded) return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        const str =
          typeof message === "string" ? message : new TextDecoder().decode(message);
        log.received.push(str);
        handler(ws as unknown as ServerWebSocket, str, log);
      },
    },
  });
  return {
    url: `http://localhost:${server.port}/graphql`,
    log,
    stop: () => server.stop(true),
  };
}

type ServerWebSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

function sendFromServer(ws: ServerWebSocket, log: ServerLog, frame: object): void {
  const s = JSON.stringify(frame);
  log.sent.push(s);
  ws.send(s);
}

const config: Config = { endpoint: "", token: "test-token" };

let stopFn: (() => void) | undefined;
afterEach(() => {
  if (stopFn) {
    stopFn();
    stopFn = undefined;
  }
});

describe("subscribe — happy path", () => {
  test("ConnectionInit → ConnectionAck → Subscribe → Next* → Complete", async () => {
    const events: unknown[] = [];
    let completed = false;

    const srv = withWsServer((ws, msg, log) => {
      const parsed = JSON.parse(msg) as { type: string; payload?: unknown };
      if (parsed.type === "connection_init") {
        // Auth payload should carry the Bearer token.
        const payload = parsed.payload as Record<string, unknown>;
        expect(payload.Authorization).toBe("Bearer test-token");
        sendFromServer(ws, log, { type: "connection_ack" });
        return;
      }
      if (parsed.type === "subscribe") {
        // Stream three events then complete.
        sendFromServer(ws, log, {
          type: "next",
          id: "1",
          payload: { data: { tick: 1 } },
        });
        sendFromServer(ws, log, {
          type: "next",
          id: "1",
          payload: { data: { tick: 2 } },
        });
        sendFromServer(ws, log, { type: "complete", id: "1" });
        return;
      }
    });
    stopFn = srv.stop;

    const handle = subscribe<{ tick: number }>(
      { ...config, endpoint: srv.url },
      {
        query: "subscription { tick }",
        onNext: (data) => events.push(data),
        onError: (err) => {
          throw err;
        },
        onComplete: () => {
          completed = true;
        },
      },
    );
    await handle.done;

    expect(events).toEqual([{ tick: 1 }, { tick: 2 }]);
    expect(completed).toBe(true);
  });

  test("ping → pong reply", async () => {
    const srv = withWsServer((ws, msg, log) => {
      const parsed = JSON.parse(msg) as { type: string };
      if (parsed.type === "connection_init") {
        sendFromServer(ws, log, { type: "connection_ack" });
        sendFromServer(ws, log, { type: "ping" });
        return;
      }
      if (parsed.type === "pong") {
        // After we see the pong, complete the test by closing.
        sendFromServer(ws, log, { type: "complete", id: "1" });
        return;
      }
      if (parsed.type === "subscribe") {
        // No-op — wait for ping/pong cycle.
        return;
      }
    });
    stopFn = srv.stop;

    const handle = subscribe(
      { ...config, endpoint: srv.url },
      {
        query: "subscription { x }",
        onNext: () => {},
        onError: (err) => {
          throw err;
        },
      },
    );
    await handle.done;
    expect(srv.log.received.some((s) => s.includes('"type":"pong"'))).toBe(true);
  });
});

describe("subscribe — error paths", () => {
  test("server error frame surfaces as onError", async () => {
    let captured: Error | undefined;

    const srv = withWsServer((ws, msg, log) => {
      const parsed = JSON.parse(msg) as { type: string };
      if (parsed.type === "connection_init") {
        sendFromServer(ws, log, { type: "connection_ack" });
        return;
      }
      if (parsed.type === "subscribe") {
        sendFromServer(ws, log, {
          type: "error",
          id: "1",
          payload: [{ message: "permission denied" }],
        });
      }
    });
    stopFn = srv.stop;

    const handle = subscribe(
      { ...config, endpoint: srv.url },
      {
        query: "subscription { x }",
        onNext: () => {},
        onError: (err) => {
          captured = err;
        },
      },
    );
    await handle.done;
    expect(captured?.message).toMatch(/permission denied/);
  });

  test("transport failure before ConnectionAck surfaces clearly", async () => {
    let captured: Error | undefined;

    const srv = withWsServer((ws) => {
      // Server abruptly closes on receiving ConnectionInit.
      ws.close(1011, "boom");
    });
    stopFn = srv.stop;

    const handle = subscribe(
      { ...config, endpoint: srv.url },
      {
        query: "subscription { x }",
        onNext: () => {},
        onError: (err) => {
          captured = err;
        },
      },
    );
    await handle.done;
    expect(captured?.message).toMatch(/WebSocket/);
  });

  test("unsubscribe sends Complete + closes the socket", async () => {
    const srv = withWsServer((ws, msg, log) => {
      const parsed = JSON.parse(msg) as { type: string };
      if (parsed.type === "connection_init") {
        sendFromServer(ws, log, { type: "connection_ack" });
      }
      // Don't send any subscribe response — let the test unsubscribe.
    });
    stopFn = srv.stop;

    const handle = subscribe(
      { ...config, endpoint: srv.url },
      {
        query: "subscription { x }",
        onNext: () => {},
        onError: () => {},
      },
    );

    // Wait briefly for ConnectionAck + Subscribe send.
    await new Promise((r) => setTimeout(r, 50));
    handle.unsubscribe();
    await handle.done;
    // The Complete frame is in flight when `done` resolves on the
    // client side (close-handshake is asynchronous over the wire);
    // give the server a tick to actually process it.
    await new Promise((r) => setTimeout(r, 50));

    expect(srv.log.received.some((s) => s.includes('"type":"complete"'))).toBe(true);
  });
});
