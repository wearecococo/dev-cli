import type { StateFile } from "./types.ts";

/**
 * Pluggable state backend. Phase 1 ships `LocalFileStateBackend`;
 * phase 2 will add `RemoteGraphQLStateBackend` (committed-server
 * state with GraphQL-mediated locking) implementing this same
 * interface so callers don't change.
 */
export interface StateBackend {
  /** Load current state, or `null` if none exists. */
  read(): Promise<StateFile | null>;

  /** Atomically overwrite state. */
  write(state: StateFile): Promise<void>;

  /**
   * Acquire an exclusive lock on the state. Returns a release fn the
   * caller must invoke (deferred or in a finally block). Throws if
   * the lock is already held by another live process.
   */
  lock(): Promise<() => Promise<void>>;
}
