import { useRef, useEffect } from "react";
import type { WsMessage } from "../hooks/useCommandOutput";

interface TerminalOutputProps {
  messages: WsMessage[];
  isActive: boolean;
  phase: string | null;
  connected: boolean;
}

export function TerminalOutput({ messages, isActive, phase, connected }: TerminalOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isScrolledToBottom = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    isScrolledToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  useEffect(() => {
    if (isScrolledToBottom.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  const lastStarted = [...messages]
    .reverse()
    .find((m): m is Extract<WsMessage, { type: "started" }> => m.type === "started");

  const lastDone = [...messages]
    .reverse()
    .find((m): m is Extract<WsMessage, { type: "done" }> => m.type === "done");

  let headerText = "Command Output";
  if (phase === "rechecking") {
    headerText = "Rechecking for updates...";
  } else if (isActive && lastStarted) {
    headerText = `Running: ${lastStarted.command}`;
  } else if (lastDone) {
    headerText = lastDone.success ? "Completed successfully" : "Command failed";
  }

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-400 truncate max-w-md">
            {headerText}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isActive && (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <span className="spinner spinner-sm !w-3 !h-3" />
              Running
            </span>
          )}
          {!connected && (
            <span className="text-xs text-amber-400">Disconnected</span>
          )}
        </div>
      </div>

      {/* Terminal body */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="p-4 font-mono text-xs leading-relaxed text-slate-300 max-h-96 overflow-y-auto whitespace-pre-wrap break-all"
      >
        {messages.length === 0 && (
          <span className="text-slate-500 italic">
            {connected ? "Waiting for output…" : "Waiting for output… (reconnecting)"}
          </span>
        )}
        {messages.map((msg, i) => {
          switch (msg.type) {
            case "started":
              return (
                <div key={i} className="text-blue-400 mb-1">
                  $ {msg.command}
                </div>
              );
            case "output":
              return (
                <span
                  key={i}
                  className={msg.stream === "stderr" ? "text-red-400" : undefined}
                >
                  {msg.data}
                </span>
              );
            case "phase":
              return (
                <div key={i} className="text-yellow-400 mt-2 mb-1">
                  --- {msg.phase === "rechecking"
                    ? "Rechecking for updates..."
                    : msg.phase} ---
                </div>
              );
            case "done":
              return (
                <div
                  key={i}
                  className={`mt-2 font-semibold ${
                    msg.success ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {msg.success ? "Done." : "Failed."}
                </div>
              );
            case "error":
              return (
                <div key={i} className="text-red-400">
                  Error: {msg.message}
                </div>
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}
