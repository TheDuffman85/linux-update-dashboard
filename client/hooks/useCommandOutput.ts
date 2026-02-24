import { useState, useEffect, useRef, useCallback } from "react";

export type WsMessage =
  | { type: "reset" }
  | { type: "started"; command: string; pkgManager: string }
  | { type: "output"; data: string; stream: "stdout" | "stderr" }
  | { type: "phase"; phase: string }
  | { type: "done"; success: boolean }
  | { type: "error"; message: string };

export function useCommandOutput(systemId: number) {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const clear = useCallback(() => {
    setMessages([]);
    setIsActive(false);
    setPhase(null);
  }, []);

  useEffect(() => {
    let disposed = false;

    function connect() {
      if (disposed) return;

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${location.host}/api/ws/systems/${systemId}/output`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!disposed) setConnected(true);
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg: WsMessage = JSON.parse(event.data);

          if (msg.type === "reset") {
            setMessages([]);
            setIsActive(false);
            setPhase(null);
            return;
          }

          setMessages((prev) => [...prev, msg]);

          switch (msg.type) {
            case "started":
              setIsActive(true);
              setPhase(null);
              break;
            case "phase":
              setPhase(msg.phase);
              break;
            case "done":
              setIsActive(false);
              setPhase(null);
              break;
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        if (disposed) return;
        setConnected(false);
        wsRef.current = null;

        // Don't reconnect on auth failure
        if (event.code !== 4001 && event.code !== 4002) {
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        // onclose fires after onerror
      };
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close(1000, "unmounted");
        wsRef.current = null;
      }
    };
  }, [systemId]);

  return { messages, connected, isActive, phase, clear };
}
