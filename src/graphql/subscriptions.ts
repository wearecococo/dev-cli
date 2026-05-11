/**
 * GraphQL subscription client speaking the modern `graphql-transport-ws`
 * sub-protocol (https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md).
 *
 * Lifecycle: ConnectionInit → ConnectionAck → Subscribe → Next* →
 * Complete (or Error). Ping/Pong are server-initiated and answered
 * automatically. SIGINT-style cancellation goes through the returned
 * unsubscribe handle, which sends a Complete frame and closes the
 * socket cleanly.
 *
 * The client uses Bun's built-in WebSocket — no transport dependency.
 *
 * Auth: Bearer token lives in the ConnectionInit payload as
 * `{ Authorization: "Bearer <token>" }`. This is what most graphql-ws
 * servers expect and matches the cococo backend.
 */

import type { Config } from "../config.ts";

export type SubscribeOptions<T> = {
  query: string;
  variables?: Record<string, unknown>;
  /** Called for each `Next` frame. */
  onNext: (data: T) => void;
  /**
   * Called once on terminal error (server error, transport failure,
   * auth rejection, etc.). After this fires, the connection is
   * already closed.
   */
  onError: (err: Error) => void;
  /** Called once when the server sends a `Complete`. */
  onComplete?: () => void;
};

export type SubscribeHandle = {
  /** Send a `Complete` and close the WS. Safe to call multiple times. */
  unsubscribe(): void;
  /**
   * Resolves once the subscription has terminated (server completed,
   * caller unsubscribed, or transport failed).
   */
  done: Promise<void>;
};

type ServerMessage =
  | { type: "connection_ack"; payload?: Record<string, unknown> }
  | { type: "ping"; payload?: Record<string, unknown> }
  | { type: "pong"; payload?: Record<string, unknown> }
  | { type: "next"; id: string; payload: { data: unknown; errors?: GraphQLError[] } }
  | { type: "error"; id: string; payload: GraphQLError[] }
  | { type: "complete"; id: string };

type GraphQLError = { message: string; path?: (string | number)[] };

/**
 * Open a WS, run a subscription, dispatch frames to the callbacks.
 * Returns a handle the caller uses to cancel.
 */
export function subscribe<T>(
  config: Config,
  opts: SubscribeOptions<T>,
): SubscribeHandle {
  const wsEndpoint = httpToWs(config.endpoint);
  const ws = new WebSocket(wsEndpoint, "graphql-transport-ws");

  const id = "1";
  let acked = false;
  let terminated = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (err?: Error): void => {
    if (terminated) return;
    terminated = true;
    try {
      ws.close();
    } catch {
      // ignore
    }
    if (err) opts.onError(err);
    else opts.onComplete?.();
    resolveDone();
  };

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "connection_init",
        payload: { Authorization: `Bearer ${config.token}` },
      }),
    );
  });

  ws.addEventListener("message", (evt) => {
    if (terminated) return;
    const data = typeof evt.data === "string" ? evt.data : evt.data.toString();
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      finish(new Error(`WebSocket received non-JSON frame: ${data.slice(0, 200)}`));
      return;
    }

    switch (msg.type) {
      case "connection_ack":
        acked = true;
        ws.send(
          JSON.stringify({
            type: "subscribe",
            id,
            payload: { query: opts.query, variables: opts.variables ?? {} },
          }),
        );
        return;
      case "ping":
        ws.send(JSON.stringify({ type: "pong", payload: msg.payload }));
        return;
      case "pong":
        // Server replied to our (currently unsent) ping. No-op.
        return;
      case "next":
        if (msg.id !== id) return;
        if (msg.payload.errors && msg.payload.errors.length > 0) {
          const summary = msg.payload.errors.map((e) => e.message).join("; ");
          finish(new Error(`GraphQL subscription returned errors: ${summary}`));
          return;
        }
        opts.onNext(msg.payload.data as T);
        return;
      case "error":
        finish(
          new Error(
            `GraphQL subscription error: ${msg.payload
              .map((e) => e.message)
              .join("; ")}`,
          ),
        );
        return;
      case "complete":
        if (msg.id !== id) return;
        finish();
        return;
    }
  });

  ws.addEventListener("error", () => {
    if (acked) {
      finish(new Error(`WebSocket error after ConnectionAck — connection lost.`));
    } else {
      finish(
        new Error(
          `WebSocket connection to ${wsEndpoint} failed before ConnectionAck. ` +
            `Check the endpoint URL and token.`,
        ),
      );
    }
  });

  ws.addEventListener("close", (evt) => {
    if (terminated) return;
    // 1000 = normal closure. Anything else with no prior `complete` is
    // a transport hiccup — surface as an error rather than silent exit.
    if (evt.code === 1000) {
      finish();
    } else {
      finish(
        new Error(
          `WebSocket closed unexpectedly (code=${evt.code}, reason=${evt.reason || "<none>"}).`,
        ),
      );
    }
  });

  return {
    unsubscribe(): void {
      if (terminated) return;
      try {
        ws.send(JSON.stringify({ type: "complete", id }));
      } catch {
        // ignore — likely already closed
      }
      // The `ws.close()` codepath in Bun doesn't reliably flush
      // application frames queued in the same tick — we'd yank the
      // socket out from under the Complete frame. Defer the close
      // to the next tick so the runtime drains the send buffer
      // before initiating the close handshake.
      queueMicrotask(() => {
        try {
          ws.close(1000, "client unsubscribe");
        } catch {
          // already closed; finish will fire via close-handler
        }
      });
    },
    done,
  };
}

/**
 * Translate `http://` / `https://` to `ws://` / `wss://`. Leaves
 * `ws://` / `wss://` URLs untouched in case the user already
 * overrode the endpoint.
 */
function httpToWs(endpoint: string): string {
  if (endpoint.startsWith("https://")) return "wss://" + endpoint.slice(8);
  if (endpoint.startsWith("http://")) return "ws://" + endpoint.slice(7);
  return endpoint;
}
