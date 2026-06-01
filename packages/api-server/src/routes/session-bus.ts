/**
 * SessionBus — global pub-sub for session events across WebSocket connections.
 *
 * Maps sessionId → Set of subscriber callbacks.
 * Multiple users/tabs can subscribe to the same session (if authorized).
 * When a WS disconnects, its subscriber is removed.
 */

import type { WsServerMessage } from '@zeroclaw/shared';

export type Subscriber = (msg: WsServerMessage) => void;

export interface SessionBus {
  subscribe(sessionId: string, subscriber: Subscriber): void;
  unsubscribe(sessionId: string, subscriber: Subscriber): void;
  unsubscribeAll(subscriber: Subscriber): void;
  publish(sessionId: string, msg: WsServerMessage): void;
}

export function createSessionBus(): SessionBus {
  const subs = new Map<string, Set<Subscriber>>();

  return {
    subscribe(sessionId, subscriber) {
      let set = subs.get(sessionId);
      if (!set) {
        set = new Set();
        subs.set(sessionId, set);
      }
      set.add(subscriber);
    },

    unsubscribe(sessionId, subscriber) {
      const set = subs.get(sessionId);
      if (set) {
        set.delete(subscriber);
        if (set.size === 0) subs.delete(sessionId);
      }
    },

    unsubscribeAll(subscriber) {
      for (const [sessionId, set] of subs) {
        set.delete(subscriber);
        if (set.size === 0) subs.delete(sessionId);
      }
    },

    publish(sessionId, msg) {
      const set = subs.get(sessionId);
      if (!set) return;
      for (const sub of set) {
        try {
          sub(msg);
        } catch {
          // ignore individual subscriber errors
        }
      }
    },
  };
}
