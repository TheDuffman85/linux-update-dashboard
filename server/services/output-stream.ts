import type { WSContext } from "hono/ws";

export type WsMessage =
  | { type: "reset" }
  | { type: "started"; command: string; pkgManager: string }
  | { type: "output"; data: string; stream: "stdout" | "stderr" }
  | { type: "phase"; phase: string }
  | { type: "done"; success: boolean }
  | { type: "error"; message: string };

interface SystemStream {
  buffer: WsMessage[];
  subscribers: Set<WSContext>;
}

const streams = new Map<number, SystemStream>();

function getOrCreate(systemId: number): SystemStream {
  let stream = streams.get(systemId);
  if (!stream) {
    stream = { buffer: [], subscribers: new Set() };
    streams.set(systemId, stream);
  }
  return stream;
}

/** Subscribe a WebSocket client. Replays full buffered history immediately. */
export function subscribe(systemId: number, ws: WSContext): void {
  const stream = getOrCreate(systemId);
  stream.subscribers.add(ws);

  for (const msg of stream.buffer) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // client disconnected during replay
    }
  }
}

/** Remove a WebSocket client from a system's subscribers. */
export function unsubscribe(systemId: number, ws: WSContext): void {
  const stream = streams.get(systemId);
  if (stream) {
    stream.subscribers.delete(ws);
  }
}

/** Push a message to all subscribers and append to buffer. */
export function publish(systemId: number, msg: WsMessage): void {
  const stream = getOrCreate(systemId);
  stream.buffer.push(msg);
  const json = JSON.stringify(msg);
  for (const ws of stream.subscribers) {
    try {
      ws.send(json);
    } catch {
      stream.subscribers.delete(ws);
    }
  }
}

/** Clear buffer for a system. Called when a new operation starts.
 *  Broadcasts a "reset" message to existing subscribers so they clear local state. */
export function resetStream(systemId: number): void {
  const stream = streams.get(systemId);
  if (stream) {
    const json = JSON.stringify({ type: "reset" });
    for (const ws of stream.subscribers) {
      try {
        ws.send(json);
      } catch {
        stream.subscribers.delete(ws);
      }
    }
    stream.buffer = [];
  }
}

/** Full cleanup: close all subscribers and remove the stream. */
export function removeStream(systemId: number): void {
  const stream = streams.get(systemId);
  if (stream) {
    for (const ws of stream.subscribers) {
      try {
        ws.close(1000, "stream removed");
      } catch {}
    }
    streams.delete(systemId);
  }
}
